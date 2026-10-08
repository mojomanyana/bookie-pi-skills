import { posix } from "node:path";
import { types } from "node:util";
import type { SourcePreflightResult } from "./source-preflight.js";
import {
  compileSourceDeployments,
  type SourceDeployment,
} from "./deployment-config.js";
import {
  encodeBuildInputRecipe,
  type EncodedBuildRecipe,
} from "./build-recipe.js";
import {
  CANONICAL_EXPORT_VERSION,
  PROJECTION_VERSIONS,
  SECRET_DETECTION_VERSION,
} from "./build-input-versions.js";
import { hashRuntimeArtifact } from "./runtime-artifact.js";

function invalid(): never {
  throw new TypeError("Build recipe assembly is invalid.");
}
function fields(value: unknown, keys: readonly string[]): readonly unknown[] {
  if (
    value === null ||
    typeof value !== "object" ||
    types.isProxy(value) ||
    Array.isArray(value)
  )
    invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== keys.length) invalid();
  return keys.map((key) => {
    const field = descriptors[key];
    if (
      !Object.hasOwn(descriptors, key) ||
      field === undefined ||
      !Object.hasOwn(field, "value")
    )
      invalid();
    return field.value as unknown;
  });
}
const commit = /^(?:[a-f0-9]{40}|[a-f0-9]{64})(?![\s\S])/u;
const digest = /^sha256:[a-f0-9]{64}(?![\s\S])/u;
const label = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?![\s\S])/u;

/**
 * Disconnected input assembly. Caller must first authorize the vault and obtain
 * the receipt from isolated deployment-checked preflight, not arbitrary core
 * reads. The stage must be immutable/trusted by the deployment owner; measuring
 * its bytes here does not attest clean-install provenance or mount policy.
 * This function must not run in the ten-second HTTP admission path.
 */
export async function assembleMeasuredInputRecipe(
  deployment: SourceDeployment,
  source: SourcePreflightResult,
  runtimeRoot: string,
): Promise<EncodedBuildRecipe> {
  try {
    if (arguments.length !== 3) invalid();
    const config = compileSourceDeployments([deployment])[0]!;
    const [ok, sourceCommit, approvedTip, objectFormat, vaultScope, manifest] =
      fields(source, [
        "ok",
        "sourceCommit",
        "approvedTip",
        "objectFormat",
        "vaultScope",
        "manifest",
      ]);
    const [vaultUid, profile, manifestHash, sensitivityClasses] = fields(
      manifest,
      ["vaultUid", "profile", "hash", "sensitivityClasses"],
    );
    if (
      ok !== true ||
      typeof sourceCommit !== "string" ||
      !commit.test(sourceCommit) ||
      typeof approvedTip !== "string" ||
      !commit.test(approvedTip) ||
      approvedTip.length !== sourceCommit.length ||
      objectFormat !== (sourceCommit.length === 40 ? "sha1" : "sha256") ||
      vaultScope !== posix.relative(config.repositoryRoot, config.root) ||
      vaultUid !== config.projection.vaultUid ||
      profile !== "1.0" ||
      typeof manifestHash !== "string" ||
      !digest.test(manifestHash) ||
      types.isProxy(sensitivityClasses) ||
      !Array.isArray(sensitivityClasses) ||
      sensitivityClasses.length === 0 ||
      sensitivityClasses.length > 65_536
    )
      invalid();
    const items = Object.getOwnPropertyDescriptors(sensitivityClasses);
    if (Reflect.ownKeys(items).length !== sensitivityClasses.length + 1)
      invalid();
    const declared: string[] = [];
    let bytes = 0;
    for (let i = 0; i < sensitivityClasses.length; i++) {
      const item = items[String(i)];
      if (
        item === undefined ||
        !Object.hasOwn(item, "value") ||
        typeof item.value !== "string" ||
        !label.test(item.value) ||
        item.value.length > 63 ||
        ["unknown", "unclassified"].includes(item.value)
      )
        invalid();
      bytes += item.value.length;
      if (bytes > 65_536) invalid();
      declared.push(item.value);
    }
    if (
      new Set(declared).size !== declared.length ||
      config.projection.approvedSensitivityClasses.some(
        (value) => !declared.includes(value),
      )
    )
      invalid();
    // Only a measured value is passed to the codec; no supplied digest/version slot.
    const runtimeArtifactHash = await hashRuntimeArtifact(runtimeRoot);
    return encodeBuildInputRecipe({
      vaultUid: config.projection.vaultUid,
      objectFormat: sourceCommit.length === 40 ? "sha1" : "sha256",
      sourceCommit,
      vaultScope: vaultScope as string,
      profile: "1.0",
      manifestHash,
      policy: {
        secretPolicy: "reject-detected",
        secretPolicyVersion: SECRET_DETECTION_VERSION,
        approvedSensitivityClasses:
          config.projection.approvedSensitivityClasses,
        provider: null,
      },
      versions: {
        canonicalExportVersion: CANONICAL_EXPORT_VERSION,
        ...PROJECTION_VERSIONS,
      },
      maxChunkBytes: config.projection.maxChunkBytes,
      runtimeArtifactHash,
      embeddingGeneration: null,
    });
  } catch {
    invalid();
  }
}
