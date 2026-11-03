import assert from "node:assert/strict";
import test from "node:test";
import { CandidateStoreError } from "../dist/redis-candidate-store.js";
import {
  authorization,
  commit,
  configuration,
  recipeFor,
  outputFor,
  deferred,
  turn,
  MemoryCandidateStore,
} from "./helpers/controller-fixture.mjs";

import {
  conceptFor,
  chunkFor,
  stream,
} from "./helpers/stored-output-fixture.mjs";

const code = (expected) => (error) =>
  error.code === expected && error.message === expected;
async function harness(t, changes = {}) {
  const { OwnedRebuildController } =
    await import("../dist/rebuild-controller.js");
  const config = configuration();
  const stores = new Map(
    config.sources.map((s) => [
      s.handle,
      new MemoryCandidateStore(s.projection.vaultUid),
    ]),
  );
  let launches = 0;
  const builder = {
    async preflight(request) {
      return {
        ok: true,
        recipe: recipeFor(
          controller.configuration,
          request.vault,
          request.sourceRef,
        ),
      };
    },
    async build(recipe, { signal }) {
      launches++;
      assert.equal(signal.aborted, false);
      return { ok: true, output: outputFor(recipe) };
    },
    ...changes,
  };
  const controller = new OwnedRebuildController({
    configuration: config,
    builder,
    stores,
  });
  t.after(() => controller.shutdown());
  const startup = deferred();
  const starting = controller.start(async () => await startup.promise);
  await turn();
  assert.equal(
    controller.ready,
    false,
    "Redis fences alone cannot prove old process death",
  );
  startup.resolve();
  await starting;
  return {
    controller,
    stores,
    builder,
    launches: () => launches,
    submit: (vault = "alpha", signal) =>
      controller.submit({
        authorization,
        vault,
        sourceRef: commit,
        ...(signal ? { signal } : {}),
      }),
  };
}

test("owned payload sequence waits for S5 and original attachment before sequential concepts/chunks and measured verification", async (t) => {
  const build = deferred(),
    built = deferred(),
    attached = deferred(),
    attachReply = deferred();
  let output, acceptedSignal;
  const h = await harness(t, {
    async build(recipe, { signal }) {
      acceptedSignal = signal;
      output = outputFor(
        recipe,
        Array.from({ length: 129 }, (_, i) =>
          conceptFor(recipe, { title: `Concept ${i}` }),
        ),
        [chunkFor(recipe, 0), chunkFor(recipe, 1)],
      );
      built.resolve();
      await build.promise;
      return { ok: true, output };
    },
  });
  const store = h.stores.get("alpha");
  const appends = [],
    verified = deferred();
  const append = store.append?.bind(store),
    verify = store.verifyStoredOutput?.bind(store);
  store.append = async (...args) => {
    appends.push(args);
    return await append(...args);
  };
  store.verifyStoredOutput = async (...args) => {
    assert.equal(args[1], output.recipe);
    assert.equal(args[2], output.outputDescriptor);
    assert.equal(args[3].signal, acceptedSignal);
    assert.ok(
      Number.isInteger(args[3].timeoutMs) &&
        args[3].timeoutMs > 0 &&
        args[3].timeoutMs <= 21600000,
    );
    const result = await verify(...args);
    verified.resolve(result);
    return result;
  };
  store.reply = async (op, value) => {
    if (op === "attach") {
      attached.resolve();
      await attachReply.promise;
    }
    return value;
  };
  const job = await h.submit();
  await built.promise;
  assert.equal(appends.length, 0);
  assert.equal(store.calls.includes("verify"), false);
  build.resolve();
  await attached.promise;
  assert.equal(appends.length, 0);
  assert.equal(store.calls.includes("verify"), false);
  attachReply.resolve();
  await turn();
  await turn();
  assert.equal(
    store.calls.includes("verify"),
    true,
    "the owned continuation invokes storage measurement",
  );
  const measurement = await verified.promise;
  assert.deepEqual(
    appends.map((a) => [a[1], a[2], a[3].length]),
    [
      ["concept", 0, 128],
      ["concept", 128, 1],
      ["chunk", 0, 2],
    ],
  );
  assert.deepEqual(
    appends.flatMap((a) => (a[1] === "concept" ? a[3] : [])),
    output.concepts,
  );
  assert.deepEqual(
    appends.flatMap((a) => (a[1] === "chunk" ? a[3] : [])),
    output.chunks,
  );
  for (const args of appends) assert.equal(args[0], measurement.lease);
  assert.deepEqual(measurement.concepts, {
    count: 129,
    hash: stream(output.concepts),
  });
  assert.deepEqual(measurement.chunks, {
    count: 2,
    hash: stream(output.chunks),
  });
  assert.equal((await store.readJob(job.jobId)).state, "building");
  assert.equal((await h.submit()).jobId, job.jobId);
  assert.equal(appends.length, 3);
  await assert.rejects(h.submit("beta"), code("RATE_LIMITED"));
});

for (const outcome of [
  "rejected",
  "committed-lost",
  "bad-next",
  "corrupt-storage",
])
  test(`post-S5 ${outcome} retires safely without replay or CPU quarantine`, async (t) => {
    const h = await harness(t, {
      async build(recipe) {
        return {
          ok: true,
          output: outputFor(recipe, [conceptFor(recipe)], []),
        };
      },
    });
    const store = h.stores.get("alpha");
    let appends = 0,
      verifies = 0;
    const append = store.append?.bind(store),
      verify = store.verifyStoredOutput?.bind(store);
    store.append = async (...args) => {
      appends++;
      if (outcome === "rejected") throw new CandidateStoreError("FENCED");
      const next = await append(...args);
      if (outcome === "committed-lost")
        throw new CandidateStoreError("INDEX_UNAVAILABLE", "unknown");
      if (outcome === "bad-next") return next + 1;
      return next;
    };
    store.verifyStoredOutput = async (...args) => {
      verifies++;
      store.payloads.get(args[0].jobId).concept.set(0, {
        ...conceptFor(args[1]),
        title: "STORAGE_ONLY_TAMPER",
      });
      return await verify(...args);
    };
    const job = await h.submit();
    await turn();
    await turn();
    const status = await store.readJob(job.jobId);
    assert.equal(status.state, "failed");
    assert.equal(status.failureCode, "DEPENDENCY_FAILED");
    assert.equal(appends, 1);
    assert.equal(verifies, outcome === "corrupt-storage" ? 1 : 0);
    assert.equal(store.manifests.has(job.jobId), false);
    assert.equal(store.payloads.has(job.jobId), false);
    assert.equal(h.controller.ready, true);
    await h.controller.shutdown();
    assert.equal(appends, 1);
  });

