import assert from "node:assert/strict";
import { connect } from "node:net";
import test from "node:test";
import { createBookieService } from "../dist/server.js";
import { OwnedRebuildController } from "../dist/rebuild-controller.js";
import { CandidateStoreError } from "../dist/redis-candidate-store.js";
import {
  configuration,
  authorization,
  commit,
  recipeFor,
  outputFor,
  MemoryCandidateStore,
  deferred,
  turn,
} from "./helpers/controller-fixture.mjs";

const payload = {
  schema_version: "1",
  vault: "alpha",
  source_commit: commit,
  embedding_generation: null,
};
async function harness(t) {
  const config = configuration();
  const stores = new Map(
    config.sources.map((s) => [
      s.handle,
      new MemoryCandidateStore(s.projection.vaultUid),
    ]),
  );
  let launches = 0,
    preflights = 0;
  const builder = {
    async preflight(request) {
      preflights++;
      return {
        ok: true,
        recipe: recipeFor(
          controller.configuration,
          request.vault,
          request.sourceRef,
        ),
      };
    },
    async build(recipe) {
      launches++;
      return { ok: true, output: outputFor(recipe) };
    },
  };
  const controller = new OwnedRebuildController({
    configuration: config,
    stores,
    builder,
  });
  await controller.start(async () => {});
  const app = await createBookieService({
    tokens: config.tokens,
    rebuilds: controller,
    store: {
      async ready() {
        return true;
      },
      async listIndexes() {
        return [];
      },
      async search() {
        throw new Error("not wired");
      },
    },
  });
  t.after(async () => {
    await app.close();
    await controller.shutdown();
  });
  const submit = (body = payload) =>
    app.inject({
      method: "POST",
      url: "/v1/admin/rebuild",
      headers: { authorization },
      payload: body,
    });
  return {
    app,
    controller,
    stores,
    builder,
    submit,
    launches: () => launches,
    preflights: () => preflights,
  };
}

test("v1 rebuild/status/cancel use unchanged strict fields and only authorized configured namespaces", async (t) => {
  const h = await harness(t);
  for (const field of ["runtimeHash", "outputDescriptor", "vaultUid", "proof"])
    assert.equal(
      (await h.submit({ ...payload, [field]: "PRIVATE_MARKER" })).statusCode,
      400,
    );
  assert.equal(
    (
      await h.submit({
        ...payload,
        embedding_generation: "emb_" + "a".repeat(64),
      })
    ).statusCode,
    400,
  );
  assert.equal(h.preflights(), 0);
  const response = await h.submit();
  assert.equal(response.statusCode, 202, response.body);
  const job = response.json();
  assert.deepEqual(
    Object.keys(job).sort(),
    ["schema_version", "request_id", "job_id", "build_id", "state"].sort(),
  );
  assert.equal(response.headers["cache-control"], "no-store");
  await turn();
  const duplicate = await h.submit();
  assert.equal(duplicate.json().job_id, job.job_id);
  assert.equal(h.launches(), 1);
  const status = await h.app.inject({
    method: "GET",
    url: "/v1/admin/rebuild/" + job.job_id,
    headers: { authorization },
  });
  assert.equal(status.statusCode, 200, status.body);
  assert.deepEqual(
    { ...status.json(), request_id: null },
    {
      schema_version: "1",
      request_id: null,
      job_id: job.job_id,
      build_id: job.build_id,
      vault: "alpha",
      source_commit: commit,
      state: "building",
      failure_code: null,
    },
  );
  assert.equal(
    (
      await h.app.inject({
        method: "GET",
        url: "/v1/admin/rebuild/" + job.job_id + "?vault=beta",
        headers: { authorization },
      })
    ).statusCode,
    400,
  );
  const cancelled = await h.app.inject({
    method: "DELETE",
    url: "/v1/admin/rebuild/" + job.job_id,
    headers: { authorization },
  });
  assert.equal(cancelled.statusCode, 202, cancelled.body);
  assert.ok(["cancelling", "cancelled"].includes(cancelled.json().state));
  assert.equal(h.stores.get("beta").calls.includes("read"), false);
});

test("reload revocation is authoritative for HTTP, not a stale independent verifier", async (t) => {
  const h = await harness(t);
  const response = await h.submit();
  const id = response.json().job_id;
  const current = configuration(2);
  current.tokens = [];
  await h.controller.reload(current);
  for (const [method, url] of [
    ["GET", "/v1/admin/rebuild/" + id],
    ["DELETE", "/v1/admin/rebuild/" + id],
    ["GET", "/v1/index"],
  ]) {
    const denied = await h.app.inject({
      method,
      url,
      headers: { authorization },
    });
    assert.equal(denied.statusCode, 401, denied.body);
    assert.equal(denied.json().code, "AUTH_INVALID");
  }
});

