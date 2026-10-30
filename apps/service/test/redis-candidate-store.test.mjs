import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import { RedisCandidateStore } from "../dist/redis-candidate-store.js";
import { encodeBuildInputRecipe } from "../dist/build-recipe.js";
import { encodeOutputDescriptor } from "../dist/output-descriptor.js";

const vaultUid = "VLT-00000000000000000000000009";
const namespaceKey = randomBytes(32);
const buildId = `bld_${"a".repeat(64)}`;
const jobId = `job_${"0".repeat(26)}`;
const hash = `sha256:${"a".repeat(64)}`;
const spec = {
  vaultUid,
  buildId,
  sourceCommit: "a".repeat(40),
  manifestHash: hash,
  policyHash: hash,
  concepts: 1,
  chunks: 0,
};
const lease = { ownerEpoch: 1, fence: 1, buildId, jobId };
const record = {
  sourceCommit: spec.sourceCommit,
  sourceHash: hash,
  projectionSchemaVersion: "1",
  contentTrust: "untrusted",
};
const code = (expected) => (error) =>
  error.code === expected && error.message === expected;

const recipe = Object.freeze({
  ...encodeBuildInputRecipe({
    vaultUid,
    objectFormat: "sha1",
    sourceCommit: spec.sourceCommit,
    vaultScope: "private/scope",
    profile: "1.0",
    manifestHash: hash,
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
    runtimeArtifactHash: hash,
    embeddingGeneration: null,
  }),
  sourceCommit: spec.sourceCommit,
  configurationEpoch: Number.MAX_SAFE_INTEGER,
});
const inputLease = Object.freeze({
  ...lease,
  buildId: recipe.buildId,
  configurationEpoch: recipe.configurationEpoch,
});
const output = encodeOutputDescriptor({
  recipeHash: recipe.recipeHash,
  canonical: { hash, bytes: 100, records: 1 },
  concepts: { count: 1, hash },
  chunks: {
    count: 0,
    hash: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  },
});

test("v2 claim retains the controller-selected attempt identity before dispatch", async () => {
  let observed;
  const store = new RedisCandidateStore({
    vaultUid,
    namespaceKey,
    execute: async (args) => {
      observed = JSON.parse(args.at(-1));
      return JSON.stringify({
        ok: true,
        created: true,
        lease: {
          ...inputLease,
          configurationEpoch: String(recipe.configurationEpoch),
        },
      });
    },
  });
  assert.equal((await store.claimInput(recipe, jobId)).lease.jobId, jobId);
  assert.equal(observed.jobId, jobId);
});

test("v2 input/descriptor snapshots redact source identity and retain the maximum epoch exactly", async () => {
  const requests = [];
  const store = new RedisCandidateStore({
    vaultUid,
    namespaceKey,
    execute: async (args) => {
      const r = JSON.parse(args.at(-1));
      requests.push(r);
      return JSON.stringify(
        r.op === "start"
          ? { ok: true, epoch: 1 }
          : r.op === "claimInput"
            ? {
                ok: true,
                created: true,
                lease: {
                  ...inputLease,
                  configurationEpoch: String(recipe.configurationEpoch),
                },
              }
            : { ok: true },
      );
    },
  });
  await store.startProcess();
  await store.setConfigurationEpoch(recipe.configurationEpoch);
  const mutable = { ...recipe };
  const pending = store.claimInput(mutable, jobId);
  mutable.sourceCommit = "b".repeat(40);
  assert.deepEqual((await pending).lease, inputLease);
  await store.beginBuilding(inputLease);
  const descriptor = { ...output };
  const attachment = store.attachOutput(inputLease, descriptor);
  descriptor.serialized = "null";
  await attachment;
  const command = JSON.stringify(requests);
  for (const excluded of [vaultUid, "private/scope", recipe.serialized])
    assert.equal(command.includes(excluded), false);
  assert.equal(requests[1].configurationEpoch, "9007199254740991");
  assert.equal(requests[2].spec.configurationEpoch, "9007199254740991");
  assert.equal(requests.at(-1).outputDescriptor, output.serialized);
});