for (const [title, expectedSizes] of [
  ["x".repeat(600000), undefined],
  ['café 😀 \\"\\\\\\n\\t\\0'.repeat(100), undefined],
])
  test("writer uses actual UTF-8 JSON record bytes, not LF/envelope/character counts", async (t) => {
    let output;
    const h = await harness(t, {
      async build(recipe) {
        const exact = conceptFor(recipe, { title: "" });
        exact.title = "x".repeat(
          1048576 - Buffer.byteLength(JSON.stringify(exact)),
        );
        output = outputFor(recipe, [exact, conceptFor(recipe, { title })], []);
        return { ok: true, output };
      },
    });
    const store = h.stores.get("alpha"),
      batches = [];
    const append = store.append?.bind(store);
    store.append = async (...args) => {
      batches.push(args[3]);
      return await append(...args);
    };
    await h.submit();
    await turn();
    await turn();
    assert.equal(store.calls.includes("verify"), true);
    assert.equal(
      Buffer.byteLength(JSON.stringify(output.concepts[0])),
      1048576,
    );
    assert.equal(
      Buffer.byteLength(JSON.stringify(output.concepts[0]) + "\n"),
      1048577,
    );
    assert.deepEqual(
      batches.map((rows) => rows.length),
      expectedSizes ?? [1, 1],
    );
  });

for (const position of [0, 128])
  test(`oversized record at ${position} fails whole attempt and cleans acknowledged ranges`, async (t) => {
    const h = await harness(t, {
      async build(recipe) {
        const large = conceptFor(recipe, { title: "" });
        large.title = "x".repeat(
          1048577 - Buffer.byteLength(JSON.stringify(large)),
        );
        const rows = Array.from({ length: position }, () => conceptFor(recipe));
        rows.push(large);
        return { ok: true, output: outputFor(recipe, rows, []) };
      },
    });
    const store = h.stores.get("alpha");
    const job = await h.submit();
    await turn();
    await turn();
    assert.equal(
      (await store.readJob(job.jobId)).failureCode,
      "LIMIT_EXCEEDED",
    );
    assert.equal(store.calls.includes("verify"), false);
    assert.equal(store.manifests.has(job.jobId), false);
    assert.equal(h.controller.ready, true);
  });

for (const phase of [
  "attach",
  "concept-batch",
  "concept-end",
  "chunk-end",
  "verify-page",
  "verify-final",
])
  for (const invalidation of [
    "cancel",
    "reload",
    "shutdown",
    "expiry",
    "renewal-loss",
    "restart",
  ])
    test(`${invalidation} invalidates ${phase} continuation before any further dispatch`, async (t) => {
      const { performance } = await import("node:perf_hooks");
      let now = 0;
      t.mock.method(performance, "now", () => now);
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const entered = deferred(),
        late = deferred();
      let held = false;
      const h = await harness(t, {
        async build(recipe) {
          return {
            ok: true,
            output: outputFor(
              recipe,
              Array.from({ length: 129 }, () => conceptFor(recipe)),
              [chunkFor(recipe)],
            ),
          };
        },
      });
      const store = h.stores.get("alpha");
      if (phase === "verify-page") {
        store.reply = async (op, value) => {
          if (op === "verifyPage" && !held) {
            held = true;
            entered.resolve();
            await late.promise;
          }
          return value;
        };
      } else {
        const method =
          phase === "attach"
            ? "attachOutput"
            : phase.startsWith("verify")
              ? "verifyStoredOutput"
              : "append";
        const original = store[method].bind(store);
        store[method] = async (...args) => {
          const value = await original(...args);
          const matches =
            phase === "attach" ||
            phase === "verify-final" ||
            (phase === "concept-batch" &&
              args[1] === "concept" &&
              args[2] === 0) ||
            (phase === "concept-end" &&
              args[1] === "concept" &&
              args[2] === 128) ||
            (phase === "chunk-end" && args[1] === "chunk");
          if (matches && !held) {
            held = true;
            entered.resolve();
            await late.promise;
            // Exercise stale success AND stale rejection without error leakage.
            if (invalidation === "reload" || invalidation === "renewal-loss")
              throw Error("PRIVATE_LATE_STORAGE");
          }
          return value;
        };
      }
      const job = await h.submit();
      await entered.promise;
      if (invalidation === "cancel")
        await h.controller.cancel({ authorization, jobId: job.jobId });
      else if (invalidation === "reload") {
        const publication = h.controller.reload(configuration(2));
        await turn();
        t.mock.timers.tick(2500);
        await publication;
      } else if (invalidation === "shutdown") await h.controller.shutdown();
      else {
        if (invalidation === "restart") await store.startProcess();
        if (invalidation !== "expiry")
          store.manifests.get(job.jobId).live = false;
        now = invalidation === "expiry" ? 21600000 : 10000;
        t.mock.timers.tick(now);
      }
      await turn();
      await turn();
      const appends = store.calls.filter((op) => op === "append").length;
      const verifies = store.calls.filter(
        (op) => op === "verify" || op === "verifyPage",
      ).length;
      let beta;
      if (!["shutdown"].includes(invalidation)) {
        assert.equal(h.controller.ready, true);
        beta = await h.submit("beta");
        await turn();
      }
      late.resolve();
      await turn();
      await turn();
      assert.equal(store.calls.filter((op) => op === "append").length, appends);
      assert.equal(
        store.calls.filter((op) => op === "verify" || op === "verifyPage")
          .length,
        verifies,
      );
      if (beta) {
        assert.equal(h.controller.ready, true);
        assert.equal(
          (await h.stores.get("beta").readJob(beta.jobId)).state,
          "building",
        );
        await assert.rejects(h.submit("alpha"), code("RATE_LIMITED"));
      }
      if (invalidation === "expiry")
        assert.equal(
          (await store.readJob(job.jobId)).failureCode,
          "LIMIT_EXCEEDED",
        );
      await h.controller.shutdown();
      t.mock.timers.reset();
    });

test("verification exceeds two seconds in total and renewal persists during writes, verification and building hold", async (t) => {
  const { performance } = await import("node:perf_hooks");
  let now = 1000;
  t.mock.method(performance, "now", () => now);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const appended = deferred(),
    write = deferred(),
    verifying = deferred(),
    read = deferred();
  let options;
  const h = await harness(t, {
    async build(recipe) {
      now += 500;
      return { ok: true, output: outputFor(recipe, [conceptFor(recipe)], []) };
    },
  });
  const store = h.stores.get("alpha"),
    append = store.append.bind(store),
    verify = store.verifyStoredOutput.bind(store);
  store.append = async (...args) => {
    const value = await append(...args);
    appended.resolve();
    await write.promise;
    return value;
  };
  store.verifyStoredOutput = async (...args) => {
    options = args[3];
    verifying.resolve();
    await read.promise;
    return await verify(...args);
  };
  const job = await h.submit();
  await appended.promise;
  now += 10000;
  t.mock.timers.tick(10000);
  await turn();
  assert.equal(store.calls.filter((op) => op === "renew").length, 1);
  write.resolve();
  await verifying.promise;
  assert.ok(options.timeoutMs <= 21600000 - 10500);
  now += 10000;
  t.mock.timers.tick(10000);
  await turn();
  assert.equal(
    options.signal.aborted,
    false,
    "whole verifier is not a single two-second RPC",
  );
  assert.equal(store.calls.filter((op) => op === "renew").length, 2);
  read.resolve();
  await turn();
  now += 10000;
  t.mock.timers.tick(10000);
  await turn();
  assert.equal(store.calls.filter((op) => op === "renew").length, 3);
  assert.equal((await store.readJob(job.jobId)).state, "building");
  await h.controller.shutdown();
  t.mock.timers.reset();
});

