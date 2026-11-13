import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { recallVault, searchVault } from "../dist/index.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "bookie-recall-"));
  await cp(
    resolve(import.meta.dirname, "../../../fixtures/valid-vault"),
    root,
    { recursive: true },
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = await readFile(
    join(root, "projects/fixture/activities/checkpoint.md"),
    "utf8",
  );
  const metadata = JSON.parse(source.split("\n")[1]);
  const put = async (
    number,
    title,
    body,
    occurredAt,
    generatedAt = occurredAt,
  ) => {
    const value = structuredClone(metadata);
    value.title = title;
    value.generated.at = generatedAt;
    value.bookie.occurred_at = occurredAt;
    value.bookie.uid = "ACT-" + number.toString().padStart(26, "0");
    delete value.bookie.relations;
    const path = `/projects/fixture/activities/note-${number}.md`;
    await writeFile(
      join(root, path.slice(1)),
      `---\n${JSON.stringify(value)}\n---\n${body}`,
    );
    return path;
  };
  return { root, put };
}

test("recall matches all normalized words across title/body without changing exact search", async (t) => {
  const { root, put } = await fixture(t);
  const path = await put(
    11,
    "Workshop learning resource",
    "Café guide: printed MAPS.",
    "2026-11-01T09:00:00Z",
  );
  await put(
    12,
    "Workshop resource",
    "No selected guide.",
    "2026-11-02T09:00:00Z",
  );
  for (const query of [
    "RESOURCE, workshop maps CAFÉ",
    "ＣＡＦÉ MAPS workshop resource",
    "cafe\u0301 workshop maps resource resource",
  ]) {
    const result = await recallVault(root, { mode: "terms", query });
    assert.equal(result.complete, true);
    assert.deepEqual(
      result.results.map((hit) => hit.source.path),
      [path],
    );
    assert.equal(result.results[0].matchedField, "title-and-body");
    assert.equal(result.results[0].excerpt, "Café guide: printed MAPS.");
  }
  assert.equal(
    (await recallVault(root, { mode: "terms", query: "workshops" }))
      .matchedCount,
    0,
  );
  assert.equal(
    (await recallVault(root, { mode: "terms", query: "workshop absent" }))
      .matchedCount,
    0,
  );
  assert.equal(
    (await searchVault(root, { query: "workshop resource" })).matchedCount,
    0,
  );
  assert.equal(
    (await searchVault(root, { query: "Workshop learning resource" }))
      .matchedCount,
    1,
  );
});

test("recent recall returns newest recorded times with stable ties and honest caps", async (t) => {
  const { root, put } = await fixture(t);
  const rows = [];
  for (let n = 10; n < 70; n++) {
    const at = new Date(Date.UTC(2026, 10, 1, 0, n)).toISOString();
    rows.push({
      path: await put(n, "Campaign note", "Ordinary result.", at),
      at,
    });
  }
  const filters = { type: "Activity" };
  const result = await recallVault(root, { mode: "recent", filters });
  assert.equal(result.complete, true);
  assert.equal(result.limit, 10);
  assert.equal(result.matchedCount, 61); // 60 new notes plus the existing fixture checkpoint.
  assert.equal(result.resultsTruncated, true);
  assert.deepEqual(
    result.results.map((hit) => hit.source.path),
    rows
      .slice(-10)
      .reverse()
      .map((r) => r.path),
  );
  assert.equal(result.results[0].recordedAtField, "bookie.occurred_at");
  assert.equal(
    (await recallVault(root, { mode: "recent", filters }, { maxResults: 50 }))
      .results.length,
    50,
  );
  const a = await put(80, "Tied report", "Same time", "2026-12-01T00:00:00Z");
  const b = await put(
    81,
    "Tied report",
    "Same time",
    "2026-12-01T00:00:00Z",
    "2027-01-01T00:00:00Z",
  );
  const tied = await recallVault(root, { mode: "terms", query: "tied report" });
  assert.deepEqual(
    tied.results.map((hit) => hit.source.path),
    [a, b],
  );
  const task = await recallVault(root, {
    mode: "recent",
    filters: { type: "Task" },
  });
  assert.equal(task.results[0].recordedAtField, "generated.at");
});

test("visibility is applied before counts and selection, and bounded scans/text remain explicit", async (t) => {
  const { root, put } = await fixture(t);
  const allowed = await put(
    11,
    "Workshop older",
    "Visible source " + "é".repeat(500),
    "2026-11-01T00:00:00Z",
  );
  await put(12, "Workshop newer", "Hidden result", "2026-11-02T00:00:00Z");
  const selected = await recallVault(
    root,
    { mode: "terms", query: "WORKSHOP" },
    {
      maxResults: 1,
      maxExcerptBytes: 20,
      include: (record) => record.source.path === allowed,
    },
  );
  assert.equal(selected.matchedCount, 1);
  assert.equal(selected.resultsTruncated, false);
  assert.equal(selected.results[0].source.path, allowed);
  // Force body matching to exercise excerpt clipping separately from result caps.
  const clipped = await recallVault(
    root,
    { mode: "terms", query: "visible source" },
    { maxExcerptBytes: 20, maxTotalTextBytes: 25 },
  );
  assert.equal(clipped.outputTruncated, true);
  assert.ok(clipped.results[0].excerptTruncated);
  assert.ok(!clipped.results[0].excerpt.includes("�"));
  const partial = await recallVault(
    root,
    { mode: "recent" },
    { maxEntries: 1 },
  );
  assert.equal(partial.complete, false);
  assert.ok(partial.diagnostics.length > 0);
  for (const request of [
    { mode: "terms", query: "!!!" },
    { mode: "terms", query: "" },
    { mode: "recent", query: "workshop" },
    { mode: "other" },
  ])
    await assert.rejects(recallVault(root, request), TypeError);
  for (const maxResults of [0, -1, 1.5, 51])
    await assert.rejects(recallVault(root, { mode: "recent" }, { maxResults }));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    recallVault(root, { mode: "recent" }, { signal: controller.signal }),
    { name: "AbortError" },
  );
  await put(13, "Workshop malformed", "Would otherwise match", "not-a-date");
  const rejected = await recallVault(root, {
    mode: "terms",
    query: "workshop",
  });
  assert.equal(rejected.complete, false);
  assert.ok(rejected.rejectedConcepts > 0);
});
