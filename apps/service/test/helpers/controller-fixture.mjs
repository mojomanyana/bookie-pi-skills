import { createHash } from "node:crypto";
import { encodeBuildInputRecipe } from "../../dist/build-recipe.js";
import { encodeOutputDescriptor } from "../../dist/output-descriptor.js";
import { CandidateStoreError } from "../../dist/redis-candidate-store.js";
import { memoryCandidateStore } from "./memory-candidate-store.mjs";

export const MemoryCandidateStore = memoryCandidateStore(CandidateStoreError);
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
        canonicalExportVersion: "1",
        projectionSchemaVersion: "1",
        parserVersion: "1",
        chunkerVersion: "1",
        preprocessingVersion: "1",
      },
      maxChunkBytes: 8192,
      runtimeArtifactHash: emptyHash,
      embeddingGeneration: null,
    }),
    sourceCommit,
    configurationEpoch: config.epoch,
  });
}
export function outputFor(recipe) {
  return {
    recipe,
    approvedTip: commit,
    outputDescriptor: encodeOutputDescriptor({
      recipeHash: recipe.recipeHash,
      canonical: { hash: emptyHash, bytes: 0, records: 0 },
      concepts: { count: 0, hash: emptyHash },
      chunks: { count: 0, hash: emptyHash },
    }),
    concepts: [],
    chunks: [],
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