test("batch lookahead remains bounded while acknowledgement is held; aggregate bytes split without cloning", async (t) => {
  let encoded = 0,
    output;
  const held = deferred(),
    release = deferred();
  const h = await harness(t, {
    async build(recipe) {
      const rows = Array.from({ length: 2000 }, () => conceptFor(recipe));
      output = outputFor(recipe, rows, []);
      // Test-only serialization counters are installed AFTER independent evidence.
      for (const row of rows)
        Object.defineProperty(row, "toJSON", {
          enumerable: false,
          value() {
            encoded++;
            return { ...this };
          },
        });
      return { ok: true, output };
    },
  });
  const store = h.stores.get("alpha"),
    append = store.append.bind(store);
  let first = true;
  store.append = async (...args) => {
    const next = await append(...args);
    if (first) {
      first = false;
      held.resolve();
      await release.promise;
    }
    return next;
  };
  await h.submit();
  await held.promise;
  assert.equal(store.calls.filter((op) => op === "append").length, 1);
  // 128 writer encodes + 128 bounded store encodes, not 2000 encoded/queued.
  assert.equal(encoded, 256);
  release.resolve();
  await turn();
  await turn();
  assert.equal(store.calls.includes("verify"), true);
  assert.equal(output.concepts.length, 2000);
});

for (const scalar of ["é", "😀", '"', "\\", "\n", "\u0000"])
  test("legal maximum record preserves Unicode/escaping and excludes only its hash LF", async (t) => {
    const h = await harness(t, {
      async build(recipe) {
        const row = conceptFor(recipe, { title: "" });
        const base = Buffer.byteLength(JSON.stringify(row));
        const size = Buffer.byteLength(JSON.stringify(scalar)) - 2;
        row.title =
          scalar.repeat(Math.floor((1048576 - base) / size)) +
          "x".repeat((1048576 - base) % size);
        assert.equal(Buffer.byteLength(JSON.stringify(row)), 1048576);
        return { ok: true, output: outputFor(recipe, [row], []) };
      },
    });
    await h.submit();
    await turn();
    await turn();
    assert.equal(h.stores.get("alpha").calls.includes("verify"), true);
  });
for (const extra of [0, 1])
  test(`aggregate byte budget at one MiB plus ${extra} splits only when needed`, async (t) => {
    const h = await harness(t, {
      async build(recipe) {
        const rows = [524288, 524288 + extra].map((size) => {
          const row = conceptFor(recipe, { title: "" });
          row.title = "x".repeat(size - Buffer.byteLength(JSON.stringify(row)));
          return row;
        });
        return { ok: true, output: outputFor(recipe, rows, []) };
      },
    });
    const store = h.stores.get("alpha"),
      append = store.append.bind(store),
      sizes = [];
    store.append = async (...args) => {
      sizes.push(args[3].length);
      return await append(...args);
    };
    await h.submit();
    await turn();
    await turn();
    assert.deepEqual(sizes, extra ? [1, 1] : [2]);
    assert.equal(store.calls.includes("verify"), true);
  });
for (const malformed of ["throws", "undefined"])
  test(`local serialization ${malformed} is a static invariant failure, not CPU uncertainty`, async (t) => {
    const h = await harness(t, {
      async build(recipe) {
        const row = conceptFor(recipe),
          out = outputFor(recipe, [row], []);
        Object.defineProperty(row, "toJSON", {
          value() {
            if (malformed === "throws") throw Error("PRIVATE_SERIALIZATION");
          },
        });
        return { ok: true, output: out };
      },
    });
    const job = await h.submit();
    await turn();
    await turn();
    assert.equal(
      (await h.stores.get("alpha").readJob(job.jobId)).failureCode,
      "INTERNAL",
    );
    assert.equal(h.controller.ready, true);
  });
test("single append RPC is bounded to two seconds even though whole verification is not", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const entered = deferred(),
    late = deferred();
  const h = await harness(t, {
    async build(recipe) {
      return { ok: true, output: outputFor(recipe, [conceptFor(recipe)], []) };
    },
  });
  const store = h.stores.get("alpha");
  store.reply = async (op, value) => {
    if (op === "append") {
      entered.resolve();
      await late.promise;
    }
    return value;
  };
  const job = await h.submit();
  await entered.promise;
  t.mock.timers.tick(1999);
  await turn();
  assert.equal((await store.readJob(job.jobId)).state, "building");
  t.mock.timers.tick(1);
  await turn();
  await turn();
  assert.equal(
    (await store.readJob(job.jobId)).failureCode,
    "DEPENDENCY_FAILED",
  );
  assert.equal(store.calls.includes("verify"), false);
  late.resolve();
  await turn();
  assert.equal(store.calls.filter((op) => op === "append").length, 1);
  await h.controller.shutdown();
  t.mock.timers.reset();
});
test("model commits payload before lost replies, verifies actual values and protects immutable attachment/full-range cleanup", async () => {
  const config = configuration(),
    store = new MemoryCandidateStore(config.sources[0].projection.vaultUid),
    recipe = recipeFor(config);
  await store.startProcess();
  await store.setConfigurationEpoch(1);
  const { lease } = await store.claimInput(
    recipe,
    "job_00000000000000000000000001",
  );
  await store.beginBuilding(lease);
  const output = outputFor(
    recipe,
    Array.from({ length: 129 }, () => conceptFor(recipe)),
    [],
  );
  await store.attachOutput(lease, output.outputDescriptor);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    store.append(
      lease,
      "concept",
      0,
      output.concepts.slice(0, 128),
      abort.signal,
    ),
    { name: "AbortError" },
  );
  assert.equal(store.payloads.get(lease.jobId).concept.size, 0);
  store.reply = async (op, value) => {
    if (op === "append")
      throw new CandidateStoreError("INDEX_UNAVAILABLE", "unknown");
    return value;
  };
  await assert.rejects(
    store.append(lease, "concept", 0, output.concepts.slice(0, 128)),
    code("INDEX_UNAVAILABLE"),
  );
  assert.deepEqual(
    [...store.payloads.get(lease.jobId).concept.values()],
    output.concepts.slice(0, 128),
  );
  await assert.rejects(
    store.append(lease, "concept", 0, [output.concepts[0]]),
    code("BUILD_CONFLICT"),
  );
  store.reply = async (_op, value) => value;
  await store.append(lease, "concept", 128, [output.concepts[128]]);
  assert.equal(
    (
      await store.verifyStoredOutput(lease, recipe, output.outputDescriptor, {
        timeoutMs: 2000,
      })
    ).concepts.hash,
    stream(output.concepts),
  );
  store.payloads.get(lease.jobId).concept.get(128).title = "STORED_ONLY_CHANGE";
  await assert.rejects(
    store.verifyStoredOutput(lease, recipe, output.outputDescriptor, {
      timeoutMs: 2000,
    }),
    code("INDEX_UNAVAILABLE"),
  );
  const conflict = outputFor(recipe, [conceptFor(recipe)], []).outputDescriptor;
  await assert.rejects(
    store.attachOutput(lease, conflict),
    code("BUILD_CONFLICT"),
  );
  await store.fail(lease, "DEPENDENCY_FAILED");
  for (const protection of ["active", "previous", "readers"]) {
    if (protection === "readers") store.readers.add(lease.buildId);
    else store[protection] = lease.buildId;
    await assert.rejects(store.cleanup(lease.jobId), code("BUILD_CONFLICT"));
    if (protection === "readers") store.readers.clear();
    else store[protection] = null;
  }
  assert.equal((await store.cleanup(lease.jobId)).done, false);
  assert.equal(store.payloads.get(lease.jobId).concept.has(128), true);
  assert.equal((await store.cleanup(lease.jobId)).done, true);
  assert.equal(store.payloads.has(lease.jobId), false);
  assert.equal((await store.readJob(lease.jobId)).state, "failed");
});

