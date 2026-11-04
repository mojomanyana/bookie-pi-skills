import { createHash } from "node:crypto";
import { encodeBuildInputRecipe } from "../../dist/build-recipe.js";
import { CandidateStoreError } from "../../dist/redis-candidate-store.js";
import { parseOutputDescriptor } from "../../dist/output-descriptor.js";
import { memoryCandidateStore } from "./memory-candidate-store.mjs";
import {
  CANONICAL_EXPORT_VERSION,
  PROJECTION_VERSIONS,
} from "../../dist/build-input-versions.js";
import { storedDescriptor } from "./stored-output-fixture.mjs";

export const MemoryCandidateStore = memoryCandidateStore(
  CandidateStoreError,
  parseOutputDescriptor,
);
export const secret = "x".repeat(43);
export const authorization = "Bearer bka_admin_" + secret;
export const commit = "a".repeat(40);
export const emptyHash =
  "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
export const configuration = (epoch = 1) => ({
  epoch,
  tokens: [
    {
      id: "admin",
      digest: createHash("sha256").update(secret).digest("hex"),
      principal: "operator",
      not_before: "2020-01-01T00:00:00Z",
      expires_at: "2100-01-01T00:00:00Z",
      grants: ["alpha", "beta"].map((vault) => ({
        vault,
        scopes: ["rebuild:create", "rebuild:read", "rebuild:cancel"],
      })),
    },
  ],
  sources: ["alpha", "beta"].map((handle, n) => ({
    handle,
    root: "/vault/" + handle,
    repositoryRoot: "/vault/" + handle,
    approvedRef: "refs/heads/approved",
    rollbackWindow: 0,
    timeoutMs: 21600000,
    projection: {
      vaultUid: "VLT-" + String(n + 1).padStart(26, "0"),
      approvedSensitivityClasses: ["public"],
      maxChunkBytes: 8192,
      maxChunks: 250000,
    },
  })),
});
export function recipeFor(config, vault = "alpha", sourceCommit = commit) {
  const source = config.sources.find((s) => s.handle === vault);
  return Object.freeze({
    ...encodeBuildInputRecipe({
      vaultUid: source.projection.vaultUid,
      objectFormat: "sha1",
      sourceCommit,
      vaultScope: "",
      profile: "1.0",
      manifestHash: emptyHash,
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
      maxChunkBytes: 8192,
      runtimeArtifactHash: emptyHash,
      embeddingGeneration: null,
    }),
    sourceCommit,
    configurationEpoch: config.epoch,
  });
}
export function outputFor(recipe, concepts = [], chunks = []) {
  return {
    recipe,
    approvedTip: commit,
    outputDescriptor: storedDescriptor(recipe, concepts, chunks),
    concepts,
    chunks,
  };
}
export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
export const turn = () => new Promise((resolve) => setImmediate(resolve));
