import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import {
  conceptFor,
  chunkFor,
  storedRecipe,
  storedDescriptor,
  stream,
} from "../helpers/stored-output-fixture.mjs";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import {
  RedisCandidateStore,
  createCandidateJobId,
} from "../../dist/redis-candidate-store.js";
import { prepareApprovedLexicalProjection } from "../../dist/ingestion.js";
import { encodeBuildInputRecipe } from "../../dist/build-recipe.js";
import {
  encodeOutputDescriptor,
  parseOutputDescriptor,
} from "../../dist/output-descriptor.js";
import { candidateScript } from "../../dist/redis-candidate-script.js";
import { OwnedRebuildController } from "../../dist/rebuild-controller.js";
import {
  configuration as controllerConfiguration,
  recipeFor as controllerRecipe,
  outputFor,
  authorization,
  deferred,
} from "../helpers/controller-fixture.mjs";

const image =
  "redis:8.2.1-alpine@sha256:987c376c727652f99625c7d205a1cba3cb2c53b92b0b62aade2bd48ee1593232";
const vaultUid = "VLT-00000000000000000000000009";
const namespaceKey = randomBytes(32);
const build = (digit) => `bld_${digit.repeat(64)}`;
const hash = `sha256:${"a".repeat(64)}`;
const commit = "a".repeat(40);
const spec = (digit = "a", concepts = 1, chunks = 0) => ({
  vaultUid,
  buildId: build(digit),
  sourceCommit: commit,
  manifestHash: hash,
  policyHash: hash,
  concepts,
  chunks,
});
const record = {
  uid: "DOC-00000000000000000000000003",
  path: "/document.md",
  sourceCommit: commit,
  sourceHash: hash,
  projectionSchemaVersion: "1",
  contentTrust: "untrusted",
  title: "Included control",
  tags: [],
};

function docker(args, input, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      signal,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 20_000,
    });
    let stdout = "";
    let stderr = "";
    // redis-cli JSON may split a UTF-8 scalar across pipe chunks. Decode as a
    // stream; per-Buffer coercion corrupts otherwise valid stored bytes.
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(stdout.trim())
        : reject(new Error(`Docker test failure: ${stderr}`)),
    );
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

const emptyHash =
  "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
function recipeFor(uid, configurationEpoch = 1, sourceCommit = commit) {
  return Object.freeze({
    ...encodeBuildInputRecipe({
      vaultUid: uid,
      objectFormat: sourceCommit.length === 40 ? "sha1" : "sha256",
      sourceCommit,
      vaultScope: "private/source",
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
    sourceCommit,
    configurationEpoch,
  });
}
function descriptorFor(recipe, concepts = 1, chunks = 0) {
  return encodeOutputDescriptor({
    recipeHash: recipe.recipeHash,
    canonical: {
      hash: concepts ? hash : emptyHash,
      bytes: concepts ? 536870912 : 0,
      records: concepts,
    },
    concepts: { count: concepts, hash: concepts ? hash : emptyHash },
    chunks: { count: chunks, hash: chunks ? hash : emptyHash },
  });
}

async function environment(t) {
  const name = `bookie-candidate-test-${process.pid}-${randomBytes(6).toString("hex")}`;
  await docker([
    "run",
    "-d",
    "--name",
    name,
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--tmpfs",
    "/data:rw,noexec,nosuid,size=16m",
    "--user",
    "redis",
    "--memory",
    "256m",
    "--pids-limit",
    "64",
    image,
    "redis-server",
    "--save",
    "",
    "--appendonly",
    "no",
  ]);
  t.after(async () => {
    await docker(["rm", "-f", name]);
    assert.equal(
      await docker(["ps", "-aq", "--filter", `name=^/${name}$`]),
      "",
    );
    t.diagnostic(`Confirmed removal of owned Redis fixture ${name}`);
  });
  const command = async (...args) => {
    const value = await docker(["exec", name, "redis-cli", "--json", ...args]);
    // redis-cli prints INFO verbatim even with --json (not a store reply).
    return args[0] === "INFO" ? value : JSON.parse(value);
  };
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      if ((await command("PING")) === "PONG") break;
    } catch {
      /* bounded startup polling */
    }
    await delay(50);
  }
  assert.equal(await command("PING"), "PONG");
  const commands = [];
  const create = (uid = vaultUid, username, reply, before, scriptFor) =>
    new RedisCandidateStore({
      vaultUid: uid,
      namespaceKey,
      execute: async (args, signal) => {
        commands.push(args);
        await before?.(JSON.parse(args.at(-1)));
        const result = JSON.parse(
          await docker(
            [
              "exec",
              "-i",
              name,
              "redis-cli",
              ...(username
                ? ["--user", username, "--pass", "", "--no-auth-warning"]
                : []),
              "--json",
              "-x",
              ...(scriptFor
                ? [
                    args[0],
                    scriptFor(args[1], JSON.parse(args.at(-1))),
                    ...args.slice(2, -1),
                  ]
                : args.slice(0, -1)),
            ],
            args.at(-1),
            signal,
          ),
        );
        return reply === undefined
          ? result
          : await reply(result, JSON.parse(args.at(-1)));
      },
    });
  return { command, create, commands };
}

const code = (expected) => (error) =>
  error.code === expected && error.message === expected;