test("deployment composition passes only the S5 configuration contract and never qualifies an unprotected host", async () => {
  const { createOwnedRebuildController } =
    await import("../dist/rebuild-controller.js");
  const { RedisCandidateStore } =
    await import("../dist/redis-candidate-store.js");
  const { randomBytes } = await import("node:crypto");
  const config = configuration();
  let lookups = 0;
  const stores = new Map(
    config.sources.map((s) => [
      s.handle,
      new RedisCandidateStore({
        vaultUid: s.projection.vaultUid,
        namespaceKey: randomBytes(32),
        execute: async () => {
          lookups++;
          throw new Error("must not dispatch before runtime qualification");
        },
      }),
    ]),
  );
  await assert.rejects(
    () =>
      createOwnedRebuildController({
        runtimeIdentityFile: "/missing/expected-runtime-identity",
        configuration: config,
        stores,
        confirmPreviousWorkersStopped: async () => {},
      }),
    { name: "TypeError", message: "Runtime qualification failed." },
  );
  assert.equal(lookups, 0);
});

test("deployment registry rejects swapped/shared vault namespaces before startup", async () => {
  const { OwnedRebuildController } =
    await import("../dist/rebuild-controller.js");
  const config = configuration();
  const stores = new Map(
    config.sources.map((s) => [
      s.handle,
      new MemoryCandidateStore(config.sources[0].projection.vaultUid),
    ]),
  );
  assert.throws(
    () =>
      new OwnedRebuildController({
        configuration: config,
        stores,
        builder: {},
      }),
    { name: "TypeError", message: "Controller configuration is invalid." },
  );
});

test("replacement startup interrupts and drains prior terminal candidates only after supervision", async (t) => {
  const { OwnedRebuildController } =
    await import("../dist/rebuild-controller.js");
  const config = configuration();
  const stores = new Map(
    config.sources.map((s) => [
      s.handle,
      new MemoryCandidateStore(s.projection.vaultUid),
    ]),
  );
  const store = stores.get("alpha");
  await store.startProcess();
  await store.setConfigurationEpoch(1);
  const prior = await store.claimInput(
    recipeFor(config),
    "job_" + "0".repeat(26),
  );
  const supervisor = deferred(),
    entered = deferred();
  const controller = new OwnedRebuildController({
    configuration: config,
    stores,
    builder: {},
  });
  t.after(() => controller.shutdown());
  const starting = controller.start(async () => {
    entered.resolve();
    await supervisor.promise;
  });
  await entered.promise;
  assert.equal(store.manifests.has(prior.lease.jobId), true);
  supervisor.resolve();
  await starting;
  assert.equal(store.manifests.has(prior.lease.jobId), false);
  assert.equal(
    (await store.readJob(prior.lease.jobId)).failureCode,
    "INTERRUPTED",
  );
});

test("builder ingestion-error quarantines capacity rather than claiming the process stopped", async (t) => {
  const h = await harness(t, {
    async build() {
      return { ok: false, reason: "ingestion-error" };
    },
  });
  const job = await h.submit();
  await turn();
  assert.equal(h.controller.ready, false);
  assert.equal(
    (await h.stores.get("alpha").readJob(job.jobId)).state,
    "building",
  );
  assert.equal(h.stores.get("alpha").calls.includes("fail"), false);
  await assert.rejects(() => h.submit("beta"), code("DEPENDENCY_UNAVAILABLE"));
});

test("reserve/claim/begin/single launch; attachment holds capacity and duplicates reapprove without a reservation", async (t) => {
  const h = await harness(t);
  const job = await h.submit();
  await turn();
  assert.equal(h.launches(), 1);
  const store = h.stores.get("alpha");
  assert.ok(store.calls.indexOf("claim") < store.calls.indexOf("begin"));
  assert.equal(
    store.manifests.get(job.jobId).outputDescriptor.serialized,
    outputFor(recipeFor(h.controller.configuration)).outputDescriptor
      .serialized,
  );
  const duplicate = await h.submit();
  assert.equal(duplicate.jobId, job.jobId);
  assert.equal(h.launches(), 1);
  assert.equal(store.calls.filter((x) => x === "claim").length, 1);
  await assert.rejects(() => h.submit("beta"), code("RATE_LIMITED"));
  assert.equal(h.stores.get("beta").calls.includes("claim"), false);
  assert.equal(
    (await h.controller.status({ authorization, jobId: job.jobId })).job.state,
    "building",
  );
  await h.controller.cancel({ authorization, jobId: job.jobId });
  await turn();
  assert.equal((await store.readJob(job.jobId)).state, "cancelled");
  assert.ok((await h.submit("beta")).jobId !== job.jobId);
});

test("concurrent same-input duplicate converges while the original claim is not yet committed", async (t) => {
  const h = await harness(t);
  const store = h.stores.get("alpha");
  const entered = deferred(),
    commitNow = deferred(),
    committed = deferred();
  const claim = store.claimInput.bind(store),
    inspect = store.inspectInput.bind(store);
  store.claimInput = async (...args) => {
    entered.resolve();
    return await store.wait(
      commitNow.promise.then(async () => {
        const result = await claim(...args);
        committed.resolve();
        return result;
      }),
      args.at(-1),
    );
  };
  store.inspectInput = async (...args) => {
    commitNow.resolve();
    await committed.promise;
    return await inspect(...args);
  };
  const original = h.submit();
  await entered.promise;
  let duplicate;
  try {
    duplicate = await h.submit();
  } finally {
    commitNow.resolve();
    await original;
  }
  assert.equal(duplicate.jobId, (await original).jobId);
  await turn();
  assert.equal(h.launches(), 1);
  assert.equal(store.calls.filter((op) => op === "claim").length, 1);
});

