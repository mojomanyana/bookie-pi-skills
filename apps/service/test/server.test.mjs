import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { connect } from "node:net";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { createBookieService } from "../dist/server.js";

const now = new Date("2026-09-15T00:00:00Z");
const secret = "a".repeat(43);
const token = `bka_reader_${secret}`;
const digest = createHash("sha256").update(secret).digest("hex");
const commit = "b".repeat(40);
const buildId = `bld_${"c".repeat(64)}`;

function verifier(overrides = {}) {
  return {
    id: "reader",
    digest,
    principal: "alice",
    not_before: "2026-09-14T00:00:00Z",
    expires_at: "2026-09-16T00:00:00Z",
    grants: [
      {
        vault: "team-ledger",
        scopes: ["index:read", "search", "context"],
      },
    ],
    ...overrides,
  };
}

function searchBody(overrides = {}) {
  return {
    schema_version: "1",
    vault: "team-ledger",
    query: "atomic generation",
    filters: {
      projects: [],
      types: ["Decision"],
      lifecycle: ["stable"],
      workflow: ["accepted"],
      sensitivity: ["internal"],
      trust: ["verified"],
      freshness: ["fresh"],
    },
    limit: 10,
    ...overrides,
  };
}

function searchResponse() {
  return {
    schema_version: "1",
    mode: "shared",
    build_id: buildId,
    embedding_generation: null,
    source_commit: commit,
    degradation: "none",
    results: [],
    truncated: false,
  };
}

async function createHarness(tokens = [verifier()], storeOverrides = {}) {
  const calls = [];
  const store = {
    async ready() {
      return true;
    },
    async listIndexes(vaults) {
      calls.push(["index", vaults]);
      return [
        {
          vault: "team-ledger",
          status: "ready",
          active_build: buildId,
          source_commit: commit,
          embedding_generation: null,
        },
      ];
    },
    async search(request, identity, signal) {
      calls.push(["search", request, identity, signal.aborted]);
      return searchResponse();
    },
    ...storeOverrides,
  };
  const app = await createBookieService({
    tokens,
    now: () => now,
    store,
  });
  return { app, calls };
}

function normalizedError(response) {
  const body = response.json();
  assert.match(body.request_id, /^req_[0-9A-HJKMNP-TV-Z]{26}$/u);
  return { ...body, request_id: "<request>" };
}

test("health is static and authenticated search is vault-scoped", async (t) => {
  const { app, calls } = await createHarness();
  t.after(() => app.close());

  const live = await app.inject({ method: "GET", url: "/health/live" });
  assert.equal(live.statusCode, 200);
  assert.deepEqual(live.json(), { schema_version: "1", status: "ok" });
  assert.equal(live.headers["cache-control"], "no-store");

  const index = await app.inject({
    method: "GET",
    url: "/v1/index",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(index.statusCode, 200, index.body);
  assert.equal(index.json().indexes[0].vault, "team-ledger");

  const response = await app.inject({
    method: "POST",
    url: "/v1/search",
    headers: { authorization: `Bearer ${token}` },
    payload: searchBody(),
  });
  assert.equal(response.statusCode, 200, response.body);
  const responseBody = response.json();
  assert.match(responseBody.request_id, /^req_[0-9A-HJKMNP-TV-Z]{26}$/u);
  assert.deepEqual(
    { ...responseBody, request_id: undefined },
    { ...searchResponse(), request_id: undefined },
  );
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], ["index", ["team-ledger"]]);
  assert.equal(calls[1][0], "search");
  assert.equal(calls[1][2].principal, "alice");
  assert.deepEqual(calls[1][2].vaults, ["team-ledger"]);
});

test("credentials and vault scopes fail without reaching the store", async (t) => {
  const { app, calls } = await createHarness();
  t.after(() => app.close());

  const missing = await app.inject({
    method: "POST",
    url: "/v1/search",
    payload: searchBody(),
  });
  const unknown = await app.inject({
    method: "POST",
    url: "/v1/search",
    headers: { authorization: "Bearer bka_unknown_" + "z".repeat(43) },
    payload: searchBody(),
  });
  assert.equal(missing.statusCode, 401);
  assert.equal(unknown.statusCode, 401);
  assert.deepEqual(normalizedError(missing), normalizedError(unknown));
  assert.equal(normalizedError(missing).code, "AUTH_INVALID");

  const foreign = await app.inject({
    method: "POST",
    url: "/v1/search",
    headers: { authorization: `Bearer ${token}` },
    payload: searchBody({ vault: "other-ledger" }),
  });
  assert.equal(foreign.statusCode, 403);
  assert.equal(normalizedError(foreign).code, "AUTH_FORBIDDEN");
  assert.deepEqual(calls, []);
});

test("index requires an explicit index scope", async (t) => {
  const { app, calls } = await createHarness([
    verifier({
      grants: [{ vault: "team-ledger", scopes: ["search"] }],
    }),
  ]);
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/v1/index",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.statusCode, 403);
  assert.equal(normalizedError(response).code, "AUTH_FORBIDDEN");
  assert.deepEqual(calls, []);
});

test("expired credentials and malformed requests return static errors", async (t) => {
  const expiredHarness = await createHarness([
    verifier({ expires_at: "2026-09-15T00:00:00Z" }),
  ]);
  const validHarness = await createHarness();
  t.after(() =>
    Promise.all([expiredHarness.app.close(), validHarness.app.close()]),
  );

  const expired = await expiredHarness.app.inject({
    method: "POST",
    url: "/v1/search",
    headers: { authorization: `Bearer ${token}` },
    payload: searchBody(),
  });
  assert.equal(expired.statusCode, 401);
  assert.equal(normalizedError(expired).code, "AUTH_INVALID");

  const malformed = await validHarness.app.inject({
    method: "POST",
    url: "/v1/search",
    headers: { authorization: `Bearer ${token}` },
    payload: searchBody({ unexpected: "sensitive-value" }),
  });
  assert.equal(malformed.statusCode, 400);
  assert.deepEqual(normalizedError(malformed), {
    schema_version: "1",
    code: "REQUEST_INVALID",
    request_id: "<request>",
    retryable: false,
  });
  assert.doesNotMatch(malformed.body, /sensitive-value/u);
  assert.deepEqual(expiredHarness.calls, []);
  assert.deepEqual(validHarness.calls, []);
});

