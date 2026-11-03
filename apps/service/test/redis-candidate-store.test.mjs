import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import { RedisCandidateStore } from "../dist/redis-candidate-store.js";
import { encodeBuildInputRecipe } from "../dist/build-recipe.js";
import { encodeOutputDescriptor } from "../dist/output-descriptor.js";

import {
  conceptFor,
  chunkFor,
  storedRecipe,
  storedDescriptor,
} from "./helpers/stored-output-fixture.mjs";

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

test("stored-output requests reject malformed budgets and pre-abort without a read", async () => {
  let calls = 0;
  const store = new RedisCandidateStore({
    vaultUid,
    namespaceKey,
    execute: async () => {
      calls++;
    },
  });
  const r = storedRecipe(vaultUid);
  const owner = { ...inputLease, buildId: r.buildId, configurationEpoch: 1 };
  const d = storedDescriptor(r, [conceptFor(r)], [chunkFor(r)]);
  for (const timeoutMs of [undefined, 0, -1, 1.5, 21600001, "1"])
    await assert.rejects(
      () => store.verifyStoredOutput(owner, r, d, { timeoutMs }),
      /Candidate input is invalid/u,
    );
  const abort = new AbortController();
  abort.abort("PRIVATE_REASON");
  await assert.rejects(
    () =>
      store.verifyStoredOutput(owner, r, d, {
        timeoutMs: 21600000,
        signal: abort.signal,
      }),
    { name: "AbortError", message: "Candidate operation cancelled." },
  );
  assert.equal(calls, 0);
});

function verifierHarness(transform = (reply) => reply, options = {}) {
  const r = storedRecipe(vaultUid);
  const owner = { ...inputLease, buildId: r.buildId, configurationEpoch: 1 };
  const concepts = [conceptFor(r)],
    chunks = [chunkFor(r)];
  const descriptor = storedDescriptor(r, concepts, chunks);
  const calls = [];
  const execute = async (args, signal) => {
    const request = JSON.parse(args.at(-1));
    calls.push(request);
    let reply;
    if (request.op === "storedPage") {
      const rows = (request.kind === "concept" ? concepts : chunks).map(
        JSON.stringify,
      );
      reply = [
        JSON.stringify({
          ok: true,
          kind: request.kind,
          offset: request.offset,
          next: request.offset + rows.length,
          rawBytes: rows.reduce((n, v) => n + Buffer.byteLength(v), 0),
        }),
        ...rows,
      ];
    } else if (request.op === "storedInventory")
      reply = [
        JSON.stringify({ ok: true, cursor: request.cursor, next: "0" }),
        "manifest",
        "concept:0",
        "chunk:0",
      ];
    else if (request.op === "storedFinish")
      reply = [JSON.stringify({ ok: true })];
    else throw new Error("unexpected operation");
    return await transform(reply, request, signal);
  };
  const store = new RedisCandidateStore({
    vaultUid,
    namespaceKey,
    execute,
    ...options,
  });
  return {
    store,
    owner,
    recipe: r,
    descriptor,
    calls,
    verify: (request = { timeoutMs: 10000 }) =>
      store.verifyStoredOutput(owner, r, descriptor, request),
  };
}

test("actual native strings are measured in order and all verifier inputs snapshot before dispatch", async () => {
  const h = verifierHarness();
  const owner = { ...h.owner },
    r = { ...h.recipe },
    d = { ...h.descriptor },
    options = { timeoutMs: 10000 };
  const pending = h.store.verifyStoredOutput(owner, r, d, options);
  owner.fence = 100;
  r.serialized = "null";
  d.serialized = "null";
  options.timeoutMs = 0;
  const result = await pending;
  assert.deepEqual(result.lease, h.owner);
  assert.equal(result.descriptorHash, h.descriptor.hash);
  assert.equal(result.concepts.count, 1);
  assert.deepEqual(
    h.calls.map((r) => r.op),
    ["storedPage", "storedPage", "storedInventory", "storedFinish"],
  );
  for (const request of h.calls) {
    assert.equal(request.lease.fence, 1);
    assert.equal(request.outputDescriptor, h.descriptor.serialized);
    assert.equal(JSON.stringify(request).includes(vaultUid), false);
  }
});