test("a late terminal-cleanup acknowledgement cannot overwrite a newly reserved cross-vault builder", async (t) => {
  // No time advances: fake timers only ensure a broken implementation's lost
  // six-hour reservation cannot keep this owned regression process alive.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = await harness(t);
  t.after(() => t.mock.timers.reset());
  const prior = await h.submit();
  await turn();
  await h.controller.cancel({ authorization, jobId: prior.jobId });
  await turn();
  await turn();
  const store = h.stores.get("alpha");
  const retained = await store.readJob(prior.jobId);
  assert.equal(retained.state, "cancelled");
  // A delayed current-job read may still carry its earlier terminal snapshot.
  store.readCurrentJob = async () => retained;
  const entered = deferred(),
    late = deferred();
  store.reply = async (op, value) => {
    if (op === "cleanup") {
      entered.resolve();
      await late.promise;
    }
    return value;
  };
  const retry = h.submit();
  const rejected = assert.rejects(() => retry, code("RATE_LIMITED"));
  await entered.promise;
  const beta = await h.submit("beta");
  await turn();
  late.resolve();
  await rejected;
  await turn();
  assert.equal(
    h.launches(),
    2,
    "only the original alpha and surviving beta launched",
  );
  assert.equal(store.jobs.size, 1);
  assert.equal(
    (await h.controller.status({ authorization, jobId: beta.jobId })).vault,
    "beta",
  );
});

test("authorization and rate limiting precede every source/store lookup; status has no vault selector", async (t) => {
  let preflights = 0;
  const h = await harness(t, {
    async preflight(request) {
      preflights++;
      return {
        ok: true,
        recipe: recipeFor(h.controller.configuration, request.vault),
      };
    },
  });
  const before = [...h.stores.values()].map((s) => s.calls.length);
  for (const request of [
    { authorization: undefined, vault: "alpha" },
    { authorization, vault: "foreign" },
  ])
    await assert.rejects(
      () => h.controller.submit({ ...request, sourceRef: commit }),
      code(request.authorization ? "AUTH_FORBIDDEN" : "AUTH_INVALID"),
    );
  assert.equal(preflights, 0);
  assert.deepEqual(
    [...h.stores.values()].map((s) => s.calls.length),
    before,
  );
  await h.submit();
  await h.submit();
  await assert.rejects(() => h.submit(), code("RATE_LIMITED"));
  assert.equal(preflights, 2);
  const revoked = { ...configuration(2), tokens: [] };
  await h.controller.reload(revoked);
  await assert.rejects(
    () =>
      h.controller.status({ authorization, jobId: "job_" + "0".repeat(26) }),
    code("AUTH_INVALID"),
  );
});

test("one service-wide preflight, no queue, disconnect before dispatch releases only proven teardown", async (t) => {
  const entered = deferred();
  const h = await harness(t, {
    async preflight({ signal }) {
      entered.resolve();
      await new Promise((resolve) =>
        signal.addEventListener("abort", resolve, { once: true }),
      );
      throw new DOMException("Ingestion cancelled.", "AbortError");
    },
  });
  const socket = new AbortController();
  const pending = h.submit("alpha", socket.signal);
  await entered.promise;
  await assert.rejects(() => h.submit("beta"), code("RATE_LIMITED"));
  socket.abort();
  await assert.rejects(() => pending, code("DEPENDENCY_UNAVAILABLE"));
  assert.equal(h.stores.get("alpha").calls.includes("claim"), false);
  h.builder.preflight = async (request) => ({
    ok: true,
    recipe: recipeFor(h.controller.configuration, request.vault),
  });
  assert.ok(await h.submit("beta"));
});

test("S6-proven pre-dispatch cancellation releases the new reservation without quarantining unrelated vaults", async (t) => {
  const h = await harness(t);
  const socket = new AbortController();
  h.stores.get("alpha").claimInput = async () => {
    socket.abort();
    throw new DOMException("Candidate operation cancelled.", "AbortError");
  };
  await assert.rejects(
    () => h.submit("alpha", socket.signal),
    code("DEPENDENCY_UNAVAILABLE"),
  );
  await turn();
  assert.equal(h.controller.ready, true);
  assert.equal(h.stores.get("alpha").jobs.size, 0);
  assert.ok(await h.submit("beta"));
});

for (const phase of ["claim", "begin", "attach"])
  test(`lost ${phase} reply reconciles original side effects without mutation replay or duplicate launch`, async (t) => {
    const h = await harness(t);
    const store = h.stores.get("alpha");
    store.reply = async (op, value) => {
      if (op === phase)
        throw new CandidateStoreError("INDEX_UNAVAILABLE", "unknown");
      return value;
    };
    let job;
    if (phase === "claim") {
      await assert.rejects(() => h.submit(), code("DEPENDENCY_UNAVAILABLE"));
      job = [...store.jobs.values()][0];
    } else job = await h.submit();
    await turn();
    assert.equal(h.launches(), 1);
    assert.equal(store.calls.filter((x) => x === phase).length, 1);
    assert.equal((await h.submit()).jobId, job.jobId);
    await assert.rejects(() => h.submit("beta"), code("RATE_LIMITED"));
  });

for (const corruption of ["policyHash", "manifestHash", "premature-output"])
  test(`begin reconciliation rejects ${corruption} instead of treating a usable shape as original phase proof`, async (t) => {
    const h = await harness(t);
    const store = h.stores.get("alpha");
    store.reply = async (op, value) => {
      if (op === "begin") {
        const manifest = store.manifests.get(store.current);
        if (corruption === "premature-output")
          manifest.outputDescriptor = outputFor(
            recipeFor(h.controller.configuration),
          ).outputDescriptor;
        else manifest[corruption] = "sha256:" + "b".repeat(64);
        throw new CandidateStoreError("INDEX_UNAVAILABLE", "unknown");
      }
      return value;
    };
    await h.submit();
    await turn();
    assert.equal(h.launches(), 0);
    assert.equal(h.controller.ready, false);
  });

test("disconnect after committed claim never cancels accepted work; late original reply has no capacity authority", async (t) => {
  const h = await harness(t);
  const store = h.stores.get("alpha");
  const dispatched = deferred(),
    late = deferred();
  const socket = new AbortController();
  store.reply = async (op, value) => {
    if (op !== "claim") return value;
    dispatched.resolve();
    await late.promise;
    return value;
  };
  const pending = h.submit("alpha", socket.signal);
  await dispatched.promise;
  socket.abort();
  await assert.rejects(() => pending, code("DEPENDENCY_UNAVAILABLE"));
  await turn();
  assert.equal(h.launches(), 1);
  late.resolve();
  await turn();
  assert.equal(h.launches(), 1);
  await assert.rejects(() => h.submit("beta"), code("RATE_LIMITED"));
});

for (const phase of ["claimInput", "beginBuilding"])
  test(`unobserved ${phase} outcome quarantines before a late commit, without launching`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = await harness(t);
    const store = h.stores.get("alpha");
    const entered = deferred(),
      late = deferred();
    const original = store[phase].bind(store);
    store[phase] = async (...args) => {
      entered.resolve();
      return await store.wait(
        // This wrapper models a command already dispatched, not a new call
        // with a now-pre-aborted signal. Redis may still commit after timeout.
        late.promise.then(() => original(...args.slice(0, -1))),
        args.at(-1),
      );
    };
    const pending = h.submit();
    // Attach rejection handling before advancing the deadline.
    const response =
      phase === "claimInput"
        ? assert.rejects(() => pending, code("DEPENDENCY_UNAVAILABLE"))
        : pending;
    await entered.promise;
    t.mock.timers.tick(2000);
    await response;
    await turn();
    assert.equal(h.controller.ready, false);
    assert.equal(h.launches(), 0);
    late.resolve();
    await turn();
    assert.equal(
      [...store.jobs.values()][0].state,
      phase === "claimInput" ? "queued" : "building",
    );
    assert.equal(h.launches(), 0);
    await assert.rejects(
      () => h.submit("beta"),
      code("DEPENDENCY_UNAVAILABLE"),
    );
    await h.controller.shutdown();
    t.mock.timers.reset();
  });

