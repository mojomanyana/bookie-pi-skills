import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { resolveApprovedGitCommit } from "./approved-git-source.js";
import { DEFAULT_MAX_YAML_DEPTH } from "./concept-loader.js";
import { parseStrictYamlMapping } from "./strict-yaml.js";
import { throwIfAborted } from "./vault-cancellation.js";
import { readLocalGitCommitManifest } from "./vault-git-base.js";
import { getSchemaValidators } from "./vault-manifest.js";
import type { Manifest } from "./vault-model.js";
import { DEFAULT_MAX_MANIFEST_BYTES } from "./vault-validator.js";

export interface ApprovedSourceManifestRequest {
  readonly sourceRef: string;
  readonly approvedRef: string;
  readonly rollbackWindow: number;
  readonly vaultUid: string;
  readonly signal?: AbortSignal;
}
export type ApprovedSourceManifestResult =
  | Readonly<{
      ok: true;
      sourceCommit: string;
      approvedTip: string;
      objectFormat: "sha1" | "sha256";
      /** Private repository-relative directory; empty for the repository root. */
      vaultScope: string;
      manifest: Readonly<{
        vaultUid: string;
        profile: "1.0";
        hash: `sha256:${string}`;
        sensitivityClasses: readonly string[];
      }>;
    }>
  | Readonly<{
      ok: false;
      reason: "source-not-approved" | "manifest-unavailable";
    }>;

function invalid(): never {
  throw new TypeError("Source manifest request is invalid.");
}

/**
 * Metadata only, not complete-vault validation or indexing permission. The service
 * must prove its deployment boundary before Git and isolate this bounded synchronous
 * YAML parse in its deadline-controlled preflight process. No counts/build ID/content.
 */
export async function readApprovedSourceManifest(
  root: string | URL,
  request: ApprovedSourceManifestRequest,
): Promise<ApprovedSourceManifestResult> {
  if (
    (typeof root !== "string" && !(root instanceof URL)) ||
    request === null ||
    typeof request !== "object" ||
    Array.isArray(request) ||
    Object.keys(request).some(
      (key) =>
        ![
          "sourceRef",
          "approvedRef",
          "rollbackWindow",
          "vaultUid",
          "signal",
        ].includes(key),
    ) ||
    typeof request.vaultUid !== "string" ||
    !/^VLT-[0-7][0-9A-HJKMNP-TV-Z]{25}(?![\s\S])/u.test(request.vaultUid)
  )
    invalid();
  const { sourceRef, approvedRef, rollbackWindow, vaultUid, signal } = request;
  // Capture mutable URL/request inputs before the first asynchronous boundary.
  let path: string;
  try {
    path = resolve(root instanceof URL ? fileURLToPath(root) : root);
  } catch {
    invalid();
  }
  let approved;
  try {
    approved = await resolveApprovedGitCommit(path, {
      sourceRef,
      approvedRef,
      rollbackWindow,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    if (error instanceof TypeError) invalid();
    throw error;
  }
  if (!approved.ok) return Object.freeze(approved);
  const failed = Object.freeze({
    ok: false,
    reason: "manifest-unavailable",
  } as const);
  try {
    const source = await readLocalGitCommitManifest(
      path,
      approved.sourceCommit,
      DEFAULT_MAX_MANIFEST_BYTES,
      signal,
    );
    const validators = await getSchemaValidators();
    throwIfAborted(signal);
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(source.bytes);
    const parsed = parseStrictYamlMapping(text, DEFAULT_MAX_YAML_DEPTH);
    if (!parsed.ok || !validators.manifest(parsed.value)) return failed;
    const manifest = parsed.value as unknown as Manifest;
    if (manifest.vault.uid !== vaultUid) return failed;
    throwIfAborted(signal);
    return Object.freeze({
      ok: true,
      sourceCommit: approved.sourceCommit,
      approvedTip: approved.approvedTip,
      objectFormat: approved.sourceCommit.length === 40 ? "sha1" : "sha256",
      vaultScope: source.prefix,
      manifest: Object.freeze({
        vaultUid: manifest.vault.uid,
        profile: manifest.profile,
        hash: `sha256:${createHash("sha256").update(source.bytes).digest("hex")}` as const,
        sensitivityClasses: Object.freeze([
          ...manifest.policy.sensitivity.classes,
        ]),
      }),
    });
  } catch {
    throwIfAborted(signal);
    return failed;
  }
}
