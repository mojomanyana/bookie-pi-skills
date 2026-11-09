import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, cp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createCheckpointMetadata } from "pi-bookie/dist/checkpoint-metadata.js";
import { prepareCheckpoint } from "pi-bookie-core";
import { labelFixture } from "./disclosure-fixture.mjs";

test("host metadata has valid deterministic identity and cannot claim a human actor", async (t) => {
  const options = {
    sessionId: "01a1a0d3-e3c1-74b5-9a96-80dadc596360",
    now: new Date("2026-11-09T00:00:00.000Z"),
    entropy: new Uint8Array(10),
  };
  const metadata = createCheckpointMetadata(options);
  assert.equal(metadata.generated.by, "process:pi:" + options.sessionId);
  assert.equal(metadata.generated.at, options.now.toISOString());
  assert.equal(metadata.occurred_at, metadata.generated.at);
  assert.match(metadata.uid, /^ACT-[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
  assert.deepEqual(createCheckpointMetadata(options), metadata);
  assert.notEqual(
    createCheckpointMetadata({ sessionId: "session" }).uid,
    createCheckpointMetadata({ sessionId: "session" }).uid,
  );
  const dir = await mkdtemp(join(tmpdir(), "bookie-metadata-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const vault = join(dir, "vault");
  await cp(
    resolve(import.meta.dirname, "../../../fixtures/valid-vault"),
    vault,
    { recursive: true },
  );
  await labelFixture(vault);
  const request = {
    path: "projects/fixture/activities/metadata.md",
    frontmatter: {
      type: "Activity",
      title: "Host generated metadata",
      status: "stable",
      generated: metadata.generated,
      bookie: {
        profile: "1.0",
        uid: metadata.uid,
        project: "/projects/fixture/project.md",
        occurred_at: metadata.occurred_at,
        sensitivity: "public",
      },
    },
    fragments: [
      "outcome",
      "changed-artifacts",
      "decisions",
      "evidence",
      "validation",
      "unresolved-work",
      "next-action",
    ].map((section) => ({ section, sensitivity: "public", text: "None." })),
  };
  assert.equal((await prepareCheckpoint(vault, request)).ok, true);
  const path = join(dir, "request.json");
  const bytes = JSON.stringify(request);
  await writeFile(path, bytes, { flag: "wx" });
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), request);
  assert.equal((await prepareCheckpoint(vault, JSON.parse(bytes))).ok, true);
});

test("metadata rejects missing or malformed session, time and entropy without echoing values", () => {
  assert.equal(
    createCheckpointMetadata({
      sessionId: "session",
      now: new Date(0),
      entropy: new Uint8Array(10),
    }).uid,
    "ACT-00000000000000000000000000",
  );
  const invalid = [
    { sessionId: "session", actor: "human:operator" },
    { sessionId: "session", now: null },
    { sessionId: "session", entropy: null },
    {},
    { sessionId: "" },
    { sessionId: "human:operator" },
    { sessionId: "PRIVATE\nSESSION" },
    { sessionId: "a".repeat(129) },
    { sessionId: "session", now: new Date(NaN) },
    { sessionId: "session", now: "2026-11-09" },
    { sessionId: "session", now: new Date(-1) },
    { sessionId: "session", now: new Date("+010000-01-01T00:00:00Z") },
    { sessionId: "session", entropy: new Uint8Array(9) },
    { sessionId: "session", entropy: new Uint8Array(11) },
    { sessionId: "session", entropy: Array(10).fill(0) },
  ];
  for (const value of invalid)
    assert.throws(
      () => createCheckpointMetadata(value),
      (error) => {
        assert.equal(error.name, "TypeError");
        assert.match(error.message, /^Bookie checkpoint metadata requires /);
        assert.doesNotMatch(error.message, /PRIVATE|operator/);
        return true;
      },
    );
});