test("expired ownership is fenced only after confirmed worker teardown, not on TTL alone", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const entered = deferred(),
    stopped = deferred();
  const h = await harness(t, {
    async build(_recipe, { signal }) {
      entered.resolve(signal);
      await new Promise((resolve) =>
        signal.addEventListener("abort", resolve, { once: true }),
      );
      await stopped.promise;
      throw new DOMException("Ingestion cancelled.", "AbortError");
    },
  });
  const job = await h.submit();
  const signal = await entered.promise;
  const store = h.stores.get("alpha");
  store.manifests.get(job.jobId).live = false;
  t.mock.timers.tick(10000);
  await turn();
  assert.equal(signal.aborted, true);
  assert.equal(store.calls.filter((op) => op === "start").length, 1);
  await assert.rejects(() => h.submit("beta"), code("RATE_LIMITED"));
  stopped.resolve();
  await turn();
  await turn();
  assert.equal(store.calls.filter((op) => op === "start").length, 2);
  assert.equal((await store.readJob(job.jobId)).failureCode, "INTERRUPTED");
  // The second beta submission may now own the sole reservation.
  h.builder.build = async (recipe) => ({ ok: true, output: outputFor(recipe) });
  assert.ok(await h.submit("beta"));
  await h.controller.shutdown();
  t.mock.timers.reset();
});

for (const outcome of ["confirmed", "committed-reply-lost", "unresolved"])
  test(`terminal failure preserves ${outcome} dispatch history through shutdown`, async (t) => {
    const h = await harness(t, {
      async build() {
        return { ok: false, reason: "secret-policy" };
      },
    });
    const store = h.stores.get("alpha");
    let failures = 0;
    const fail = store.fail.bind(store);
    store.fail = async (...args) => {
      failures++;
      if (outcome === "unresolved")
        throw new CandidateStoreError("INDEX_UNAVAILABLE", "unknown");
      return await fail(...args);
    };
    store.reply = async (op, value) => {
      if (op === "fail" && outcome === "committed-reply-lost")
        throw new CandidateStoreError("INDEX_UNAVAILABLE", "unknown");
      return value;
    };
    const job = await h.submit();
    await turn();
    await turn();
    assert.equal(store.calls.includes("attach"), false);
    assert.equal(failures, 1);
    if (outcome === "unresolved") {
      assert.equal(h.controller.ready, false);
      assert.equal((await store.readJob(job.jobId)).state, "building");
      await assert.rejects(
        () => h.submit("beta"),
        code("DEPENDENCY_UNAVAILABLE"),
      );
    } else {
      assert.equal(
        (await store.readJob(job.jobId)).failureCode,
        "SECRET_DETECTED",
      );
      assert.ok(await h.submit("beta"));
    }
    await h.controller.shutdown();
    await turn();
    assert.equal(
      failures,
      1,
      "shutdown must observe, not replay an uncertain failure",
    );
    assert.equal(
      (await store.readJob(job.jobId)).state,
      outcome === "unresolved" ? "building" : "failed",
    );
  });

test("an uncertain recovery fence is not replayed by shutdown", async (t) => {
  const entered = deferred(),
    result = deferred();
  const h = await harness(t, {
    async build() {
      entered.resolve();
      return await result.promise;
    },
  });
  const job = await h.submit();
  await entered.promise;
  const store = h.stores.get("alpha");
  let fences = 0;
  store.startProcess = async () => {
    fences++;
    throw new CandidateStoreError("INDEX_UNAVAILABLE", "unknown");
  };
  store.manifests.get(job.jobId).live = false;
  result.resolve({ ok: false, reason: "secret-policy" });
  await turn();
  await turn();
  assert.equal(fences, 1);
  assert.equal(h.controller.ready, false);
  await h.controller.shutdown();
  await turn();
  assert.equal(
    fences,
    1,
    "a pending ownership fence cannot be blindly redispatched",
  );
  assert.equal((await store.readJob(job.jobId)).state, "building");
});

for (const mode of ["reapproval", "different-input"])
  test(`${mode} rejection preserves the original accepted reservation`, async (t) => {
    const h = await harness(t);
    const job = await h.submit();
    await turn();
    if (mode === "reapproval") {
      h.builder.preflight = async () => ({
        ok: false,
        reason: "source-not-approved",
      });
      await assert.rejects(() => h.submit(), code("DEPENDENCY_UNAVAILABLE"));
      h.builder.preflight = async (request) => ({
        ok: true,
        recipe: recipeFor(h.controller.configuration, request.vault),
      });
    } else
      await assert.rejects(
        () =>
          h.controller.submit({
            authorization,
            vault: "alpha",
            sourceRef: "b".repeat(40),
          }),
        code("BUILD_CONFLICT"),
      );
    await assert.rejects(() => h.submit("beta"), code("RATE_LIMITED"));
    assert.equal(
      (await h.stores.get("alpha").readJob(job.jobId)).state,
      "building",
    );
  });

test("unknown unobserved claim and unconfirmed preflight teardown disable admission, never phantom absence", async (t) => {
  for (const fault of ["claim", "teardown"]) {
    const h = await harness(
      t,
      fault === "teardown"
        ? {
            async preflight() {
              return { ok: false, reason: "ingestion-error" };
            },
          }
        : {},
    );
    const store = h.stores.get("alpha");
    if (fault === "claim")
      store.claimInput = async () => {
        throw new CandidateStoreError("INDEX_UNAVAILABLE", "unknown");
      };
    await assert.rejects(() => h.submit(), code("DEPENDENCY_UNAVAILABLE"));
    await turn();
    assert.equal(h.controller.ready, false);
    assert.equal(h.launches(), 0);
    await assert.rejects(
      () => h.submit("beta"),
      code("DEPENDENCY_UNAVAILABLE"),
    );
  }
});

test("submission reserves the one-second teardown allowance and clamps Redis to the remaining ten-second budget", async (t) => {
  const { performance } = await import("node:perf_hooks");
  const originalNow = performance.now();
  let elapsed = 0;
  t.mock.method(performance, "now", () => originalNow + elapsed);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const prepared = deferred(),
    entered = deferred(),
    lookup = deferred();
  const h = await harness(t, {
    async preflight(request) {
      assert.equal(request.timeoutMs, 7000);
      entered.resolve();
      return await prepared.promise;
    },
  });
  const store = h.stores.get("alpha");
  let redisSignal;
  const current = store.readCurrentJob.bind(store);
  store.reply = async (op, value) =>
    op === "current" ? await lookup.promise : value;
  store.readCurrentJob = async (signal) => {
    redisSignal = signal;
    return await current(signal);
  };
  const pending = h.submit();
  const rejected = assert.rejects(
    () => pending,
    code("DEPENDENCY_UNAVAILABLE"),
  );
  await entered.promise;
  // Seven seconds of preparation plus the existing one-second teardown.
  elapsed = 8000;
  t.mock.timers.tick(8000);
  prepared.resolve({ ok: true, recipe: recipeFor(h.controller.configuration) });
  await turn();
  assert.equal(redisSignal.aborted, false);
  elapsed = 9999;
  t.mock.timers.tick(1999);
  await turn();
  assert.equal(redisSignal.aborted, false);
  elapsed++;
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(redisSignal.aborted, true);
  lookup.resolve(null);
  await turn();
  assert.equal(store.calls.includes("claim"), false);
  assert.equal(
    h.controller.ready,
    true,
    "confirmed preflight teardown released the permit",
  );
  await h.controller.shutdown();
  t.mock.timers.reset();
});