test("v2 rejects hostile, extra, forged and malformed inputs before dispatch", async () => {
  let calls = 0;
  const store = new RedisCandidateStore({
    vaultUid,
    namespaceKey,
    execute: async () => {
      calls++;
    },
  });
  const invalid = /Candidate input is invalid/u;
  for (const epoch of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1", null])
    await assert.rejects(() => store.setConfigurationEpoch(epoch), invalid);
  let touched = false;
  const hostile = new Proxy(recipe, {
    ownKeys() {
      touched = true;
      throw new Error("PRIVATE_MARKER");
    },
  });
  const accessor = { ...recipe };
  Object.defineProperty(accessor, "serialized", {
    get() {
      touched = true;
      throw new Error("PRIVATE_MARKER");
    },
  });
  for (const value of [
    hostile,
    accessor,
    { ...recipe, extra: true },
    { ...recipe, serialized: "null" },
    { ...recipe, sourceCommit: "b".repeat(40) },
    { ...recipe, recipeHash: hash },
    { ...recipe, buildId },
    { ...recipe, configurationEpoch: 0 },
  ])
    await assert.rejects(() => store.claimInput(value, jobId), invalid);
  for (const value of [
    null,
    { ...output, hash },
    { ...output, extra: true },
    { ...output, serialized: "null" },
  ])
    await assert.rejects(() => store.attachOutput(inputLease, value), invalid);
  await assert.rejects(
    () => store.beginBuilding({ ...inputLease, configurationEpoch: 0 }),
    invalid,
  );
  assert.equal(touched, false);
  assert.equal(calls, 0);
});

test("candidate input validation and namespace derivation precede Redis", async () => {
  let calls = 0;
  const execute = async () => {
    calls++;
    return JSON.stringify({ ok: true, epoch: 1 });
  };
  const store = new RedisCandidateStore({ vaultUid, namespaceKey, execute });
  assert.match(store.namespace, /^bk:v1:v:[a-f0-9]{64}:$/u);
  assert.throws(() => {
    store.namespace = "bk:v1:v:foreign:";
  }, TypeError);
  assert.equal(
    new RedisCandidateStore({ vaultUid, namespaceKey, execute }).namespace,
    store.namespace,
  );
  assert.notEqual(
    new RedisCandidateStore({
      vaultUid: "VLT-00000000000000000000000008",
      namespaceKey,
      execute,
    }).namespace,
    store.namespace,
  );
  assert.throws(
    () =>
      new RedisCandidateStore({
        vaultUid,
        namespaceKey: new Uint8Array(31),
        execute,
      }),
    /Candidate input is invalid/u,
  );
  for (const change of [
    { sourceCommit: "HEAD" },
    { concepts: 50001 },
    { chunks: 250001 },
    { vaultUid: "VLT-00000000000000000000000008" },
    { buildId: `${buildId}\n` },
    { extra: true },
  ]) {
    await assert.rejects(
      () => store.claim({ ...spec, ...change }),
      /Candidate input is invalid/u,
    );
  }
  await assert.rejects(
    () => store.readJob("../../foreign"),
    /Candidate input is invalid/u,
  );
  for (const entries of [
    [],
    Array(129).fill(record),
    [{ ...record, contentTrust: "trusted" }],
    [{ ...record, text: "x".repeat(1048576) }],
  ]) {
    await assert.rejects(
      () => store.append(lease, "concept", 0, entries),
      /Candidate input is invalid/u,
    );
  }
  assert.equal(calls, 0);
});

test("candidate calls snapshot inputs and pass a bounded cancellation signal", async () => {
  const commands = [];
  const store = new RedisCandidateStore({
    vaultUid,
    namespaceKey,
    execute: async (command, signal) => {
      assert.ok(signal instanceof AbortSignal);
      assert.equal(signal.aborted, false);
      commands.push(command);
      const request = JSON.parse(command.at(-1));
      return JSON.stringify(
        request.op === "start"
          ? { ok: true, epoch: 1 }
          : { ok: true, created: true, lease },
      );
    },
  });
  await store.startProcess();
  const mutable = { ...spec };
  const pending = store.claim(mutable);
  mutable.sourceCommit = "b".repeat(40);
  assert.equal((await pending).lease.buildId, buildId);
  assert.equal(commands[1][0], "EVAL");
  assert.equal(commands[1][2], "1");
  assert.equal(commands[1][3], store.namespace);
  const request = JSON.parse(commands[1].at(-1));
  assert.equal(request.spec.sourceCommit, spec.sourceCommit);
  assert.equal("vaultUid" in request.spec, false);
  assert.equal(request.epoch, 1);
});

test("appending snapshots a caller-owned batch before asynchronous dispatch", async () => {
  const store = new RedisCandidateStore({
    vaultUid,
    namespaceKey,
    execute: async (command) => {
      const request = JSON.parse(command.at(-1));
      return JSON.stringify(
        request.op === "start"
          ? { ok: true, epoch: 1 }
          : { ok: true, next: request.offset + request.records.length },
      );
    },
  });
  await store.startProcess();
  const batch = [{ ...record }];
  const pending = store.append(lease, "concept", 0, batch);
  batch.length = 0;
  assert.equal(await pending, 1);
});

test("Redis errors and malformed replies never expose dependency text", async () => {
  for (const value of [
    "PRIVATE_MARKER",
    JSON.stringify({ ok: true, epoch: "PRIVATE_MARKER" }),
    JSON.stringify({ ok: false, code: "PRIVATE_MARKER" }),
    "x".repeat(4097),
    null,
  ]) {
    const store = new RedisCandidateStore({
      vaultUid,
      namespaceKey,
      execute: async () => value,
    });
    await assert.rejects(() => store.startProcess(), code("INDEX_UNAVAILABLE"));
  }
  const store = new RedisCandidateStore({
    vaultUid,
    namespaceKey,
    execute: async () => {
      throw new Error("PRIVATE_MARKER");
    },
  });
  await assert.rejects(() => store.startProcess(), code("INDEX_UNAVAILABLE"));
});

test("unusable mutation acknowledgements are unknown, and legacy claims never accept a v2 lease", async () => {
  const store = new RedisCandidateStore({
    vaultUid,
    namespaceKey,
    execute: async (args) => {
      const r = JSON.parse(args.at(-1));
      return JSON.stringify(
        r.op === "claim"
          ? {
              ok: true,
              created: false,
              lease: { ...lease, configurationEpoch: 1 },
            }
          : { ok: true },
      );
    },
  });
  for (const action of [
    () => store.startProcess(),
    () => store.claim(spec),
    () => store.claimInput(recipe, jobId),
    () => store.append(lease, "concept", 0, [record]),
    () => store.cleanup(jobId),
    () => store.fail(lease, "INTERNAL"),
    () => store.requestCancel(jobId),
  ])
    await assert.rejects(
      action,
      (error) =>
        code("INDEX_UNAVAILABLE")(error) && error.outcome === "unknown",
    );
});

test("dispatched mutations explicitly retain unknown outcome without replay, including late replies", async () => {
  let calls = 0;
  let settle;
  const store = new RedisCandidateStore({
    vaultUid,
    namespaceKey,
    operationTimeoutMs: 10,
    execute: async () => {
      calls++;
      return await new Promise((resolve) => {
        settle = resolve;
      });
    },
  });
  await assert.rejects(
    () => store.startProcess(),
    (error) => code("INDEX_UNAVAILABLE")(error) && error.outcome === "unknown",
  );
  settle(JSON.stringify({ ok: true, epoch: 1 }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  const cancel = new AbortController();
  const pending = store.startProcess(cancel.signal);
  await new Promise((resolve) => setImmediate(resolve));
  cancel.abort("PRIVATE_MARKER");
  await assert.rejects(
    () => pending,
    (error) =>
      error.name === "AbortError" &&
      error.outcome === "unknown" &&
      !error.message.includes("PRIVATE_MARKER"),
  );
  settle(JSON.stringify({ ok: true, epoch: 2 }));
  assert.equal(calls, 2);
});

test("deadline and cancellation fail observably even if the adapter ignores its signal", async () => {
  let calls = 0;
  let capturedSignal;
  const store = new RedisCandidateStore({
    vaultUid,
    namespaceKey,
    operationTimeoutMs: 10,
    execute: async (_args, signal) => {
      calls++;
      capturedSignal = signal;
      return await new Promise(() => {});
    },
  });
  await assert.rejects(() => store.startProcess(), code("INDEX_UNAVAILABLE"));
  assert.equal(capturedSignal.aborted, true);
  assert.equal(calls, 1);
  const controller = new AbortController();
  controller.abort("PRIVATE_MARKER");
  await assert.rejects(
    () => store.startProcess(controller.signal),
    (error) =>
      error.name === "AbortError" && !error.message.includes("PRIVATE_MARKER"),
  );
  assert.equal(calls, 1);
  const active = new AbortController();
  const pending = store.startProcess(active.signal);
  queueMicrotask(() => active.abort("PRIVATE_MARKER"));
  await assert.rejects(
    () => pending,
    (error) =>
      error.name === "AbortError" && !error.message.includes("PRIVATE_MARKER"),
  );
});
