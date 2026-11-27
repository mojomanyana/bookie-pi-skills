import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createCaptureAuthority } from "../dist/capture-authority.js";
import {
  registerProducerBridge,
  requestProducer,
} from "../dist/producer-bridge.js";

test("managed capture schedules once for each new grant", () => {
  const capture = createCaptureAuthority({ registerCommand() {} });
  let runs = 0;
  capture.setReferenceSync(
    async () => {},
    () => runs++,
  );
  const selection = {
    vault: {},
    scope: { project: { path: "project", sourceHash: "hash" } },
  };
  capture.selectManaged(selection);
  capture.selectManaged(selection);
  assert.equal(runs, 1);
  capture.reset();
  capture.selectManaged(selection);
  assert.equal(runs, 2);
});

test("Auto catches up on open and resume, honors Off, and keeps manual sync available", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "bookie-auto-sync-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  });
  const hooks = new Map(),
    events = new Map(),
    pages = [];
  const pi = {
    on: (key, fn) => hooks.set(key, fn),
    events: {
      on: (key, fn) => events.set(key, fn),
      emit: (key, value) => events.get(key)?.(value),
    },
  };
  const ctx = {
    cwd: dir,
    sessionManager: { getSessionId: () => "owner" },
    ui: { notify() {} },
  };
  let granted = true,
    manual,
    activate;
  registerProducerBridge(pi, {
    setReferenceSync(fn, start) {
      manual = fn;
      activate = start;
    },
    async referenceGrant() {
      return granted
        ? {
            assertCurrent: async () => {},
            project: {},
            sensitivity: "internal",
          }
        : undefined;
    },
  });
  events.set("pi-daddy:operation-artifacts:v1", (r) => {
    assert.equal(r.action, "list");
    pages.push(r.sessionId);
    r.reply({
      ...r,
      ok: true,
      producerInstance: "fixture",
      references: [],
      uncertain: 0,
      issues: 0,
      complete: true,
    });
  });
  // A trailing manual sync drains the same serial queue, so assertions don't depend on timers.
  hooks.get("session_start")({}, ctx);
  activate();
  await manual(ctx);
  assert.equal(pages.length, 2);
  await writeFile(
    join(dir, "ecosystem.json"),
    JSON.stringify({ bookie: { autoSyncReviews: false } }),
  );
  pi.events.emit("bookie:review-sync-settings:v1", { action: "changed" });
  hooks.get("session_shutdown")();
  hooks.get("session_start")({}, ctx);
  activate();
  pi.events.emit("pi-daddy:operation-artifact-ready:v1", {
    version: 1,
    reference: {},
  });
  await manual(ctx);
  assert.equal(pages.length, 3);
  await writeFile(
    join(dir, "ecosystem.json"),
    JSON.stringify({ bookie: { autoSyncReviews: true } }),
  );
  pi.events.emit("bookie:review-sync-settings:v1", { action: "changed" });
  await manual(ctx);
  assert.equal(pages.length, 5);
  granted = false;
  activate();
  await assert.rejects(manual(ctx), /capture first/);
  assert.equal(pages.length, 5);
  hooks.get("session_shutdown")();
  hooks.get("session_start")({}, ctx);
  granted = true;
  activate();
  await manual(ctx);
  assert.equal(pages.length, 7);
});

test("an unbound discovery copy cannot hide the active producer; authorization refusals stay final", async () => {
  const owner = { cwd: "/fixture", sessionId: "session" };
  const query = (code) =>
    requestProducer(
      {
        events: {
          emit(_, req) {
            req.reply({ ...req, ok: false, code });
            req.reply({ ...req, ok: true });
          },
        },
      },
      owner,
      { action: "read" },
    );
  assert.equal((await query("owner-unavailable")).ok, true);
  await assert.rejects(query("authority"), (e) => e.code === "authority");
});

test("malformed ecosystem.json fails closed without throwing and mid-sync opt-out emits no false warning", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "bookie-auto-sync-edge-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  });
  await writeFile(join(dir, "ecosystem.json"), "{broken json");
  const hooks = new Map(),
    events = new Map(),
    notices = [];
  const pi = {
    on: (key, fn) => hooks.set(key, fn),
    events: {
      on: (key, fn) => events.set(key, fn),
      emit: (key, value) => events.get(key)?.(value),
    },
  };
  const ctx = {
    cwd: dir,
    sessionManager: { getSessionId: () => "owner" },
    ui: { notify: (msg, level) => notices.push({ msg, level }) },
  };
  let activate, manual;
  registerProducerBridge(pi, {
    hasStanding: () => true,
    setReferenceSync(fn, start) {
      manual = fn;
      activate = start;
    },
    async referenceGrant() {
      return {
        assertCurrent: async () => {},
        project: {},
        sensitivity: "internal",
      };
    },
  });
  // Malformed ecosystem.json must not throw on bind/activate/settings/READY.
  assert.doesNotThrow(() => hooks.get("session_start")({}, ctx));
  assert.doesNotThrow(() => activate());
  assert.doesNotThrow(() =>
    pi.events.emit("bookie:review-sync-settings:v1", { action: "changed" }),
  );
  // Now write valid config, start sync, and toggle autoSyncReviews off mid-page: zero warning notices.
  await writeFile(
    join(dir, "ecosystem.json"),
    JSON.stringify({ bookie: { autoSyncReviews: true } }),
  );
  let resolvePage;
  events.set("pi-daddy:operation-artifacts:v1", (r) => {
    resolvePage = () =>
      r.reply({
        ...r,
        ok: true,
        producerInstance: "fixture",
        references: [],
        scanned: 1,
        uncertain: 0,
        issues: 0,
        complete: false,
        cursor: "c1",
      });
  });
  notices.length = 0;
  activate();
  await new Promise((r) => setImmediate(r));
  await writeFile(
    join(dir, "ecosystem.json"),
    JSON.stringify({ bookie: { autoSyncReviews: false } }),
  );
  resolvePage?.();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(
    notices.some((n) => n.level === "warning"),
    false,
    "disabling autoSyncReviews mid-sync must not warn as a failure",
  );
  assert.equal(typeof manual, "function");
});
