import { createHash } from "node:crypto";
import { posix } from "node:path";
import { types } from "node:util";
import { ownDataFields } from "./closed-data.js";

/** Codec inputs only: neither a source authorization nor runtime-artifact attestation. */
export interface BuildRecipeInputs {
  readonly vaultUid: string;
  readonly objectFormat: "sha1" | "sha256";
  readonly sourceCommit: string;
  readonly vaultScope: string;
  readonly profile: "1.0";
  readonly manifestHash: string;
  readonly policy: Readonly<{
    secretPolicy: "reject-detected";
    secretPolicyVersion: string;
    approvedSensitivityClasses: readonly string[];
    provider: null;
  }>;
  readonly versions: Readonly<{
    canonicalExportVersion: string;
    projectionSchemaVersion: string;
    parserVersion: string;
    chunkerVersion: string;
    preprocessingVersion: string;
  }>;
  readonly maxChunkBytes: number;
  readonly runtimeArtifactHash: string;
  readonly embeddingGeneration: null;
}
export interface EncodedBuildRecipe {
  /** Private canonical identity metadata; never a log, HTTP or Redis-control field. */
  readonly serialized: string;
  readonly scopeHash: `sha256:${string}`;
  readonly policyHash: `sha256:${string}`;
  readonly recipeHash: `sha256:${string}`;
  readonly buildId: `bld_${string}`;
}
function invalid(): never {
  throw new TypeError("Build recipe inputs are invalid.");
}

function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}
const versionPattern = /^[A-Za-z0-9._+-]{1,128}(?![\s\S])/u;
const hashPattern = /^sha256:[a-f0-9]{64}(?![\s\S])/u;
function hash(tuple: readonly unknown[]): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(JSON.stringify(tuple), "utf8").digest("hex")}`;
}
function scope(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > 4096 ||
    /[\p{Cc}\p{Cs}\\]/u.test(value)
  )
    return false;
  if (value === "") return true;
  const parts = value.split("/");
  return (
    !posix.isAbsolute(value) &&
    posix.normalize(value) === value &&
    parts.length <= 64 &&
    parts.every(
      (part) =>
        part !== "" &&
        part !== "." &&
        part !== ".." &&
        part.toLowerCase() !== ".git" &&
        Buffer.byteLength(part, "utf8") <= 255,
    )
  );
}

/**
 * Pure v2 lexical encoding, deliberately unused by admission and the legacy worker.
 * Supplied hashes/version labels are checked for syntax, NOT measured or trusted.
 * A verified artifact producer and trusted input assembly are required before use.
 */
export function encodeBuildInputRecipe(
  input: BuildRecipeInputs,
): EncodedBuildRecipe {
  try {
    const [
      vaultUid,
      objectFormat,
      sourceCommit,
      vaultScope,
      profile,
      manifestHash,
      policy,
      versions,
      maxChunkBytes,
      runtimeArtifactHash,
      embeddingGeneration,
    ] = ownDataFields(input, [
      "vaultUid",
      "objectFormat",
      "sourceCommit",
      "vaultScope",
      "profile",
      "manifestHash",
      "policy",
      "versions",
      "maxChunkBytes",
      "runtimeArtifactHash",
      "embeddingGeneration",
    ]);
    if (
      !matches(vaultUid, /^VLT-[0-7][0-9A-HJKMNP-TV-Z]{25}(?![\s\S])/u) ||
      !matches(sourceCommit, /^(?:[a-f0-9]{40}|[a-f0-9]{64})(?![\s\S])/u) ||
      objectFormat !== (sourceCommit.length === 40 ? "sha1" : "sha256") ||
      !scope(vaultScope) ||
      profile !== "1.0" ||
      !matches(manifestHash, hashPattern) ||
      !matches(runtimeArtifactHash, hashPattern) ||
      embeddingGeneration !== null ||
      typeof maxChunkBytes !== "number" ||
      !Number.isSafeInteger(maxChunkBytes) ||
      maxChunkBytes < 16 ||
      maxChunkBytes > 65536
    )
      invalid();
    const [
      secretPolicy,
      secretPolicyVersion,
      approvedSensitivityClasses,
      provider,
    ] = ownDataFields(policy, [
      "secretPolicy",
      "secretPolicyVersion",
      "approvedSensitivityClasses",
      "provider",
    ]);
    if (
      secretPolicy !== "reject-detected" ||
      !matches(secretPolicyVersion, versionPattern) ||
      provider !== null ||
      types.isProxy(approvedSensitivityClasses) ||
      !Array.isArray(approvedSensitivityClasses)
    )
      invalid();
    // Native arrays have a non-accessor length. Reject proxies before reading it,
    // bound work before copying, then consume one closed descriptor snapshot.
    const length = approvedSensitivityClasses.length;
    if (length > 64) invalid();
    const items = Object.getOwnPropertyDescriptors(
      approvedSensitivityClasses as object,
    );
    if (Reflect.ownKeys(items).length !== length + 1) invalid();
    const classes: string[] = [];
    for (let i = 0; i < length; i++) {
      const item = items[String(i)];
      if (
        !Object.hasOwn(items, String(i)) ||
        item === undefined ||
        !Object.hasOwn(item, "value") ||
        !matches(item.value, /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?![\s\S])/u) ||
        item.value.length > 63 ||
        item.value === "unknown" ||
        item.value === "unclassified"
      )
        invalid();
      classes.push(item.value);
    }
    if (new Set(classes).size !== classes.length) invalid();
    classes.sort();
    const versionValues = ownDataFields(versions, [
      "canonicalExportVersion",
      "projectionSchemaVersion",
      "parserVersion",
      "chunkerVersion",
      "preprocessingVersion",
    ]);
    if (!versionValues.every((value) => matches(value, versionPattern)))
      invalid();
    const scopeHash = hash(["bookie-vault-scope", 1, vaultScope]);
    const policyHash = hash([
      "bookie-index-policy",
      1,
      secretPolicy,
      secretPolicyVersion,
      classes,
      provider,
    ]);
    const tuple = [
      "bookie-build-inputs",
      2,
      vaultUid,
      objectFormat,
      sourceCommit,
      scopeHash,
      profile,
      manifestHash,
      policyHash,
      ...versionValues,
      maxChunkBytes,
      runtimeArtifactHash,
      embeddingGeneration,
    ];
    const serialized = JSON.stringify(tuple);
    const recipeHash = hash(tuple);
    return Object.freeze({
      serialized,
      scopeHash,
      policyHash,
      recipeHash,
      buildId: `bld_${recipeHash.slice(7)}`,
    });
  } catch {
    // Includes unsupported reflective/proxy input; never expose caller diagnostics.
    invalid();
  }
}
