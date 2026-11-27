import test from "node:test";
import assert from "node:assert/strict";
import { reconcileProposalAgainstMatches } from "../dist/memory-proposals.js";

test("reconcileProposalAgainstMatches identifies duplicates, conflicts, and novel notes", () => {
  const existing = [
    {
      path: "/projects/demo/activities/note-1.md",
      uid: "ACT-01",
      title: "Use SQLite WAL mode",
      excerpt:
        "All Bookie indexes must use SQLite WAL mode for concurrent reads.",
    },
  ];

  const dup = reconcileProposalAgainstMatches(
    {
      title: "use sqlite wal mode",
      summary:
        "All Bookie indexes must use SQLite WAL mode for concurrent reads",
    },
    existing,
  );
  assert.equal(dup.status, "duplicate");
  assert.equal(dup.existingPath, "/projects/demo/activities/note-1.md");

  const conflict = reconcileProposalAgainstMatches(
    {
      title: "Use SQLite WAL mode",
      summary: "Disable WAL mode and use DELETE journal instead.",
    },
    existing,
  );
  assert.equal(conflict.status, "conflict");
  assert.equal(conflict.existingUid, "ACT-01");

  const novel = reconcileProposalAgainstMatches(
    {
      title: "Retry policy for read-only roles",
      summary: "Replay-safe specialists retry once automatically.",
    },
    existing,
  );
  assert.equal(novel.status, "novel");
});