test("hostile closed verifier inputs and unsupported recipes never execute getters or Redis", async () => {
  const h = verifierHarness();
  let touched = false;
  const hostile = (value) =>
    new Proxy(value, {
      ownKeys() {
        touched = true;
        throw new Error("PRIVATE");
      },
    });
  const getter = { ...h.descriptor };
  Object.defineProperty(getter, "serialized", {
    get() {
      touched = true;
      throw new Error("PRIVATE");
    },
  });
  for (const [owner, suppliedRecipe, descriptor, options] of [
    [hostile(h.owner), h.recipe, h.descriptor, { timeoutMs: 100 }],
    [h.owner, hostile(h.recipe), h.descriptor, { timeoutMs: 100 }],
    [h.owner, h.recipe, getter, { timeoutMs: 100 }],
    [h.owner, h.recipe, h.descriptor, hostile({ timeoutMs: 100 })],
    [h.owner, h.recipe, h.descriptor, { timeoutMs: 100, extra: true }],
    [h.owner, h.recipe, h.descriptor, { timeoutMs: 100, signal: {} }],
    [h.owner, h.recipe, { ...h.descriptor, hash }, { timeoutMs: 100 }],
    [h.owner, recipe, h.descriptor, { timeoutMs: 100 }],
  ])
    await assert.rejects(
      () =>
        h.store.verifyStoredOutput(owner, suppliedRecipe, descriptor, options),
      { name: "TypeError", message: "Candidate input is invalid." },
    );
  assert.equal(touched, false);
  assert.equal(h.calls.length, 0);
});

test("malicious payload pages, envelopes, encoding and progression are static read failures", async () => {
  const corruptions = [
    () => null,
    () => "PRIVATE_DEPENDENCY",
    () => JSON.stringify({ ok: true }),
    () => ["x".repeat(4097)],
    () => [JSON.stringify({ ok: true }), ...Array(129).fill("{}")],
    () => [JSON.stringify({ ok: true }), "x".repeat(6 * 1048576 + 1)],
    (reply) => {
      reply[1] = "null";
      return reply;
    },
    (reply) => {
      reply[1] = "{bad JSON PRIVATE";
      return reply;
    },
    (reply) => {
      reply[1] = '{"uid":"\\ud800"}';
      return reply;
    },
    (reply) => {
      reply[1] = '{"tags":' + "[".repeat(64) + "0" + "]".repeat(64) + "}";
      return reply;
    },
    (reply) => {
      const p = JSON.parse(reply[0]);
      p.next = p.offset;
      reply[0] = JSON.stringify(p);
      return reply;
    },
    (reply) => {
      const p = JSON.parse(reply[0]);
      p.offset++;
      reply[0] = JSON.stringify(p);
      return reply;
    },
    (reply) => {
      const p = JSON.parse(reply[0]);
      p.next++;
      reply[0] = JSON.stringify(p);
      return reply;
    },
    (reply) => {
      const p = JSON.parse(reply[0]);
      p.kind = "chunk";
      reply[0] = JSON.stringify(p);
      return reply;
    },
    (reply) => {
      const p = JSON.parse(reply[0]);
      p.rawBytes++;
      reply[0] = JSON.stringify(p);
      return reply;
    },
    (reply) => {
      reply.pop();
      return reply;
    },
    (reply) => {
      reply.extra = "PRIVATE";
      return reply;
    },
  ];
  for (const corrupt of corruptions) {
    const h = verifierHarness((reply, r) =>
      r.op === "storedPage" ? corrupt(reply) : reply,
    );
    await assert.rejects(
      () => h.verify(),
      (error) =>
        code("INDEX_UNAVAILABLE")(error) && error.outcome === undefined,
    );
    assert.equal(h.calls.length, 1);
  }
});