test("Redis 8 stored-output integrity", { timeout: 600_000 }, async (t) => {
  const { command, create, commands } = await environment(t);
  let serial = 3000;
  async function fixture(
    conceptCount = 3,
    chunkCount = 3,
    sourceCommit = commit,
    options = {},
  ) {
    const uid = `VLT-${String(serial++).padStart(26, "0")}`;
    const recipe = storedRecipe(
      uid,
      sourceCommit,
      options.epoch ?? Number.MAX_SAFE_INTEGER,
    );
    const concepts =
      options.concepts?.(recipe) ??
      Array.from({ length: conceptCount }, (_, i) =>
        conceptFor(recipe, { title: `Record ${i} café 😀 \\"\n\t\u0000` }),
      );
    const chunks =
      options.chunks?.(recipe) ??
      Array.from({ length: chunkCount }, (_, i) => chunkFor(recipe, i));
    const descriptor = storedDescriptor(recipe, concepts, chunks);
    const transport = [];
    const store = create(
      uid,
      options.username,
      async (result, request) => {
        if (Array.isArray(result))
          transport.push({
            op: request.op,
            count: result.length - 1,
            rawBytes: result
              .slice(1)
              .reduce((n, s) => n + Buffer.byteLength(s), 0),
            envelopeBytes: Buffer.byteLength(JSON.stringify(result)),
            metadataBytes: Buffer.byteLength(result[0]),
          });
        return options.reply ? await options.reply(result, request) : result;
      },
      options.before,
    );
    await store.startProcess();
    await store.setConfigurationEpoch(recipe.configurationEpoch);
    const { lease } = await store.claimInput(recipe, createCandidateJobId());
    if (options.phase !== "queued") await store.beginBuilding(lease);
    if (!options.phase) await store.attachOutput(lease, descriptor);
    for (const [kind, rows] of options.phase
      ? []
      : [
          ["concept", concepts],
          ["chunk", chunks],
        ]) {
      let offset = 0;
      while (offset < rows.length) {
        const batch = [];
        let bytes = 0;
        while (batch.length < 128 && offset + batch.length < rows.length) {
          const row = rows[offset + batch.length];
          const size = Buffer.byteLength(JSON.stringify(row));
          if (batch.length && bytes + size > 1048576) break;
          batch.push(row);
          bytes += size;
        }
        await store.append(lease, kind, offset, batch);
        offset += batch.length;
      }
    }
    const prefix = `${store.namespace}build:${recipe.buildId}:`;
    return {
      uid,
      recipe,
      concepts,
      chunks,
      descriptor,
      store,
      lease,
      prefix,
      transport,
    };
  }
  const verify = (f) =>
    f.store.verifyStoredOutput(f.lease, f.recipe, f.descriptor, {
      timeoutMs: 20000,
    });

  await t.test(
    "actual RedisJSON encoding preserves ordered ECMAScript bytes and native payload strings",
    async () => {
      const f = await fixture();
      for (const [kind, rows] of [
        ["concept", f.concepts],
        ["chunk", f.chunks],
      ]) {
        for (const [i, row] of rows.entries()) {
          const raw = await command("JSON.GET", f.prefix + kind + ":" + i);
          assert.equal(JSON.stringify(JSON.parse(raw)), JSON.stringify(row));
          const memory = await command(
            "JSON.DEBUG",
            "MEMORY",
            f.prefix + kind + ":" + i,
            ".",
          );
          assert.ok(Number.isSafeInteger(memory) && memory > 0);
          t.diagnostic(
            `${kind} encoded=${Buffer.byteLength(JSON.stringify(row))} raw=${Buffer.byteLength(raw)} memory=${memory}`,
          );
        }
      }
      const before = await command("HGETALL", f.prefix + "manifest");
      const job = await f.store.readJob(f.lease.jobId);
      const result = await verify(f);
      assert.deepEqual(result, {
        lease: f.lease,
        sourceCommit: f.recipe.sourceCommit,
        descriptorHash: f.descriptor.hash,
        concepts: { count: 3, hash: stream(f.concepts) },
        chunks: { count: 3, hash: stream(f.chunks) },
      });
      assert.ok(
        Object.isFrozen(result) &&
          Object.isFrozen(result.lease) &&
          Object.isFrozen(result.concepts) &&
          Object.isFrozen(result.chunks),
      );
      assert.deepEqual(await command("HGETALL", f.prefix + "manifest"), before);
      assert.deepEqual(await f.store.readJob(f.lease.jobId), job);
      assert.equal(await command("EXISTS", f.store.namespace + "active"), 0);
    },
  );

  await t.test(
    "stored-only text corruption defeats the original descriptor and unchanged cursors",
    async () => {
      const f = await fixture();
      const before = await command("HGETALL", f.prefix + "manifest");
      await command(
        "JSON.SET",
        f.prefix + "chunk:1",
        ".text",
        JSON.stringify("TAMPERED_PRIVATE_TEXT"),
      );
      await assert.rejects(() => verify(f), code("INDEX_UNAVAILABLE"));
      assert.deepEqual(await command("HGETALL", f.prefix + "manifest"), before);
      await command(
        "JSON.SET",
        f.prefix + "chunk:1",
        ".text",
        JSON.stringify(f.chunks[1].text),
      );
      assert.equal((await verify(f)).chunks.hash, stream(f.chunks));
      assert.equal(
        commands
          .map((a) => JSON.parse(a.at(-1)))
          .filter((r) => r.op === "append").length,
        4,
      );
    },
  );

  await t.test(
    "both Git lengths, zero chunks and actual empty inventory verify without state/TTL changes",
    async () => {
      for (const [concepts, chunks, source] of [
        [0, 0, "b".repeat(64)],
        [2, 0, commit],
        [2, 2, "b".repeat(64)],
      ]) {
        const f = await fixture(concepts, chunks, source);
        const leaseKey = f.store.namespace + "lease:" + f.recipe.buildId;
        await command("ZADD", leaseKey, "1", "expired-reader");
        const ttl = await command("PTTL", f.store.namespace + "lock:rebuild");
        const before = await f.store.readCandidate(f.lease.jobId);
        const result = await verify(f);
        assert.equal(result.concepts.hash, stream(f.concepts));
        assert.equal(result.chunks.hash, stream(f.chunks));
        assert.equal(
          await command("ZCARD", leaseKey),
          1,
          "no removal of expired reader leases",
        );
        const afterTtl = await command(
          "PTTL",
          f.store.namespace + "lock:rebuild",
        );
        assert.ok(
          afterTtl > 0 && afterTtl < ttl,
          "verification never renews the lock",
        );
        assert.deepEqual(await f.store.readCandidate(f.lease.jobId), before);
        await f.store.requestCancel(f.lease.jobId);
        await f.store.acknowledgeCancel(f.lease);
        await f.store.cleanup(f.lease.jobId);
        assert.equal((await f.store.readJob(f.lease.jobId)).state, "cancelled");
      }
    },
  );

  await t.test(
    "storage corruption, holes, wrong types/order and nonadjacent inventory extras cannot be hidden by cursors",
    async () => {
      const f = await fixture();
      const before = await command("HGETALL", f.prefix + "manifest");
      const changes = [
        ["concept:0", { ...f.concepts[0], title: "PRIVATE_TAMPER" }],
        ["chunk:1", { ...f.chunks[1], text: "PRIVATE_TAMPER" }],
        [
          "concept:1",
          { ...f.concepts[1], sourceHash: `sha256:${"b".repeat(64)}` },
        ],
        ["chunk:0", { ...f.chunks[0], sourceCommit: "b".repeat(40) }],
        ["concept:0", f.concepts[1]],
        ["chunk:1", { ...f.chunks[1], ordinal: 0 }],
        ["concept:1", f.chunks[1]],
        ["chunk:1", f.concepts[1]],
        ["concept:1", { ...f.concepts[1], projectionSchemaVersion: "2" }],
        ["chunk:2", { ...f.chunks[2], chunkerVersion: "unsupported" }],
      ];
      for (const [key, row] of changes) {
        const saved = await command("JSON.GET", f.prefix + key);
        try {
          await command("JSON.SET", f.prefix + key, ".", JSON.stringify(row));
          await assert.rejects(() => verify(f), code("INDEX_UNAVAILABLE"));
          assert.deepEqual(
            await command("HGETALL", f.prefix + "manifest"),
            before,
          );
        } finally {
          await command("JSON.SET", f.prefix + key, ".", saved);
        }
      }
      for (const kind of ["concept", "chunk"]) {
        for (const index of [0, 1, 2]) {
          const key = f.prefix + kind + ":" + index;
          const saved = await command("JSON.GET", key);
          await command("DEL", key);
          try {
            await assert.rejects(() => verify(f), code("INDEX_UNAVAILABLE"));
          } finally {
            await command("JSON.SET", key, ".", saved);
          }
        }
        const key = f.prefix + kind + ":0";
        const saved = await command("JSON.GET", key);
        await command("DEL", key);
        await command("SET", key, "PRIVATE_WRONG_TYPE");
        try {
          await assert.rejects(() => verify(f), code("INDEX_UNAVAILABLE"));
        } finally {
          await command("DEL", key);
          await command("JSON.SET", key, ".", saved);
        }
        for (const index of [3, 99999]) {
          const extra = f.prefix + kind + ":" + index;
          await command("SET", extra, "PRIVATE_EXTRA_NO_PAYLOAD_READ");
          try {
            await assert.rejects(() => verify(f), code("INDEX_UNAVAILABLE"));
          } finally {
            await command("DEL", extra);
          }
        }
      }
      await command(
        "JSON.SET",
        f.prefix + "concept:0",
        ".",
        JSON.stringify(f.concepts[1]),
      );
      await command(
        "JSON.SET",
        f.prefix + "concept:1",
        ".",
        JSON.stringify(f.concepts[0]),
      );
      await assert.rejects(() => verify(f), code("INDEX_UNAVAILABLE"));
      for (const i of [0, 1])
        await command(
          "JSON.SET",
          f.prefix + "concept:" + i,
          ".",
          JSON.stringify(f.concepts[i]),
        );
      assert.equal((await verify(f)).concepts.hash, stream(f.concepts));
      for (const kind of ["concept", "chunk"]) {
        const empty = await fixture(0, 0);
        const extra = empty.prefix + kind + ":99999";
        await command("SET", extra, "PRIVATE_EMPTY_EXTRA");
        await assert.rejects(() => verify(empty), code("INDEX_UNAVAILABLE"));
        await command("DEL", extra);
        assert.equal((await verify(empty)).concepts.count, 0);
      }
    },
  );

  await t.test(
    "full projection domains reject malformed fields even with matching asserted stream hashes",
    async () => {
      const patches = [
        ["concept", { uid: null }],
        ["concept", { path: 4 }],
        ["concept", { type: [] }],
        ["concept", { title: {} }],
        ["concept", { project: false }],
        ["concept", { lifecycle: 1 }],
        ["concept", { workflow: [] }],
        ["concept", { sensitivity: null }],
        ["concept", { tags: [1] }],
        ["concept", { links: "bad" }],
        ["concept", { trust: "trusted" }],
        ["concept", { verifiedBy: [null] }],
        ["concept", { staleAfter: 0 }],
        [
          "concept",
          {
            relations: [{ kind: "x", target: "y", targetUid: null, extra: 1 }],
          },
        ],
        [
          "concept",
          { relations: [{ kind: "x", target: null, targetUid: null }] },
        ],
        ["concept", { unknown: "PRIVATE_UNKNOWN" }],
        ["concept", { sourceHash: "invalid" }],
        ["concept", { contentTrust: "trusted" }],
        ["concept", { projectionSchemaVersion: "unsupported" }],
        ["concept", { tags: [[[[["PRIVATE_DEPTH"]]]]] }],
        ["chunk", { heading: [] }],
        ["chunk", { headingPath: [null] }],
        ["chunk", { text: 1 }],
        ["chunk", { text: "é".repeat(32769) }],
        ["chunk", { embeddingGeneration: "vector" }],
        ["chunk", { ordinal: 1 }],
        ["chunk", { chunkerVersion: "wrong" }],
      ];
      const f = await fixture(1, 1);
      for (const [kind, patch] of patches) {
        const rows =
          kind === "concept"
            ? [{ ...f.concepts[0], ...patch }]
            : [{ ...f.chunks[0], ...patch }];
        const descriptor = storedDescriptor(
          f.recipe,
          kind === "concept" ? rows : f.concepts,
          kind === "chunk" ? rows : f.chunks,
        );
        await command(
          "JSON.SET",
          f.prefix + kind + ":0",
          ".",
          JSON.stringify(rows[0]),
        );
        await command(
          "HSET",
          f.prefix + "manifest",
          "outputDescriptor",
          descriptor.serialized,
        );
        await assert.rejects(
          () => verify({ ...f, descriptor }),
          code("INDEX_UNAVAILABLE"),
        );
        await command(
          "JSON.SET",
          f.prefix + kind + ":0",
          ".",
          JSON.stringify(kind === "concept" ? f.concepts[0] : f.chunks[0]),
        );
      }
      await command(
        "HSET",
        f.prefix + "manifest",
        "outputDescriptor",
        f.descriptor.serialized,
      );
      assert.equal((await verify(f)).chunks.count, 1);
    },
  );

  await t.test(
    "missing attachment/manifest, malformed metadata and incomplete cursors are not empty evidence",
    async () => {
      const f = await fixture();
      const key = f.prefix + "manifest";
      const original = await command("HGETALL", key);
      const wrongDescriptor = storedDescriptor(
        f.recipe,
        [{ ...f.concepts[0], title: "different" }, ...f.concepts.slice(1)],
        f.chunks,
      );
      for (const [field, value, expected] of [
        ["outputDescriptor", undefined, "INDEX_UNAVAILABLE"],
        ["outputDescriptor", wrongDescriptor.serialized, "BUILD_CONFLICT"],
        [
          "outputDescriptor",
          f.descriptor.serialized.replace('output",1', 'output",2'),
          "INDEX_UNAVAILABLE",
        ],
        ["manifestVersion", "3", "INDEX_UNAVAILABLE"],
        ["nextConcept", "2", "INDEX_UNAVAILABLE"],
        ["nextConcept", "4", "INDEX_UNAVAILABLE"],
        ["nextChunk", "2", "INDEX_UNAVAILABLE"],
        ["nextConcept", "-0", "INDEX_UNAVAILABLE"],
        ["nextConcept", "01", "INDEX_UNAVAILABLE"],
        ["nextChunk", "1.5", "INDEX_UNAVAILABLE"],
        ["cleanupConcept", "1", "INDEX_UNAVAILABLE"],
        ["cleanupChunk", "-1", "INDEX_UNAVAILABLE"],
        ["state", "unknown", "INDEX_UNAVAILABLE"],
        ["manifestHash", hash, "BUILD_CONFLICT"],
        ["policyHash", hash, "BUILD_CONFLICT"],
      ]) {
        if (value === undefined) await command("HDEL", key, field);
        else await command("HSET", key, field, value);
        await assert.rejects(() => verify(f), code(expected));
        await command("HSET", key, field, original[field]);
      }
      await command("DEL", key);
      await assert.rejects(() => verify(f), code("INDEX_UNAVAILABLE"));
      await command("HSET", key, ...Object.entries(original).flat());
      assert.equal((await verify(f)).concepts.count, 3);
      for (const phase of ["queued", "absent"]) {
        const missing = await fixture(1, 0, commit, { phase });
        await assert.rejects(
          () => verify(missing),
          code(phase === "queued" ? "FENCED" : "BUILD_CONFLICT"),
        );
        assert.equal(missing.transport.length, 0);
      }
    },
  );

  await t.test(
    "live ownership, phases and serving/reader protections reject without payload disclosure",
    async () => {
      const f = await fixture();
      for (const patch of [
        { ownerEpoch: 2 },
        { fence: 2 },
        { jobId: `job_${"0".repeat(26)}` },
        { configurationEpoch: 1 },
      ]) {
        const before = f.transport.length;
        await assert.rejects(
          () =>
            f.store.verifyStoredOutput(
              { ...f.lease, ...patch },
              patch.configurationEpoch
                ? { ...f.recipe, configurationEpoch: 1 }
                : f.recipe,
              f.descriptor,
              { timeoutMs: 10000 },
            ),
          code("FENCED"),
        );
        assert.equal(f.transport.length, before);
      }
      for (const pointer of ["active", "previous", "reader"]) {
        const key =
          f.store.namespace +
          (pointer === "reader" ? "lease:" + f.recipe.buildId : pointer);
        if (pointer === "reader")
          await command("ZADD", key, String(Date.now() + 60000), "reader");
        else await command("SET", key, f.recipe.buildId);
        const before = f.transport.length;
        await assert.rejects(() => verify(f), code("BUILD_CONFLICT"));
        assert.equal(f.transport.length, before);
        await command("DEL", key);
      }
      for (const [state, failure, expected] of [
        ["cancelling", "", "FENCED"],
        ["cancelled", "CANCELLED", "FENCED"],
        ["failed", "INTERNAL", "FENCED"],
        ["complete", "", "BUILD_CONFLICT"],
        ["verifying", "", "FENCED"],
        ["evaluating", "", "FENCED"],
      ]) {
        await command("HSET", f.prefix + "manifest", "state", state);
        await command(
          "HSET",
          f.store.namespace + "job:" + f.lease.jobId,
          "state",
          state,
          "failureCode",
          failure,
        );
        await assert.rejects(() => verify(f), code(expected));
      }
      await command("HSET", f.prefix + "manifest", "state", "building");
      await command(
        "HSET",
        f.store.namespace + "job:" + f.lease.jobId,
        "state",
        "building",
        "failureCode",
        "",
      );
      const lock = f.store.namespace + "lock:rebuild";
      await command("PEXPIREAT", lock, "1");
      await assert.rejects(() => verify(f), code("FENCED"));
      await f.store.startProcess();
      await assert.rejects(() => verify(f), code("FENCED"));
      await f.store.cleanup(f.lease.jobId);
      assert.equal(
        (await f.store.readJob(f.lease.jobId)).failureCode,
        "INTERRUPTED",
      );
      const foreign = await fixture(0, 0);
      await assert.rejects(
        () =>
          foreign.store.verifyStoredOutput(
            { ...f.lease, buildId: foreign.recipe.buildId },
            foreign.recipe,
            foreign.descriptor,
            { timeoutMs: 10000 },
          ),
        code("FENCED"),
      );
    },
  );

  for (const boundary of ["between-pages", "before-final"])
    for (const invalidation of ["cancel", "configure", "restart", "lease-loss"])
      await t.test(
        `${invalidation} wins storage ordering ${boundary}`,
        async () => {
          let f,
            fired = false;
          const invalidate = async (request) => {
            if (
              !f ||
              fired ||
              request.op !==
                (boundary === "between-pages" ? "storedPage" : "storedFinish")
            )
              return;
            fired = true;
            if (invalidation === "cancel")
              await f.store.requestCancel(f.lease.jobId);
            if (invalidation === "configure")
              await f.store.setConfigurationEpoch(2);
            if (invalidation === "restart") await f.store.startProcess();
            if (invalidation === "lease-loss")
              await command("DEL", f.store.namespace + "lock:rebuild");
          };
          f = await fixture(129, 0, commit, {
            epoch: 1,
            ...(boundary === "between-pages"
              ? {
                  reply: async (result, request) => {
                    await invalidate(request);
                    return result;
                  },
                }
              : { before: invalidate }),
          });
          await assert.rejects(() => verify(f), code("FENCED"));
          assert.equal(fired, true);
          assert.equal(
            f.transport.filter((p) => p.op === "storedPage").length,
            boundary === "between-pages" ? 1 : 2,
          );
          if (invalidation === "cancel")
            await f.store.acknowledgeCancel(f.lease);
          else await f.store.startProcess();
          while (!(await f.store.cleanup(f.lease.jobId)).done) {
            /* bounded two-page fixture */
          }
          assert.ok(
            ["cancelled", "failed"].includes(
              (await f.store.readJob(f.lease.jobId)).state,
            ),
          );
        },
      );

  await t.test(
    "count and encoded-byte endpoints split actual native transport without widening metadata",
    async () => {
      const f = await fixture(129, 0);
      await verify(f);
      assert.deepEqual(
        f.transport.filter((p) => p.op === "storedPage").map((p) => p.count),
        [128, 1],
      );
      function sized(recipe, bytes, scalar) {
        const base = conceptFor(recipe, { title: "" });
        const remaining = bytes - Buffer.byteLength(JSON.stringify(base));
        const width = Buffer.byteLength(JSON.stringify(scalar)) - 2;
        return {
          ...base,
          title:
            scalar.repeat(Math.floor(remaining / width)) +
            "x".repeat(remaining % width),
        };
      }
      for (const scalar of ["x", "😀", "\u0000"]) {
        const large = await fixture(1, 0, commit, {
          concepts: (r) => [sized(r, 1048576, scalar)],
        });
        assert.equal(
          Buffer.byteLength(JSON.stringify(large.concepts[0])),
          1048576,
        );
        assert.equal(
          (await verify(large)).concepts.hash,
          stream(large.concepts),
        );
        const pages = large.transport.filter((p) => p.op === "storedPage");
        assert.equal(pages.length, 1);
        assert.equal(pages[0].count, 1);
        assert.ok(pages[0].rawBytes <= 6 * 1048576);
        assert.ok(pages[0].metadataBytes <= 4096);
        assert.ok(
          pages[0].envelopeBytes <= 6 * (6 * 1048576 + 4096) + 3 * 129 + 2,
        );
        t.diagnostic(`native maximum ${JSON.stringify(pages[0])}`);
        if (scalar === "x") {
          await command(
            "JSON.STRAPPEND",
            large.prefix + "concept:0",
            ".title",
            '"x"',
          );
          const descriptor = storedDescriptor(
            large.recipe,
            [{ ...large.concepts[0], title: large.concepts[0].title + "x" }],
            [],
          );
          await command(
            "HSET",
            large.prefix + "manifest",
            "outputDescriptor",
            descriptor.serialized,
          );
          await assert.rejects(
            () => verify({ ...large, descriptor }),
            code("INDEX_UNAVAILABLE"),
          );
        }
      }
      const exact = await fixture(2, 0, commit, {
        concepts: (r) => [sized(r, 524288, "é"), sized(r, 524288, "x")],
      });
      await verify(exact);
      assert.deepEqual(
        exact.transport
          .filter((p) => p.op === "storedPage")
          .map((p) => p.rawBytes),
        [1048576],
      );
      const over = await fixture(2, 0, commit, {
        concepts: (r) => [sized(r, 524288, "é"), sized(r, 524289, "x")],
      });
      await verify(over);
      assert.deepEqual(
        over.transport.filter((p) => p.op === "storedPage").map((p) => p.count),
        [1, 1],
      );
      await assert.rejects(
        () =>
          over.store.append(over.lease, "concept", 0, [
            sized(over.recipe, 1048577, "x"),
          ]),
        /Candidate input is invalid/u,
      );
    },
  );

  await t.test(
    "oversized external DOM fails server-side before JSON.GET and bounded reply transport",
    async () => {
      const f = await fixture(1, 0);
      // A huge shallow array has a tiny seed command; expansion stays in this owned fixture.
      await command(
        "JSON.SET",
        f.prefix + "concept:0",
        ".tags",
        '["' + "x".repeat(65536) + '"]',
      );
      await command(
        "EVAL",
        `for i=1,10 do local a=redis.call('JSON.GET',KEYS[1],'.tags'); local v=cjson.decode(a); for j=1,#v do v[j]=cjson.encode(v[j]) end; redis.call('JSON.ARRAPPEND',KEYS[1],'.tags',unpack(v)) end return 1`,
        "1",
        f.prefix + "concept:0",
      );
      const memory = await command(
        "JSON.DEBUG",
        "MEMORY",
        f.prefix + "concept:0",
        ".",
      );
      assert.ok(memory > 67108864);
      await command("CONFIG", "RESETSTAT");
      await assert.rejects(() => verify(f), code("INDEX_UNAVAILABLE"));
      const stats = await command("INFO", "commandstats");
      assert.equal(
        /cmdstat_json.get:/iu.test(stats),
        false,
        "the oversized value was not serialized/read",
      );
      assert.equal(f.transport.length, 0);
      await command("DEL", f.prefix + "concept:0");
      await command(
        "JSON.SET",
        f.prefix + "concept:0",
        ".",
        JSON.stringify(f.concepts[0]),
      );
      assert.equal((await verify(f)).concepts.count, 1);
    },
  );

  await t.test(
    "a committed lost append reply is measured without replay or phase/capacity inference",
    async () => {
      const uid = `VLT-${String(serial++).padStart(26, "0")}`;
      const recipe = storedRecipe(uid);
      const concepts = [conceptFor(recipe)];
      const descriptor = storedDescriptor(recipe, concepts, []);
      const committed = deferred();
      let late;
      const store = create(uid, undefined, async (reply, r) => {
        if (r.op !== "append") return reply;
        committed.resolve();
        return await new Promise((resolve) => {
          late = () => resolve(reply);
        });
      });
      await store.startProcess();
      await store.setConfigurationEpoch(1);
      const { lease } = await store.claimInput(recipe, createCandidateJobId());
      await store.beginBuilding(lease);
      await store.attachOutput(lease, descriptor);
      const abort = new AbortController();
      const pending = store.append(lease, "concept", 0, concepts, abort.signal);
      const rejected = assert.rejects(
        pending,
        (error) => error.name === "AbortError" && error.outcome === "unknown",
      );
      await committed.promise;
      abort.abort("PRIVATE_APPEND_REPLY_LOST");
      await rejected;
      late();
      const writes = commands.filter(
        (args) =>
          JSON.parse(args.at(-1)).op === "append" &&
          args[3] === store.namespace,
      ).length;
      assert.equal(writes, 1);
      assert.equal(
        (
          await store.verifyStoredOutput(lease, recipe, descriptor, {
            timeoutMs: 10000,
          })
        ).concepts.hash,
        stream(concepts),
      );
      assert.equal(
        commands.filter(
          (args) =>
            JSON.parse(args.at(-1)).op === "append" &&
            args[3] === store.namespace,
        ).length,
        writes,
      );
      assert.equal((await store.readJob(lease.jobId)).state, "building");
      assert.equal((await store.inspectInput(lease.jobId)).live, true);
      await store.fail(lease, "INTERNAL");
      await store.cleanup(lease.jobId);
    },
  );

  await t.test(
    "ACL/dependency faults are static read failures, never empty or uncertain mutations",
    async () => {
      for (const denied of ["json.get", "json.debug", "scan", "info"]) {
        const username = "deny-" + denied.replaceAll(".", "-");
        await command(
          "ACL",
          "SETUSER",
          username,
          "on",
          "nopass",
          "~*",
          "+@all",
          "-" + denied,
        );
        const f = await fixture(1, 0, commit, { username });
        const before = await f.store.readCandidate(f.lease.jobId);
        await assert.rejects(
          () => verify(f),
          (error) =>
            code("INDEX_UNAVAILABLE")(error) && error.outcome === undefined,
        );
        assert.deepEqual(await f.store.readCandidate(f.lease.jobId), before);
      }
      const f = await fixture(1, 0, commit, {
        reply: async (result, r) => {
          if (r.op === "storedPage")
            throw new Error("PRIVATE_DEPENDENCY_CREDENTIAL");
          return result;
        },
      });
      await assert.rejects(
        () => verify(f),
        (error) =>
          code("INDEX_UNAVAILABLE")(error) &&
          error.outcome === undefined &&
          !JSON.stringify(error).includes("PRIVATE"),
      );
      await f.store.fail(f.lease, "DEPENDENCY_FAILED");
      await f.store.cleanup(f.lease.jobId);
      assert.equal(
        (await f.store.readJob(f.lease.jobId)).failureCode,
        "DEPENDENCY_FAILED",
      );
    },
  );
});

