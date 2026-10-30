import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import {
  assertRuntimeProfile,
  qualifyRuntime,
} from "../dist/runtime-qualification.js";

// Protect the immutable installation boundary, not a historical qualification receipt.
const profile = {
  version: 1,
  baseImage:
    "node:24.19.0-bookworm@sha256:4196d66a565c6f195728d9952f161f4adfe2ad753052a08b7ec7f1c5a6bda42b",
  platform: "linux/amd64",
  node: "v24.19.0",
  git: "git version 2.39.5",
  gitHash: `sha256:${"a".repeat(64)}`,
  npm: "11.9.0",
  build: "bookie-clean-workspaces-1",
};
const observed = {
  node: profile.node,
  git: profile.git,
  gitHash: profile.gitHash,
  platform: profile.platform,
};
const status =
  "Uid:\t1000\t1000\t1000\t1000\nCapInh:\t0000\nCapPrm:\t0000\nCapEff:\t0000\nCapBnd:\t0000\nCapAmb:\t0000\nNoNewPrivs:\t1\n";
const mounts =
  "1 0 0:1 / / ro - overlay overlay rw\n2 1 0:2 / /tmp rw - tmpfs tmpfs rw\n";
const paths = ["/opt/bookie", "/usr/local/bin/node", "/usr/bin/git"];
const bad = { name: "TypeError", message: "Runtime qualification failed." };
const check = (
  table = mounts,
  proc = status,
  uid = 1000,
  baked = profile,
  running = observed,
) => assertRuntimeProfile(table, proc, uid, paths, baked, running);

test("qualified profile permits unrelated bounded tmpfs, but rejects mutable runtime, ancestors and aliases", () => {
  assert.doesNotThrow(() => check());
  for (const table of [
    mounts.replace("/ ro", "/ rw"),
    mounts + "3 1 0:3 / /opt rw - tmpfs tmpfs rw\n",
    mounts + "3 1 0:3 / /opt/bookie/node_modules rw - tmpfs tmpfs rw\n",
    mounts + "3 1 0:1 /opt/bookie /alias rw - overlay overlay rw\n",
    mounts + "3 1 0:1 /usr /alias rw - overlay overlay rw\n",
    "PRIVATE_KERNEL_ERROR",
    "x".repeat(1048577),
    mounts.trimEnd(),
  ])
    assert.throws(() => check(table), bad);
});

test("read-only nested dependency cannot qualify with a writable backing alias", () => {
  const table =
    mounts +
    "3 1 8:2 /dependency /opt/bookie/node_modules/yaml ro - ext4 /dev/test rw\n";
  assert.doesNotThrow(() => check(table));
  assert.throws(
    () =>
      check(
        table +
          "4 1 8:2 /dependency /dependency-alias rw - ext4 /dev/test rw\n",
      ),
    bad,
  );
});

test("identity, capability, privilege and baked/observed runtime mismatch fail statically", () => {
  assert.throws(() => check(mounts, status, 0), bad);
  for (const proc of [
    "",
    status.replace("NoNewPrivs:\t1", "NoNewPrivs:\t0"),
    status.replace("1000\t1000\t1000\t1000", "0\t1000\t0\t0"),
    ...["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"].map((key) =>
      status.replace(`${key}:\t0000`, `${key}:\t0001`),
    ),
  ])
    assert.throws(() => check(mounts, proc), bad);
  for (const key of Object.keys(profile)) {
    const changed = { ...profile, [key]: "PRIVATE_PROFILE" };
    assert.throws(() => check(mounts, status, 1000, changed), bad);
    const missing = { ...profile };
    delete missing[key];
    assert.throws(() => check(mounts, status, 1000, missing), bad);
  }
  assert.throws(
    () => check(mounts, status, 1000, { ...profile, extra: true }),
    bad,
  );
  for (const key of Object.keys(observed))
    assert.throws(
      () =>
        check(mounts, status, 1000, profile, {
          ...observed,
          [key]: "PRIVATE_RUNTIME",
        }),
      bad,
    );
});

test("only trusted orchestration assembles qualified recipes; HTTP/Redis cannot start or qualify builders", async () => {
  const root = new URL("../src/", import.meta.url);
  const consumers = new Set(["trusted-builder.ts", "ingestion-process.ts"]);
  for (const path of await readdir(root)) {
    if (!path.endsWith(".ts") || path === "build-input-assembly.ts") continue;
    const source = await readFile(new URL(path, root), "utf8");
    assert.equal(/assembleMeasuredInputRecipe/u.test(source), false, path);
    if (!consumers.has(path))
      assert.equal(
        /build-input-assembly|assembleQualifiedInputRecipe/u.test(source),
        false,
        path,
      );
    if (path === "server.ts" || path.startsWith("redis-")) {
      // S6 consumes S5's data type, not its runtime or authorization boundary.
      const executable =
        path === "redis-candidate-store.ts"
          ? source.replace(
              /^import type \{ TrustedBuildRecipe \} from "\.\/trusted-builder\.js";$/mu,
              "",
            )
          : source;
      assert.equal(
        /trusted-builder|qualifyBuildRuntime|loadBuildRuntime/u.test(
          executable,
        ),
        false,
        path,
      );
    }
  }
});

test("live qualification has no caller-selected root or mount receipt, and chmod cannot qualify the host", async () => {
  for (const expected of [
    undefined,
    "PRIVATE_PATH",
    `sha256:${"0".repeat(64)}`,
    `sha256:${"0".repeat(64)}\n`,
  ])
    await assert.rejects(qualifyRuntime(expected), bad);
  await assert.rejects(
    qualifyRuntime(`sha256:${"0".repeat(64)}`, {
      mounts,
      status,
      root: "/opt/bookie",
    }),
    bad,
  );
});
