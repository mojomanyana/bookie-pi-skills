import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire, syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { preflightDeploymentSource } from "../dist/ingestion.js";

const deployment = {
  handle: "demo",
  root: "/repo/nested",
  repositoryRoot: "/repo",
  approvedRef: "refs/heads/approved",
  rollbackWindow: 0,
  timeoutMs: 21600000,
  projection: {
    vaultUid: "VLT-00000000000000000000000009",
    approvedSensitivityClasses: ["public"],
    maxChunkBytes: 8192,
    maxChunks: 250000,
  },
};
const sourceRef = "a".repeat(40);
const success = {
  ok: true,
  sourceCommit: sourceRef,
  approvedTip: "b".repeat(40),
  objectFormat: "sha1",
  vaultScope: "nested",
  manifest: {
    vaultUid: deployment.projection.vaultUid,
    profile: "1.0",
    hash: `sha256:${"c".repeat(64)}`,
    sensitivityClasses: ["public", "internal"],
  },
};
const call = (config = deployment, extra = {}) =>
  preflightDeploymentSource(config, { sourceRef, timeoutMs: 7000, ...extra });

async function fake(t, response, action) {
  const environment = {
    NODE_OPTIONS: process.env.NODE_OPTIONS,
    NODE_PATH: process.env.NODE_PATH,
  };
  process.env.NODE_OPTIONS = "--import=/PRIVATE_LOADER";
  process.env.NODE_PATH = "/PRIVATE_MODULES";
  const cp = createRequire(import.meta.url)("node:child_process");
  const calls = [];
  const mock = t.mock.method(cp, "fork", (path, args, options) => {
    const child = new EventEmitter();
    child.send = (input, callback) => {
      calls.push({ path, args, options, input });
      callback(null);
      queueMicrotask(() => {
        child.emit("message", structuredClone(response));
        child.emit("close", 0);
      });
    };
    return child;
  });
  syncBuiltinESMExports();
  try {
    await action(calls);
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
    for (const [key, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("preflight snapshots deployment/request and returns only frozen private metadata from an isolated process", async (t) => {
  await fake(t, success, async (calls) => {
    const mutable = structuredClone(deployment);
    const request = { sourceRef, timeoutMs: 7000 };
    const pending = preflightDeploymentSource(mutable, request);
    mutable.root = "/PRIVATE";
    mutable.approvedRef = "refs/heads/PRIVATE";
    mutable.projection.approvedSensitivityClasses.push("undeclared");
    request.sourceRef = "PRIVATE";
    const result = await pending;
    assert.deepEqual(result, success);
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result.manifest));
    assert.ok(Object.isFrozen(result.manifest.sensitivityClasses));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].input.root, deployment.root);
    assert.equal(calls[0].input.repositoryRoot, deployment.repositoryRoot);
    assert.equal(calls[0].input.mode, "preflight");
    assert.equal(calls[0].input.approvedRef, deployment.approvedRef);
    assert.deepEqual(calls[0].input.config, deployment.projection);
    assert.equal(calls[0].options.detached, true);
    assert.deepEqual(calls[0].options.execArgv, ["--max-old-space-size=1024"]);
    assert.deepEqual(calls[0].options.stdio, [
      "ignore",
      "ignore",
      "ignore",
      "ipc",
    ]);
    assert.equal(calls[0].options.env.NODE_OPTIONS, undefined);
    assert.equal(calls[0].options.env.NODE_PATH, undefined);
  });
});

test("preflight requires a bounded independent deadline, rejects malformed requests and aborts before spawning", async (t) => {
  await fake(t, success, async (calls) => {
    for (const timeoutMs of [
      undefined,
      0,
      -1,
      7001,
      21600000,
      1.5,
      Infinity,
      "7000",
    ]) {
      await assert.rejects(() => call(deployment, { timeoutMs }), {
        name: "TypeError",
        message: "Source preflight request is invalid.",
      });
    }
    for (const patch of [{ bypass: true }, { signal: {} }, { sourceRef: 1 }]) {
      await assert.rejects(() => call(deployment, patch), {
        name: "TypeError",
        message: "Source preflight request is invalid.",
      });
    }
    assert.deepEqual(await call(deployment, { sourceRef: "HEAD" }), {
      ok: false,
      reason: "source-not-approved",
    });
    const controller = new AbortController();
    controller.abort("PRIVATE_ABORT");
    await assert.rejects(
      () => call(deployment, { signal: controller.signal }),
      { name: "AbortError", message: "Ingestion cancelled." },
    );
    assert.equal(calls.length, 0);
  });
});

