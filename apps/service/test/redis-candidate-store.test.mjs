import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import { RedisCandidateStore } from "../dist/redis-candidate-store.js";

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
