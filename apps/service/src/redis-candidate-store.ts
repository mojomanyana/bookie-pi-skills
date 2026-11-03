import { createHash, createHmac, randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { types } from "node:util";
import {
  CANONICAL_EXPORT_VERSION,
  PROJECTION_VERSIONS,
} from "./build-input-versions.js";

import { ownDataFields } from "./closed-data.js";
import {
  parseOutputDescriptor,
  type EncodedOutputDescriptor,
} from "./output-descriptor.js";
import type { TrustedBuildRecipe } from "./trusted-builder.js";

import type { ChunkProjection, ConceptProjection } from "./projection.js";
import { candidateScript } from "./redis-candidate-script.js";

export type CandidateErrorCode =
  "BUILD_CONFLICT" | "FENCED" | "INDEX_UNAVAILABLE" | "NOT_FOUND";
export class CandidateStoreError extends Error {
  constructor(
    readonly code: CandidateErrorCode,
    readonly outcome?: "unknown",
  ) {
    super(code);
    this.name = "CandidateStoreError";
  }
}
export type CandidateFailureCode =
  | "INVALID_COMMIT"
  | "VALIDATION_FAILED"
  | "SECRET_DETECTED"
  | "POLICY_REJECTED"
  | "LIMIT_EXCEEDED"
  | "DEPENDENCY_FAILED"
  | "EVALUATION_FAILED"
  | "INTERRUPTED"
  | "INTERNAL";
export interface CandidateSpec {
  readonly vaultUid: string;
  readonly buildId: string;
  readonly sourceCommit: string;
  readonly manifestHash: string;
  readonly policyHash: string;
  readonly concepts: number;
  readonly chunks: number;
}
export interface CandidateLease {
  readonly ownerEpoch: number;
  readonly fence: number;
  readonly jobId: string;
  readonly buildId: string;
}
export interface CandidateInputLease extends CandidateLease {
  readonly configurationEpoch: number;
}
/** Private v2 reconciliation data. Descriptor presence, not counts, selects phase. */
export interface CandidateInputManifest {
  readonly manifestVersion: 2;
  readonly lease: CandidateInputLease;
  readonly sourceCommit: string;
  readonly manifestHash: string;
  readonly policyHash: string;
  readonly recipeHash: string;
  readonly state: CandidateJob["state"];
  readonly nextConcept: number;
  readonly nextChunk: number;
  readonly cleanupConcept: number;
  readonly cleanupChunk: number;
  readonly outputDescriptor?: EncodedOutputDescriptor;
}
/** Ephemeral private observation, never a completion/authorization receipt. */
export interface StoredOutputMeasurement {
  readonly lease: CandidateInputLease;
  readonly sourceCommit: string;
  readonly descriptorHash: string;
  readonly concepts: Readonly<{ count: number; hash: string }>;
  readonly chunks: Readonly<{ count: number; hash: string }>;
}
export interface CandidateInspection {
  readonly job: CandidateJob;
  readonly manifest: CandidateInputManifest | null;
  /** Same current process/configuration/controller/fence and an unexpired lease. */
  readonly live: boolean;
}
export interface CandidateJob {
  readonly jobId: string;
  readonly buildId: string;
  readonly sourceCommit: string;
  readonly state:
    | "queued"
    | "building"
    | "verifying"
    | "evaluating"
    | "complete"
    | "failed"
    | "cancelling"
    | "cancelled";
  readonly failureCode: CandidateFailureCode | "CANCELLED" | null;
}
/** Deployment adapter must honor cancellation and must not log command arguments. */
export type RedisExecutor = (
  command: readonly string[],
  signal: AbortSignal,
) => Promise<unknown>;

// Separate payload domain; the metadata ceiling remains 4096 bytes.
const PAGE_COUNT = 128;
const ENCODED_BYTES = 1_048_576;
const RAW_BYTES = 6 * ENCODED_BYTES;
const INVENTORY_CALLS = 16_384;
const readOperations = new Set([
  "read",
  "readCandidate",
  "current",
  "inspect",
  "storedPage",
  "storedInventory",
  "storedFinish",
]);
const buildPattern = /^bld_[0-9a-f]{64}(?![\s\S])/u;
const jobPattern = /^job_[0-9A-HJKMNP-TV-Z]{26}(?![\s\S])/u;
const commitPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})(?![\s\S])/u;
const hashPattern = /^sha256:[0-9a-f]{64}(?![\s\S])/u;
const vaultPattern = /^VLT-[0-7][0-9A-HJKMNP-TV-Z]{25}(?![\s\S])/u;
const failureCodes = new Set([
  "INVALID_COMMIT",
  "VALIDATION_FAILED",
  "SECRET_DETECTED",
  "POLICY_REJECTED",
  "LIMIT_EXCEEDED",
  "DEPENDENCY_FAILED",
  "EVALUATION_FAILED",
  "INTERRUPTED",
  "INTERNAL",
]);
const states = new Set([
  "queued",
  "building",
  "verifying",
  "evaluating",
  "complete",
  "failed",
  "cancelling",
  "cancelled",
]);
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}
function bounded(
  value: unknown,
  maximum: number,
  minimum = 0,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}
