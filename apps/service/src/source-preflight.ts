import { posix } from "node:path";
import type { ApprovedSourceManifestResult } from "@bookie/core";
import {
  compileSourceDeployments,
  type SourceDeployment,
} from "./deployment-config.js";
import {
  runIngestionProcess,
  type IsolationFailure,
} from "./ingestion-isolation.js";

export type SourcePreflightResult =
  | ApprovedSourceManifestResult
  | IsolationFailure
  | Readonly<{
      ok: false;
      reason: "deployment-rejected" | "sensitivity-policy";
    }>;

const commitPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})(?![\s\S])/u;
const failed = { ok: false, reason: "ingestion-error" } as const;
const failureReasons = new Set([
  "source-not-approved",
  "manifest-unavailable",
  "deployment-rejected",
  "sensitivity-policy",
  "ingestion-error",
]);
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function reply(
  value: unknown,
  config: SourceDeployment,
  sourceRef: string,
): SourcePreflightResult {
  if (!object(value)) return failed;
  if (
    value.ok === false &&
    Object.keys(value).length === 2 &&
    typeof value.reason === "string" &&
    failureReasons.has(value.reason)
  )
    return { ok: false, reason: value.reason } as SourcePreflightResult;
  // Private IPC, not a new public metadata ingestion interface. Reconstruct only
  // known fields, bind them to the snapshot, and restore freezing lost over IPC.
  if (
    value.ok !== true ||
    Object.keys(value).length !== 6 ||
    value.sourceCommit !== sourceRef ||
    typeof value.approvedTip !== "string" ||
    !commitPattern.test(value.approvedTip) ||
    value.approvedTip.length !== sourceRef.length ||
    value.objectFormat !== (sourceRef.length === 40 ? "sha1" : "sha256") ||
    value.vaultScope !== posix.relative(config.repositoryRoot, config.root) ||
    !object(value.manifest)
  )
    return failed;
  const manifest = value.manifest;
  if (
    Object.keys(manifest).length !== 4 ||
    manifest.vaultUid !== config.projection.vaultUid ||
    manifest.profile !== "1.0" ||
    typeof manifest.hash !== "string" ||
    !/^sha256:[a-f0-9]{64}(?![\s\S])/u.test(manifest.hash) ||
    !Array.isArray(manifest.sensitivityClasses) ||
    manifest.sensitivityClasses.length === 0 ||
    manifest.sensitivityClasses.length > 65_536
  )
    return failed;
  const classes: string[] = [];
  let bytes = 0;
  for (const label of manifest.sensitivityClasses as unknown[]) {
    if (
      typeof label !== "string" ||
      label.length > 63 ||
      !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?![\s\S])/u.test(label) ||
      label === "unknown" ||
      label === "unclassified"
    )
      return failed;
    bytes += label.length;
    if (bytes > 65_536) return failed;
    classes.push(label);
  }
  if (new Set(classes).size !== classes.length) return failed;
  if (
    config.projection.approvedSensitivityClasses.some(
      (label) => !classes.includes(label),
    )
  )
    return { ok: false, reason: "sensitivity-policy" };
  return Object.freeze({
    ok: true,
    sourceCommit: sourceRef,
    approvedTip: value.approvedTip,
    objectFormat: sourceRef.length === 40 ? "sha1" : "sha256",
    vaultScope: posix.relative(config.repositoryRoot, config.root),
    manifest: Object.freeze({
      vaultUid: config.projection.vaultUid,
      profile: "1.0",
      hash: manifest.hash as `sha256:${string}`,
      sensitivityClasses: Object.freeze(classes),
    }),
  });
}

/**
 * Internal pre-claim metadata only. The future controller owns authorization,
 * the single preflight permit, remaining submission budget, and quarantine on
 * uncertain teardown. This does not create a job, validate a corpus, or grant
 * provider/activation permission. Deployment's timeout remains the builder limit.
 */
export async function preflightDeploymentSource(
  deployment: SourceDeployment,
  request: Readonly<{
    sourceRef: string;
    timeoutMs: number;
    signal?: AbortSignal;
  }>,
): Promise<SourcePreflightResult> {
  const config = compileSourceDeployments([deployment])[0]!;
  if (
    !object(request) ||
    Object.keys(request).some(
      (key) => !["sourceRef", "timeoutMs", "signal"].includes(key),
    ) ||
    typeof request.sourceRef !== "string" ||
    !Number.isSafeInteger(request.timeoutMs) ||
    request.timeoutMs < 1 ||
    request.timeoutMs > 7000 ||
    (request.signal !== undefined && !(request.signal instanceof AbortSignal))
  )
    throw new TypeError("Source preflight request is invalid.");
  const { sourceRef, timeoutMs, signal } = request;
  if (signal?.aborted)
    throw new DOMException("Ingestion cancelled.", "AbortError");
  if (!commitPattern.test(sourceRef))
    return { ok: false, reason: "source-not-approved" };
  return await runIngestionProcess(
    {
      mode: "preflight",
      root: config.root,
      repositoryRoot: config.repositoryRoot,
      sourceRef,
      approvedRef: config.approvedRef,
      rollbackWindow: config.rollbackWindow,
      config: config.projection,
    },
    {
      timeoutMs,
      ...(signal === undefined ? {} : { signal }),
      decode: (value) => reply(value, config, sourceRef),
    },
  );
}
