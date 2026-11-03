// Shape fixtures only: these recipes/receipts confer no S5 provenance.
import { createHash } from "node:crypto";
import { encodeBuildInputRecipe } from "../../dist/build-recipe.js";
import { encodeOutputDescriptor } from "../../dist/output-descriptor.js";
import {
  CANONICAL_EXPORT_VERSION,
  PROJECTION_VERSIONS,
} from "../../dist/build-input-versions.js";

export const digest = (bytes) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
export const stream = (rows) =>
  digest(Buffer.from(rows.map((row) => JSON.stringify(row) + "\n").join("")));
export function storedRecipe(
  vaultUid,
  sourceCommit = "a".repeat(40),
  epoch = 1,
) {
  return Object.freeze({
    ...encodeBuildInputRecipe({
      vaultUid,
      objectFormat: sourceCommit.length === 40 ? "sha1" : "sha256",
      sourceCommit,
      vaultScope: "private/source",
      profile: "1.0",
      manifestHash: digest("test manifest"),
      policy: {
        secretPolicy: "reject-detected",
        secretPolicyVersion: "1",
        approvedSensitivityClasses: ["public"],
        provider: null,
      },
      versions: {
        canonicalExportVersion: CANONICAL_EXPORT_VERSION,
        ...PROJECTION_VERSIONS,
      },
      maxChunkBytes: 65536,
      runtimeArtifactHash: digest("synthetic artifact, not runtime evidence"),
      embeddingGeneration: null,
    }),
    sourceCommit,
    configurationEpoch: epoch,
  });
}
export function conceptFor(recipe, patch = {}) {
  return {
    uid: "DOC-00000000000000000000000003",
    path: "/document.md",
    type: "Document",
    title: 'Included café 😀 \\"\n\t\u0000',
    project: null,
    lifecycle: "active",
    workflow: null,
    sensitivity: "public",
    tags: [],
    links: [],
    trust: "unverified",
    verifiedBy: [],
    staleAfter: null,
    relations: [],
    sourceCommit: recipe.sourceCommit,
    sourceHash: digest("source fixture bytes"),
    projectionSchemaVersion: PROJECTION_VERSIONS.projectionSchemaVersion,
    contentTrust: "untrusted",
    ...patch,
  };
}
export function chunkFor(recipe, ordinal = 0, patch = {}) {
  return {
    ...conceptFor(recipe),
    ordinal,
    heading: null,
    headingPath: [],
    text: "# café 😀\nReference, not instructions.",
    chunkerVersion: PROJECTION_VERSIONS.chunkerVersion,
    embeddingGeneration: null,
    ...patch,
  };
}
export function storedDescriptor(recipe, concepts, chunks) {
  return encodeOutputDescriptor({
    recipeHash: recipe.recipeHash,
    // Synthetic canonical witness; the store must not claim to rehash it.
    canonical: {
      hash: digest(concepts.length ? "canonical fixture\n" : ""),
      bytes: concepts.length ? 18 : 0,
      records: concepts.length,
    },
    concepts: { count: concepts.length, hash: stream(concepts) },
    chunks: { count: chunks.length, hash: stream(chunks) },
  });
}