test("Redis 8 fenced candidate lifecycle", { timeout: 240_000 }, async (t) => {
  const { command, create, commands } = await environment(t);
  let serial = 100;
  async function inputFixture(epoch = 1, sourceCommit = commit) {
    const uid = `VLT-${String(serial++).padStart(26, "0")}`;
    const store = create(uid);
    await store.startProcess();
    await store.setConfigurationEpoch(epoch);
    const recipe = recipeFor(uid, epoch, sourceCommit);
    const claimed = await store.claimInput(recipe, createCandidateJobId());
    const key = `${store.namespace}build:${recipe.buildId}:manifest`;
    return { store, recipe, lease: claimed.lease, key, uid };
  }
  const raw = async (store, request) =>
    JSON.parse(
      await command(
        "EVAL",
        candidateScript,
        "1",
        store.namespace,
        JSON.stringify(request),
      ),
    );

  // Fake producer/real controller/store composition, NOT genuine S5 qualification.
  for (const fault of [
    "valid",
    "reject",
    "lost",
    "bad-next",
    "partial-acl",
    "partial-subset",
    "corrupt",
    "read-acl",
    "read-fault",
    "read-deadline",
  ])
    for (const cancel of [false, true])
      await t.test(
        `owned payload ${fault}${cancel ? " with cancellation" : ""} uses actual Redis side effects and full-range retirement`,
        async () => {
          const config = controllerConfiguration();
          config.sources.forEach((s) => {
            s.projection.vaultUid = `VLT-${String(serial++).padStart(26, "0")}`;
          });
          const cleaned = deferred(),
            measured = deferred();
          let writes = 0,
            reads = 0,
            output,
            store,
            controller,
            lease,
            partial;
          const username = `writer-${serial}`;
          await command(
            "ACL",
            "SETUSER",
            username,
            "on",
            "nopass",
            "~*",
            "+@all",
          );
          store = create(
            config.sources[0].projection.vaultUid,
            username,
            async (result, r) => {
              if (r.op === "append") {
                writes++;
                if (fault === "partial-acl" || fault === "partial-subset") {
                  const prefix =
                    store.namespace + "build:" + lease.buildId + ":";
                  partial = {
                    low: await command("EXISTS", prefix + "concept:0"),
                    high: await command("EXISTS", prefix + "concept:127"),
                    cursor: await command(
                      "HGET",
                      prefix + "manifest",
                      "nextConcept",
                    ),
                  };
                  await command("ACL", "SETUSER", username, "+hset");
                }
                if (
                  cancel &&
                  [
                    "lost",
                    "bad-next",
                    "partial-acl",
                    "partial-subset",
                  ].includes(fault)
                )
                  await store.requestCancel(lease.jobId);
                if (fault === "lost") throw Error("PRIVATE_LOST_REPLY");
                if (fault === "bad-next")
                  return JSON.stringify({ ok: true, next: 999 });
              }
              if (r.op === "storedFinish") measured.resolve(result);
              if (r.op === "cleanup" && JSON.parse(result).done)
                cleaned.resolve();
              return result;
            },
            async (r) => {
              if (r.op === "append" && fault === "reject") {
                if (cancel) await store.requestCancel(lease.jobId);
                else await command("ACL", "SETUSER", username, "-json.mset");
              }
              if (r.op === "append" && fault === "partial-acl")
                await command("ACL", "SETUSER", username, "-hset");
              if (r.op === "storedPage") {
                reads++;
                if (
                  cancel &&
                  [
                    "valid",
                    "corrupt",
                    "read-acl",
                    "read-fault",
                    "read-deadline",
                  ].includes(fault)
                )
                  await store.requestCancel(lease.jobId);
                if (fault === "corrupt")
                  await command(
                    "JSON.SET",
                    store.namespace + "build:" + lease.buildId + ":concept:0",
                    ".title",
                    JSON.stringify("STORAGE_ONLY_TAMPER"),
                  );
                if (fault === "read-acl")
                  await command("ACL", "SETUSER", username, "-json.get");
                if (fault === "read-fault") throw Error("PRIVATE_READ_FAILURE");
                if (fault === "read-deadline") await delay(2100);
              }
            },
            (script, r) => {
              if (r.op !== "append" || fault !== "partial-subset")
                return script;
              const anchor =
                "local result=redis.pcall('JSON.MSET',unpack(args))";
              assert.equal(script.split(anchor).length, 2);
              // Explicit TEST-ONLY write-boundary fault, AFTER unchanged preflight/
              // ownership guards. Stock RedisJSON is not claimed to split a batch.
              return script.replace(
                anchor,
                "local result=redis.pcall('JSON.MSET',unpack(args,#args-2,#args)); error('fixture fault')",
              );
            },
          );
          const stores = new Map([
            ["alpha", store],
            ["beta", create(config.sources[1].projection.vaultUid)],
          ]);
          const claim = store.claimInput.bind(store);
          store.claimInput = async (...a) => {
            const value = await claim(...a);
            lease = value.lease;
            return value;
          };
          const verify = store.verifyStoredOutput.bind(store);
          let verified;
          store.verifyStoredOutput = async (...a) => {
            try {
              verified = await verify(...a);
              return verified;
            } finally {
              measured.resolve();
            }
          };
          controller = new OwnedRebuildController({
            configuration: config,
            stores,
            builder: {
              async preflight(r) {
                return {
                  ok: true,
                  recipe: controllerRecipe(config, r.vault, r.sourceRef),
                };
              },
              async build(recipe) {
                output = outputFor(
                  recipe,
                  Array.from({ length: 129 }, (_, i) =>
                    conceptFor(recipe, { title: `Record ${i}` }),
                  ),
                  [chunkFor(recipe)],
                );
                return { ok: true, output };
              },
            },
          });
          const bounded = async (p) => {
            let timer;
            try {
              return await Promise.race([
                p,
                new Promise((_, reject) => {
                  timer = setTimeout(
                    () => reject(Error("Redis controller fixture stalled.")),
                    15000,
                  );
                }),
              ]);
            } finally {
              clearTimeout(timer);
            }
          };
          try {
            await controller.start(async () => {});
            const job = await controller.submit({
              authorization,
              vault: "alpha",
              sourceRef: commit,
            });
            if (fault === "valid" && !cancel) {
              await bounded(measured.promise);
              await new Promise((r) => setImmediate(r));
              assert.deepEqual(verified.concepts, {
                count: 129,
                hash: stream(output.concepts),
              });
              assert.equal((await store.readJob(job.jobId)).state, "building");
              assert.equal(writes, 3);
              await controller.cancel({ authorization, jobId: job.jobId });
            }
            await bounded(cleaned.promise);
            await new Promise((r) => setImmediate(r));
            assert.equal(controller.ready, true);
            if (partial) {
              assert.equal(partial.high, 1);
              assert.equal(partial.low, fault === "partial-subset" ? 0 : 1);
              assert.equal(partial.cursor, "0");
            }
            assert.equal(
              await command(
                "EXISTS",
                store.namespace + "build:" + job.buildId + ":concept:127",
              ),
              0,
            );
            assert.equal(
              await command(
                "EXISTS",
                store.namespace + "build:" + job.buildId + ":concept:128",
              ),
              0,
            );
            assert.equal(await store.readCandidate(job.jobId), null);
            const status = await store.readJob(job.jobId);
            assert.equal(
              status.state,
              cancel || fault === "valid" ? "cancelled" : "failed",
            );
            if (
              ["lost", "bad-next", "partial-acl", "partial-subset"].includes(
                fault,
              )
            ) {
              assert.equal(writes, 1);
              assert.equal(reads, 0);
            }
            if (fault === "valid" && !cancel) assert.ok(verified);
            else assert.equal(verified, undefined);
            assert.equal(JSON.stringify(status).includes("PRIVATE"), false);
            await controller.shutdown();
            assert.equal(
              writes,
              [
                "corrupt",
                "read-acl",
                "read-fault",
                "read-deadline",
                "valid",
              ].includes(fault)
                ? 3
                : 1,
            );
          } finally {
            await command(
              "ACL",
              "SETUSER",
              username,
              "+hset",
              "+json.get",
              "+json.mset",
            );
            await controller.shutdown();
          }
        },
      );

  await t.test(
    "controller permits real multi-page verification over two seconds while each Redis RPC stays capped",
    async () => {
      const config = controllerConfiguration();
      config.sources = config.sources.slice(0, 1);
      config.sources[0].projection.vaultUid = `VLT-${String(serial++).padStart(26, "0")}`;
      const complete = deferred(),
        cleaned = deferred(),
        durations = [];
      let started;
      const reads = (r) => r.op.startsWith("stored");
      const store = create(
        config.sources[0].projection.vaultUid,
        undefined,
        async (reply, r) => {
          if (reads(r)) durations.push(performance.now() - started);
          if (r.op === "cleanup" && JSON.parse(reply).done) cleaned.resolve();
          return reply;
        },
        async (r) => {
          if (reads(r)) {
            started = performance.now();
            await delay(550);
          }
        },
      );
      const verify = store.verifyStoredOutput.bind(store);
      let elapsed;
      store.verifyStoredOutput = async (...args) => {
        const start = performance.now();
        const value = await verify(...args);
        elapsed = performance.now() - start;
        complete.resolve(value);
        return value;
      };
      const controller = new OwnedRebuildController({
        configuration: config,
        stores: new Map([["alpha", store]]),
        builder: {
          async preflight() {
            return { ok: true, recipe: controllerRecipe(config) };
          },
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
        },
      });
      try {
        await controller.start(async () => {});
        const job = await controller.submit({
          authorization,
          vault: "alpha",
          sourceRef: commit,
        });
        assert.equal((await complete.promise).concepts.count, 129);
        assert.ok(elapsed > 2000);
        assert.ok(durations.length >= 5 && durations.every((ms) => ms < 2000));
        assert.equal((await store.readJob(job.jobId)).state, "building");
        await controller.cancel({ authorization, jobId: job.jobId });
        await cleaned.promise;
      } finally {
        await controller.shutdown();
      }
    },
  );

  await t.test(
    "S7 original-attempt reconciliation, duplicate capacity, attachment and cancellation use real Redis",
    async () => {
      const config = controllerConfiguration();
      config.sources.forEach((s) => {
        s.projection.vaultUid = `VLT-${String(serial++).padStart(26, "0")}`;
      });
      let lost = true;
      const cleaned = deferred();
      const stores = new Map(
        config.sources.map((s) => [
          s.handle,
          create(s.projection.vaultUid, undefined, async (reply, request) => {
            // Redis has committed before this reply is lost; do not fake rollback.
            if (request.op === "claimInput" && lost) {
              lost = false;
              return "PRIVATE_UNUSABLE_REPLY";
            }
            if (
              request.op === "cleanup" &&
              s.handle === "alpha" &&
              JSON.parse(reply).done
            )
              cleaned.resolve();
            return reply;
          }),
        ]),
      );
      let launches = 0;
      const controller = new OwnedRebuildController({
        configuration: config,
        stores,
        builder: {
          async preflight(request) {
            return {
              ok: true,
              recipe: controllerRecipe(
                config,
                request.vault,
                request.sourceRef,
              ),
            };
          },
          async build(recipe) {
            launches++;
            return { ok: true, output: outputFor(recipe) };
          },
        },
      });
      try {
        await controller.start(async () => {}); // fixture owns no previous workers
        await assert.rejects(
          () =>
            controller.submit({
              authorization,
              vault: "alpha",
              sourceRef: commit,
            }),
          code("DEPENDENCY_UNAVAILABLE"),
        );
        const store = stores.get("alpha");
        for (let n = 0; n < 150; n++) {
          const current = await store.readCurrentJob();
          if (
            current &&
            (await store.inspectInput(current.jobId)).manifest?.outputDescriptor
          )
            break;
          await delay(10);
        }
        const duplicate = await controller.submit({
          authorization,
          vault: "alpha",
          sourceRef: commit,
        });
        const observed = await store.inspectInput(duplicate.jobId);
        assert.equal(observed.live, true);
        assert.ok(observed.manifest.outputDescriptor);
        assert.equal(launches, 1);
        await assert.rejects(
          () =>
            controller.submit({
              authorization,
              vault: "beta",
              sourceRef: commit,
            }),
          code("RATE_LIMITED"),
        );
        await controller.cancel({ authorization, jobId: duplicate.jobId });
        for (
          let n = 0;
          n < 100 &&
          (await store.readJob(duplicate.jobId)).state !== "cancelled";
          n++
        )
          await delay(10);
        assert.equal((await store.readJob(duplicate.jobId)).state, "cancelled");
        await cleaned.promise;
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(
          (
            await controller.submit({
              authorization,
              vault: "beta",
              sourceRef: commit,
            })
          ).state,
          "queued",
        );
      } finally {
        await controller.shutdown();
      }
    },
  );

  for (const race of ["lost-claim-reply", "worker-failure"])
    await t.test(
      `S7 cancellation settles the ${race} interleaving through real Lua`,
      async () => {
        const config = controllerConfiguration();
        config.sources.forEach((source) => {
          source.projection.vaultUid = `VLT-${String(serial++).padStart(26, "0")}`;
        });
        const claimed = deferred(),
          claimReply = deferred();
        const cancelCommitted = deferred(),
          cancelReply = deferred();
        const failing = deferred(),
          failReply = deferred();
        const entered = deferred(),
          workerResult = deferred();
        const observed = [];
        const stores = new Map(
          config.sources.map((source) => [
            source.handle,
            create(
              source.projection.vaultUid,
              undefined,
              async (reply, request) => {
                if (source.handle !== "alpha") return reply;
                observed.push(request.op);
                if (
                  request.op === "claimInput" &&
                  race === "lost-claim-reply"
                ) {
                  claimed.resolve(request.jobId);
                  await claimReply.promise;
                  return "UNUSABLE_CLAIM_REPLY";
                }
                if (request.op === "cancel") {
                  cancelCommitted.resolve();
                  if (race === "worker-failure") await cancelReply.promise;
                }
                if (request.op === "fail" && race === "worker-failure") {
                  failing.resolve(JSON.parse(reply));
                  await failReply.promise;
                }
                return reply;
              },
            ),
          ]),
        );
        let workers = 0;
        const controller = new OwnedRebuildController({
          configuration: config,
          stores,
          builder: {
            async preflight(request) {
              return {
                ok: true,
                recipe: controllerRecipe(
                  config,
                  request.vault,
                  request.sourceRef,
                ),
              };
            },
            async build(recipe) {
              workers++;
              if (race === "worker-failure" && workers === 1) {
                entered.resolve();
                return await workerResult.promise;
              }
              return { ok: true, output: outputFor(recipe) };
            },
          },
        });
        const submit = (vault) =>
          controller.submit({ authorization, vault, sourceRef: commit });
        try {
          await controller.start(async () => {}); // no prior workers in this owned fixture
          let job;
          if (race === "lost-claim-reply") {
            const pending = submit("alpha");
            const rejected = assert.rejects(
              pending,
              code("DEPENDENCY_UNAVAILABLE"),
            );
            const id = await claimed.promise;
            job = await submit("alpha");
            assert.equal(job.jobId, id);
            await controller.cancel({ authorization, jobId: id });
            claimReply.resolve();
            await rejected;
          } else {
            job = await submit("alpha");
            await entered.promise;
            const cancellation = controller.cancel({
              authorization,
              jobId: job.jobId,
            });
            await cancelCommitted.promise;
            workerResult.resolve({ ok: false, reason: "secret-policy" });
            assert.deepEqual(await failing.promise, {
              ok: false,
              code: "FENCED",
            });
            cancelReply.resolve();
            assert.equal((await cancellation).state, "cancelling");
            failReply.resolve();
          }
          const store = stores.get("alpha");
          for (
            let n = 0;
            n < 50 && (await store.readJob(job.jobId)).state !== "cancelled";
            n++
          )
            await delay(10);
          const cancelled = await store.readJob(job.jobId);
          assert.equal(cancelled.state, "cancelled");
          assert.equal(cancelled.failureCode, "CANCELLED");
          for (
            let n = 0;
            n < 50 && (await store.inspectInput(job.jobId)).manifest !== null;
            n++
          )
            await delay(10);
          assert.equal((await store.inspectInput(job.jobId)).manifest, null);
          assert.equal(controller.ready, true);
          assert.equal(observed.filter((op) => op === "claimInput").length, 1);
          assert.equal(observed.filter((op) => op === "ackCancel").length, 1);
          assert.equal(
            observed.filter((op) => op === "fail").length,
            race === "worker-failure" ? 1 : 0,
          );
          assert.equal(workers, race === "worker-failure" ? 1 : 0);
          assert.equal((await submit("beta")).state, "queued");
          assert.equal((await store.readJob(job.jobId)).state, "cancelled");
        } finally {
          claimReply.resolve();
          cancelReply.resolve();
          workerResult.resolve({ ok: false, reason: "secret-policy" });
          failReply.resolve();
          await controller.shutdown();
        }
      },
    );

  await t.test(
    "S7 replacement fences every configured namespace, queued and attached, and waits for supervision",
    async () => {
      const config = controllerConfiguration();
      const prior = [];
      for (const [n, source] of config.sources.entries()) {
        source.projection.vaultUid = `VLT-${String(serial++).padStart(26, "0")}`;
        const store = create(source.projection.vaultUid);
        await store.startProcess();
        await store.setConfigurationEpoch(1);
        const recipe = controllerRecipe(config, source.handle);
        const claimed = await store.claimInput(recipe, createCandidateJobId());
        if (n === 1) {
          await store.beginBuilding(claimed.lease);
          await store.attachOutput(
            claimed.lease,
            descriptorFor(recipe, 129, 0),
          );
        }
        prior.push(claimed.lease.jobId);
      }
      const stores = new Map(
        config.sources.map((s) => [s.handle, create(s.projection.vaultUid)]),
      );
      let launches = 0;
      const controller = new OwnedRebuildController({
        configuration: config,
        stores,
        builder: {
          async preflight() {
            throw new Error("must not preflight during startup");
          },
          async build() {
            launches++;
            throw new Error("must never resume");
          },
        },
      });
      const supervised = deferred();
      try {
        const starting = controller.start(async () => {
          assert.equal(controller.ready, false);
          supervised.resolve();
          await stopped.promise;
        });
        const stopped = deferred();
        await supervised.promise;
        for (const [n, source] of config.sources.entries())
          assert.equal(
            (await stores.get(source.handle).readJob(prior[n])).failureCode,
            "INTERRUPTED",
          );
        assert.equal(controller.ready, false);
        assert.equal(launches, 0);
        stopped.resolve();
        await starting;
        assert.equal(controller.ready, true);
        for (const [n, source] of config.sources.entries()) {
          assert.equal(
            (await stores.get(source.handle).inspectInput(prior[n])).manifest,
            null,
          );
          assert.equal(
            commands
              .map((args) => JSON.parse(args.at(-1)))
              .filter((r) => r.op === "cleanup" && r.jobId === prior[n]).length,
            n === 0 ? 1 : 2,
          );
        }
      } finally {
        await controller.shutdown();
      }
    },
  );

  await t.test(
    "input claim is definitive and absent, begin is explicit, and attachment is immutable",
    async () => {
      const { store, recipe, lease, key } = await inputFixture();
      const fields = await command("HGETALL", key);
      assert.equal(fields.manifestVersion, "2");
      assert.equal(Object.hasOwn(fields, "outputDescriptor"), false);
      assert.equal(Object.hasOwn(fields, "concepts"), false);
      assert.equal(Object.hasOwn(fields, "chunks"), false);
      for (const name of [
        "nextConcept",
        "nextChunk",
        "cleanupConcept",
        "cleanupChunk",
      ])
        assert.equal(fields[name], "0");
      const initial = await store.readCandidate(lease.jobId);
      assert.equal(initial.manifestVersion, 2);
      assert.equal(Object.hasOwn(initial, "outputDescriptor"), false);
      assert.equal(initial.recipeHash, recipe.recipeHash);
      assert.deepEqual(initial.lease, lease);
      assert.ok(Object.isFrozen(initial));
      const output = descriptorFor(recipe);
      await assert.rejects(
        () => store.attachOutput(lease, output),
        code("FENCED"),
      );
      await assert.rejects(
        () => store.append(lease, "concept", 0, [record]),
        code("FENCED"),
      );
      await store.renew(lease);
      await store.beginBuilding(lease);
      await store.beginBuilding(lease);
      assert.equal(await command("HEXISTS", key, "outputDescriptor"), 0);
      await assert.rejects(
        () => store.append(lease, "concept", 0, [record]),
        code("FENCED"),
      );
      const duplicate = await store.claimInput(recipe, createCandidateJobId());
      assert.equal(duplicate.created, false);
      assert.deepEqual(duplicate.lease, lease);
      for (const op of ["index", "verify", "evaluate", "complete", "activate"])
        assert.equal(
          (
            await raw(store, {
              op,
              epoch: lease.ownerEpoch,
              lease: {
                ...lease,
                configurationEpoch: String(lease.configurationEpoch),
              },
            })
          ).ok,
          false,
        );
      await store.attachOutput(lease, output);
      const before = await command("HGETALL", key);
      await store.attachOutput(lease, output);
      await store.beginBuilding(lease);
      assert.deepEqual(await command("HGETALL", key), before);
      const conflicting = descriptorFor(recipe, 2);
      await assert.rejects(
        () => store.attachOutput(lease, conflicting),
        code("BUILD_CONFLICT"),
      );
      assert.equal(
        await command("HGET", key, "outputDescriptor"),
        output.serialized,
      );
      const attached = await store.readCandidate(lease.jobId);
      assert.deepEqual(attached.outputDescriptor, output);
      assert.ok(Object.isFrozen(attached.outputDescriptor));
      await store.append(lease, "concept", 0, [record]);
      assert.equal((await store.readCandidate(lease.jobId)).nextConcept, 1);
      assert.deepEqual(
        JSON.parse(
          await command(
            "JSON.GET",
            `${store.namespace}build:${recipe.buildId}:concept:0`,
          ),
        ),
        record,
      );
      await store.fail(lease, "INTERNAL");
      for (const action of [
        () => store.beginBuilding(lease),
        () => store.attachOutput(lease, output),
        () => store.renew(lease),
      ])
        await assert.rejects(action, code("FENCED"));
      await store.cleanup(lease.jobId);
      assert.equal(await store.readCandidate(lease.jobId), null);
      assert.equal((await store.readJob(lease.jobId)).failureCode, "INTERNAL");
      const retried = await store.claimInput(recipe, createCandidateJobId());
      assert.notEqual(retried.lease.jobId, lease.jobId);
      assert.equal((await store.readJob(lease.jobId)).state, "failed");
      await assert.rejects(
        () => store.attachOutput(lease, output),
        code("FENCED"),
      );
      await store.fail(retried.lease, "INTERNAL");
      await store.cleanup(retried.lease.jobId);
    },
  );

  await t.test(
    "lost real-Redis replies reconcile without replay or premature payloads",
    async () => {
      const uid = `VLT-${String(serial++).padStart(26, "0")}`;
      let dropped;
      let committed;
      let late;
      const attemptId = createCandidateJobId();
      const calls = [];
      const store = create(uid, undefined, async (result, r) => {
        calls.push(r.op);
        if (r.op !== dropped) return result;
        committed();
        return await new Promise((resolve) => {
          late = () => resolve(result);
        });
      });
      await store.startProcess();
      await store.setConfigurationEpoch(1);
      const recipe = recipeFor(uid);
      let lease;
      for (const op of ["claimInput", "begin", "attach", "append"]) {
        dropped = op;
        const commitObserved = new Promise((resolve) => {
          committed = resolve;
        });
        const cancel = new AbortController();
        const pending =
          op === "claimInput"
            ? store.claimInput(recipe, attemptId, cancel.signal)
            : op === "begin"
              ? store.beginBuilding(lease, cancel.signal)
              : op === "attach"
                ? store.attachOutput(
                    lease,
                    descriptorFor(recipe),
                    cancel.signal,
                  )
                : store.append(lease, "concept", 0, [record], cancel.signal);
        try {
          await commitObserved;
          cancel.abort("PRIVATE_MARKER");
          await assert.rejects(
            () => pending,
            (error) =>
              error.name === "AbortError" && error.outcome === "unknown",
          );
        } finally {
          late?.();
        }
        const id = lease?.jobId ?? attemptId;
        const state = await store.readCandidate(id);
        lease = state.lease;
        assert.equal(state.state, op === "claimInput" ? "queued" : "building");
        assert.equal(
          Object.hasOwn(state, "outputDescriptor"),
          op === "attach" || op === "append",
        );
        assert.equal(state.nextConcept, op === "append" ? 1 : 0);
        assert.equal(calls.filter((value) => value === op).length, 1);
        assert.equal(
          await command(
            "EXISTS",
            `${store.namespace}build:${recipe.buildId}:concept:0`,
          ),
          op === "append" ? 1 : 0,
        );
      }
      dropped = undefined;
      await assert.rejects(
        () => store.append(lease, "concept", 0, [record]),
        code("BUILD_CONFLICT"),
      );
      await store.fail(lease, "INTERNAL");
      await store.cleanup(lease.jobId);
      assert.equal((await store.readJob(lease.jobId)).state, "failed");
    },
  );

  await t.test(
    "begin/attachment enforce live ownership and protections, and cancellation orders atomically",
    async () => {
      const { store, recipe, lease, key } = await inputFixture();
      for (const changed of [
        { ...lease, fence: lease.fence + 1 },
        { ...lease, ownerEpoch: lease.ownerEpoch + 1 },
        { ...lease, jobId: `job_${"0".repeat(26)}` },
        { ...lease, buildId: build("f") },
        { ...lease, configurationEpoch: 2 },
      ]) {
        await assert.rejects(
          () => store.beginBuilding(changed),
          code("FENCED"),
        );
        await assert.rejects(
          () => store.attachOutput(changed, descriptorFor(recipe)),
          code("FENCED"),
        );
      }
      for (const pointer of ["active", "previous", "reader"]) {
        if (pointer === "reader")
          await command(
            "ZADD",
            `${store.namespace}lease:${recipe.buildId}`,
            String(Date.now() + 60000),
            "reader",
          );
        else
          await command("SET", `${store.namespace}${pointer}`, recipe.buildId);
        await assert.rejects(
          () => store.beginBuilding(lease),
          code("BUILD_CONFLICT"),
        );
        assert.equal(await command("HGET", key, "state"), "queued");
        if (pointer === "reader")
          await command("DEL", `${store.namespace}lease:${recipe.buildId}`);
        else await command("DEL", `${store.namespace}${pointer}`);
      }
      await store.beginBuilding(lease);
      for (const pointer of ["active", "previous", "reader"]) {
        if (pointer === "reader")
          await command(
            "ZADD",
            `${store.namespace}lease:${recipe.buildId}`,
            String(Date.now() + 60000),
            "reader",
          );
        else
          await command("SET", `${store.namespace}${pointer}`, recipe.buildId);
        await assert.rejects(
          () => store.attachOutput(lease, descriptorFor(recipe)),
          code("BUILD_CONFLICT"),
        );
        assert.equal(await command("HEXISTS", key, "outputDescriptor"), 0);
        if (pointer === "reader")
          await command("DEL", `${store.namespace}lease:${recipe.buildId}`);
        else await command("DEL", `${store.namespace}${pointer}`);
      }
      const [attachment, cancelled] = await Promise.allSettled([
        store.attachOutput(lease, descriptorFor(recipe)),
        store.requestCancel(lease.jobId),
      ]);
      assert.equal(cancelled.status, "fulfilled");
      if (attachment.status === "rejected")
        assert.equal(attachment.reason.code, "FENCED");
      assert.equal(
        Object.hasOwn(
          await store.readCandidate(lease.jobId),
          "outputDescriptor",
        ),
        attachment.status === "fulfilled",
      );
      await store.acknowledgeCancel(lease);
      await store.cleanup(lease.jobId);
      const writing = await inputFixture();
      await writing.store.beginBuilding(writing.lease);
      await writing.store.attachOutput(
        writing.lease,
        descriptorFor(writing.recipe),
      );
      const [append, cancel] = await Promise.allSettled([
        writing.store.append(writing.lease, "concept", 0, [record]),
        writing.store.requestCancel(writing.lease.jobId),
      ]);
      assert.equal(cancel.status, "fulfilled");
      if (append.status === "rejected")
        assert.equal(append.reason.code, "FENCED");
      assert.equal(
        (await writing.store.readCandidate(writing.lease.jobId)).nextConcept,
        append.status === "fulfilled" ? 1 : 0,
      );
      await writing.store.acknowledgeCancel(writing.lease);
      await writing.store.cleanup(writing.lease.jobId);
    },
  );

  await t.test(
    "Redis enforces exact configuration epochs through the maximum safe integer",
    async () => {
      const epochs = [
        2147483648,
        999999999999999,
        1000000000000000,
        Number.MAX_SAFE_INTEGER - 1,
        Number.MAX_SAFE_INTEGER,
      ];
      for (const epoch of epochs) {
        const { store, recipe, lease, key } = await inputFixture(epoch);
        assert.equal(lease.configurationEpoch, epoch);
        assert.equal(
          (await store.readCandidate(lease.jobId)).lease.configurationEpoch,
          epoch,
        );
        assert.equal(
          await command("HGET", key, "configurationEpoch"),
          String(epoch),
        );
        await store.beginBuilding(lease);
        await store.attachOutput(lease, descriptorFor(recipe));
        await store.renew(lease);
        await assert.rejects(
          () => store.setConfigurationEpoch(epoch - 1),
          code("FENCED"),
        );
        assert.equal(
          (await store.claimInput(recipe, createCandidateJobId())).created,
          false,
        );
        if (epoch < Number.MAX_SAFE_INTEGER) {
          await store.setConfigurationEpoch(epoch + 1);
          for (const action of [
            () => store.beginBuilding(lease),
            () => store.attachOutput(lease, descriptorFor(recipe)),
            () => store.append(lease, "concept", 0, [record]),
            () => store.renew(lease),
            () => store.claimInput(recipe, createCandidateJobId()),
          ])
            await assert.rejects(action, code("FENCED"));
          await assert.rejects(
            () => store.setConfigurationEpoch(epoch),
            code("FENCED"),
          );
        }
        await store.requestCancel(lease.jobId);
        await store.startProcess();
        assert.equal(
          (await store.readJob(lease.jobId)).failureCode,
          "INTERRUPTED",
        );
        await store.cleanup(lease.jobId);
      }
      const { store, lease } = await inputFixture();
      for (const value of [
        "0",
        "01",
        "1.0",
        "1e0",
        "9007199254740992",
        1,
        null,
      ]) {
        const reply = await raw(store, {
          op: "configure",
          epoch: lease.ownerEpoch,
          configurationEpoch: value,
        });
        assert.equal(reply.code, "INDEX_UNAVAILABLE");
      }
      assert.equal(
        await command(
          "HGET",
          `${store.namespace}control`,
          "configurationEpoch",
        ),
        "1",
      );
      await store.fail(lease, "INTERNAL");
      await store.cleanup(lease.jobId);
    },
  );

  await t.test(
    "attachment validates the complete descriptor inside Redis, including zero and endpoint counts",
    async () => {
      const { store, recipe, lease, key } = await inputFixture();
      await store.beginBuilding(lease);
      const valid = descriptorFor(recipe);
      const tuple = JSON.parse(valid.serialized);
      const bad = [
        "",
        "null",
        "{}",
        "[]",
        "x".repeat(1025),
        ` ${valid.serialized}`,
        `${valid.serialized}\n`,
      ];
      for (const [index, value] of [
        [1, 2],
        [2, `sha256:${"b".repeat(64)}`],
        [4, 536870913],
        [4, 0],
        [5, 2],
        [6, 50001],
        [6, -1],
        [6, 1.5],
        [6, "1"],
        [8, 250001],
        [8, null],
        [7, emptyHash],
      ]) {
        const copy = [...tuple];
        copy[index] = value;
        bad.push(JSON.stringify(copy));
      }
      const forgedEmpty = [
        "bookie-build-output",
        1,
        recipe.recipeHash,
        hash,
        0,
        0,
        0,
        hash,
        0,
        hash,
      ];
      bad.push(JSON.stringify(forgedEmpty));
      for (const outputDescriptor of bad) {
        const reply = await raw(store, {
          op: "attach",
          epoch: lease.ownerEpoch,
          lease: { ...lease, configurationEpoch: "1" },
          outputDescriptor,
        });
        assert.equal(reply.ok, false);
        assert.equal(await command("HEXISTS", key, "outputDescriptor"), 0);
      }
      await store.attachOutput(lease, descriptorFor(recipe, 50000, 250000));
      assert.equal(
        (await store.readCandidate(lease.jobId)).outputDescriptor.serialized,
        descriptorFor(recipe, 50000, 250000).serialized,
      );
      await store.startProcess();
      // Range boundaries above are validation, not a 300,000-record scale benchmark.
      const empty = await inputFixture(1, "b".repeat(64));
      await empty.store.beginBuilding(empty.lease);
      await empty.store.attachOutput(
        empty.lease,
        descriptorFor(empty.recipe, 0, 0),
      );
      await assert.rejects(
        () =>
          empty.store.append(empty.lease, "concept", 0, [
            { ...record, sourceCommit: empty.recipe.sourceCommit },
          ]),
        code("BUILD_CONFLICT"),
      );
      await empty.store.fail(empty.lease, "INTERNAL");
      assert.deepEqual(await empty.store.cleanup(empty.lease.jobId), {
        done: true,
        removed: 0,
      });
    },
  );

  await t.test(
    "literal negative-zero descriptors reject before attachment and fence persisted corruption",
    async () => {
      const { store, recipe, lease, key } = await inputFixture();
      await store.beginBuilding(lease);
      const canonical = descriptorFor(recipe, 0, 0);
      const tokens = JSON.parse(canonical.serialized).map((value) =>
        JSON.stringify(value),
      );
      const malformed = [4, 5, 6, 8].map((index) => {
        const copy = [...tokens];
        // JSON.stringify(-0) would erase the exact wire counterexample.
        copy[index] = "-0";
        return `[${copy.join(",")}]`;
      });
      for (const outputDescriptor of malformed) {
        assert.throws(() => parseOutputDescriptor(outputDescriptor), TypeError);
        const reply = await raw(store, {
          op: "attach",
          epoch: lease.ownerEpoch,
          lease: { ...lease, configurationEpoch: "1" },
          outputDescriptor,
        });
        assert.deepEqual(reply, { ok: false, code: "INDEX_UNAVAILABLE" });
        assert.equal(await command("HEXISTS", key, "outputDescriptor"), 0);
        assert.equal(
          (await store.readCandidate(lease.jobId)).state,
          "building",
        );
      }
      await store.attachOutput(lease, canonical);
      for (const outputDescriptor of malformed) {
        await command("HSET", key, "outputDescriptor", outputDescriptor);
        try {
          for (const action of [
            () => store.readCandidate(lease.jobId),
            () => store.renew(lease),
            () => store.beginBuilding(lease),
            () => store.attachOutput(lease, canonical),
          ])
            await assert.rejects(action, code("INDEX_UNAVAILABLE"));
          assert.equal(
            await command("HGET", key, "outputDescriptor"),
            outputDescriptor,
          );
          assert.equal((await store.readJob(lease.jobId)).state, "building");
        } finally {
          await command("HSET", key, "outputDescriptor", canonical.serialized);
        }
      }
      await store.renew(lease);
      assert.equal(
        (await store.readCandidate(lease.jobId)).outputDescriptor.serialized,
        canonical.serialized,
      );
      await store.fail(lease, "INTERNAL");
      assert.deepEqual(await store.cleanup(lease.jobId), {
        done: true,
        removed: 0,
      });
    },
  );

  await t.test(
    "private reconciliation fails closed on corrupt fields and phase/state/cursor inconsistencies",
    async () => {
      for (const attached of [false, true]) {
        const { store, recipe, lease, key } = await inputFixture();
        if (attached) {
          await store.beginBuilding(lease);
          await store.attachOutput(lease, descriptorFor(recipe));
        }
        const original = await command("HGETALL", key);
        const corruptions = [
          ["manifestVersion", "3"],
          ["manifestVersion", ""],
          ["outputDescriptor", "null"],
          ["outputDescriptor", ""],
          ["outputDescriptor", "{}"],
          [
            "outputDescriptor",
            JSON.stringify([
              "bookie-build-output",
              1,
              recipe.recipeHash,
              hash,
              0,
              0,
              0,
              hash,
              0,
              hash,
            ]),
          ],
          ["ownerEpoch", String(lease.ownerEpoch + 1)],
          ["fence", String(lease.fence + 1)],
          ["configurationEpoch", "2"],
          ["recipeHash", `sha256:${"b".repeat(64)}`],
          ["nextConcept", "2"],
          ["nextChunk", "1"],
          ["cleanupConcept", "1"],
          ["cleanupChunk", "1"],
          ["concepts", "0"],
          ["unexpected", "PRIVATE_MARKER"],
        ];
        if (!attached) corruptions.push(["nextConcept", "1"]);
        for (const [field, value] of corruptions) {
          await command("HSET", key, field, value);
          for (const action of [
            () => store.readCandidate(lease.jobId),
            () => store.renew(lease),
            () => store.requestCancel(lease.jobId),
            () => store.startProcess(),
          ])
            await assert.rejects(action, code("INDEX_UNAVAILABLE"));
          if (Object.hasOwn(original, field))
            await command("HSET", key, field, original[field]);
          else await command("HDEL", key, field);
          await store.renew(lease);
        }
        for (const state of attached
          ? ["queued", "complete"]
          : ["verifying", "evaluating", "complete"]) {
          await command("HSET", key, "state", state);
          await command(
            "HSET",
            `${store.namespace}job:${lease.jobId}`,
            "state",
            state,
          );
          await assert.rejects(
            () => store.readCandidate(lease.jobId),
            code("INDEX_UNAVAILABLE"),
          );
        }
        await command("HSET", key, "state", original.state);
        await command(
          "HSET",
          `${store.namespace}job:${lease.jobId}`,
          "state",
          original.state,
        );
        await store.fail(lease, "INTERNAL");
        if (!attached) {
          await command("HSET", key, "nextConcept", "1");
          await assert.rejects(
            () => store.cleanup(lease.jobId),
            code("INDEX_UNAVAILABLE"),
          );
          await command("HSET", key, "nextConcept", "0");
        }
        await store.cleanup(lease.jobId);
        assert.equal((await store.readJob(lease.jobId)).state, "failed");
      }
    },
  );

  await t.test(
    "a missing complete manifest cannot admit a replacement or surrender retained payloads",
    async () => {
      for (const concepts of [0, 1]) {
        for (const inputClaim of [false, true]) {
          const { store, recipe, lease, key, uid } = await inputFixture();
          await store.beginBuilding(lease);
          await store.attachOutput(lease, descriptorFor(recipe, concepts, 0));
          const payload = `${store.namespace}build:${recipe.buildId}:concept:0`;
          if (concepts) await store.append(lease, "concept", 0, [record]);
          await command("HSET", key, "state", "complete");
          await command(
            "HSET",
            `${store.namespace}job:${lease.jobId}`,
            "state",
            "complete",
          );
          // A terminal lease must not accidentally hide the admission defect.
          await command("DEL", `${store.namespace}lock:rebuild`);
          const claim = () =>
            inputClaim
              ? store.claimInput(recipe, createCandidateJobId())
              : store.claim({
                  vaultUid: uid,
                  buildId: recipe.buildId,
                  sourceCommit: recipe.sourceCommit,
                  manifestHash: hash,
                  policyHash: recipe.policyHash,
                  concepts,
                  chunks: 0,
                });
          await assert.rejects(claim, code("BUILD_CONFLICT"));
          const control = await command("HGETALL", `${store.namespace}control`);
          const job = await store.readJob(lease.jobId);
          const bytes = concepts ? await command("JSON.GET", payload) : null;
          await command("DEL", key);
          await assert.rejects(
            () => store.readCandidate(lease.jobId),
            code("INDEX_UNAVAILABLE"),
          );
          await assert.rejects(claim, code("INDEX_UNAVAILABLE"));
          assert.deepEqual(
            await command("HGETALL", `${store.namespace}control`),
            control,
          );
          assert.deepEqual(await store.readJob(lease.jobId), job);
          assert.equal(await command("EXISTS", payload), concepts);
          if (concepts) assert.equal(await command("JSON.GET", payload), bytes);
          assert.equal(await command("EXISTS", key), 0);
        }
      }
    },
  );

  await t.test(
    "manifestless retained payloads remain protected after the current attempt advances",
    async () => {
      const { store, recipe, lease, key, uid } = await inputFixture();
      await store.beginBuilding(lease);
      await store.attachOutput(lease, descriptorFor(recipe));
      await store.append(lease, "concept", 0, [record]);
      await command("HSET", key, "state", "complete");
      await command(
        "HSET",
        `${store.namespace}job:${lease.jobId}`,
        "state",
        "complete",
      );
      await command("DEL", `${store.namespace}lock:rebuild`);
      const later = await store.claimInput(
        recipeFor(uid, 1, "b".repeat(40)),
        createCandidateJobId(),
      );
      await store.fail(later.lease, "INTERNAL");
      await store.cleanup(later.lease.jobId);
      await command("DEL", key);
      const payload = `${store.namespace}build:${recipe.buildId}:concept:0`;
      const bytes = await command("JSON.GET", payload);
      const control = await command("HGETALL", `${store.namespace}control`);
      await assert.rejects(
        () => store.claimInput(recipe, createCandidateJobId()),
        code("INDEX_UNAVAILABLE"),
      );
      assert.equal(await command("JSON.GET", payload), bytes);
      assert.deepEqual(
        await command("HGETALL", `${store.namespace}control`),
        control,
      );
      assert.equal((await store.readJob(lease.jobId)).state, "complete");
      assert.equal(await command("EXISTS", key), 0);
    },
  );

  await t.test(
    "expiry, cancellation, and replacement startup fence both phases including queued claims",
    async () => {
      for (const phase of ["queued", "building", "attached"]) {
        const { store, recipe, lease, uid } = await inputFixture();
        if (phase !== "queued") await store.beginBuilding(lease);
        if (phase === "attached")
          await store.attachOutput(lease, descriptorFor(recipe));
        await command("DEL", `${store.namespace}lock:rebuild`);
        for (const action of [
          () => store.beginBuilding(lease),
          () => store.attachOutput(lease, descriptorFor(recipe)),
          () => store.renew(lease),
          () => store.fail(lease, "INTERNAL"),
        ])
          await assert.rejects(action, code("FENCED"));
        const replacement = create(uid);
        await replacement.startProcess();
        assert.equal(
          (await replacement.readJob(lease.jobId)).failureCode,
          "INTERRUPTED",
        );
        for (const action of [
          () => store.beginBuilding(lease),
          () => replacement.attachOutput(lease, descriptorFor(recipe)),
          () => store.setConfigurationEpoch(2),
        ])
          await assert.rejects(action, code("FENCED"));
        await replacement.cleanup(lease.jobId);
        assert.equal((await replacement.readJob(lease.jobId)).state, "failed");
      }
      for (const attached of [false, true]) {
        const { store, recipe, lease } = await inputFixture();
        if (attached) {
          await store.beginBuilding(lease);
          await store.attachOutput(lease, descriptorFor(recipe));
        }
        await store.requestCancel(lease.jobId);
        for (const action of [
          () => store.beginBuilding(lease),
          () => store.attachOutput(lease, descriptorFor(recipe)),
          () => store.append(lease, "concept", 0, [record]),
        ])
          await assert.rejects(action, code("FENCED"));
        await store.acknowledgeCancel(lease);
        assert.equal(
          (await store.readJob(lease.jobId)).failureCode,
          "CANCELLED",
        );
        await store.cleanup(lease.jobId);
      }
      const live = await inputFixture();
      await live.store.beginBuilding(live.lease);
      const replacement = create(live.uid);
      await replacement.startProcess();
      await assert.rejects(
        () => live.store.attachOutput(live.lease, descriptorFor(live.recipe)),
        code("FENCED"),
      );
      await replacement.cleanup(live.lease.jobId);
    },
  );

  await t.test(
    "cleanup scans full output ranges and preserves protections, terminal status, and unrelated links",
    async () => {
      for (const attached of [false, true]) {
        const { store, recipe, lease, key, uid } = await inputFixture();
        if (attached) {
          await store.beginBuilding(lease);
          await store.attachOutput(lease, descriptorFor(recipe, 129, 2));
        }
        await assert.rejects(
          () => store.cleanup(lease.jobId),
          code("BUILD_CONFLICT"),
        );
        const payload = `${store.namespace}build:${recipe.buildId}:`;
        // Simulate unacknowledged dependency writes without advancing append cursors.
        await command("SET", `${payload}concept:0`, "uncertain");
        if (attached) {
          await command("SET", `${payload}concept:128`, "uncertain");
          await command("SET", `${payload}chunk:1`, "uncertain");
        }
        await store.fail(lease, "INTERNAL");
        for (const pointer of ["active", "previous"]) {
          await command("SET", `${store.namespace}${pointer}`, recipe.buildId);
          await assert.rejects(
            () => store.cleanup(lease.jobId),
            code("BUILD_CONFLICT"),
          );
          await command("DEL", `${store.namespace}${pointer}`);
        }
        await command(
          "ZADD",
          `${store.namespace}lease:${recipe.buildId}`,
          String(Date.now() + 60000),
          "reader",
        );
        await assert.rejects(
          () => store.cleanup(lease.jobId),
          code("BUILD_CONFLICT"),
        );
        await command("DEL", `${store.namespace}lease:${recipe.buildId}`);
        // A valid complete layout remains immutable too (no completion operation added).
        if (attached) {
          await command(
            "HSET",
            key,
            "state",
            "complete",
            "nextConcept",
            "129",
            "nextChunk",
            "2",
          );
          await command(
            "HSET",
            `${store.namespace}job:${lease.jobId}`,
            "state",
            "complete",
            "failureCode",
            "",
          );
          await assert.rejects(
            () => store.cleanup(lease.jobId),
            code("BUILD_CONFLICT"),
          );
          await command(
            "HSET",
            key,
            "state",
            "failed",
            "nextConcept",
            "0",
            "nextChunk",
            "0",
          );
          await command(
            "HSET",
            `${store.namespace}job:${lease.jobId}`,
            "state",
            "failed",
            "failureCode",
            "INTERNAL",
          );
        }
        const newerRecipe = recipeFor(uid, 1, "c".repeat(40));
        const newer = await store.claimInput(
          newerRecipe,
          createCandidateJobId(),
        );
        const first = await store.cleanup(lease.jobId);
        assert.deepEqual(
          first,
          attached ? { done: false, removed: 1 } : { done: true, removed: 0 },
        );
        if (attached) {
          assert.equal(await command("HGET", key, "cleanupConcept"), "128");
          assert.equal(await command("EXISTS", `${payload}concept:128`), 1);
          assert.deepEqual(await store.cleanup(lease.jobId), {
            done: true,
            removed: 2,
          });
        } else
          assert.equal(
            await command("GET", `${payload}concept:0`),
            "uncertain",
          );
        assert.equal(
          await command("HGET", `${store.namespace}control`, "currentJob"),
          newer.lease.jobId,
        );
        assert.equal(
          (await store.readJob(lease.jobId)).failureCode,
          "INTERNAL",
        );
        await store.fail(newer.lease, "INTERNAL");
        await store.cleanup(newer.lease.jobId);
      }
    },
  );

  await t.test(
    "legacy/v2 duplicate recognition, namespace isolation, and control redaction stay distinct",
    async () => {
      const { store, recipe, lease, uid } = await inputFixture();
      await assert.rejects(
        () =>
          store.claim({ ...spec(), vaultUid: uid, buildId: recipe.buildId }),
        code("BUILD_CONFLICT"),
      );
      const foreign = create(`VLT-${String(serial++).padStart(26, "0")}`);
      await foreign.startProcess();
      await foreign.setConfigurationEpoch(1);
      await assert.rejects(
        () => foreign.readCandidate(lease.jobId),
        code("NOT_FOUND"),
      );
      await assert.rejects(() => foreign.beginBuilding(lease), code("FENCED"));
      await assert.rejects(
        () => foreign.claimInput(recipe, createCandidateJobId()),
        /Candidate input is invalid/u,
      );
      const surfaces =
        JSON.stringify(
          await command(
            "HGETALL",
            `${store.namespace}build:${recipe.buildId}:manifest`,
          ),
        ) +
        JSON.stringify(
          await command("HGETALL", `${store.namespace}job:${lease.jobId}`),
        ) +
        JSON.stringify(await store.readJob(lease.jobId)) +
        JSON.stringify(commands.map((args) => args.at(-1)));
      for (const canary of [
        uid,
        "private/source",
        recipe.serialized,
        "EXCLUDED_REDIS_CANARY_7742",
        "SECRET_REDIS_CANARY_7742",
      ])
        assert.equal(surfaces.includes(canary), false);
      await store.fail(lease, "INTERNAL");
      await store.cleanup(lease.jobId);
      const legacy = await store.claim({
        ...spec(),
        vaultUid: uid,
        buildId: recipe.buildId,
      });
      await assert.rejects(
        () => store.claimInput(recipe, createCandidateJobId()),
        code("BUILD_CONFLICT"),
      );
      await store.append(legacy.lease, "concept", 0, [record]);
      await store.fail(legacy.lease, "INTERNAL");
      await store.cleanup(legacy.lease.jobId);
    },
  );
  const store = create();
  await store.startProcess();
  const prefix = store.namespace;

  await t.test(
    "duplicate claims converge and different builds conflict",
    async () => {
      const [first, duplicate] = await Promise.all([
        store.claim(spec()),
        store.claim(spec()),
      ]);
      assert.deepEqual(first.lease, duplicate.lease);
      assert.equal(Number(first.created) + Number(duplicate.created), 1);
      await assert.rejects(
        () => store.claim(spec("b")),
        code("BUILD_CONFLICT"),
      );
      assert.equal((await store.readJob(first.lease.jobId)).state, "queued");
      await store.append(first.lease, "concept", 0, [record]);
      const stored = JSON.parse(
        await command("JSON.GET", `${prefix}build:${build("a")}:concept:0`),
      );
      assert.deepEqual(stored, record);
      assert.equal((await store.readJob(first.lease.jobId)).state, "building");
      await assert.rejects(
        () => store.append(first.lease, "concept", 0, [record]),
        code("BUILD_CONFLICT"),
      );
      await store.fail(first.lease, "DEPENDENCY_FAILED");
      assert.equal(
        (await store.readJob(first.lease.jobId)).failureCode,
        "DEPENDENCY_FAILED",
      );
      await assert.rejects(() => store.claim(spec()), code("BUILD_CONFLICT"));
      assert.equal((await store.cleanup(first.lease.jobId)).done, true);
      const retried = await store.claim(spec());
      assert.notEqual(retried.lease.jobId, first.lease.jobId);
      assert.ok(retried.lease.fence > first.lease.fence);
      await assert.rejects(
        () => store.append(first.lease, "concept", 0, [record]),
        code("FENCED"),
      );
      await store.fail(retried.lease, "INTERNAL");
      await store.cleanup(retried.lease.jobId);
    },
  );

  await t.test(
    "cancellation fences payloads before worker acknowledgement",
    async () => {
      const { lease } = await store.claim(spec("b"));
      assert.equal(
        (await store.requestCancel(lease.jobId)).state,
        "cancelling",
      );
      await assert.rejects(
        () => store.append(lease, "concept", 0, [record]),
        code("FENCED"),
      );
      assert.equal(
        await command("EXISTS", `${prefix}build:${build("b")}:concept:0`),
        0,
      );
      assert.equal((await store.acknowledgeCancel(lease)).state, "cancelled");
      assert.equal((await store.requestCancel(lease.jobId)).state, "cancelled");
      await store.cleanup(lease.jobId);
    },
  );

  await t.test(
    "expired leases cannot renew or mutate and restart records interruption",
    async () => {
      const { lease } = await store.claim(spec("c"));
      await store.renew(lease);
      await command("PEXPIRE", `${prefix}lock:rebuild`, "1");
      await delay(10);
      await assert.rejects(() => store.renew(lease), code("FENCED"));
      await assert.rejects(
        () => store.append(lease, "concept", 0, [record]),
        code("FENCED"),
      );
      await store.startProcess();
      assert.equal(
        (await store.readJob(lease.jobId)).failureCode,
        "INTERRUPTED",
      );
      await assert.rejects(() => store.fail(lease, "INTERNAL"), code("FENCED"));
      await store.cleanup(lease.jobId);
    },
  );

  await t.test("a new process fences even a still-live old lease", async () => {
    const { lease } = await store.claim(spec("d"));
    const replacement = create();
    await replacement.startProcess();
    for (const action of [
      () => store.renew(lease),
      () => store.append(lease, "concept", 0, [record]),
      () => store.fail(lease, "INTERNAL"),
      () => store.requestCancel(lease.jobId),
      () => store.cleanup(lease.jobId),
    ]) {
      await assert.rejects(action, code("FENCED"));
    }
    assert.equal((await replacement.readJob(lease.jobId)).state, "failed");
    await replacement.cleanup(lease.jobId);
    await store.startProcess();
  });

  await t.test(
    "preflight rejects a corrupt batch target without partial writes",
    async () => {
      const { lease } = await store.claim(spec("e", 2));
      const collision = `${prefix}build:${build("e")}:concept:1`;
      await command("SET", collision, "foreign-marker");
      await assert.rejects(
        () => store.append(lease, "concept", 0, [record, record]),
        code("INDEX_UNAVAILABLE"),
      );
      assert.equal(
        await command("EXISTS", `${prefix}build:${build("e")}:concept:0`),
        0,
      );
      assert.equal(
        await command(
          "HGET",
          `${prefix}build:${build("e")}:manifest`,
          "nextConcept",
        ),
        "0",
      );
      await store.fail(lease, "INTERNAL");
      await store.cleanup(lease.jobId);
    },
  );

  await t.test(
    "bounded cleanup preserves active, previous, complete and leased data",
    async () => {
      const { lease } = await store.claim(spec("f", 129));
      await store.append(
        lease,
        "concept",
        0,
        Array.from({ length: 128 }, () => record),
      );
      await store.fail(lease, "INTERNAL");
      for (const pointer of ["active", "previous"]) {
        await command("SET", `${prefix}${pointer}`, build("f"));
        await assert.rejects(
          () => store.cleanup(lease.jobId),
          code("BUILD_CONFLICT"),
        );
        assert.equal(
          await command("EXISTS", `${prefix}build:${build("f")}:concept:0`),
          1,
        );
        await command("DEL", `${prefix}${pointer}`);
      }
      await command(
        "ZADD",
        `${prefix}lease:${build("f")}`,
        String(Date.now() + 60_000),
        "reader",
      );
      await assert.rejects(
        () => store.cleanup(lease.jobId),
        code("BUILD_CONFLICT"),
      );
      await command("DEL", `${prefix}lease:${build("f")}`);
      await command(
        "HSET",
        `${prefix}build:${build("f")}:manifest`,
        "state",
        "complete",
      );
      await assert.rejects(
        () => store.cleanup(lease.jobId),
        code("INDEX_UNAVAILABLE"),
      );
      await command(
        "HSET",
        `${prefix}build:${build("f")}:manifest`,
        "state",
        "failed",
      );
      assert.equal((await store.cleanup(lease.jobId)).done, false);
      await assert.rejects(
        () => store.claim(spec("f")),
        code("BUILD_CONFLICT"),
      );
      assert.equal((await store.cleanup(lease.jobId)).done, true);
      assert.equal(
        await command("EXISTS", `${prefix}build:${build("f")}:manifest`),
        0,
      );
      assert.equal((await store.readJob(lease.jobId)).state, "failed");
    },
  );

  await t.test(
    "namespaces isolate foreign jobs and do not expose canonical vault UIDs",
    async () => {
      const { lease } = await store.claim(spec("1"));
      const foreign = create("VLT-00000000000000000000000008");
      await foreign.startProcess();
      assert.notEqual(foreign.namespace, prefix);
      assert.equal(prefix.includes(vaultUid), false);
      await assert.rejects(
        () => foreign.readJob(lease.jobId),
        code("NOT_FOUND"),
      );
      await assert.rejects(
        () => foreign.requestCancel(lease.jobId),
        code("NOT_FOUND"),
      );
      await assert.rejects(
        () => foreign.append(lease, "concept", 0, [record]),
        code("FENCED"),
      );
      await store.fail(lease, "INTERNAL");
      await store.cleanup(lease.jobId);
    },
  );

  await t.test(
    "concurrent cancellation and batch writes have one atomic ordering",
    async () => {
      const { lease } = await store.claim(spec("3"));
      const [written, cancelled] = await Promise.allSettled([
        store.append(lease, "concept", 0, [record]),
        store.requestCancel(lease.jobId),
      ]);
      assert.equal(cancelled.status, "fulfilled");
      assert.equal(cancelled.value.state, "cancelling");
      if (written.status === "rejected")
        assert.equal(written.reason.code, "FENCED");
      assert.equal(
        await command("EXISTS", `${prefix}build:${build("3")}:concept:0`),
        written.status === "fulfilled" ? 1 : 0,
      );
      await store.acknowledgeCancel(lease);
      await store.cleanup(lease.jobId);
    },
  );

  await t.test(
    "a RedisJSON write denial marks the candidate failed, never serving",
    async () => {
      await command(
        "ACL",
        "SETUSER",
        "no-json",
        "on",
        "nopass",
        "~*",
        "+@all",
        "-json.mset",
      );
      const restricted = create(vaultUid, "no-json");
      await restricted.startProcess();
      const { lease } = await restricted.claim(spec("4"));
      await assert.rejects(
        () => restricted.append(lease, "concept", 0, [record]),
        code("INDEX_UNAVAILABLE"),
      );
      assert.equal(
        (await restricted.readJob(lease.jobId)).failureCode,
        "DEPENDENCY_FAILED",
      );
      assert.equal(
        await command("EXISTS", `${prefix}build:${build("4")}:concept:0`),
        0,
      );
      await restricted.cleanup(lease.jobId);
      await store.startProcess();
    },
  );

  await t.test(
    "counter exhaustion refuses new identities without invalidating the last valid lease",
    async () => {
      const uid = "VLT-00000000000000000000000007";
      const limited = create(uid);
      await limited.startProcess();
      await command(
        "HSET",
        `${limited.namespace}control`,
        "fence",
        "2147483646",
      );
      const { lease } = await limited.claim({ ...spec("5"), vaultUid: uid });
      assert.equal(lease.fence, 2147483647);
      await limited.renew(lease);
      await limited.append(lease, "concept", 0, [record]);
      await limited.fail(lease, "INTERNAL");
      await limited.cleanup(lease.jobId);
      await assert.rejects(
        () => limited.claim({ ...spec("6"), vaultUid: uid }),
        code("INDEX_UNAVAILABLE"),
      );
      assert.equal(
        await command("HGET", `${limited.namespace}control`, "fence"),
        "2147483647",
      );
    },
  );

  await t.test(
    "approved isolated policy-filtered projections survive Redis JSON round trips",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "bookie-redis-vault-"));
      t.after(() => rm(root, { recursive: true, force: true }));
      await cp(
        resolve(import.meta.dirname, "../../../../examples/vault"),
        root,
        { recursive: true },
      );
      const excludedUid = "DOC-00000000000000000000000077";
      const excludedPath = "projects/demo/documents/private.md";
      const excludedMarker = "EXCLUDED_REDIS_CANARY_7742";
      const original = await readFile(
        join(root, "projects/demo/documents/overview.md"),
        "utf8",
      );
      await writeFile(
        join(root, excludedPath),
        original
          .replace(/ {2}uid: DOC-[0-9A-Z]{26}/u, `  uid: ${excludedUid}`)
          .replace("sensitivity: public", "sensitivity: restricted") +
          `\n${excludedMarker}\n`,
      );
      const git = (...args) => {
        const result = spawnSync(
          "git",
          [
            "-c",
            "user.name=Bookie Redis Tests",
            "-c",
            "user.email=redis@example.invalid",
            "-c",
            "commit.gpgSign=false",
            "-C",
            root,
            ...args,
          ],
          { encoding: "utf8" },
        );
        assert.equal(result.status, 0, result.stderr);
        return result.stdout.trim();
      };
      git("init", "-q");
      git("add", "-A");
      git("commit", "-qm", "Redis fixture");
      const uid = "VLT-01ARZ3NDEKTSV4RRFFQ69G5FAY";
      const sourceRef = git("rev-parse", "HEAD");
      git("update-ref", "refs/heads/approved", sourceRef);
      const prepared = await prepareApprovedLexicalProjection(root, {
        sourceRef,
        approvedRef: "refs/heads/approved",
        rollbackWindow: 0,
        timeoutMs: 10_000,
        config: {
          vaultUid: uid,
          approvedSensitivityClasses: ["public"],
          maxChunkBytes: 8192,
          maxChunks: 250000,
        },
      });
      assert.equal(prepared.ok, true, JSON.stringify(prepared));
      assert.equal(prepared.approvedTip, sourceRef);
      const projection = prepared.projection;
      assert.equal(projection.concepts.length, 8);
      const real = create(uid);
      await real.startProcess();
      const { lease } = await real.claim({
        vaultUid: uid,
        buildId: projection.buildId,
        sourceCommit: projection.sourceCommit,
        manifestHash: projection.manifestHash,
        policyHash: projection.policyHash,
        concepts: projection.concepts.length,
        chunks: projection.chunks.length,
      });
      await real.append(lease, "concept", 0, projection.concepts);
      await real.append(lease, "chunk", 0, projection.chunks);
      const keys = await command("KEYS", `${real.namespace}*`);
      let emitted =
        JSON.stringify(keys) + JSON.stringify(await real.readJob(lease.jobId));
      for (const kind of ["concept", "chunk"]) {
        const expected =
          kind === "concept" ? projection.concepts : projection.chunks;
        for (let index = 0; index < expected.length; index++) {
          const raw = await command(
            "JSON.GET",
            `${real.namespace}build:${projection.buildId}:${kind}:${index}`,
          );
          emitted += raw;
          assert.deepEqual(JSON.parse(raw), expected[index]);
        }
      }
      assert.ok(emitted.includes("/projects/demo/documents/overview.md"));
      for (const excluded of [excludedUid, excludedPath, excludedMarker])
        assert.equal(emitted.includes(excluded), false);
      assert.equal(await command("EXISTS", `${real.namespace}active`), 0);
      await real.fail(lease, "INTERNAL");
      await real.cleanup(lease.jobId);
      // Explicit test-only composition, not S5 provenance or legacy-ID migration.
      const recipe = storedRecipe(uid, sourceRef);
      const outputDescriptor = encodeOutputDescriptor({
        recipeHash: recipe.recipeHash,
        canonical: projection.canonicalOutput,
        concepts: {
          count: projection.concepts.length,
          hash: stream(projection.concepts),
        },
        chunks: {
          count: projection.chunks.length,
          hash: stream(projection.chunks),
        },
      });
      await real.setConfigurationEpoch(1);
      const input = await real.claimInput(recipe, createCandidateJobId());
      await real.beginBuilding(input.lease);
      await real.attachOutput(input.lease, outputDescriptor);
      await real.append(input.lease, "concept", 0, projection.concepts);
      await real.append(input.lease, "chunk", 0, projection.chunks);
      const measured = await real.verifyStoredOutput(
        input.lease,
        recipe,
        outputDescriptor,
        { timeoutMs: 20000 },
      );
      assert.equal(measured.concepts.hash, projection.conceptStreamHash);
      assert.equal(measured.chunks.hash, projection.chunkStreamHash);
      assert.notEqual(recipe.buildId, projection.buildId);
      const surfaces =
        JSON.stringify(measured) +
        JSON.stringify(await real.readJob(input.lease.jobId));
      for (const excluded of [
        excludedUid,
        excludedPath,
        excludedMarker,
        "SECRET_REDIS_CANARY_7742",
        "Included control",
        uid,
      ])
        assert.equal(surfaces.includes(excluded), false);
      assert.equal((await real.readJob(input.lease.jobId)).state, "building");
      await real.fail(input.lease, "INTERNAL");
      await real.cleanup(input.lease.jobId);
    },
  );

  await t.test(
    "restart and failure never modify retained serving pointers",
    async () => {
      await store.startProcess();
      await command("SET", `${prefix}active`, build("8"));
      await command("SET", `${prefix}previous`, build("9"));
      await command(
        "HSET",
        `${prefix}build:${build("8")}:manifest`,
        "state",
        "complete",
      );
      const { lease } = await store.claim(spec("2"));
      await store.startProcess();
      await store.cleanup(lease.jobId);
      assert.equal(await command("GET", `${prefix}active`), build("8"));
      assert.equal(await command("GET", `${prefix}previous`), build("9"));
      assert.equal(
        await command("HGET", `${prefix}build:${build("8")}:manifest`, "state"),
        "complete",
      );
    },
  );
});