test("not-found, encoding, and size errors never reflect request data", async (t) => {
  const { app, calls } = await createHarness();
  t.after(() => app.close());

  const missing = await app.inject({
    method: "GET",
    url: "/secret-path",
  });
  assert.equal(missing.statusCode, 404);
  assert.equal(normalizedError(missing).code, "REQUEST_INVALID");
  assert.doesNotMatch(missing.body, /secret-path/u);

  const unsupported = await app.inject({
    method: "POST",
    url: "/v1/search",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "text/plain",
    },
    payload: JSON.stringify(searchBody()),
  });
  assert.equal(unsupported.statusCode, 415);
  assert.equal(normalizedError(unsupported).code, "CONTENT_TYPE_INVALID");

  const encoded = await app.inject({
    method: "POST",
    url: "/v1/search",
    headers: {
      authorization: `Bearer ${token}`,
      "content-encoding": "gzip",
      "content-type": "application/json",
    },
    payload: JSON.stringify(searchBody()),
  });
  assert.equal(encoded.statusCode, 415);
  assert.equal(normalizedError(encoded).code, "CONTENT_TYPE_INVALID");

  const oversized = await app.inject({
    method: "POST",
    url: "/v1/search",
    headers: { authorization: `Bearer ${token}` },
    payload: searchBody({ query: "x".repeat(70_000) }),
  });
  assert.equal(oversized.statusCode, 413);
  assert.equal(normalizedError(oversized).code, "REQUEST_TOO_LARGE");
  assert.deepEqual(calls, []);
});

test("query parameters and credential-bearing cookies fail statically", async (t) => {
  const { app, calls } = await createHarness();
  t.after(() => app.close());

  const query = await app.inject({
    method: "GET",
    url: `/v1/index?token=${token}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(query.statusCode, 400);
  assert.equal(normalizedError(query).code, "REQUEST_INVALID");
  assert.doesNotMatch(query.body, /bka_|reader/u);

  for (const cookieValue of [
    `bookie_token=${token}`,
    `bookie_token="${token}"`,
  ]) {
    const cookie = await app.inject({
      method: "GET",
      url: "/v1/index",
      headers: {
        authorization: `Bearer ${token}`,
        cookie: cookieValue,
      },
    });
    assert.equal(cookie.statusCode, 400);
    assert.equal(normalizedError(cookie).code, "REQUEST_INVALID");
    assert.doesNotMatch(cookie.body, /bka_|reader/u);
  }
  assert.deepEqual(calls, []);
});

test("index responses cannot introduce a foreign vault", async (t) => {
  const { app } = await createHarness([verifier()], {
    async listIndexes() {
      return [
        {
          vault: "other-ledger",
          status: "unavailable",
          active_build: null,
          source_commit: null,
          embedding_generation: null,
        },
      ];
    },
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/v1/index",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.statusCode, 503);
  assert.equal(normalizedError(response).code, "INDEX_UNAVAILABLE");
  assert.doesNotMatch(response.body, /other-ledger/u);
});

test("readiness reflects the store dependency without configuration detail", async (t) => {
  const { app } = await createHarness([verifier()], {
    async ready() {
      return false;
    },
  });
  t.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/health/ready" });
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), {
    schema_version: "1",
    status: "unavailable",
  });
});

test("verifier configuration rejects extra fields, invalid dates, duplicate secrets, and mixed roles", async () => {
  const baseStore = {
    async ready() {
      return true;
    },
    async listIndexes() {
      return [];
    },
    async search() {
      return searchResponse();
    },
  };
  const invalidSets = [
    [verifier({ plaintext_token: token })],
    [verifier({ not_before: "2026-02-30T00:00:00Z" })],
    [verifier(), verifier({ id: "other", principal: "bob" })],
    [
      verifier({
        grants: [
          {
            vault: "team-ledger",
            scopes: ["search", "rebuild:create"],
          },
        ],
      }),
    ],
  ];
  for (const tokens of invalidSets) {
    await assert.rejects(
      createBookieService({ tokens, store: baseStore, now: () => now }),
      { name: "TypeError" },
    );
  }
});

test("a premature response-socket close aborts store work", async (t) => {
  let observeAbort;
  let observeEntered;
  const aborted = new Promise((resolve) => {
    observeAbort = resolve;
  });
  const entered = new Promise((resolve) => {
    observeEntered = resolve;
  });
  const { app } = await createHarness([verifier()], {
    async search(_request, _identity, signal) {
      observeEntered();
      await Promise.race([
        new Promise((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", resolve, { once: true });
        }),
        delay(1_000).then(() => {
          throw new Error("store abort was not observed");
        }),
      ]);
      observeAbort(signal.aborted);
      return searchResponse();
    },
  });
  t.after(() => app.close());
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address === "object");
  const body = JSON.stringify(searchBody());
  const socket = connect(address.port, "127.0.0.1");
  socket.write(
    `POST /v1/search HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
  await Promise.race([
    entered,
    delay(1_000).then(() => {
      throw new Error("store was not entered");
    }),
  ]);
  socket.destroy();
  assert.equal(await Promise.race([aborted, delay(1_000, false)]), true);
});
