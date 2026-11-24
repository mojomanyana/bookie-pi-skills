import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { queryVaultFts } from "../dist/index.js";

test("queryVaultFts indexes YAML and JSON frontmatter public/internal notes, excludes restricted/secret notes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bookie-fts-"));
  const dbPath = join(dir, "index.sqlite");
  try {
    writeFileSync(
      join(dir, "allowed.md"),
      "---\ntitle: Rate limiter eviction\nsensitivity: internal\n---\nEvict expired sliding window keys cleanly.\n",
    );
    writeFileSync(
      join(dir, "json-activity.md"),
      '---\n{"type":"Activity","title":"JSON checkpoint","bookie":{"profile":"1.0","sensitivity":"internal"}}\n---\nEvict expired sliding window keys from JSON concept.\n',
    );
    writeFileSync(
      join(dir, "restricted.md"),
      "---\ntitle: Restricted secret\nsensitivity: restricted\n---\nEvict expired sliding window keys restricted details.\n",
    );
    writeFileSync(
      join(dir, "secret.md"),
      "---\ntitle: Leaked key note\nsensitivity: public\n---\nEvict expired keys with token ghp_1234567890abcdefghijklmnopqrstuvwxyzABCD.\n",
    );

    const hits = await queryVaultFts(
      dir,
      dbPath,
      "please fix the evict expired keys in our code",
      5,
    );
    assert.equal(hits.length, 2);
    assert.deepEqual(hits.map((h) => h.path).sort(), [
      "allowed.md",
      "json-activity.md",
    ]);

    rmSync(join(dir, "allowed.md"));
    rmSync(join(dir, "json-activity.md"));
    const afterDelete = await queryVaultFts(dir, dbPath, "evict expired", 5);
    assert.equal(afterDelete.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