test("revocation during a missing-job reply cannot advance into the next namespace under stale grants", async (t) => {
  const h = await harness(t);
  const entered = deferred(),
    response = deferred();
  h.stores.get("alpha").readJob = async () => {
    entered.resolve();
    await response.promise;
    throw new CandidateStoreError("NOT_FOUND");
  };
  const pending = h.controller.status({
    authorization,
    jobId: "job_" + "0".repeat(26),
  });
  const rejected = assert.rejects(
    () => pending,
    code("DEPENDENCY_UNAVAILABLE"),
  );
  await entered.promise;
  const next = configuration(2);
  next.tokens[0].grants = [next.tokens[0].grants[0]];
  await h.controller.reload(next);
  const calls = h.stores.get("beta").calls.length;
  response.resolve();
  await rejected;
  assert.equal(h.stores.get("beta").calls.length, calls);
});

test("configuration change during preflight cannot claim, and reload interrupts attached work without pretending completion", async (t) => {
  const entered = deferred(),
    leave = deferred();
  const h = await harness(t, {
    async preflight(request) {
      const recipe = recipeFor(h.controller.configuration, request.vault);
      entered.resolve();
      await leave.promise;
      return { ok: true, recipe };
    },
  });
  const pending = h.submit();
  await entered.promise;
  const reloading = h.controller.reload(configuration(2));
  leave.resolve();
  await assert.rejects(() => pending, code("DEPENDENCY_UNAVAILABLE"));
  await reloading;
  assert.equal(h.stores.get("alpha").calls.includes("claim"), false);
  h.builder.preflight = async (request) => ({
    ok: true,
    recipe: recipeFor(h.controller.configuration, request.vault),
  });
  const accepted = await h.submit();
  await turn();
  await h.controller.reload(configuration(3));
  assert.equal(
    (await h.stores.get("alpha").readJob(accepted.jobId)).failureCode,
    "INTERRUPTED",
  );
  assert.equal(h.controller.ready, true);
});

test("the memory candidate failure transition rejects cancelling ownership like Lua", async () => {
  const config = configuration();
  const store = new MemoryCandidateStore(config.sources[0].projection.vaultUid);
  await store.startProcess();
  await store.setConfigurationEpoch(config.epoch);
  const recipe = recipeFor(config);
  const claimed = await store.claimInput(
    recipe,
    "job_00000000000000000000000001",
  );
  await store.requestCancel(claimed.lease.jobId);
  await assert.rejects(
    () => store.fail(claimed.lease, "SECRET_DETECTED"),
    code("FENCED"),
  );
  assert.equal((await store.readJob(claimed.lease.jobId)).state, "cancelling");
  assert.equal(store.manifests.get(claimed.lease.jobId).state, "cancelling");
});

test("a lost claim reply recovers an already confirmed cancellation without launching", async (t) => {
  const h = await harness(t);
  const store = h.stores.get("alpha");
  const committed = deferred(),
    reply = deferred();
  store.reply = async (op, value) => {
    if (op === "claim") {
      committed.resolve(value.lease.jobId);
      return await reply.promise;
    }
    return value;
  };
  const submission = h.submit();
  const rejected = assert.rejects(submission, code("DEPENDENCY_UNAVAILABLE"));
  try {
    const id = await committed.promise;
    const duplicate = await h.submit();
    assert.equal(duplicate.jobId, id);
    assert.equal(duplicate.state, "queued");
    await h.controller.cancel({ authorization, jobId: id });
    assert.equal((await store.readJob(id)).state, "cancelling");
    assert.equal(store.calls.includes("ack"), false);
    reply.reject(new CandidateStoreError("INDEX_UNAVAILABLE", "unknown"));
    await rejected;
    await turn();
    await turn();
    assert.equal(h.controller.ready, true);
    const cancelled = await store.readJob(id);
    assert.equal(cancelled.state, "cancelled");
    assert.equal(cancelled.failureCode, "CANCELLED");
    assert.equal(store.manifests.has(id), false);
    assert.equal(store.calls.filter((op) => op === "ack").length, 1);
    assert.equal(store.calls.filter((op) => op === "claim").length, 1);
    assert.equal(store.calls.includes("begin"), false);
    assert.equal(h.launches(), 0);
    assert.equal((await h.submit("beta")).state, "queued");
    assert.equal((await store.readJob(id)).state, "cancelled");
  } finally {
    reply.reject(new CandidateStoreError("INDEX_UNAVAILABLE", "unknown"));
    await rejected;
  }
});

for (const acknowledgement of [
  "confirmed",
  "committed-reply-lost",
  "unresolved",
])
  test(`worker-failure cancellation reconciliation preserves ${acknowledgement} acknowledgement semantics`, async (t) => {
    const entered = deferred(),
      result = deferred();
    let workers = 0;
    const h = await harness(t, {
      async build(recipe) {
        workers++;
        if (workers === 1) {
          entered.resolve();
          return await result.promise;
        }
        return { ok: true, output: outputFor(recipe) };
      },
    });
    const job = await h.submit();
    await entered.promise;
    const store = h.stores.get("alpha");
    const cancelCommitted = deferred(),
      cancelReply = deferred();
    const failing = deferred(),
      failReply = deferred();
    let failures = 0,
      acknowledgements = 0;
    const fail = store.fail.bind(store),
      acknowledge = store.acknowledgeCancel.bind(store);
    store.reply = async (op, value) => {
      if (op === "cancel") {
        cancelCommitted.resolve();
        await cancelReply.promise;
      }
      if (op === "ack" && acknowledgement === "committed-reply-lost")
        throw new CandidateStoreError("INDEX_UNAVAILABLE", "unknown");
      return value;
    };
    store.fail = async (...args) => {
      failures++;
      const settled = await fail(...args).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      failing.resolve(settled);
      await failReply.promise;
      if (settled.error) throw settled.error;
      return settled.value;
    };
    store.acknowledgeCancel = async (...args) => {
      acknowledgements++;
      if (acknowledgement === "unresolved")
        throw new CandidateStoreError("INDEX_UNAVAILABLE", "unknown");
      return await acknowledge(...args);
    };
    const cancellation = h.controller.cancel({
      authorization,
      jobId: job.jobId,
    });
    try {
      await cancelCommitted.promise;
      result.resolve({ ok: false, reason: "secret-policy" });
      const failed = await failing.promise;
      assert.equal(
        failed.error?.code,
        "FENCED",
        "failure cannot overwrite committed cancellation",
      );
      assert.equal((await store.readJob(job.jobId)).state, "cancelling");
      assert.equal(acknowledgements, 0);
      cancelReply.resolve();
      assert.equal((await cancellation).state, "cancelling");
      assert.equal(
        acknowledgements,
        0,
        "the in-flight failure settles before acknowledgement",
      );
      failReply.resolve();
      await turn();
      await turn();
      assert.equal(failures, 1, "do not replay the rejected failure");
      assert.equal(
        acknowledgements,
        1,
        "never replay an uncertain acknowledgement",
      );
      assert.equal(workers, 1);
      if (acknowledgement === "unresolved") {
        assert.equal(h.controller.ready, false);
        assert.equal((await store.readJob(job.jobId)).state, "cancelling");
        assert.equal(store.manifests.has(job.jobId), true);
        await assert.rejects(
          () => h.submit("beta"),
          code("DEPENDENCY_UNAVAILABLE"),
        );
      } else {
        assert.equal(h.controller.ready, true);
        const cancelled = await store.readJob(job.jobId);
        assert.equal(cancelled.state, "cancelled");
        assert.equal(cancelled.failureCode, "CANCELLED");
        assert.equal(store.manifests.has(job.jobId), false);
        assert.equal((await h.submit("beta")).state, "queued");
        assert.equal((await store.readJob(job.jobId)).state, "cancelled");
      }
      if (acknowledgement === "unresolved") {
        await h.controller.cancel({ authorization, jobId: job.jobId });
        await turn();
      }
      await h.controller.shutdown();
      await turn();
      assert.equal(
        acknowledgements,
        1,
        "late cancellation and shutdown cannot replay an uncertain acknowledgement",
      );
      assert.equal(failures, 1);
    } finally {
      result.resolve({ ok: false, reason: "secret-policy" });
      cancelReply.resolve();
      failReply.resolve();
      await cancellation;
    }
  });

