import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  captureTaskFiles,
  openTaskHistory,
  publishTaskFiles,
  readTaskBlob,
} from "../dist/index.js";

test("task selection, read-only recovery and duplicate observation receipts", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bookie-history-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vault = path.join(root, "vault");
  await mkdir(vault, { mode: 0o700 });
  const scope = {
    vault,
    projectId: "PRJ-00000000000000000000000000",
    assertCurrent: async () => {},
  };
  const history = await openTaskHistory(scope);
  const selection = await history.selectNew("Ticket A");
  const event = {
    version: 1,
    owner: "principal",
    operationId: "example",
    kind: "workflow",
    state: "retained",
    label: "Review result retained",
  };
  const first = await history.append(selection, event);
  assert.deepEqual(await history.append(selection, event), first);
  await assert.rejects(
    history.append(selection, { ...event, label: "Different claim" }),
  );
  const reopened = await openTaskHistory(scope);
  assert.deepEqual(await reopened.selected(), selection);
  assert.equal((await reopened.project(selection)).observations, 1);
  const next = await reopened.selectNew("Ticket B");
  await assert.rejects(history.append(selection, event));
  assert.equal((await reopened.project(next)).observations, 0);
  const selectedAgain = await reopened.selectExisting(selection.taskId);
  assert.notEqual(selectedAgain.revision, selection.revision);
  await assert.rejects(history.append(selection, event));
  assert.equal((await reopened.project(selectedAgain)).observations, 1);
});

test("checkpoint worker uses immutable captured bytes and retains explicit missing paths", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bookie-snapshot-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vault = path.join(root, "vault"),
    workspace = path.join(root, "source");
  await mkdir(vault);
  await mkdir(workspace);
  let active = true;
  const assertCurrent = async () => {
    if (!active) throw Error("revoked");
  };
  const scope = {
    vault,
    projectId: "PRJ-00000000000000000000000000",
    assertCurrent,
  };
  const history = await openTaskHistory(scope);
  const task = await history.ensureSelected();
  await writeFile(path.join(workspace, "file.txt"), "first");
  const files = await captureTaskFiles(
    workspace,
    ["file.txt", "missing.txt"],
    assertCurrent,
  );
  const id = await history.capture(task, files);
  await writeFile(path.join(workspace, "file.txt"), "second");
  await unlink(path.join(workspace, "file.txt"));
  assert.equal((await history.project(task)).lastCheckpoint.state, "captured");
  active = false;
  await assert.rejects(publishTaskFiles(history));
  active = true;
  const resumed = await openTaskHistory(scope);
  await publishTaskFiles(resumed);
  assert.equal((await resumed.project(task)).lastCheckpoint.state, "published");
  const { checkpoints } = await resumed.bundle(task);
  assert.equal(checkpoints[0].checkpointId, id);
  assert.equal(checkpoints[0].manifest.entries[1].status, "missing");
  const file = checkpoints[0].manifest.entries[0];
  assert.equal(
    (
      await readTaskBlob(resumed, checkpoints[0].object, file.digest)
    ).toString(),
    "first",
  );
});

test("an overlapping session takes over pending checkpoint publication under its own grant", async (t) => {
  const root = await mkdtemp(
    path.join(tmpdir(), "bookie-publication-handoff-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const vault = path.join(root, "vault");
  await mkdir(vault, { mode: 0o700 });
  const scope = {
    vault,
    projectId: "PRJ-00000000000000000000000000",
    assertCurrent: async () => {},
  };
  const entered = Promise.withResolvers();
  const leave = Promise.withResolvers();
  let closing = false;
  const old = await openTaskHistory({
    ...scope,
    async assertCurrent() {
      if (closing) {
        entered.resolve();
        await leave.promise;
        throw Error("old session closed");
      }
    },
  });
  const task = await old.ensureSelected();
  await writeFile(path.join(root, "agenda.txt"), "first session");
  const files = await captureTaskFiles(
    root,
    ["agenda.txt"],
    scope.assertCurrent,
  );
  const id = await old.capture(task, files);
  const fresh = await openTaskHistory(scope);
  closing = true;
  const pending = publishTaskFiles(old);
  await entered.promise;
  const resumed = publishTaskFiles(fresh);
  leave.resolve();
  await Promise.all([pending, resumed]);

  const { checkpoints } = await fresh.bundle(task);
  assert.deepEqual(
    checkpoints.map((c) => c.checkpointId),
    [id],
  );
  const file = checkpoints[0].manifest.entries[0];
  assert.equal(
    (await readTaskBlob(fresh, checkpoints[0].object, file.digest)).toString(),
    "first session",
  );
});

test("replay checkpoints move atomically with owner facts and survive reopening", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bookie-replay-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vault = path.join(root, "vault");
  await mkdir(vault, { mode: 0o700 });
  const scope = {
    vault,
    projectId: "PRJ-00000000000000000000000000",
    assertCurrent: async () => {},
  };
  const store = await openTaskHistory(scope);
  const task = await store.selectNew("Field report");
  const event = {
    version: 1,
    owner: "pi-daddy",
    operationId: "first",
    kind: "dispatch",
    state: "admitted",
    label: "Attempt admitted",
  };
  const source = (sequence) => ({
    sequence,
    recordedAt: "2021-01-01T00:00:00.000Z",
  });
  const review = {
    ...event,
    owner: "principal",
    kind: "review",
    state: "reported",
    label: "More recent review",
  };
  await store.append(task, review);
  await store.applyReplay(task, "pi-daddy", 0, 1, [event], [source(1)]);
  assert.equal((await store.project(task)).lastObservation.label, review.label);
  const older = (await store.recent(task)).find(
    (entry) => entry.event.kind === "dispatch",
  );
  assert.equal(older.recordedAt, source(1).recordedAt);
  assert.equal(older.ownerSequence, 1);
  assert.ok(older.indexedAt > older.recordedAt);
  const reopened = await openTaskHistory(scope);
  await reopened.applyReplay(task, "pi-daddy", 0, 1, [event], [source(1)]);
  await assert.rejects(
    reopened.applyReplay(
      task,
      "pi-daddy",
      1,
      3,
      [
        { ...event, operationId: "second" },
        { ...event, label: "Conflicting earlier fact" },
      ],
      [source(2), source(3)],
    ),
  );
  assert.equal(await reopened.replayCursor(task, "pi-daddy"), 1);
  assert.equal((await reopened.recent(task)).length, 2);
  await assert.rejects(
    reopened.applyReplay(task, "pi-daddy", 2, 3, [event], [source(3)]),
  );
  const other = await reopened.selectNew("Another task");
  await assert.rejects(
    store.applyReplay(task, "pi-daddy", 1, 2, [event], [source(2)]),
  );
  assert.equal(await reopened.replayCursor(other, "pi-daddy"), 0);
});
