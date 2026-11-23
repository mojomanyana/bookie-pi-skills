import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { queryVaultFts } from "../dist/index.js";

test("queryVaultFts indexes public/internal notes, excludes restricted/excluded/secret notes, and strips stopwords", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bookie-fts-"));
  const dbPath = join(dir, "index.sqlite");
  try {
    writeFileSync(
      join(dir, "allowed.md"),
      "---\ntitle: Rate limiter eviction\nsensitivity: internal\n---\nEvict expired sliding window keys cleanly.\n",
    );
    writeFileSync(
      join(dir, "restricted.md"),
      "---\ntitle: Restricted architecture secret\nsensitivity: restricted\n---\nEvict expired sliding window keys restricted details.\n",
    );
    writeFileSync(
      join(dir, "excluded.md"),
      "---\ntitle: Excluded note\nsensitivity: excluded\n---\nEvict expired sliding window keys excluded details.\n",
    );
    writeFileSync(
      join(dir, "missing-sensitivity.md"),
      "---\ntitle: Unlabeled note\n---\nEvict expired sliding window keys without sensitivity label.\n",
    );
    writeFileSync(
      join(dir, "secret.md"),
      "---\ntitle: Leaked key note\nsensitivity: public\n---\nEvict expired keys with token ghp_1234567890abcdefghijklmnopqrstuvwxyzABCD.\n",
    );

    const hits = await queryVaultFts(dir, dbPath, "please fix the evict expired keys in our code", 5);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].path, "allowed.md");
    assert.equal(hits[0].title, "Rate limiter eviction");

    // Removing the file removes it from the index on next query
    rmSync(join(dir, "allowed.md"));
    const afterDelete = await queryVaultFts(dir, dbPath, "evict expired", 5);
    assert.equal(afterDelete.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
