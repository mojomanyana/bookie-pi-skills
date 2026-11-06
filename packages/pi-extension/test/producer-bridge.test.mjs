import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readRecallState } from "pi-bookie-core";
import registerBookie from "../dist/index.js";
import { labelFixture } from "./disclosure-fixture.mjs";
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), "bookie-producer-")),
    vault = join(dir, "vault");
  await cp(
    resolve(import.meta.dirname, "../../../fixtures/valid-vault"),
    vault,
    { recursive: true },
  );
  await labelFixture(vault);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const commands = new Map(),
    handlers = new Map(),
    events = new Map(),
    notices = [],
    requests = [];
  const pi = {
    registerTool() {},
    registerCommand: (n, c) => commands.set(n, c),
    on: (n, f) => handlers.set(n, [...(handlers.get(n) || []), f]),
    events: {
      on: (n, f) => {
        events.set(n, f);
        return () => events.delete(n);
      },
      emit: (n, r) => events.get(n)?.(r),
    },
  };
  registerBookie(pi);
  const owner = { sessionId: "owner", cwd: dir };
  const ctx = {
    cwd: dir,
    hasUI: true,
    isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => owner.sessionId },
    ui: { notify: (m) => notices.push(m), confirm: async () => true },
  };
  for (const handler of handlers.get("session_start")) await handler({}, ctx);
  const reference = (id) => ({
    version: 1,
    producer: "pi-daddy",
    owner,
    operationId: `role:${id}`,
    executionId: `exec:${id}`,
    manifest: {
      path: `/private/producer/${id}/result.json`,
      sha256: "a".repeat(64),
      bytes: 128,
    },
  });
  let fail = false;
  const refs = [reference("one"), reference("two")];
  events.set("pi-daddy:operation-artifacts:v1", (r) => {
    requests.push(r);
    const base = {
      version: 1,
      requestId: r.requestId,
      sessionId: r.sessionId,
      cwd: r.cwd,
    };
    if (r.action === "list")
      r.reply({
        ...base,
        ok: true,
        producerInstance: "b".repeat(64),
        references: refs,
        scanned: 3,
        uncertain: 1,
        issues: 0,
        complete: true,
      });
    else
      r.reply({
        ...base,
        ok: !(fail && r.reference.operationId === "role:two"),
        producerInstance: "b".repeat(64),
        final: { text: "PRIVATE FINAL MUST NOT BE SAVED" },
      });
  });
  const inputs = [vault, "/projects/fixture/project.md"];
  await commands.get("bookie-capture").handler("", {
    ...ctx,
    ui: {
      ...ctx.ui,
      input: async () => inputs.shift(),
      select: async (title) =>
        title === "Bookie capture content"
          ? "Producer reference metadata"
          : "public",
    },
  });
  return {
    vault,
    commands,
    ctx,
    events,
    notices,
    requests,
    setFail: (v) => (fail = v),
    sync: () => commands.get("bookie-capture").handler("sync", ctx),
  };
}
test("metadata sync is idempotent, labels references and never retains producer output", async (t) => {
  const f = await setup(t);
  await f.sync();
  await f.sync();
  const state = await readRecallState(f.vault);
  assert.equal(state.ok, true);
  assert.equal(state.state.registrations.length, 2);
  assert.ok(state.state.registrations.every((r) => r.sensitivity === "public"));
  assert.ok(!JSON.stringify(state).includes("PRIVATE FINAL"));
  assert.ok(f.requests.every((r) => ["list", "read"].includes(r.action)));
  assert.match(f.notices.at(-1), /0 registered, 2 reused/);
});
test("failed mid-page registration retries from a fresh scan without skipping the missing record", async (t) => {
  const f = await setup(t);
  f.setFail(true);
  await assert.rejects(f.sync(), /registration refused/);
  assert.equal((await readRecallState(f.vault)).state.registrations.length, 1);
  f.setFail(false);
  await f.sync();
  assert.equal((await readRecallState(f.vault)).state.registrations.length, 2);
  assert.ok(
    f.requests
      .filter((r) => r.action === "list")
      .every((r) => r.cursor === undefined),
  );
});
test("absent optional producer leaves Bookie records intact and reports unavailable", async (t) => {
  const f = await setup(t);
  await f.sync();
  const before = await readRecallState(f.vault);
  f.events.delete("pi-daddy:operation-artifacts:v1");
  await assert.rejects(f.sync(), /unavailable/);
  assert.equal((await readRecallState(f.vault)).revision, before.revision);
});
