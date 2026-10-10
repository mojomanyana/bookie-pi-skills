import { createHmac, randomBytes } from "node:crypto";

import type { ChunkProjection, ConceptProjection } from "./projection.js";
import { candidateScript } from "./redis-candidate-script.js";

export type CandidateErrorCode =
  "BUILD_CONFLICT" | "FENCED" | "INDEX_UNAVAILABLE" | "NOT_FOUND";
export class CandidateStoreError extends Error {
  constructor(readonly code: CandidateErrorCode) {
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
function unavailable(): never {
  throw new CandidateStoreError("INDEX_UNAVAILABLE");
}
function lease(value: unknown): value is CandidateLease {
  return (
    object(value) &&
    Object.keys(value).length === 4 &&
    matches(value.jobId, jobPattern) &&
    matches(value.buildId, buildPattern) &&
    bounded(value.ownerEpoch, 2147483647, 1) &&
    bounded(value.fence, 2147483647, 1)
  );
}
function job(value: unknown): CandidateJob {
  if (
    !object(value) ||
    Object.keys(value).length !== 5 ||
    !matches(value.jobId, jobPattern) ||
    !matches(value.buildId, buildPattern) ||
    !matches(value.sourceCommit, commitPattern) ||
    typeof value.state !== "string" ||
    !states.has(value.state)
  )
    unavailable();
  if (
    value.state === "failed"
      ? !failureCodes.has(String(value.failureCode))
      : value.state === "cancelled"
        ? value.failureCode !== "CANCELLED"
        : value.failureCode !== null
  )
    unavailable();
  return Object.freeze(value) as unknown as CandidateJob;
}
function jobId(): string {
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
 * Trusted, non-serving builder primitive. Call only after Git approval, validation,
 * and projection policy checks. Redis never authorizes clients or canonical data.
 * No complete/activate operation exists in this slice.
 */
export class RedisCandidateStore {
  readonly #namespace: string;
  get namespace(): string {
    return this.#namespace;
  }
  readonly #vaultUid: string;
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
      if (signal?.aborted)
        throw new DOMException("Candidate operation cancelled.", "AbortError");
      if (error instanceof CandidateStoreError) throw error;
      unavailable();
    } finally {
      clearTimeout(timer);
      composed.removeEventListener("abort", onAbort);
    }
  }

  async startProcess(signal?: AbortSignal): Promise<number> {
    const reply = await this.#call({ op: "start" }, signal);
    if (!bounded(reply.epoch, 2147483647, 1)) unavailable();
    this.#epoch = reply.epoch;
    return reply.epoch;
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
      { op: "claim", spec: metadata, jobId: jobId() },
      signal,
    );
    if (
      typeof reply.created !== "boolean" ||
      !lease(reply.lease) ||
      reply.lease.buildId !== expectedBuildId
    )
      unavailable();
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
      { op: "append", lease: owner, kind, offset, records: serialized },
      signal,
    );
    if (reply.next !== expectedNext) unavailable();
    return reply.next as number;
  }

  async renew(owner: CandidateLease, signal?: AbortSignal): Promise<void> {
    input(lease(owner));
    await this.#call({ op: "renew", lease: owner }, signal);
  }
  async readJob(id: string, signal?: AbortSignal): Promise<CandidateJob> {
    input(matches(id, jobPattern));
    return job((await this.#call({ op: "read", jobId: id }, signal)).job);
  }
  async requestCancel(id: string, signal?: AbortSignal): Promise<CandidateJob> {
    input(matches(id, jobPattern));
    return job((await this.#call({ op: "cancel", jobId: id }, signal)).job);
  }
  async acknowledgeCancel(
    owner: CandidateLease,
    signal?: AbortSignal,
  ): Promise<CandidateJob> {
    input(lease(owner));
    return job(
      (await this.#call({ op: "ackCancel", lease: owner }, signal)).job,
    );
  }
  async fail(
    owner: CandidateLease,
    failureCode: CandidateFailureCode,
    signal?: AbortSignal,
  ): Promise<CandidateJob> {
    input(lease(owner) && failureCodes.has(failureCode));
    return job(
      (await this.#call({ op: "fail", lease: owner, failureCode }, signal)).job,
    );
  }
  async cleanup(
    id: string,
    signal?: AbortSignal,
  ): Promise<Readonly<{ done: boolean; removed: number }>> {
    input(matches(id, jobPattern));
    const reply = await this.#call({ op: "cleanup", jobId: id }, signal);
    if (typeof reply.done !== "boolean" || !bounded(reply.removed, 128))
      unavailable();
    return { done: reply.done, removed: reply.removed };
  }
}
