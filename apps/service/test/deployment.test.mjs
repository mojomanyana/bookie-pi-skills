import assert from "node:assert/strict";
import test from "node:test";
import { compileSourceDeployments } from "../dist/deployment-config.js";
import { assertReadonlyMountProfile } from "../dist/readonly-checkout.js";
import { prepareDeploymentLexicalProjection } from "../dist/ingestion.js";

const config = {
  handle: "demo",
  root: "/vault",
  repositoryRoot: "/vault",
  approvedRef: "refs/heads/main",
  rollbackWindow: 0,
  timeoutMs: 10000,
  projection: {
    vaultUid: "VLT-00000000000000000000000009",
    approvedSensitivityClasses: ["public"],
    maxChunkBytes: 8192,
    maxChunks: 250000,
  },
};
const status = `Uid:\t1000\t1000\t1000\t1000\nCapInh:\t0000000000000000\nCapPrm:\t0000000000000000\nCapEff:\t0000000000000000\nCapBnd:\t0000000000000000\nCapAmb:\t0000000000000000\nNoNewPrivs:\t1\n`;
const mounts =
  "1 0 0:1 / / ro,relatime - overlay overlay rw\n2 1 8:1 /source /vault ro,relatime - ext4 /dev/test rw\n3 1 0:3 / /tmp rw,nosuid - tmpfs tmpfs rw\n";
const check = (
  table = mounts,
  proc = status,
  paths = ["/vault", "/vault/.git"],
  uid = 1000,
) => assertReadonlyMountProfile(table, proc, uid, paths);
const rejected = { message: "DEPLOYMENT_REJECTED" };

test("source deployments are strict, immutable, unique and non-overlapping", () => {
  const mutable = structuredClone(config);
  const compiled = compileSourceDeployments([mutable]);
  mutable.projection.approvedSensitivityClasses.length = 0;
  assert.deepEqual(compiled, [config]);
  assert.throws(() => compiled.push(config), TypeError);
  assert.throws(
    () => compiled[0].projection.approvedSensitivityClasses.push("internal"),
    TypeError,
  );
  assert.throws(() => {
    compiled[0].root = "/elsewhere";
  }, TypeError);
  assert.deepEqual(compileSourceDeployments([]), []);
  const maximum = Array.from({ length: 64 }, (_, i) => ({
    ...config,
    handle: `vault-${i}`,
    root: `/vault-${i}`,
    repositoryRoot: `/vault-${i}`,
    projection: {
      ...config.projection,
      vaultUid: `VLT-${String(i).padStart(26, "0")}`,
    },
  }));
  assert.equal(compileSourceDeployments(maximum).length, 64);
  const sibling = {
    ...config,
    handle: "other",
    root: "/repo/b",
    repositoryRoot: "/repo",
    projection: {
      ...config.projection,
      vaultUid: "VLT-00000000000000000000000008",
    },
  };
  assert.equal(
    compileSourceDeployments([
      { ...config, root: "/repo/a", repositoryRoot: "/repo" },
      sibling,
    ]).length,
    2,
  );
  for (const overrides of [
    { handle: "UPPER" },
    { handle: "demo\n" },
    { root: "/vault/../vault" },
    { root: "relative" },
    { repositoryRoot: "/other" },
    { root: "/vault/.git/a" },
    { approvedRef: "HEAD" },
    { approvedRef: "refs/replace/a" },
    { approvedRef: "refs/heads/a~1" },
    { rollbackWindow: 1025 },
    { timeoutMs: 21600001 },
    { timeoutMs: undefined },
    { unchecked: true },
  ])
    assert.throws(
      () => compileSourceDeployments([{ ...config, ...overrides }]),
      /Deployment config is invalid/u,
    );
  for (const second of [
    config,
    { ...sibling, handle: config.handle },
    { ...sibling, projection: config.projection },
    { ...sibling, root: "/vault/sub", repositoryRoot: "/vault" },
  ]) {
    assert.throws(
      () => compileSourceDeployments([config, second]),
      /Deployment config is invalid/u,
    );
  }
  assert.throws(
    () => compileSourceDeployments(Array(65).fill(config)),
    /Deployment config is invalid/u,
  );
});

test("mount proof uses per-mount read-only flags, handles escaping, and rejects writable descendants and aliases", () => {
  assert.doesNotThrow(() => check());
  assert.doesNotThrow(() =>
    check(mounts + "4 1 8:2 / /vault-other rw - ext4 /dev/other rw\n"),
  );
  assert.doesNotThrow(() =>
    check(mounts.replaceAll("/vault", "/vault\\040name"), status, [
      "/vault name",
      "/vault name/.git",
    ]),
  );
  for (const table of [
    mounts.replace("/ / ro,", "/ / rw,"),
    mounts.replace("/vault ro,", "/vault rw,"),
    mounts + "4 2 0:4 / /vault/nested rw - tmpfs tmpfs rw\n",
    mounts + "4 2 0:4 / /vault/.git/objects rw - tmpfs tmpfs rw\n",
    mounts + "4 1 8:1 /source /alias rw - ext4 /dev/test rw\n",
    mounts + "4 1 8:1 / /alias rw - ext4 /dev/test rw\n",
    mounts + "4 1 8:1 /source/objects /alias rw - ext4 /dev/test rw\n",
  ])
    assert.throws(() => check(table), rejected);
});

test("malformed or ambiguous kernel metadata and insufficient process hardening fail closed", () => {
  for (const table of [
    "",
    mounts.trimEnd(),
    mounts + "bad\n",
    mounts.replace("/vault", "relative"),
    mounts.replace("ro,relatime", "ro,rw"),
    mounts + "4 1 8:2 / /vault ro - ext4 x ro\n",
    mounts.replace("/source", "/source\\999"),
    "x".repeat(1048577),
  ]) {
    assert.throws(() => check(table), rejected);
  }
  for (const proc of [
    "",
    status.replace("NoNewPrivs:\t1", "NoNewPrivs:\t0"),
    status + "NoNewPrivs:\t1\n",
    ...["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"].map((key) =>
      status.replace(`${key}:\t0000000000000000`, `${key}:\t0000000000000001`),
    ),
  ]) {
    assert.throws(() => check(mounts, proc), rejected);
  }
  assert.throws(
    () =>
      check(mounts, status.replace("1000\t1000\t1000\t1000", "0\t1000\t0\t0")),
    rejected,
  );
  assert.throws(() => check(mounts, status, ["/vault"], 0), rejected);
  assert.throws(() => check(mounts, status, ["/vault"], 1001), rejected);
});

test("deployment ingestion rejects an ordinary writable host before approving any commit", async () => {
  const result = await prepareDeploymentLexicalProjection(
    { ...config, root: process.cwd(), repositoryRoot: process.cwd() },
    { sourceRef: "a".repeat(40) },
  );
  assert.deepEqual(result, { ok: false, reason: "deployment-rejected" });
  await assert.rejects(
    () =>
      prepareDeploymentLexicalProjection(config, {
        sourceRef: "a".repeat(40),
        bypass: true,
      }),
    /Deployment request is invalid/u,
  );
});