function input(condition: boolean): asserts condition {
  if (!condition) throw new TypeError("Candidate input is invalid.");
}
function unavailable(outcome?: "unknown"): never {
  throw new CandidateStoreError("INDEX_UNAVAILABLE", outcome);
}
function lease(value: unknown): value is CandidateLease | CandidateInputLease {
  try {
    let values: readonly unknown[];
    try {
      values = ownDataFields(value, [
        "ownerEpoch",
        "fence",
        "jobId",
        "buildId",
      ]);
    } catch {
      values = ownDataFields(value, [
        "ownerEpoch",
        "fence",
        "jobId",
        "buildId",
        "configurationEpoch",
      ]);
      if (!bounded(values[4], Number.MAX_SAFE_INTEGER, 1)) return false;
    }
    return (
      bounded(values[0], 2147483647, 1) &&
      bounded(values[1], 2147483647, 1) &&
      matches(values[2], jobPattern) &&
      matches(values[3], buildPattern)
    );
  } catch {
    return false;
  }
}
function wireLease(value: CandidateLease): Record<string, unknown> {
  return {
    ...value,
    ...("configurationEpoch" in value
      ? { configurationEpoch: String(value.configurationEpoch) }
      : {}),
  };
}
function inputLease(value: unknown): value is CandidateInputLease {
  return lease(value) && "configurationEpoch" in value;
}
function receivedLease(value: unknown): CandidateInputLease {
  if (
    !object(value) ||
    !matches(value.configurationEpoch, /^[1-9][0-9]{0,15}(?![\s\S])/u)
  )
    unavailable();
  const result = {
    ...value,
    configurationEpoch: Number(value.configurationEpoch),
  };
  if (!inputLease(result)) unavailable();
  return Object.freeze(result);
}
/** Consume the existing canonical v2 codec result; never persist its private tuple.
 * Structural validation does not confer the S5 builder's process-local provenance. */
