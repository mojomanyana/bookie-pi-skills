import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { runtimeFixture } from "./helpers/runtime-fixture.mjs";
import { assembleMeasuredInputRecipe } from "../dist/build-input-assembly.js";
import { hashRuntimeArtifact } from "../dist/runtime-artifact.js";

const uid = "VLT-00000000000000000000000009";
const commit = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;
const deployment = {
  handle: "demo",
  root: "/repo/vault",
  repositoryRoot: "/repo",
  approvedRef: "refs/heads/approved",
  rollbackWindow: 0,
  timeoutMs: 10000,
  projection: {
    vaultUid: uid,
    approvedSensitivityClasses: ["public"],
    maxChunkBytes: 64,
    maxChunks: 250000,
  },
};
const receipt = {
  ok: true,
  sourceCommit: commit,
  approvedTip: commit,
  objectFormat: "sha1",
  vaultScope: "vault",
  manifest: {
    vaultUid: uid,
    profile: "1.0",
    hash: digest,
    sensitivityClasses: ["public"],
  },
};
const artifact = (t) => runtimeFixture(t, "bookie-assembly-");
const bad = { name: "TypeError", message: "Build recipe assembly is invalid." };

test("assembly measures artifact bytes and binds claimed preflight metadata, policy, scope and implementation versions", async (t) => {
  const { root, file } = await artifact(t);
  const result = await assembleMeasuredInputRecipe(deployment, receipt, root);
  assert.match(result.buildId, /^bld_[a-f0-9]{64}$/);
  const tuple = JSON.parse(result.serialized);
  assert.equal(tuple[15], await hashRuntimeArtifact(root));
  assert.deepEqual(tuple.slice(9, 14), [
    "1.0",
    "1",
    "bookie-1_yaml-2.9.0_mdast-2.0.3",
    "heading-utf8-1",
    "markdown-trim-policy-2",
  ]);
  assert.equal(
    result.policyHash,
    `sha256:${createHash("sha256")
      .update(
        JSON.stringify([
          "bookie-index-policy",
          1,
          "reject-detected",
          "bookie-secret-1",
          ["public"],
          null,
        ]),
        "utf8",
      )
      .digest("hex")}`,
  );
  assert.deepEqual(
    result,
    await assembleMeasuredInputRecipe(
      deployment,
      { ...receipt, approvedTip: "c".repeat(40) },
      root,
    ),
  );
  assert.deepEqual(
    result,
    await assembleMeasuredInputRecipe(
      { ...deployment, root: "/elsewhere/vault", repositoryRoot: "/elsewhere" },
      receipt,
      root,
    ),
  );
  assert.notEqual(
    result.buildId,
    (
      await assembleMeasuredInputRecipe(
        { ...deployment, root: "/repo/other" },
        { ...receipt, vaultScope: "other" },
        root,
      )
    ).buildId,
  );
  assert.notEqual(
    result.buildId,
    (
      await assembleMeasuredInputRecipe(
        {
          ...deployment,
          projection: { ...deployment.projection, maxChunkBytes: 32 },
        },
        receipt,
        root,
      )
    ).buildId,
  );
  assert.notEqual(
    result.buildId,
    (
      await assembleMeasuredInputRecipe(
        deployment,
        {
          ...receipt,
          manifest: { ...receipt.manifest, hash: `sha256:${"c".repeat(64)}` },
        },
        root,
      )
    ).buildId,
  );
  const declared = {
    ...receipt,
    manifest: {
      ...receipt.manifest,
      sensitivityClasses: ["public", "internal"],
    },
  };
  const expanded = {
    ...deployment,
    projection: {
      ...deployment.projection,
      approvedSensitivityClasses: ["public", "internal"],
    },
  };
  assert.notEqual(
    result.buildId,
    (await assembleMeasuredInputRecipe(expanded, declared, root)).buildId,
  );
  assert.deepEqual(
    await assembleMeasuredInputRecipe(expanded, declared, root),
    await assembleMeasuredInputRecipe(
      {
        ...expanded,
        projection: {
          ...expanded.projection,
          approvedSensitivityClasses: ["internal", "public"],
        },
      },
      declared,
      root,
    ),
  );
  await file("node_modules/module/index.js", "export default 4;");
  assert.notEqual(
    result.buildId,
    (await assembleMeasuredInputRecipe(deployment, receipt, root)).buildId,
  );
});

test("assembly rejects mismatched sources, undeclared approvals and incomplete artifacts without an identity", async (t) => {
  const { root, file } = await artifact(t);
  for (const source of [
    { ...receipt, sourceCommit: "b".repeat(64) },
    { ...receipt, objectFormat: "sha256" },
    { ...receipt, vaultScope: "other" },
    {
      ...receipt,
      manifest: {
        ...receipt.manifest,
        vaultUid: "VLT-00000000000000000000000008",
      },
    },
    { ...receipt, manifest: { ...receipt.manifest, hash: "bad" } },
    { ...receipt, manifest: { ...receipt.manifest, sensitivityClasses: [] } },
    { ...receipt, ok: false, reason: "manifest-unavailable" },
  ])
    await assert.rejects(
      assembleMeasuredInputRecipe(deployment, source, root),
      bad,
    );
  await assert.rejects(
    assembleMeasuredInputRecipe(
      {
        ...deployment,
        projection: {
          ...deployment.projection,
          approvedSensitivityClasses: ["restricted"],
        },
      },
      receipt,
      root,
    ),
    bad,
  );
  await assert.rejects(
    assembleMeasuredInputRecipe(deployment, receipt, root, {
      runtimeArtifactHash: digest,
    }),
    bad,
  );
  let executed = false;
  const hostile = new Proxy(receipt, {
    ownKeys() {
      executed = true;
      throw Error("PRIVATE");
    },
  });
  await assert.rejects(
    assembleMeasuredInputRecipe(deployment, hostile, root),
    bad,
  );
  assert.equal(executed, false);
  await file("schemas/service/v1/protocol.schema.json", "MISMATCH");
  await assert.rejects(
    assembleMeasuredInputRecipe(deployment, receipt, root),
    bad,
  );
});
