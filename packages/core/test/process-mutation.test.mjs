import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { withRootMutationQueue } from "../dist/concept-mutation-filesystem.js";
import { amendConcept, computeConceptSourceHash } from "../dist/index.js";

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "bookie-process-"));
  const vault = join(dir, "vault");
  await cp(
    resolve(import.meta.dirname, "../../../fixtures/valid-vault"),
    vault,
    { recursive: true },
  );
  t.after(() => rm(dir, { recursive: true, force: true }));
  const worker = join(dir, "worker.mjs");
  await writeFile(
    worker,
    `import { withRootMutationQueue } from ${JSON.stringify(new URL("../dist/concept-mutation-filesystem.js", import.meta.url).href)};
import { readFile, writeFile } from "node:fs/promises";
await withRootMutationQueue(process.argv[2], undefined, async () => {
  process.send("held");
  await new Promise(resolve => process.once("message", resolve));
  const target = process.argv[2] + "/projects/fixture/tasks/task.md";
  await writeFile(target, (await readFile(target, "utf8")) + "\\nWinning update\\n");
});
process.disconnect();`,
  );
  const child = fork(worker, [vault], {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  });
  await Promise.race([
    once(child, "message"),
    once(child, "exit").then(() => {
      throw new Error("Writer exited before acquiring ownership");
    }),
  ]);
  return { vault, child };
}

test("two processes serialize revisions: a held winner leaves a stale conflict", async (t) => {
  const { vault, child } = await fixture(t);
  const path = "projects/fixture/tasks/task.md";
  const original = await readFile(join(vault, path));
  let settled = false;
  const pending = amendConcept(vault, {
    path,
    expectedSourceHash: computeConceptSourceHash(original),
    edits: [],
    bodyText: "Losing update",
  }).finally(() => {
    settled = true;
  });
  await delay(200);
  assert.equal(
    settled,
    false,
    "another process must not enter the held critical section",
  );
  const exited = once(child, "exit");
  child.send("release");
  await exited;
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.conflict, true);
  assert.deepEqual(result.changedPaths, []);
  assert.match(await readFile(join(vault, path), "utf8"), /Winning update/);
  await assert.rejects(readFile(join(vault, ".bookie-write.lock")), {
    code: "ENOENT",
  });
});

test("interrupted ownership stays blocked and a waiting writer can cancel", async (t) => {
  const { vault, child } = await fixture(t);
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  const owner = await readFile(join(vault, ".bookie-write.lock"), "utf8");
  const path = "projects/fixture/tasks/task.md";
  const original = await readFile(join(vault, path));
  const controller = new AbortController();
  const pending = amendConcept(
    vault,
    {
      path,
      expectedSourceHash: computeConceptSourceHash(original),
      edits: [],
      bodyText: "Never published",
    },
    { signal: controller.signal },
  );
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(
    await readFile(join(vault, ".bookie-write.lock"), "utf8"),
    owner,
  );
  assert.deepEqual(await readFile(join(vault, path)), original);
  const request = {
    path,
    expectedSourceHash: computeConceptSourceHash(original),
    edits: [],
    bodyText: "After explicit recovery",
  };
  const blocked = await amendConcept(vault, request);
  assert.equal(blocked.ok, false);
  assert.ok(blocked.diagnostics.some((row) => row.code === "MUTATION-LOCKED"));
  assert.equal(
    await readFile(join(vault, ".bookie-write.lock"), "utf8"),
    owner,
  );
  // The owner has exited and no writers remain; explicit operator recovery.
  await rm(join(vault, ".bookie-write.lock"));
  assert.equal((await amendConcept(vault, request)).ok, true);
});

test("trusted authority is revalidated after waiting for vault ownership", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "bookie-authority-lock-"));
  const vault = join(dir, "vault");
  await cp(
    resolve(import.meta.dirname, "../../../fixtures/valid-vault"),
    vault,
    { recursive: true },
  );
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = "projects/fixture/tasks/task.md";
  const original = await readFile(join(vault, path));
  let release;
  let entered;
  const heldSignal = new Promise((resolve) => {
    entered = resolve;
  });
  const held = withRootMutationQueue(vault, undefined, async () => {
    entered();
    await new Promise((resolve) => {
      release = resolve;
    });
  });
  await heldSignal;
  let queued;
  const queuedSignal = new Promise((resolve) => {
    queued = resolve;
  });
  let revoked = false;
  let revalidated = 0;
  const pending = amendConcept(
    vault,
    {
      path,
      expectedSourceHash: computeConceptSourceHash(original),
      edits: [],
      bodyText: "Must not publish",
    },
    {
      runExclusive: async (_path, work) => {
        queued();
        return work();
      },
      assertAuthority: async () => {
        revalidated++;
        assert.ok(await readFile(join(vault, ".bookie-write.lock")));
        if (revoked) throw new Error("revoked");
      },
    },
  );
  await queuedSignal;
  revoked = true;
  release();
  await held;
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(revalidated, 1);
  assert.deepEqual(result.changedPaths, []);
  assert.deepEqual(await readFile(join(vault, path)), original);
});
