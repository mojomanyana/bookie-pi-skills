import { createHash, createHmac, randomBytes } from "node:crypto";

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
    const timer = setTimeout(() => deadline.abort(), this.#timeout);
    let dispatched = false;
    const mutating = !["read", "readCandidate", "current", "inspect"].includes(
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
      if (typeof raw !== "string" || Buffer.byteLength(raw) > 4096)
        unavailable();
      const reply: unknown = JSON.parse(raw);
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
      if (reply.ok !== true) unavailable();
      return reply;
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
