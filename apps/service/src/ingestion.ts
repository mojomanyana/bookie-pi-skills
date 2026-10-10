import { fileURLToPath } from "node:url";
import { runIngestionProcess } from "./ingestion-isolation.js";
export { preflightDeploymentSource } from "./source-preflight.js";
export type { SourcePreflightResult } from "./source-preflight.js";
import {
  compileSourceDeployments,
  type SourceDeployment,
} from "./deployment-config.js";
import {
  snapshotProjectionConfig,
  type LexicalProjection,
  type PrepareProjectionResult,
  type ProjectionConfig,
} from "./projection.js";

export interface ApprovedIngestionRequest {
  readonly sourceRef: string;
  /** Deployment-owned full local ref; never take this from an HTTP body. */
  readonly approvedRef: string;
  readonly rollbackWindow: number;
  readonly config: ProjectionConfig;
  /** Required outer bound for the entire ingestion, at most six hours. */
  readonly timeoutMs: number;
  /** Builder cancellation/shutdown, not a submission connection's disconnect. */
  readonly signal?: AbortSignal;
}
export type ApprovedIngestionResult =
  | Readonly<{ ok: true; approvedTip: string; projection: LexicalProjection }>
  | Exclude<PrepareProjectionResult, { ok: true }>
  | Readonly<{
      ok: false;
      reason:
        | "source-not-approved"
        | "deadline-exceeded"
        | "ingestion-error"
        | "deployment-rejected";
    }>;

const failed = { ok: false, reason: "ingestion-error" } as const;
const commitPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})(?![\s\S])/u;
const failureReasons = new Set([
  "deployment-rejected",
  "source-not-approved",
  "invalid-source",
  "invalid-vault",
  "sensitivity-policy",
  "secret-policy",
  "incomplete",
  "output-error",
  "projection-error",
  "ingestion-error",
]);
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function reply(value: unknown, sourceRef: string): ApprovedIngestionResult {
  if (!object(value)) return failed;
  if (
    value.ok === false &&
    Object.keys(value).length === 2 &&
    typeof value.reason === "string" &&
    failureReasons.has(value.reason)
  ) {
    return { ok: false, reason: value.reason } as ApprovedIngestionResult;
  }
  // IPC is private to our trusted child program, not a public ingestion interface.
  if (
    value.ok === true &&
    Object.keys(value).length === 3 &&
    typeof value.approvedTip === "string" &&
    commitPattern.test(value.approvedTip) &&
    object(value.projection) &&
    value.projection.sourceCommit === sourceRef &&
    Array.isArray(value.projection.concepts) &&
    value.projection.concepts.length <= 50_000 &&
    Array.isArray(value.projection.chunks) &&
    value.projection.chunks.length <= 250_000
  ) {
    return value as unknown as ApprovedIngestionResult;
  }
  return failed;
}

/**
 * Non-serving POSIX process boundary: approves history, validates the exact vault
 * and policy, then projects. No Redis, client authorization, read-only mount proof,
 * evaluation or activation. Windows fails closed; portable core reads still work.
 */
export async function prepareApprovedLexicalProjection(
  root: string | URL,
  request: ApprovedIngestionRequest,
): Promise<ApprovedIngestionResult> {
  return await runIngestion(root, request);
}

/** Deployment-owned config only; a future controller must resolve the authorized handle first. */
export async function prepareDeploymentLexicalProjection(
  deployment: SourceDeployment,
  request: Readonly<{ sourceRef: string; signal?: AbortSignal }>,
): Promise<ApprovedIngestionResult> {
  const config = compileSourceDeployments([deployment])[0]!;
  if (
    !object(request) ||
    Object.keys(request).some(
      (key) => !["sourceRef", "signal"].includes(key),
    ) ||
    typeof request.sourceRef !== "string" ||
    (request.signal !== undefined && !(request.signal instanceof AbortSignal))
  )
    throw new TypeError("Deployment request is invalid.");
  return await runIngestion(
    config.root,
    {
      sourceRef: request.sourceRef,
      approvedRef: config.approvedRef,
      rollbackWindow: config.rollbackWindow,
      config: config.projection,
      timeoutMs: config.timeoutMs,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    },
    config.repositoryRoot,
  );
}

async function runIngestion(
  root: string | URL,
  request: ApprovedIngestionRequest,
  repositoryRoot?: string,
): Promise<ApprovedIngestionResult> {
  if (
    (typeof root !== "string" && !(root instanceof URL)) ||
    !object(request) ||
    Object.keys(request).some(
      (key) =>
        ![
          "sourceRef",
          "approvedRef",
          "rollbackWindow",
          "config",
          "timeoutMs",
          "signal",
        ].includes(key),
    ) ||
    typeof request.sourceRef !== "string" ||
    typeof request.approvedRef !== "string" ||
    !Number.isSafeInteger(request.rollbackWindow) ||
    request.rollbackWindow < 0 ||
    request.rollbackWindow > 1024 ||
    !Number.isSafeInteger(request.timeoutMs) ||
    request.timeoutMs < 1 ||
    request.timeoutMs > 21_600_000 ||
    (request.signal !== undefined && !(request.signal instanceof AbortSignal))
  )
    throw new TypeError("Ingestion request is invalid.");
  const config = snapshotProjectionConfig(request.config);
  const { sourceRef, approvedRef, rollbackWindow, timeoutMs, signal } = request;
  if (signal?.aborted)
    throw new DOMException("Ingestion cancelled.", "AbortError");
  if (!commitPattern.test(sourceRef))
    return { ok: false, reason: "source-not-approved" };
  if (process.platform === "win32") return failed;
  let path: string;
  try {
    path = root instanceof URL ? fileURLToPath(root) : root;
  } catch {
    throw new TypeError("Ingestion request is invalid.");
  }
  return await runIngestionProcess(
    {
      root: path,
      sourceRef,
      approvedRef,
      rollbackWindow,
      config,
      ...(repositoryRoot === undefined ? {} : { repositoryRoot }),
    },
    {
      timeoutMs,
      ...(signal === undefined ? {} : { signal }),
      decode: (value) => reply(value, sourceRef),
    },
  );
}