test("raw expansion and metadata budgets accept exact endpoints and reject one byte beyond", async () => {
  for (const extra of [0, 1]) {
    const h = verifierHarness((reply, r) => {
      if (r.op !== "storedPage") return reply;
      const metadata = JSON.parse(reply[0]);
      const raw =
        reply[1] +
        " ".repeat(6 * 1048576 + extra - Buffer.byteLength(reply[1]));
      metadata.rawBytes = Buffer.byteLength(raw);
      return [JSON.stringify(metadata), raw];
    });
    if (extra)
      await assert.rejects(() => h.verify(), code("INDEX_UNAVAILABLE"));
    else assert.equal((await h.verify()).chunks.count, 1);
    const metadata = verifierHarness((reply) => [
      reply[0] + " ".repeat(4096 + extra - Buffer.byteLength(reply[0])),
      ...reply.slice(1),
    ]);
    if (extra)
      await assert.rejects(() => metadata.verify(), code("INDEX_UNAVAILABLE"));
    else assert.equal((await metadata.verify()).concepts.count, 1);
  }
});

test("inventory requires exhaustion, unique in-range records and bounded progressing cursors", async () => {
  for (const corrupt of [
    (reply) => {
      const p = JSON.parse(reply[0]);
      p.cursor = "skipped";
      reply[0] = JSON.stringify(p);
      return reply;
    },
    (reply) => {
      const p = JSON.parse(reply[0]);
      p.next = "00";
      reply[0] = JSON.stringify(p);
      return reply;
    },
    (reply) => {
      const p = JSON.parse(reply[0]);
      p.next = "18446744073709551616";
      reply[0] = JSON.stringify(p);
      return reply;
    },
    (reply) => {
      reply.pop();
      return reply;
    },
    (reply) => {
      reply.push("concept:0");
      return reply;
    },
    (reply) => {
      reply[1] = "concept:99999";
      return reply;
    },
    (reply) => {
      reply[1] = "concept:00";
      return reply;
    },
    (reply) => {
      reply[1] = "unknown:0";
      return reply;
    },
    (reply) => {
      reply[1] = "x".repeat(4096);
      return reply;
    },
    () => [JSON.stringify({ ok: true, cursor: "0", next: "1" })],
  ]) {
    const h = verifierHarness((reply, r) =>
      r.op === "storedInventory" ? corrupt(reply) : reply,
    );
    await assert.rejects(
      () => h.verify(),
      (error) =>
        code("INDEX_UNAVAILABLE")(error) && error.outcome === undefined,
    );
    assert.ok(h.calls.length <= 4);
    assert.equal(
      h.calls.some((r) => r.op === "storedFinish"),
      false,
    );
  }
  // Endless, distinct cursors/empty pages must hit the fixed iteration ceiling,
  // not use COUNT as proof of completion or rely on a long wall-clock timeout.
  let pages = 0;
  const h = verifierHarness((reply, r) =>
    r.op === "storedInventory"
      ? [JSON.stringify({ ok: true, cursor: r.cursor, next: String(++pages) })]
      : reply,
  );
  await assert.rejects(
    () => h.verify({ timeoutMs: 21600000 }),
    code("INDEX_UNAVAILABLE"),
  );
  assert.equal(pages, 16384);
});

test("abort/deadline settle promptly with no late hash, continuation, retry or partial reuse", async () => {
  for (const stage of ["storedPage", "storedInventory", "storedFinish"]) {
    for (const cause of ["abort", "deadline", "call-cap"]) {
      let late, entered;
      const reached = new Promise((resolve) => {
        entered = resolve;
      });
      let stalled = true;
      const h = verifierHarness(
        async (reply, request, signal) => {
          if (!stalled || request.op !== stage) return reply;
          entered(signal);
          return await new Promise((resolve) => {
            late = () => resolve(reply);
          });
        },
        { operationTimeoutMs: cause === "call-cap" ? 10 : 2000 },
      );
      const abort = new AbortController();
      const pending = h.verify({
        timeoutMs: cause === "deadline" ? 20 : 10000,
        signal: abort.signal,
      });
      const rejected = assert.rejects(pending, (error) =>
        cause === "abort"
          ? error.name === "AbortError" &&
            error.message === "Candidate operation cancelled." &&
            error.outcome === undefined
          : code("INDEX_UNAVAILABLE")(error) && error.outcome === undefined,
      );
      const signal = await reached;
      if (cause === "abort") abort.abort("PRIVATE_ABORT");
      await rejected;
      assert.equal(signal.aborted, true);
      const calls = h.calls.length;
      late();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(h.calls.length, calls);
      stalled = false;
      assert.equal(
        (await h.verify()).concepts.count,
        1,
        "a new invocation reads/hashes from zero",
      );
      assert.equal(h.calls[calls].op, "storedPage");
      assert.equal(h.calls[calls].offset, 0);
    }
  }
});