function recipeMetadata(
  recipe: TrustedBuildRecipe,
  vaultUid: string,
): Record<string, unknown> {
  try {
    const [
      serialized,
      scopeHash,
      policyHash,
      recipeHash,
      buildId,
      sourceCommit,
      configurationEpoch,
    ] = ownDataFields(recipe, [
      "serialized",
      "scopeHash",
      "policyHash",
      "recipeHash",
      "buildId",
      "sourceCommit",
      "configurationEpoch",
    ]);
    input(
      typeof serialized === "string" && Buffer.byteLength(serialized) <= 4096,
    );
    const tuple: unknown = JSON.parse(serialized);
    input(
      Array.isArray(tuple) &&
        tuple.length === 17 &&
        JSON.stringify(tuple) === serialized,
    );
    input(
      tuple[0] === "bookie-build-inputs" &&
        tuple[1] === 2 &&
        tuple[2] === vaultUid &&
        matches(sourceCommit, commitPattern) &&
        tuple[4] === sourceCommit &&
        tuple[3] === (sourceCommit.length === 40 ? "sha1" : "sha256") &&
        tuple[5] === scopeHash &&
        tuple[6] === "1.0" &&
        tuple[8] === policyHash &&
        tuple[16] === null,
    );
    input(
      [scopeHash, policyHash, recipeHash, tuple[7], tuple[15]].every((v) =>
        matches(v, hashPattern),
      ) &&
        tuple
          .slice(9, 14)
          .every((v) => matches(v, /^[A-Za-z0-9._+-]{1,128}(?![\s\S])/u)) &&
        bounded(tuple[14], 65536, 16) &&
        bounded(configurationEpoch, Number.MAX_SAFE_INTEGER, 1),
    );
    input(
      recipeHash ===
        `sha256:${createHash("sha256").update(serialized, "utf8").digest("hex")}` &&
        buildId === `bld_${(recipeHash as string).slice(7)}`,
    );
    return {
      buildId,
      sourceCommit,
      manifestHash: tuple[7],
      policyHash,
      recipeHash,
      configurationEpoch: String(configurationEpoch),
    };
  } catch {
    throw new TypeError("Candidate input is invalid.");
  }
}
function candidate(value: unknown): CandidateInputManifest | null {
  if (value === null) return null;
  try {
    input(object(value));
    ownDataFields(value, [
      "manifestVersion",
      "lease",
      "sourceCommit",
      "manifestHash",
      "policyHash",
      "recipeHash",
      "state",
      "nextConcept",
      "nextChunk",
      "cleanupConcept",
      "cleanupChunk",
      ...(Object.hasOwn(value, "outputDescriptor") ? ["outputDescriptor"] : []),
    ]);
    const owner = receivedLease(value.lease);
    input(
      value.manifestVersion === 2 &&
        matches(value.sourceCommit, commitPattern) &&
        matches(value.manifestHash, hashPattern) &&
        matches(value.policyHash, hashPattern) &&
        matches(value.recipeHash, hashPattern) &&
        owner.buildId === `bld_${value.recipeHash.slice(7)}` &&
        typeof value.state === "string" &&
        states.has(value.state),
    );
    const descriptor = Object.hasOwn(value, "outputDescriptor")
      ? parseOutputDescriptor(value.outputDescriptor as string)
      : undefined;
    const tuple =
      descriptor === undefined
        ? undefined
        : (JSON.parse(descriptor.serialized) as unknown[]);
    input(
      tuple === undefined
        ? !["verifying", "evaluating", "complete"].includes(value.state)
        : tuple[2] === value.recipeHash && value.state !== "queued",
    );
    const concepts = tuple === undefined ? 0 : (tuple[6] as number);
    const chunks = tuple === undefined ? 0 : (tuple[8] as number);
    input(
      bounded(value.nextConcept, concepts) &&
        bounded(value.nextChunk, chunks) &&
        bounded(value.cleanupConcept, concepts) &&
        bounded(value.cleanupChunk, chunks),
    );
    input(
      ["failed", "cancelled"].includes(value.state) ||
        (value.cleanupConcept === 0 && value.cleanupChunk === 0),
    );
    input(value.cleanupChunk === 0 || value.cleanupConcept === concepts);
    input(
      !["verifying", "evaluating", "complete"].includes(value.state) ||
        (value.nextConcept === concepts && value.nextChunk === chunks),
    );
    return Object.freeze({
      ...value,
      lease: owner,
      ...(descriptor === undefined ? {} : { outputDescriptor: descriptor }),
    }) as unknown as CandidateInputManifest;
  } catch {
    unavailable();
  }
}
function job(
  value: unknown,
  outcome?: "unknown",
  expected?: Readonly<{ jobId: string; buildId?: string }>,
): CandidateJob {
  if (
    !object(value) ||
    Object.keys(value).length !== 5 ||
    !matches(value.jobId, jobPattern) ||
    !matches(value.buildId, buildPattern) ||
    !matches(value.sourceCommit, commitPattern) ||
    (expected !== undefined &&
      (value.jobId !== expected.jobId ||
        (expected.buildId !== undefined &&
          value.buildId !== expected.buildId))) ||
    typeof value.state !== "string" ||
    !states.has(value.state)
  )
    unavailable(outcome);
  if (
    value.state === "failed"
      ? !failureCodes.has(String(value.failureCode))
      : value.state === "cancelled"
        ? value.failureCode !== "CANCELLED"
        : value.failureCode !== null
  )
    unavailable(outcome);
  return Object.freeze(value) as unknown as CandidateJob;
}
function payloadStrings(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    types.isProxy(value) ||
    value.length < 1 ||
    value.length > PAGE_COUNT + 1
  )
    unavailable();
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(fields).length !== value.length + 1) unavailable();
  const result: string[] = [];
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const field = fields[String(i)];
    if (
      field === undefined ||
      !Object.hasOwn(field, "value") ||
      typeof field.value !== "string" ||
      /[\uD800-\uDFFF]/u.test(field.value)
    )
      unavailable();
    const text = field.value as string;
    if (i > 0) bytes += Buffer.byteLength(text);
    if ((i === 0 && Buffer.byteLength(text) > 4096) || bytes > RAW_BYTES)
      unavailable();
    result.push(text);
  }
  return result;
}
const conceptFields = [
  "uid",
  "path",
  "type",
  "title",
  "project",
  "lifecycle",
  "workflow",
  "sensitivity",
  "tags",
  "links",
  "trust",
  "verifiedBy",
  "staleAfter",
  "relations",
  "sourceCommit",
  "sourceHash",
  "projectionSchemaVersion",
  "contentTrust",
];
const chunkFields = [
  "ordinal",
  "heading",
  "headingPath",
  "text",
  "chunkerVersion",
  "embeddingGeneration",
];
/** Only parsed, bounded Redis JSON reaches this validator. Not an append-policy change. */
function storedRecord(
  raw: string,
  kind: "concept" | "chunk",
  ordinal: number,
  source: string,
  maxChunkBytes: number,
): string {
  // Reject excessive container depth before JSON.parse can allocate a hostile tree.
  let depth = 0,
    quoted = false,
    escaped = false;
  for (const char of raw) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{" || char === "[") {
      if (++depth > 4) unavailable();
    } else if (char === "}" || char === "]") depth--;
  }
  const value: unknown = JSON.parse(raw);
  ownDataFields(value, [
    ...conceptFields,
    ...(kind === "chunk" ? chunkFields : []),
  ]);
  const v = value as Record<string, unknown>;
  const text = (x: unknown): x is string =>
    typeof x === "string" && !/[\uD800-\uDFFF]/u.test(x);
  const nullable = (x: unknown): boolean => x === null || text(x);
  const strings = (x: unknown): boolean => Array.isArray(x) && x.every(text);
  if (
    ![v.uid, v.path, v.type, v.title, v.lifecycle, v.sensitivity].every(text) ||
    ![v.project, v.workflow, v.staleAfter].every(nullable) ||
    ![v.tags, v.links, v.verifiedBy].every(strings) ||
    typeof v.trust !== "string" ||
    !["unverified", "declared", "verified"].includes(v.trust) ||
    v.sourceCommit !== source ||
    !matches(v.sourceHash, hashPattern) ||
    v.projectionSchemaVersion !== PROJECTION_VERSIONS.projectionSchemaVersion ||
    v.contentTrust !== "untrusted" ||
    !Array.isArray(v.relations)
  )
    unavailable();
  for (const relation of v.relations) {
    const [kind, target, uid] = ownDataFields(relation, [
      "kind",
      "target",
      "targetUid",
    ]);
    if (!text(kind) || !text(target) || !nullable(uid)) unavailable();
  }
  if (
    kind === "chunk" &&
    (v.ordinal !== ordinal ||
      !nullable(v.heading) ||
      !strings(v.headingPath) ||
      !text(v.text) ||
      Buffer.byteLength(v.text) > maxChunkBytes ||
      v.chunkerVersion !== PROJECTION_VERSIONS.chunkerVersion ||
      v.embeddingGeneration !== null)
  )
    unavailable();
  return JSON.stringify(value);
}