test("preflight IPC rejects mismatched source, scope, UID, shape and policy instead of exposing partial metadata", async (t) => {
  for (const response of [
    { ...success, sourceCommit: "d".repeat(40) },
    { ...success, approvedTip: "d".repeat(64) },
    { ...success, objectFormat: "sha256" },
    { ...success, vaultScope: "elsewhere" },
    { ...success, privateText: "PRIVATE" },
    {
      ...success,
      manifest: {
        ...success.manifest,
        vaultUid: "VLT-00000000000000000000000008",
      },
    },
    { ...success, manifest: { ...success.manifest, profile: "2" } },
    { ...success, manifest: { ...success.manifest, hash: "PRIVATE" } },
    { ...success, manifest: { ...success.manifest, privateText: "PRIVATE" } },
    ...[
      [],
      ["unknown"],
      ["public", "public"],
      ["public\n"],
      ["a".repeat(64)],
      Array(1),
      Array(65_537).fill("public"),
      Array.from({ length: 1050 }, (_, i) => `a${String(i).padStart(62, "0")}`),
    ].map((sensitivityClasses) => ({
      ...success,
      manifest: { ...success.manifest, sensitivityClasses },
    })),
    { ok: false, reason: "PRIVATE" },
    { ok: false, reason: "deployment-rejected", privateText: "PRIVATE" },
    {
      ok: true,
      approvedTip: sourceRef,
      projection: { sourceCommit: sourceRef, concepts: [], chunks: [] },
    },
  ])
    await fake(t, response, async () => {
      assert.deepEqual(await call(), { ok: false, reason: "ingestion-error" });
    });
  await fake(t, success, async () => {
    assert.deepEqual(
      await call({
        ...deployment,
        projection: {
          ...deployment.projection,
          approvedSensitivityClasses: ["undeclared"],
        },
      }),
      { ok: false, reason: "sensitivity-policy" },
    );
    assert.equal(
      (
        await call({
          ...deployment,
          projection: {
            ...deployment.projection,
            approvedSensitivityClasses: [],
          },
        })
      ).ok,
      true,
    );
  });
});

test("preflight accepts SHA-256/root scope and manifest-declared classes beyond the deployment approval count", async (t) => {
  const response = {
    ...success,
    sourceCommit: "a".repeat(64),
    approvedTip: "b".repeat(64),
    objectFormat: "sha256",
    vaultScope: "",
    manifest: {
      ...success.manifest,
      sensitivityClasses: [
        "public",
        ...Array.from({ length: 64 }, (_, i) => `class-${i}`),
      ],
    },
  };
  await fake(t, response, async () => {
    assert.deepEqual(
      await call(
        { ...deployment, root: "/repo" },
        { sourceRef: response.sourceCommit },
      ),
      response,
    );
  });
});

test("preflight retains static child failures and a writable host fails the real guard", async (t) => {
  for (const reason of [
    "source-not-approved",
    "manifest-unavailable",
    "sensitivity-policy",
    "deployment-rejected",
    "ingestion-error",
  ]) {
    await fake(t, { ok: false, reason }, async () =>
      assert.deepEqual(await call(), { ok: false, reason }),
    );
  }
  assert.deepEqual(
    await call({
      ...deployment,
      root: process.cwd(),
      repositoryRoot: process.cwd(),
    }),
    { ok: false, reason: "deployment-rejected" },
  );
});

test("preflight timeout is clamped by its request, not the six-hour builder configuration", async (t) => {
  const cp = createRequire(import.meta.url)("node:child_process");
  const mock = t.mock.method(cp, "fork", () => {
    const child = new EventEmitter();
    child.send = (_input, callback) => callback(null);
    // Simulate close after the parent's deadline but before its teardown allowance.
    setTimeout(() => child.emit("close", 0), 7001);
    return child;
  });
  syncBuiltinESMExports();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const pending = call();
    t.mock.timers.tick(7001);
    assert.deepEqual(await pending, { ok: false, reason: "deadline-exceeded" });
  } finally {
    t.mock.timers.reset();
    mock.mock.restore();
    syncBuiltinESMExports();
  }
});
