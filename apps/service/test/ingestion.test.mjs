import assert from "node:assert/strict";
import { createHook } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { spawnSync } from "node:child_process";
import {
  chmod,
  cp,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  prepareApprovedLexicalProjection,
  preflightDeploymentSource,
} from "../dist/ingestion.js";
import { prepareLexicalProjection } from "../dist/projection.js";

const config = {
  vaultUid: "VLT-00000000000000000000000009",
  approvedSensitivityClasses: ["public"],
  maxChunkBytes: 8192,
  maxChunks: 250_000,
};
const approvedRef = "refs/heads/approved";
function git(root, args) {
  const result = spawnSync(
    "git",
    [
      "-c",
      "user.name=Ingestion Test",
      "-c",
      "user.email=test@example.invalid",
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
}
async function vault(t) {
  const root = await mkdtemp(join(tmpdir(), "bookie-ingestion-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(
    resolve(import.meta.dirname, "../../../fixtures/valid-vault"),
    root,
    { recursive: true },
  );
  for (const path of await readdir(root, { recursive: true })) {
    if (!path.endsWith(".md") || path.endsWith("index.md")) continue;
    const file = join(root, path);
    const source = await readFile(file, "utf8");
    const match = /^---\n([^\n]+)\n---\n([\s\S]*)$/u.exec(source);
    assert.ok(match);
    const fm = JSON.parse(match[1]);
    fm.bookie.sensitivity = "public";
    await writeFile(file, `---\n${JSON.stringify(fm)}\n---\n${match[2]}`);
  }
  git(root, ["init", "-q"]);
  return { root, commit: commit(root) };
}
function commit(root) {
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "--allow-empty", "-m", "ingestion fixture"]);
  const oid = git(root, ["rev-parse", "HEAD"]);
  git(root, ["update-ref", approvedRef, oid]);
  return oid;
}
const ingest = (source, extra = {}) =>
  prepareApprovedLexicalProjection(source.root, {
    sourceRef: source.commit,
    approvedRef,
    rollbackWindow: 0,
    config,
    timeoutMs: 10_000,
    ...extra,
  });

const preflight = (source, extra = {}) =>
  preflightDeploymentSource(
    {
      handle: "demo",
      root: source.root,
      repositoryRoot: source.root,
      approvedRef,
      rollbackWindow: 0,
      timeoutMs: 21600000,
      projection: config,
    },
    { sourceRef: source.commit, timeoutMs: 7000, ...extra },
  );

test("approved ingestion isolates the whole Git/export/projection path and preserves exact build identity", async (t) => {
  const source = await vault(t);
  const expected = await prepareLexicalProjection(source.root, {
    sourceRef: source.commit,
    config,
  });
  assert.equal(expected.ok, true);
  let workers = 0;
  let processes = 0;
  const hook = createHook({
    init(_id, type) {
      if (type === "WORKER") workers++;
      if (type === "PROCESSWRAP") processes++;
    },
  });
  hook.enable();
  let actual;
  try {
    actual = await ingest(source);
  } finally {
    hook.disable();
  }
  assert.deepEqual(actual, { ...expected, approvedTip: source.commit });
  assert.equal(
    workers,
    0,
    "canonical work must not run in the caller's thread or child worker",
  );
  assert.equal(
    processes,
    1,
    "the caller owns only the isolated ingestion process, never Git subprocesses",
  );
  assert.equal(actual.projection.concepts.length, 8);
  const newer = commit(source.root);
  assert.deepEqual(await ingest(source), {
    ok: false,
    reason: "source-not-approved",
  });
  assert.deepEqual(await ingest(source, { rollbackWindow: 1 }), {
    ...expected,
    approvedTip: newer,
  });
  await writeFile(
    join(source.root, "bookie.yaml"),
    "PRIVATE_UNCOMMITTED_MARKER\n",
  );
  assert.deepEqual(await ingest(source, { rollbackWindow: 1 }), {
    ...expected,
    approvedTip: newer,
  });
});

test("approved ingestion rejects final-chunk secrets and corrupted approved blobs without partial output", async (t) => {
  const source = await vault(t);
  const path = "projects/fixture/documents/document.md";
  const file = join(source.root, path);
  const original = await readFile(file, "utf8");
  const closing = original.indexOf("\n---\n", 4) + 5;
  assert.ok(closing > 4);
  await writeFile(
    file,
    original.slice(0, closing) + "a".repeat(64) + "ghp_" + "b".repeat(36),
  );
  source.commit = commit(source.root);
  assert.deepEqual(
    await ingest(source, { config: { ...config, maxChunkBytes: 64 } }),
    { ok: false, reason: "secret-policy" },
  );
  await writeFile(file, original);
  source.commit = commit(source.root);
  assert.equal((await ingest(source)).ok, true);
  const oid = git(source.root, ["rev-parse", `${source.commit}:${path}`]);
  const altered = Buffer.from(
    original.replace("Fixture document", "Fixture documenX"),
  );
  const objectPath = join(
    source.root,
    ".git/objects",
    oid.slice(0, 2),
    oid.slice(2),
  );
  await chmod(objectPath, 0o600);
  await writeFile(
    objectPath,
    deflateSync(
      Buffer.concat([Buffer.from(`blob ${altered.length}\0`), altered]),
    ),
  );
  assert.deepEqual(await ingest(source), {
    ok: false,
    reason: "invalid-source",
  });
});

test("approval precedes validation; invalid vault/policy/secret/size failures yield no partial projection", async (t) => {
  const source = await vault(t);
  const manifest = join(source.root, "bookie.yaml");
  const original = await readFile(manifest, "utf8");
  await writeFile(manifest, "PRIVATE_BAD_MANIFEST\n");
  const bad = commit(source.root);
  git(source.root, ["update-ref", approvedRef, source.commit]);
  assert.deepEqual(await ingest({ ...source, commit: bad }), {
    ok: false,
    reason: "source-not-approved",
  });
  git(source.root, ["update-ref", approvedRef, bad]);
  assert.deepEqual(await ingest({ ...source, commit: bad }), {
    ok: false,
    reason: "incomplete",
  });
  await writeFile(manifest, original);
  source.commit = commit(source.root);
  assert.deepEqual(
    await ingest(source, {
      config: { ...config, vaultUid: "VLT-00000000000000000000000008" },
    }),
    { ok: false, reason: "invalid-vault" },
  );
  assert.deepEqual(
    await ingest(source, {
      config: { ...config, approvedSensitivityClasses: [] },
    }),
    { ok: false, reason: "sensitivity-policy" },
  );
  assert.deepEqual(
    await ingest(source, { config: { ...config, maxChunks: 1 } }),
    { ok: false, reason: "incomplete" },
  );
  const path = join(source.root, "projects/fixture/documents/document.md");
  await writeFile(
    path,
    `${await readFile(path, "utf8")}\n-----BEGIN PRIVATE KEY-----\nPRIVATE_SECRET_MARKER\n`,
  );
  source.commit = commit(source.root);
  assert.deepEqual(await ingest(source), {
    ok: false,
    reason: "secret-policy",
  });
});

test("ingestion snapshots caller-owned config and rejects unsafe limits without raw diagnostics", async (t) => {
  const source = await vault(t);
  const mutable = { ...config, approvedSensitivityClasses: ["public"] };
  const request = {
    sourceRef: source.commit,
    approvedRef,
    rollbackWindow: 0,
    timeoutMs: 10_000,
    config: mutable,
  };
  const pending = prepareApprovedLexicalProjection(source.root, request);
  mutable.approvedSensitivityClasses.length = 0;
  request.sourceRef = "PRIVATE_MARKER";
  assert.equal((await pending).ok, true);
  for (const timeoutMs of [
    0,
    -1,
    21_600_001,
    Infinity,
    1.5,
    "1000",
    undefined,
  ]) {
    await assert.rejects(
      () => ingest(source, { timeoutMs }),
      /Ingestion request is invalid/u,
    );
  }
  await assert.rejects(
    () => ingest(source, { unchecked: true }),
    /Ingestion request is invalid/u,
  );
  assert.deepEqual(await ingest(source, { sourceRef: "HEAD" }), {
    ok: false,
    reason: "source-not-approved",
  });
  assert.deepEqual(await ingest(source, { timeoutMs: 1 }), {
    ok: false,
    reason: "deadline-exceeded",
  });
  const controller = new AbortController();
  controller.abort("PRIVATE_ABORT_MARKER");
  await assert.rejects(() => ingest(source, { signal: controller.signal }), {
    name: "AbortError",
    message: "Ingestion cancelled.",
  });
});

function processIsRunningNow(pid, readProc = readFileSync) {
  try {
    const stat = readProc(`/proc/${pid}/stat`, "utf8");
    return !stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z ");
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ESRCH") return false;
    throw error;
  }
}

async function processIsRunning(pid, readProc = readFile) {
  try {
    const stat = await readProc(`/proc/${pid}/stat`, "utf8");
    return !stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z ");
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ESRCH") return false;
    throw error;
  }
}

test("process cleanup checks distinguish disappearance from permission failures", async () => {
  for (const code of ["ENOENT", "ESRCH"]) {
    assert.equal(
      await processIsRunning(123, async () => {
        throw Object.assign(new Error("process disappeared"), { code });
      }),
      false,
    );
  }
  await assert.rejects(
    () =>
      processIsRunning(123, async () => {
        throw Object.assign(new Error("permission failure"), {
          code: "EACCES",
        });
      }),
    { code: "EACCES" },
  );
  assert.equal(
    await processIsRunning(123, async () => "123 (worker) R 1 2"),
    true,
  );
  assert.equal(
    await processIsRunning(123, async () => "123 (worker) Z 1 2"),
    false,
  );
});

// Owned groups only; also stop descendants when a mutation fails the assertion.
async function stopOwnedWorkload(pids) {
  try {
    process.kill(-pids[0], "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
  for (const pid of pids) {
    for (let n = 0; n < 100 && (await processIsRunning(pid)); n++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(
      await processIsRunning(pid),
      false,
      "owned workload cleanup failed",
    );
  }
}

test(
  "cancellation and deadline kill blocked ingestion and its descendants before returning",
  { skip: process.platform !== "linux" },
  async (t) => {
    const source = await vault(t);
    for (const [phase, mode, operation] of [
      ["ingestion", "cancel", ingest],
      ["ingestion", "deadline", ingest],
      ["preflight", "cancel", preflight],
      ["preflight", "deadline", preflight],
    ]) {
      await t.test(`${phase}/${mode}`, async (t) => {
        const marker = join(source.root, `${phase}-${mode}-pids.json`);
        const fixture = join(source.root, "blocked.mjs");
        await writeFile(
          fixture,
          `
    import { spawn } from 'node:child_process';
    import { writeFileSync } from 'node:fs';
    process.once('message', () => {
      const child = spawn(process.execPath, ['-e', 'process.send("ready"); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      child.once('message', () => {
        writeFileSync(process.argv[2], JSON.stringify([process.pid, child.pid]));
        while (true) {}
      });
    });
  `,
        );
        const cpModule = createRequire(import.meta.url)("node:child_process");
        const original = cpModule.fork;
        const mock = t.mock.method(
          cpModule,
          "fork",
          (_modulePath, _args, options) => original(fixture, [marker], options),
        );
        syncBuiltinESMExports();
        const controller = new AbortController();
        let pids;
        const observeSettlement = () => {
          assert.ok(pids, "current workload must start before settlement");
          for (const pid of pids)
            assert.equal(
              processIsRunningNow(pid),
              false,
              `${phase}/${mode} pid ${pid} still runs at settlement`,
            );
        };
        const pending = operation(source, {
          signal: controller.signal,
          timeoutMs: mode === "deadline" ? 2000 : 7000,
        }).then(
          (result) => {
            observeSettlement();
            return result;
          },
          (error) => {
            observeSettlement();
            throw error;
          },
        );
        // Attach the rejection handler before abort to avoid an unhandled rejection.
        const rejected =
          mode === "cancel"
            ? assert.rejects(() => pending, {
                name: "AbortError",
                message: "Ingestion cancelled.",
              })
            : pending.then((result) =>
                assert.deepEqual(result, {
                  ok: false,
                  reason: "deadline-exceeded",
                }),
              );
        try {
          for (let n = 0; n < 200 && pids === undefined; n++) {
            try {
              pids = JSON.parse(await readFile(marker, "utf8"));
            } catch {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
          }
          assert.ok(pids, "isolated process must begin its blocked workload");
          if (mode === "cancel") controller.abort("PRIVATE_ABORT_MARKER");
          await rejected;
        } finally {
          controller.abort();
          try {
            await rejected;
          } finally {
            try {
              if (pids !== undefined) await stopOwnedWorkload(pids);
            } finally {
              mock.mock.restore();
              syncBuiltinESMExports();
            }
          }
        }
      });
    }
  },
);

test("spawn, dispatch, child crash and invalid reply failures remain static", async (t) => {
  const source = await vault(t);
  for (const [phase, operation] of [
    "spawn",
    "dispatch",
    "crash",
    "reply",
  ].flatMap((phase) => [
    [phase, ingest],
    [phase, preflight],
  ])) {
    const fixture = join(source.root, "fault.mjs");
    await writeFile(
      fixture,
      phase === "crash"
        ? "throw new Error('PRIVATE_CRASH_MARKER');"
        : "process.once('message', () => process.send({ ok: false, reason: 'PRIVATE_REPLY_MARKER' }));",
    );
    const cpModule = createRequire(import.meta.url)("node:child_process");
    const original = cpModule.fork;
    const mock = t.mock.method(
      cpModule,
      "fork",
      (modulePath, args, options) => {
        if (phase === "spawn") throw new Error("PRIVATE_SPAWN_MARKER");
        const child = original(
          phase === "dispatch" ? modulePath : fixture,
          args,
          options,
        );
        if (phase === "dispatch")
          child.send = () => {
            throw new Error("PRIVATE_DISPATCH_MARKER");
          };
        return child;
      },
    );
    syncBuiltinESMExports();
    try {
      assert.deepEqual(
        await operation(source),
        { ok: false, reason: "ingestion-error" },
        phase,
      );
    } finally {
      mock.mock.restore();
      syncBuiltinESMExports();
    }
  }
});