/** Allocate before dispatch; the future controller retains this attempt ID on uncertainty. */
export function createCandidateJobId(): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let value = BigInt(`0x${randomBytes(16).toString("hex")}`);
  let result = "";
  for (let n = 0; n < 26; n++) {
    result = alphabet[Number(value & 31n)] + result;
    value >>= 5n;
  }
  return `job_${result}`;
}

/**
 * Trusted, non-serving builder primitive. Legacy claims require complete projection;
 * v2 claims consume S5 input recipes, and only fully verified S5 output may attach.
 * Redis and codec parsing never authorize clients or canonical data.
 * No complete/activate operation exists in this slice.
 */
export class RedisCandidateStore {
  readonly #namespace: string;
  get namespace(): string {
    return this.#namespace;
  }
  readonly #vaultUid: string;
  /** Deployment registry check only; never an HTTP assertion or lookup. */
  isForVault(vaultUid: string): boolean {
    return this.#vaultUid === vaultUid;
  }
  readonly #execute: RedisExecutor;
  readonly #timeout: number;
  #epoch: number | undefined;

  constructor(
    options: Readonly<{
      vaultUid: string;
      namespaceKey: Uint8Array;
      execute: RedisExecutor;
      operationTimeoutMs?: number;
    }>,
  ) {
    input(
      object(options) &&
        Object.keys(options).every((key) =>
          [
            "vaultUid",
            "namespaceKey",
            "execute",
            "operationTimeoutMs",
          ].includes(key),
        ) &&
        matches(options.vaultUid, vaultPattern) &&
        options.namespaceKey instanceof Uint8Array &&
        options.namespaceKey.byteLength >= 32 &&
        options.namespaceKey.byteLength <= 64 &&
        typeof options.execute === "function" &&
        (options.operationTimeoutMs === undefined ||
          bounded(options.operationTimeoutMs, 2000, 1)),
    );
    this.#vaultUid = options.vaultUid;
    this.#namespace = `bk:v1:v:${createHmac("sha256", options.namespaceKey).update(options.vaultUid).digest("hex")}:`;
    this.#execute = options.execute;
    this.#timeout = options.operationTimeoutMs ?? 2000;
  }

