import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  openTaskHistory,
  exportTaskBundle,
  importTaskBundle,
  readImportedTaskBundle,
  exportHistoryArchive,
  importHistoryArchive,
  readImportedHistoryArchive,
  captureTaskFiles,
  publishTaskFiles,
} from "../dist/index.js";

const noChange = async () => {};
async function workspace(t, projectId) {
  const root = await mkdtemp(join(tmpdir(), "bookie-bundle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, "vault");
  await mkdir(vault, { mode: 0o700 });
  const store = await openTaskHistory({
    vault,
    projectId,
    assertCurrent: noChange,
  });
  return { root, store };
}
function rehash(bundle) {
  const { bundleId: _, ...body } = bundle;
  return {
    ...body,
    bundleId: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
  };
}

test("a selected task travels with exact bytes, preserves limits, and cannot change the destination task", async (t) => {
  const a = await workspace(t, "PRJ-00000000000000000000000001");
  const b = await workspace(t, "PRJ-00000000000000000000000002");
  const unrelated = await a.store.selectNew("Other study");
  await a.store.append(unrelated, {
    version: 1,
    owner: "scout",
    kind: "research",
    operationId: "other-study",
    state: "recorded",
    label: "Unrelated finding",
  });
  const wanted = await a.store.selectNew("Design research");
  await a.store.append(wanted, {
    version: 1,
    owner: "scout",
    kind: "research",
    operationId: "study-1",
    state: "partial",
    label: "Interview recorded with unresolved questions",
  });
  await writeFile(join(a.root, "notes.txt"), "Original observation\n");
  const captured = await captureTaskFiles(
    a.root,
    ["notes.txt", "absent.txt"],
    noChange,
  );
  await a.store.capture(wanted, captured);
  await writeFile(join(a.root, "notes.txt"), "Later observation\n");
  await assert.rejects(exportTaskBundle(a.store, wanted), /pending/);
  await publishTaskFiles(a.store);
  const bundle = await exportTaskBundle(a.store, wanted);
  assert.equal(bundle.observations.length, 1);
  assert.equal(bundle.observations[0].event.state, "partial");
  assert.equal(
    Buffer.from(bundle.blobs[0].data, "base64").toString(),
    "Original observation\n",
  );
  assert.equal(
    bundle.checkpoints[0].manifest.entries.find((e) => e.path === "absent.txt")
      .status,
    "missing",
  );
  assert.equal(JSON.stringify(bundle).includes("Unrelated finding"), false);
  const other = await b.store.selectNew("Current local work");
  await writeFile(join(b.root, "notes.txt"), "User work\n");
  const first = await importTaskBundle(
    b.store,
    JSON.parse(JSON.stringify(bundle)),
  );
  assert.equal(first.duplicate, false);
  assert.equal((await importTaskBundle(b.store, bundle)).duplicate, true);
  assert.deepEqual(
    await readImportedTaskBundle(b.store, bundle.bundleId),
    bundle,
  );
  assert.deepEqual(await b.store.selected(), other);
  assert.equal(
    await readFile(join(b.root, "notes.txt"), "utf8"),
    "User work\n",
  );
  assert.equal((await b.store.project(other)).observations, 0);
  const tampered = structuredClone(bundle);
  tampered.blobs[0].data = Buffer.from("Altered observation\n").toString(
    "base64",
  );
  await assert.rejects(importTaskBundle(b.store, rehash(tampered)), /blob/);
  const conflicting = structuredClone(bundle);
  conflicting.observations[0].event.label = "Different claim";
  await assert.rejects(
    importTaskBundle(b.store, rehash(conflicting)),
    /different content/,
  );
  assert.deepEqual(
    await readImportedTaskBundle(b.store, bundle.bundleId),
    bundle,
  );
});

test("project export captures every local root and dependencies while a task bundle follows only descendants", async (t) => {
  const src = await workspace(t, "PRJ-00000000000000000000000001");
  const dst = await workspace(t, "PRJ-00000000000000000000000002");
  const unrelated = await src.store.selectNew("External preparation");
  const parent = await src.store.selectNew("Creative work");
  const child = await src.store.createChild(parent, "Editorial review");
  await src.store.addDependency(child, unrelated.taskId);
  await assert.rejects(src.store.addDependency(child, child.taskId));
  const selected = await src.store.selectExisting(parent.taskId);
  const empty = async () => ({ records: [], limited: false });
  const single = await exportHistoryArchive(src.store, selected, "task", empty);
  assert.equal(single.bundles.length, 1);
  assert.equal(single.bundles[0].subtasks[0].parentId, parent.taskId);
  assert.deepEqual(single.bundles[0].subtasks[0].prerequisites, [
    unrelated.taskId,
  ]);
  assert.equal(JSON.stringify(single).includes("External preparation"), false);
  const all = await exportHistoryArchive(src.store, selected, "project", empty);
  assert.equal(all.bundles.length, 2);
  assert.deepEqual(
    new Set(all.bundles.map((b) => b.taskId)),
    new Set([parent.taskId, unrelated.taskId]),
  );
  assert.deepEqual(await src.store.selected(), selected);
  const active = await dst.store.selectNew("Existing notes");
  const receipt = await importHistoryArchive(dst.store, all);
  assert.equal(receipt.duplicate, false);
  assert.equal((await importHistoryArchive(dst.store, all)).duplicate, true);
  assert.deepEqual(
    await readImportedHistoryArchive(dst.store, all.archiveId),
    all,
  );
  assert.deepEqual(await dst.store.selected(), active);
  const { archiveId, ...damaged } = structuredClone(all);
  damaged.bundles = damaged.bundles.filter(
    (b) => b.taskId !== unrelated.taskId,
  );
  await assert.rejects(
    importHistoryArchive(dst.store, {
      ...damaged,
      archiveId: createHash("sha256")
        .update(JSON.stringify(damaged))
        .digest("hex"),
    }),
    /prerequisite/,
  );
  const injected = structuredClone(all);
  injected.bundles[0].projectId = "PRJ-00000000000000000000000002";
  await assert.rejects(importHistoryArchive(dst.store, injected));
  assert.deepEqual(
    await readImportedHistoryArchive(dst.store, all.archiveId),
    all,
  );
});