for (const failure of ["start", "configure"])
  test(`lost ${failure} publication reply disables health even after pre-dispatch claim release`, async (t) => {
    const h = await harness(t);
    const store = h.stores.get("alpha");
    const claiming = deferred();
    store.claimInput = async (_recipe, _id, signal) => {
      claiming.resolve();
      await new Promise((resolve) =>
        signal.addEventListener("abort", resolve, { once: true }),
      );
      throw new DOMException("Candidate operation cancelled.", "AbortError");
    };
    store.reply = async (op, value) => {
      if (op === failure)
        throw new CandidateStoreError("INDEX_UNAVAILABLE", "unknown");
      return value;
    };
    const submission = h.submit();
    await claiming.promise;
    await assert.rejects(
      () => h.controller.reload(configuration(2)),
      (error) => error.code === "DEPENDENCY_UNAVAILABLE",
    );
    assert.equal((await submission).statusCode, 503);
    assert.equal(
      store.epoch,
      2,
      "the owner advance committed before its reply boundary",
    );
    assert.equal(store.configurationEpoch, failure === "configure" ? 2 : 1);
    assert.equal(
      h.controller.configuration.epoch,
      1,
      "failed publication cannot expose a partial snapshot",
    );
    assert.equal(
      store.jobs.size,
      0,
      "the original claim was proven not dispatched",
    );
    assert.equal(h.controller.ready, false);
    const health = await h.app.inject({ method: "GET", url: "/health/ready" });
    assert.equal(health.statusCode, 503);
    assert.equal(health.json().status, "unavailable");
    const preflights = h.preflights();
    const betaCalls = h.stores.get("beta").calls.length;
    assert.equal(
      (await h.submit({ ...payload, vault: "beta" })).statusCode,
      503,
    );
    assert.equal(
      h.preflights(),
      preflights,
      "disabled admission performs no new source work",
    );
    assert.equal(h.stores.get("beta").calls.length, betaCalls);
    assert.equal(h.launches(), 0);
  });

test("foreign and nonexistent jobs are indistinguishable without querying ungranted namespaces", async (t) => {
  const h = await harness(t);
  const accepted = await h.submit({ ...payload, vault: "beta" });
  const foreign = accepted.json().job_id;
  const current = configuration(2);
  current.tokens[0].grants = [current.tokens[0].grants[0]];
  await h.controller.reload(current);
  const count = h.stores.get("beta").calls.length;
  const bodies = [];
  for (const id of [foreign, "job_" + "0".repeat(26)]) {
    const response = await h.app.inject({
      method: "GET",
      url: "/v1/admin/rebuild/" + id,
      headers: { authorization },
    });
    assert.equal(response.statusCode, 404, response.body);
    bodies.push({ ...response.json(), request_id: null });
  }
  assert.deepEqual(bodies[0], bodies[1]);
  assert.equal(h.stores.get("beta").calls.length, count);
});

for (const phase of ["preflight", "committed-claim"])
  test(
    `real submission socket disconnect at ${phase} preserves correct ownership`,
    { timeout: 15000 },
    async (t) => {
      const h = await harness(t);
      const entered = deferred(),
        stopped = deferred(),
        late = deferred();
      if (phase === "preflight")
        h.builder.preflight = async ({ signal }) => {
          entered.resolve();
          await new Promise((resolve) =>
            signal.addEventListener("abort", resolve, { once: true }),
          );
          stopped.resolve();
          throw new DOMException("Ingestion cancelled.", "AbortError");
        };
      else
        h.stores.get("alpha").reply = async (op, value) => {
          if (op === "claim") {
            entered.resolve();
            await late.promise;
          }
          if (op === "attach") stopped.resolve();
          return value;
        };
      const address = new URL(
        await h.app.listen({ port: 0, host: "127.0.0.1" }),
      );
      const socket = connect(Number(address.port), "127.0.0.1");
      socket.on("error", () => {}); // client deliberately destroys its own connection
      t.after(() => socket.destroy());
      await new Promise((resolve) => socket.once("connect", resolve));
      const body = JSON.stringify(payload);
      socket.write(
        `POST /v1/admin/rebuild HTTP/1.1\r\nHost: localhost\r\nAuthorization: ${authorization}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
      );
      await entered.promise;
      socket.destroy();
      await stopped.promise;
      await turn();
      if (phase === "preflight") {
        assert.equal(h.launches(), 0);
        assert.equal(h.stores.get("alpha").calls.includes("claim"), false);
      } else {
        assert.equal(h.launches(), 1);
        late.resolve();
        await turn();
        const retry = await h.submit();
        assert.equal(retry.statusCode, 202, retry.body);
        assert.equal(
          retry.json().job_id,
          [...h.stores.get("alpha").jobs.keys()][0],
        );
        assert.equal(h.launches(), 1);
      }
    },
  );