  async #call(
    request: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs = this.#timeout,
  ): Promise<Record<string, unknown>> {
    input(signal === undefined || signal instanceof AbortSignal);
    if (signal?.aborted)
      throw new DOMException("Candidate operation cancelled.", "AbortError");
    const command = Object.freeze([
      "EVAL",
      candidateScript,
      "1",
      this.#namespace,
      JSON.stringify({ ...request, epoch: this.#epoch }),
    ]);
    const deadline = new AbortController();
    const composed =
      signal === undefined
        ? deadline.signal
        : AbortSignal.any([signal, deadline.signal]);
    const timer = setTimeout(
      () => deadline.abort(),
      Math.min(this.#timeout, timeoutMs),
    );
    let dispatched = false;
    const mutating = !readOperations.has(String(request.op));
    const native = ["storedPage", "storedInventory", "storedFinish"].includes(
      String(request.op),
    );
    let onAbort: () => void = () => {};
    try {
      const raw = await new Promise<unknown>((resolve, reject) => {
        onAbort = () =>
          reject(
            signal?.aborted
              ? new DOMException("Candidate operation cancelled.", "AbortError")
              : new CandidateStoreError("INDEX_UNAVAILABLE"),
          );
        composed.addEventListener("abort", onAbort, { once: true });
        void Promise.resolve()
          .then(() => {
            if (composed.aborted)
              throw new CandidateStoreError("INDEX_UNAVAILABLE");
            dispatched = true;
            return this.#execute(command, composed);
          })
          .then(resolve, reject);
      });
      if (composed.aborted) unavailable();
      const parts =
        native && Array.isArray(raw) ? payloadStrings(raw) : undefined;
      const metadata = parts === undefined ? raw : parts[0];
      if (typeof metadata !== "string" || Buffer.byteLength(metadata) > 4096)
        unavailable();
      const reply: unknown = JSON.parse(metadata);
      if (!object(reply)) unavailable();
      if (reply.ok === false) {
        if (
          ![
            "BUILD_CONFLICT",
            "FENCED",
            "INDEX_UNAVAILABLE",
            "NOT_FOUND",
          ].includes(String(reply.code))
        )
          unavailable();
        throw new CandidateStoreError(reply.code as CandidateErrorCode);
      }
      if (reply.ok !== true || (native && parts === undefined)) unavailable();
      return native ? { ...reply, records: parts!.slice(1) } : reply;
    } catch (error) {
      const outcome = dispatched && mutating ? ("unknown" as const) : undefined;
      if (signal?.aborted)
        throw Object.assign(
          new DOMException("Candidate operation cancelled.", "AbortError"),
          outcome === undefined ? {} : { outcome },
        );
      if (
        error instanceof CandidateStoreError &&
        error.code !== "INDEX_UNAVAILABLE"
      )
        throw error;
      throw new CandidateStoreError("INDEX_UNAVAILABLE", outcome);
    } finally {
      clearTimeout(timer);
      composed.removeEventListener("abort", onAbort);
    }
  }

  async startProcess(signal?: AbortSignal): Promise<number> {
    const reply = await this.#call({ op: "start" }, signal);
    if (!bounded(reply.epoch, 2147483647, 1)) unavailable("unknown");
    this.#epoch = reply.epoch;
    return reply.epoch;
  }

  /** Storage half of configuration publication; S7 owns the reload interlock.
   * Decimal strings preserve S5's entire positive-safe-integer epoch contract in Lua. */
  async setConfigurationEpoch(
    epoch: number,
    signal?: AbortSignal,
  ): Promise<void> {
    input(bounded(epoch, Number.MAX_SAFE_INTEGER, 1));
    await this.#call(
      { op: "configure", configurationEpoch: String(epoch) },
      signal,
    );
  }

  async claimInput(
    recipe: TrustedBuildRecipe,
    attemptId: string,
    signal?: AbortSignal,
  ): Promise<Readonly<{ created: boolean; lease: CandidateInputLease }>> {
    input(matches(attemptId, jobPattern));
    const spec = recipeMetadata(recipe, this.#vaultUid);
    const reply = await this.#call(
      { op: "claimInput", spec, jobId: attemptId },
      signal,
    );
    try {
      const owner = receivedLease(reply.lease);
      if (
        typeof reply.created !== "boolean" ||
        owner.buildId !== spec.buildId ||
        (reply.created && owner.jobId !== attemptId) ||
        String(owner.configurationEpoch) !== spec.configurationEpoch
      )
        unavailable();
      return Object.freeze({ created: reply.created, lease: owner });
    } catch {
      unavailable("unknown");
    }
  }

  async beginBuilding(
    owner: CandidateInputLease,
    signal?: AbortSignal,
  ): Promise<void> {
    input(inputLease(owner));
    await this.#call({ op: "begin", lease: wireLease(owner) }, signal);
  }

  /** Trusted primitive only: parsing a descriptor is not full-source authorization. */
  async attachOutput(
    owner: CandidateInputLease,
    output: EncodedOutputDescriptor,
    signal?: AbortSignal,
  ): Promise<void> {
    input(inputLease(owner));
    let serialized: string;
    try {
      const [raw, hash] = ownDataFields(output, ["serialized", "hash"]);
      const parsed = parseOutputDescriptor(raw as string);
      input(parsed.hash === hash);
      serialized = parsed.serialized;
    } catch {
      throw new TypeError("Candidate input is invalid.");
    }
    await this.#call(
      { op: "attach", lease: wireLease(owner), outputDescriptor: serialized },
      signal,
    );
  }

  /** Read-only actual storage observation. Caller owns renewal/capacity and supplies
   * remaining claim-relative time, not a new build lifetime. Never retries a read/write. */
  async verifyStoredOutput(
    owner: CandidateInputLease,
    recipe: TrustedBuildRecipe,
    expectedDescriptor: EncodedOutputDescriptor,
    options: Readonly<{ timeoutMs: number; signal?: AbortSignal }>,
  ): Promise<StoredOutputMeasurement> {
    let held: CandidateInputLease;
    let spec: Record<string, unknown>;
    let descriptor: EncodedOutputDescriptor;
    let tuple: unknown[];
    let maxChunkBytes: number;
    let timeoutMs: number;
    let signal: AbortSignal | undefined;
    try {
      input(inputLease(owner));
      held = Object.freeze({ ...owner });
      spec = recipeMetadata(recipe, this.#vaultUid);
      const [serialized] = ownDataFields(recipe, [
        "serialized",
        "scopeHash",
        "policyHash",
        "recipeHash",
        "buildId",
        "sourceCommit",
        "configurationEpoch",
      ]);
      const r = JSON.parse(serialized as string) as unknown[];
      input(
        r[9] === CANONICAL_EXPORT_VERSION &&
          r[10] === PROJECTION_VERSIONS.projectionSchemaVersion &&
          r[11] === PROJECTION_VERSIONS.parserVersion &&
          r[12] === PROJECTION_VERSIONS.chunkerVersion &&
          r[13] === PROJECTION_VERSIONS.preprocessingVersion,
      );
      maxChunkBytes = r[14] as number;
      const [raw, hash] = ownDataFields(expectedDescriptor, [
        "serialized",
        "hash",
      ]);
      descriptor = parseOutputDescriptor(raw as string);
      input(descriptor.hash === hash);
      tuple = JSON.parse(descriptor.serialized) as unknown[];
      input(
        tuple[2] === spec.recipeHash &&
          held.buildId === spec.buildId &&
          String(held.configurationEpoch) === spec.configurationEpoch,
      );
      input(object(options) && !types.isProxy(options));
      const values = ownDataFields(options, [
        "timeoutMs",
        ...(Object.hasOwn(options, "signal") ? ["signal"] : []),
      ]);
      input(bounded(values[0], 21_600_000, 1));
      timeoutMs = values[0];
      input(values[1] === undefined || values[1] instanceof AbortSignal);
      signal = values[1] as AbortSignal | undefined;
    } catch {
      throw new TypeError("Candidate input is invalid.");
    }
    const until = performance.now() + timeoutMs;
    const remaining = (): number => {
      if (signal?.aborted)
        throw new DOMException("Candidate operation cancelled.", "AbortError");
      const ms = Math.floor(until - performance.now());
      if (ms < 1) unavailable();
      return ms;
    };
    const request = {
      lease: wireLease(held),
      spec,
      outputDescriptor: descriptor.serialized,
    };
    const call = async (
      op: string,
      extra: Record<string, unknown> = {},
    ): Promise<Record<string, unknown>> => {
      const reply = await this.#call(
        { ...request, op, ...extra },
        signal,
        remaining(),
      );
      remaining();
      return reply;
    };
    try {
      const measured: { count: number; hash: string }[] = [];
      for (const [kind, total] of [
        ["concept", tuple[6]],
        ["chunk", tuple[8]],
      ] as const) {
        const count = total as number;
        const hash = createHash("sha256");
        let offset = 0;
        while (offset < count) {
          const page = await call("storedPage", { kind, offset });
          ownDataFields(page, [
            "ok",
            "kind",
            "offset",
            "next",
            "rawBytes",
            "records",
          ]);
          const rows = page.records as string[];
          if (
            page.kind !== kind ||
            page.offset !== offset ||
            !Array.isArray(rows) ||
            rows.length < 1 ||
            rows.length > PAGE_COUNT ||
            page.next !== offset + rows.length ||
            (page.next as number) > count ||
            page.rawBytes !==
              rows.reduce((n, raw) => n + Buffer.byteLength(raw), 0)
          )
            unavailable();
          let bytes = 0;
          for (const [i, raw] of rows.entries()) {
            remaining();
            const encoded = storedRecord(
              raw,
              kind,
              offset + i,
              spec.sourceCommit as string,
              maxChunkBytes,
            );
            bytes += Buffer.byteLength(encoded);
            if (bytes > ENCODED_BYTES) unavailable();
            hash.update(encoded, "utf8").update("\n", "utf8");
          }
          offset += rows.length;
        }
        measured.push({ count: offset, hash: `sha256:${hash.digest("hex")}` });
      }
      if (measured[0]!.hash !== tuple[7] || measured[1]!.hash !== tuple[9])
        unavailable();
      // A compact ordinal bitset, not a generation/payload buffer. SCAN can
      // duplicate entries: reject rather than counting them as new evidence.
      const concepts = tuple[6] as number,
        chunks = tuple[8] as number;
      const seen = new Uint8Array(Math.ceil((concepts + chunks + 1) / 8));
      let cursor = "0",
        observed = 0;
      const cursors = new Set<string>();
      for (let iteration = 0; ; iteration++) {
        if (iteration === INVENTORY_CALLS || cursors.has(cursor)) unavailable();
        cursors.add(cursor);
        const page = await call("storedInventory", { cursor });
        ownDataFields(page, ["ok", "cursor", "next", "records"]);
        if (
          page.cursor !== cursor ||
          !matches(page.next, /^(?:0|[1-9][0-9]{0,19})(?![\s\S])/u) ||
          (page.next.length === 20 && page.next > "18446744073709551615")
        )
          unavailable();
        const records = page.records as string[];
        for (const token of records) {
          let ordinal: number;
          if (token === "manifest") ordinal = concepts + chunks;
          else {
            const match =
              /^(concept|chunk):(0|[1-9][0-9]{0,5})(?![\s\S])/u.exec(token);
            if (!match) unavailable();
            const index = Number(match[2]);
            if (index >= (match[1] === "concept" ? concepts : chunks))
              unavailable();
            ordinal = index + (match[1] === "concept" ? 0 : concepts);
          }
          const byte = ordinal >> 3,
            bit = 1 << (ordinal & 7);
          if (seen[byte]! & bit) unavailable();
          seen[byte] = seen[byte]! | bit;
          observed++;
        }
        cursor = page.next;
        if (cursor === "0") break;
      }
      if (observed !== concepts + chunks + 1) unavailable();
      const final = await call("storedFinish");
      ownDataFields(final, ["ok", "records"]);
      if ((final.records as string[]).length !== 0) unavailable();
      remaining();
      return Object.freeze({
        lease: held,
        sourceCommit: spec.sourceCommit as string,
        descriptorHash: descriptor.hash,
        concepts: Object.freeze(measured[0]!),
        chunks: Object.freeze(measured[1]!),
      });
    } catch (error) {
      if (signal?.aborted)
        throw new DOMException("Candidate operation cancelled.", "AbortError");
      if (error instanceof CandidateStoreError) throw error;
      unavailable();
    }
  }

  /** Null means a cleaned terminal candidate, never a malformed present descriptor. */
  async readCandidate(
    id: string,
    signal?: AbortSignal,
  ): Promise<CandidateInputManifest | null> {
    input(matches(id, jobPattern));
    return candidate(
      (await this.#call({ op: "readCandidate", jobId: id }, signal)).manifest,
    );
  }

  /** Startup/status evidence only, always inside this configured namespace. */
  async readCurrentJob(signal?: AbortSignal): Promise<CandidateJob | null> {
    const reply = await this.#call({ op: "current" }, signal);
    return reply.job === null ? null : job(reply.job);
  }

  /** One atomic, read-only observation under this process owner epoch. NOT_FOUND
   * cannot prove that an earlier dispatched mutation will never commit. */
  async inspectInput(
    id: string,
    signal?: AbortSignal,
  ): Promise<CandidateInspection> {
    input(matches(id, jobPattern));
    const reply = await this.#call({ op: "inspect", jobId: id }, signal);
    const observed = job(reply.job);
    const manifest = candidate(reply.manifest);
    if (
      observed.jobId !== id ||
      typeof reply.live !== "boolean" ||
      (manifest === null
        ? reply.live || !["failed", "cancelled"].includes(observed.state)
        : manifest.lease.jobId !== id ||
          manifest.lease.buildId !== observed.buildId ||
          manifest.sourceCommit !== observed.sourceCommit ||
          manifest.state !== observed.state)
    )
      unavailable();
    return Object.freeze({ job: observed, manifest, live: reply.live });
  }

  async claim(
    spec: CandidateSpec,
    signal?: AbortSignal,
  ): Promise<Readonly<{ created: boolean; lease: CandidateLease }>> {
    input(
      object(spec) &&
        Object.keys(spec).length === 7 &&
        spec.vaultUid === this.#vaultUid &&
        matches(spec.buildId, buildPattern) &&
        matches(spec.sourceCommit, commitPattern) &&
        matches(spec.manifestHash, hashPattern) &&
        matches(spec.policyHash, hashPattern) &&
        bounded(spec.concepts, 50000) &&
        bounded(spec.chunks, 250000),
    );
    // Do not persist canonical vault identity; the HMAC namespace already binds it.
    const { vaultUid: _vaultUid, ...metadata } = spec;
    const expectedBuildId = metadata.buildId;
    void _vaultUid;
    const reply = await this.#call(
      { op: "claim", spec: metadata, jobId: createCandidateJobId() },
      signal,
    );
    if (
      typeof reply.created !== "boolean" ||
      !lease(reply.lease) ||
      inputLease(reply.lease) ||
      reply.lease.buildId !== expectedBuildId
    )
      unavailable("unknown");
    return Object.freeze({
      created: reply.created,
      lease: Object.freeze(reply.lease),
    });
  }

  async append(
    owner: CandidateLease,
    kind: "concept" | "chunk",
    offset: number,
    records: readonly (ConceptProjection | ChunkProjection)[],
    signal?: AbortSignal,
  ): Promise<number> {
    input(
      lease(owner) &&
        (kind === "concept" || kind === "chunk") &&
        bounded(offset, 250000) &&
        Array.isArray(records) &&
        records.length > 0 &&
        records.length <= 128,
    );
    let serialized: string[];
    try {
      serialized = records.map((record) => {
        input(
          object(record) &&
            matches(record.sourceCommit, commitPattern) &&
            matches(record.sourceHash, hashPattern) &&
            record.projectionSchemaVersion === "1" &&
            record.contentTrust === "untrusted",
        );
        return JSON.stringify(record);
      });
    } catch {
      throw new TypeError("Candidate input is invalid.");
    }
    input(
      serialized.reduce((size, value) => size + Buffer.byteLength(value), 0) <=
        1048576,
    );
    const expectedNext = offset + serialized.length;
    const reply = await this.#call(
      {
        op: "append",
        lease: wireLease(owner),
        kind,
        offset,
        records: serialized,
      },
      signal,
    );
    if (reply.next !== expectedNext) unavailable("unknown");
    return reply.next as number;
  }

  async renew(owner: CandidateLease, signal?: AbortSignal): Promise<void> {
    input(lease(owner));
    await this.#call({ op: "renew", lease: wireLease(owner) }, signal);
  }
  async readJob(id: string, signal?: AbortSignal): Promise<CandidateJob> {
    input(matches(id, jobPattern));
    return job(
      (await this.#call({ op: "read", jobId: id }, signal)).job,
      undefined,
      { jobId: id },
    );
  }
  async requestCancel(id: string, signal?: AbortSignal): Promise<CandidateJob> {
    input(matches(id, jobPattern));
    const result = job(
      (await this.#call({ op: "cancel", jobId: id }, signal)).job,
      "unknown",
      { jobId: id },
    );
    if (result.state !== "cancelling" && result.state !== "cancelled")
      unavailable("unknown");
    return result;
  }
  async acknowledgeCancel(
    owner: CandidateLease,
    signal?: AbortSignal,
  ): Promise<CandidateJob> {
    input(lease(owner));
    const result = job(
      (await this.#call({ op: "ackCancel", lease: wireLease(owner) }, signal))
        .job,
      "unknown",
      owner,
    );
    if (result.state !== "cancelled") unavailable("unknown");
    return result;
  }
  async fail(
    owner: CandidateLease,
    failureCode: CandidateFailureCode,
    signal?: AbortSignal,
  ): Promise<CandidateJob> {
    input(lease(owner) && failureCodes.has(failureCode));
    const result = job(
      (
        await this.#call(
          { op: "fail", lease: wireLease(owner), failureCode },
          signal,
        )
      ).job,
      "unknown",
      owner,
    );
    if (result.state !== "failed" || result.failureCode !== failureCode)
      unavailable("unknown");
    return result;
  }
  async cleanup(
    id: string,
    signal?: AbortSignal,
  ): Promise<Readonly<{ done: boolean; removed: number }>> {
    input(matches(id, jobPattern));
    const reply = await this.#call({ op: "cleanup", jobId: id }, signal);
    if (typeof reply.done !== "boolean" || !bounded(reply.removed, 128))
      unavailable("unknown");
    return { done: reply.done, removed: reply.removed };
  }
}
