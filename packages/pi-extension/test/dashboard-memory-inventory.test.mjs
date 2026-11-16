import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { dashboardMemoryInventory } from "../dist/dashboard-memory-inventory.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "bookie-memory-inventory-"));
  await cp(
    resolve(import.meta.dirname, "../../../fixtures/valid-vault"),
    root,
    { recursive: true },
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = await readFile(
    join(root, "projects/fixture/activities/checkpoint.md"),
    "utf8",
  );
  const template = JSON.parse(original.split("\n")[1]);
  const put = async (n, title, summary) => {
    const meta = structuredClone(template);
    meta.title = title;
    meta.bookie.uid = "ACT-" + String(n).padStart(26, "0");
    meta.bookie.occurred_at = "2026-11-16T00:00:00Z";
    delete meta.bookie.relations;
    const path = `/projects/fixture/activities/inventory-${n}.md`;
    await writeFile(
      join(root, path.slice(1)),
      `---\n${JSON.stringify(meta)}\n---\n# Outcome\n\n${summary}\n\n# Changed artifacts\n\nNo additional information recorded.\n`,
    );
    return path;
  };
  const access = {
    root,
    scope: { project: { path: "/projects/fixture/project.md" } },
    allows: (record) => record.source.path.includes("/inventory-"),
    assertCurrent: async () => {},
  };
  return { root, put, access };
}

test("memory inventory exposes only visible scoped notes, with complete empty distinct from unavailable", async (t) => {
  const { put, access } = await fixture(t);
  const empty = await dashboardMemoryInventory(access);
  assert.equal(empty.state, "empty");
  assert.equal(empty.count, 0);
  assert.equal(empty.limited, false);
  const visible = await put(
    1,
    "Orchid workshop",
    "Participants will use printed maps.",
  );
  await put(2, "Hidden title", "Protected description.");
  access.allows = (record) => record.source.path === visible;
  const result = await dashboardMemoryInventory(access);
  assert.equal(result.state, "available");
  assert.equal(result.count, 1);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].title, "Orchid workshop");
  assert.equal(
    result.entries[0].summary,
    "Participants will use printed maps.",
  );
  assert.equal(result.entries[0].reference, visible);
  assert.ok(!JSON.stringify(result).includes("Hidden title"));
  assert.ok(!JSON.stringify(result).includes("Protected description"));
  let checks = 0;
  access.assertCurrent = async () => {
    if (++checks === 2) throw Error("revoked");
  };
  await assert.rejects(dashboardMemoryInventory(access), /revoked/);
});

test("inventory caps preserve exact visible count and UTF-8 envelope while incomplete scans omit count", async (t) => {
  const { root, put, access } = await fixture(t);
  for (let n = 10; n < 26; n++)
    await put(n, "Café 🗺️ ".repeat(15), "Maps and grids 🗺️ ".repeat(70));
  const result = await dashboardMemoryInventory(access);
  assert.equal(result.state, "available");
  assert.equal(result.count, 16);
  assert.equal(result.limited, true);
  assert.ok(result.entries.length > 0 && result.entries.length <= 12);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 8192);
  assert.ok(
    result.entries.every(
      (row) =>
        row.title.length <= 160 &&
        row.summary.length <= 480 &&
        !row.summary.includes("�"),
    ),
  );
  await writeFile(
    join(root, "projects/fixture/broken.md"),
    "---\n{ invalid\n---\nMalformed record.\n",
  );
  const partial = await dashboardMemoryInventory(access);
  assert.equal(partial.state, "available");
  assert.equal(partial.count, undefined);
  assert.equal(partial.limited, true);
  access.allows = () => false;
  const unknown = await dashboardMemoryInventory(access);
  assert.equal(unknown.state, "unknown");
  assert.equal(unknown.count, undefined);
  assert.deepEqual(unknown.entries, []);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(dashboardMemoryInventory(access, controller.signal), {
    name: "AbortError",
  });
});
