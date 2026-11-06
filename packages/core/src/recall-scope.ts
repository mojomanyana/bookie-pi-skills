import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readVaultManifest, getSchemaValidators } from "./vault-manifest.js";
import {
  createPathTracker,
  readSafeBoundedFile,
  verifyTrackedPaths,
} from "./vault-filesystem.js";
import { validationLimits } from "./vault-limits.js";
import { DiagnosticCollector } from "./vault-diagnostics.js";
import {
  computeConceptSourceHash,
  isObject,
} from "./concept-mutation-model.js";
import { inspectConcept } from "./filesystem-query.js";
import { containsDetectedSecret } from "./vault-secret-detection.js";
import { throwIfAborted } from "./vault-cancellation.js";
import type { Manifest } from "./vault-model.js";
import type {
  ConceptRevision,
  RecallReadOptions,
  RecallResult,
  RecallScope,
} from "./recall-model.js";

export const RECALL_SCAN_LIMITS = Object.freeze({
  maxEntries: 10_000,
  maxConcepts: 2_000,
  maxTotalConceptBytes: 16_777_216,
  maxTotalResourceBytes: 33_554_432,
  maxOutputBytes: 33_554_432,
});

export const recallFailure = (
  reason: import("./recall-model.js").RecallFailureReason,
) => ({ ok: false as const, reason });
export function validHash(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
}
export function safeText(value: unknown, maximum = 4096): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value) <= maximum &&
    !Array.from(value).some((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point <= 31 || (point >= 127 && point <= 159);
    }) &&
    !containsDetectedSecret(value)
  );
}
export function validRevision(value: unknown): value is ConceptRevision {
  return (
    isObject(value) &&
    safeText(value.path) &&
    value.path.startsWith("/") &&
    validHash(value.sourceHash)
  );
}
export async function readRecallManifest(
  rootPath: string | URL,
  options: RecallReadOptions = {},
): Promise<
  RecallResult<{
    root: string;
    manifest: Manifest;
    manifestRevision: `sha256:${string}`;
  }>
> {
  const { signal } = options;
  throwIfAborted(signal);
  try {
    const root = await realpath(
      resolve(rootPath instanceof URL ? fileURLToPath(rootPath) : rootPath),
    );
    if (containsDetectedSecret(root)) return recallFailure("vault");
    const tracker = createPathTracker();
    const limits = validationLimits(RECALL_SCAN_LIMITS);
    const collector = new DiagnosticCollector(limits.maxDiagnostics);
    const loaded = await readVaultManifest(
      root,
      limits,
      await getSchemaValidators(),
      collector,
      signal,
      tracker,
    );
    if (!loaded.manifest) return recallFailure("vault");
    const bytes = await readSafeBoundedFile(
      root,
      "bookie.yaml",
      limits.maxManifestBytes,
      signal,
      tracker,
    );
    if (!bytes.ok || !(await verifyTrackedPaths(tracker, signal)))
      return recallFailure("vault");
    return {
      ok: true,
      root,
      manifest: loaded.manifest,
      manifestRevision: computeConceptSourceHash(bytes.bytes),
    };
  } catch {
    throwIfAborted(signal);
    return recallFailure("vault");
  }
}
export async function inspectRecallScope(
  rootPath: string | URL,
  project: ConceptRevision,
  options: RecallReadOptions = {},
): Promise<RecallResult<{ scope: RecallScope }>> {
  if (!validRevision(project)) return recallFailure("input");
  const loaded = await readRecallManifest(rootPath, options);
  if (!loaded.ok) return loaded;
  const inspected = await inspectConcept(
    loaded.root,
    { path: project.path },
    { ...RECALL_SCAN_LIMITS, maxContentBytes: 1, ...options },
  );
  if (
    !inspected.ok ||
    inspected.type !== "Project" ||
    inspected.handling === "excluded" ||
    inspected.source.sourceHash !== project.sourceHash ||
    inspected.sensitivity.classification !== "declared"
  )
    return recallFailure("scope");
  const checked = await readRecallManifest(loaded.root, options);
  if (!checked.ok || checked.manifestRevision !== loaded.manifestRevision)
    return recallFailure("scope");
  return {
    ok: true,
    scope: {
      root: loaded.root,
      vaultUid: loaded.manifest.vault.uid,
      project: {
        path: inspected.source.path,
        uid: inspected.uid,
        sourceHash: inspected.source.sourceHash,
      },
      manifestRevision: loaded.manifestRevision,
      sensitivityClasses: [...loaded.manifest.policy.sensitivity.classes],
      excludedClasses: [...loaded.manifest.policy.sensitivity.excluded_classes],
    },
  };
}
