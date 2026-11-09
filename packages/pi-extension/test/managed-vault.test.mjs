import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  cp,
  rmdir,
  readdir,
  rm,
  symlink,
  unlink,
  rename,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectConcept, readRecallState, validateVault } from "pi-bookie-core";
import { openManagedVault } from "../dist/managed-vault.js";

const allow = async () => {};
async function setup(t) {
  const parent = await mkdtemp(join(tmpdir(), "bookie-first-run-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const agent = join(parent, "agent");
  const workspace = join(parent, "new-event");
  await mkdir(agent);
  await mkdir(workspace);
  return {
    parent,
    workspace,
    agent,
    open: (path = workspace, check = allow) =>
      openManagedVault(path, check, agent),
  };
}

test("two simultaneous first opens publish the same valid project outside an untouched empty workspace", async (t) => {
  const { workspace, open } = await setup(t);
  const [first, other] = await Promise.all([open(), open()]);
  assert.equal(first.root, other.root);
  assert.deepEqual(await readdir(workspace), []);
  const checked = await validateVault(first.root);
  assert.equal(checked.valid, true, JSON.stringify(checked.diagnostics));
  const project = await inspectConcept(
    first.root,
    { path: first.project },
    { maxContentBytes: 1 },
  );
  assert.equal(project.type, "Project");
  assert.equal(project.sensitivity.value, "internal");
  await first.assertCurrent();
  assert.equal((await readRecallState(first.root)).ok, true);
  assert.equal((await open()).root, first.root);
});

test("a different or replaced workspace does not inherit the original ledger", async (t) => {
  const { workspace, parent, open } = await setup(t);
  const first = await open();
  const second = join(parent, "another");
  await mkdir(second);
  assert.notEqual((await open(second)).root, first.root);
  await rename(workspace, join(parent, "old"));
  await mkdir(workspace);
  await assert.rejects(first.assertCurrent);
  assert.notEqual((await open()).root, first.root);
});

test("existing memory with missing controls is never silently reinitialized", async (t) => {
  const { open } = await setup(t);
  const first = await open();
  await unlink(join(first.root, "bookie-recall.json"));
  await assert.rejects(open);
  assert.equal(
    (await readdir(first.root)).includes("bookie-recall.json"),
    false,
  );
});

test("denied authority and redirected private storage cannot write into the project", async (t) => {
  const { workspace, agent, open } = await setup(t);
  await assert.rejects(() =>
    open(workspace, async () => {
      throw Error("off");
    }),
  );
  assert.deepEqual(await readdir(agent), []);
  await symlink(workspace, join(agent, "bookie-project-memory"), "dir");
  await assert.rejects(open);
  assert.deepEqual(await readdir(workspace), []);
});

test("a deleted workspace and a replaced private vault cannot inherit an old binding", async (t) => {
  const { workspace, parent, open } = await setup(t);
  const first = await open();
  await rmdir(workspace);
  await mkdir(workspace);
  await assert.rejects(first.assertCurrent);
  const fresh = await open();
  assert.notEqual(fresh.root, first.root);
  const original = join(parent, "old-vault");
  await rename(fresh.root, original);
  await cp(original, fresh.root, { recursive: true });
  await assert.rejects(open);
});
