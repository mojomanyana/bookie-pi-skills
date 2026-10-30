import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
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
  const command = async (...args) =>
    JSON.parse(await docker(["exec", name, "redis-cli", "--json", ...args]));
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
  const create = (uid = vaultUid, username, reply) =>
    new RedisCandidateStore({
      vaultUid: uid,
      namespaceKey,
      execute: async (args, signal) => {
        commands.push(args);
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
              ...args.slice(0, -1),
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