test("final ownership/reply failure discards measured hashes without mutating anything", async () => {
  for (const final of [
    JSON.stringify({ ok: false, code: "FENCED" }),
    [JSON.stringify({ ok: true }), "PRIVATE_EXTRA"],
    [JSON.stringify({ ok: true, extra: true })],
  ]) {
    const h = verifierHarness((reply, r) =>
      r.op === "storedFinish" ? final : reply,
    );
    await assert.rejects(
      () => h.verify(),
      (error) =>
        ["FENCED", "INDEX_UNAVAILABLE"].includes(error.code) &&
        error.outcome === undefined,
    );
    assert.equal(h.calls.at(-1).op, "storedFinish");
  }
});

test("owner-epoch reconciliation reads live ownership and current job without dispatching a mutation", async () => {
  const requests = [];
  const publicJob = {
    jobId,
    buildId: inputLease.buildId,
    sourceCommit: spec.sourceCommit,
    state: "building",
    failureCode: null,
  };
  const manifest = {
    manifestVersion: 2,
    lease: {
      ...inputLease,
      configurationEpoch: String(recipe.configurationEpoch),
    },
    sourceCommit: spec.sourceCommit,
    manifestHash: hash,
    policyHash: hash,
    recipeHash: recipe.recipeHash,
    state: "building",
    nextConcept: 0,
    nextChunk: 0,
    cleanupConcept: 0,
    cleanupChunk: 0,
  };
  const store = new RedisCandidateStore({
    vaultUid,
    namespaceKey,
    execute: async (args) => {
      const request = JSON.parse(args.at(-1));
      requests.push(request);
      return JSON.stringify(
        request.op === "current"
          ? { ok: true, job: publicJob }
          : { ok: true, job: publicJob, manifest, live: true },
      );
    },
  });
  assert.deepEqual(await store.readCurrentJob(), publicJob);
  const observed = await store.inspectInput(jobId);
  assert.deepEqual(observed.job, publicJob);
  assert.equal(observed.manifest.lease.ownerEpoch, 1);
  assert.equal(observed.live, true);
  assert.deepEqual(
    requests.map((r) => r.op),
    ["current", "inspect"],
  );
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

test("well-shaped replies for a different job or build cannot prove the requested terminal transition", async () => {
  for (const patch of [
    { jobId: "job_" + "1".repeat(26) },
    { buildId: "bld_" + "b".repeat(64) },
  ]) {
    const store = new RedisCandidateStore({
      vaultUid,
      namespaceKey,
      execute: async () =>
        JSON.stringify({
          ok: true,
          job: {
            jobId,
            buildId,
            sourceCommit: spec.sourceCommit,
            state: "failed",
            failureCode: "INTERNAL",
            ...patch,
          },
        }),
    });
    for (const action of [
      () => store.fail(lease, "INTERNAL"),
      () => store.acknowledgeCancel(lease),
    ])
      await assert.rejects(
        action,
        (error) =>
          code("INDEX_UNAVAILABLE")(error) && error.outcome === "unknown",
      );
    if (patch.jobId) {
      await assert.rejects(
        () => store.readJob(jobId),
        code("INDEX_UNAVAILABLE"),
      );
      await assert.rejects(
        () => store.requestCancel(jobId),
        (error) =>
          code("INDEX_UNAVAILABLE")(error) && error.outcome === "unknown",
      );
    }
  }
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