test("cancellation before output waits for worker teardown before acknowledgement or capacity release", async (t) => {
  const started = deferred(),
    stopped = deferred();
  const h = await harness(t, {
    async build(_recipe, { signal }) {
      started.resolve(signal);
      await new Promise((resolve) =>
        signal.addEventListener("abort", resolve, { once: true }),
      );
      await stopped.promise;
      throw new DOMException("Ingestion cancelled.", "AbortError");
    },
  });
  const job = await h.submit();
  await started.promise;
  await h.controller.cancel({ authorization, jobId: job.jobId });
  const store = h.stores.get("alpha");
  assert.equal((await store.readJob(job.jobId)).state, "cancelling");
  assert.equal(store.calls.includes("ack"), false);
  await assert.rejects(() => h.submit("beta"), code("RATE_LIMITED"));
  stopped.resolve();
  await turn();
  await turn();
  assert.equal((await store.readJob(job.jobId)).state, "cancelled");
  assert.ok(await h.submit("beta"));
});

test("renewal maintains attached ownership, and the six-hour bound starts before claim confirmation", async (t) => {
  const { performance } = await import("node:perf_hooks");
  const originalNow = performance.now();
  let elapsed = 0;
  t.mock.method(performance, "now", () => originalNow + elapsed);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = await harness(t);
  const store = h.stores.get("alpha");
  const entered = deferred(),
    response = deferred();
  store.reply = async (op, value) => {
    if (op === "claim") {
      entered.resolve();
      await response.promise;
    }
    return value;
  };
  const pending = h.submit();
  await entered.promise;
  // Claim already committed at time zero. Delay only its acknowledgement.
  elapsed = 1000;
  t.mock.timers.tick(1000);
  response.resolve();
  const job = await pending;
  await turn();
  elapsed = 11_000;
  t.mock.timers.tick(10_000);
  await turn();
  assert.ok(store.calls.includes("renew"));
  elapsed = 21_599_999;
  t.mock.timers.tick(21_588_999);
  await turn();
  assert.equal((await store.readJob(job.jobId)).state, "building");
  elapsed++;
  t.mock.timers.tick(1);
  await turn();
  await turn();
  const failed = await store.readJob(job.jobId);
  assert.equal(failed.state, "failed");
  assert.equal(failed.failureCode, "LIMIT_EXCEEDED");
  await h.controller.shutdown();
  t.mock.timers.reset();
});

test("reload retains retirement authority when a stopped worker loses its failure reply", async (t) => {
  const h = await harness(t, {
    async build() {
      return { ok: false, reason: "secret-policy" };
    },
  });
  const store = h.stores.get("alpha");
  const failing = deferred(),
    failReply = deferred();
  const fencing = deferred(),
    fenceReply = deferred();
  store.reply = async (op, value) => {
    if (op === "fail") {
      failing.resolve();
      await failReply.promise;
      throw new CandidateStoreError("INDEX_UNAVAILABLE", "unknown");
    }
    if (op === "start") {
      fencing.resolve();
      await fenceReply.promise;
    }
    return value;
  };
  const job = await h.submit();
  await failing.promise;
  const publication = h.controller.reload(configuration(2));
  try {
    await fencing.promise;
    failReply.resolve();
    await turn();
    fenceReply.resolve();
    await publication;
    assert.equal(h.controller.configuration.epoch, 2);
    assert.equal(
      h.controller.ready,
      true,
      "the confirmed reload fence owns stopped-worker retirement",
    );
    assert.equal((await store.readJob(job.jobId)).state, "failed");
    assert.equal(store.manifests.has(job.jobId), false);
    assert.equal((await h.submit("beta")).state, "queued");
  } finally {
    failReply.resolve();
    fenceReply.resolve();
    await publication;
  }
});

test("reload interlocks a dispatched claim; queued claims are fenced without launch", async (t) => {
  const h = await harness(t);
  const store = h.stores.get("alpha");
  const entered = deferred(),
    late = deferred();
  store.reply = async (op, value) => {
    if (op === "claim") {
      entered.resolve();
      await late.promise;
    }
    return value;
  };
  const submission = h.submit();
  await entered.promise;
  const reloading = h.controller.reload(configuration(2));
  await assert.rejects(() => submission, code("DEPENDENCY_UNAVAILABLE"));
  await reloading;
  late.resolve();
  await turn();
  assert.equal(h.launches(), 0);
  assert.equal([...store.jobs.values()][0].failureCode, "INTERRUPTED");
  assert.equal(h.controller.configuration.epoch, 2);
});

test("lease loss cannot release capacity on TTL alone; shutdown retains unconfirmed worker teardown", async (t) => {
  const started = deferred(),
    stopped = deferred();
  const h = await harness(t, {
    async build(_recipe, { signal }) {
      started.resolve(signal);
      await new Promise((resolve) =>
        signal.addEventListener("abort", resolve, { once: true }),
      );
      await stopped.promise;
      return { ok: false, reason: "ingestion-error" };
    },
  });
  const job = await h.submit();
  const signal = await started.promise;
  h.stores.get("alpha").manifests.get(job.jobId).live = false;
  await h.controller.shutdown();
  assert.equal(signal.aborted, true);
  assert.equal(h.controller.ready, false);
  stopped.resolve();
  await turn();
  assert.equal(h.stores.get("alpha").calls.includes("ack"), false);
});
