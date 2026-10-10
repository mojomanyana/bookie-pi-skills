import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { RedisCandidateStore } from "../../dist/redis-candidate-store.js";
import { prepareApprovedLexicalProjection } from "../../dist/ingestion.js";

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
  t.after(() => docker(["rm", "-f", name]));
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
  const create = (uid = vaultUid, username) =>
    new RedisCandidateStore({
      vaultUid: uid,
      namespaceKey,
      execute: async (args, signal) =>
        JSON.parse(
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
        ),
    });
  return { command, create };
}

const code = (expected) => (error) =>
  error.code === expected && error.message === expected;

test("Redis 8 fenced candidate lifecycle", { timeout: 90_000 }, async (t) => {
  const { command, create } = await environment(t);
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
