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
        late.promise.then(() => original(...args)),
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
