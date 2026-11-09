import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import registerBookie from "../dist/index.js";
import { modelContext } from "./disclosure-fixture.mjs";

const channel = "pi-daddy:request-project-memory-owner-v1";
function host(cwd, enabled = true) {
  const events = new EventEmitter(),
    tools = new Map(),
    commands = new Map(),
    hooks = new Map();
  const sessionId = "root-session";
  const ctx = modelContext({
    cwd,
    hasUI: true,
    isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => sessionId, getBranch: () => [] },
    ui: { notify() {} },
  });
  const dashboards = [];
  events.on("pi-daddy:dashboard-source:v1", (q) => {
    if (q.producer === "bookie-memory")
      q.reply({
        version: 1,
        ok: true,
        publish: (update) => {
          dashboards.push(update);
          return true;
        },
        close: () => dashboards.push("closed"),
      });
  });
  const owner = { version: 1, cwd, sessionId, isCurrent: () => enabled };
  events.on(channel, (q) => {
    if (enabled && q.sessionId === sessionId && q.cwd === cwd) q.reply(owner);
  });
  registerBookie({
    events,
    registerTool: (t) => tools.set(t.name, t),
    registerCommand: (k, v) => commands.set(k, v),
    on: (k, h) => hooks.set(k, [...(hooks.get(k) || []), h]),
  });
  return {
    ctx,
    dashboards,
    commands,
    async event(name) {
      for (const h of hooks.get(name) || []) await h({}, ctx);
    },
    revoke() {
      enabled = false;
      events.emit("pi-daddy:project-memory-owner-v1", owner);
    },
    async call(name, args) {
      const tool = tools.get(name);
      assert.ok(tool, name);
      return (await tool.execute("id", args, undefined, undefined, ctx))
        .content[0].text;
    },
  };
}
test("fresh trusted Auto workspace remembers and recalls across sessions without setup; disabled, unrelated and revoked sessions stay isolated", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "bookie-auto-project-"));
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
  t.after(async () => {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  });
  const cwd = join(dir, "project"),
    other = join(dir, "another");
  await Promise.all(
    [cwd, other, process.env.PI_CODING_AGENT_DIR].map((p) =>
      mkdir(p, { mode: 0o700 }),
    ),
  );
  const subject = "Moonstone",
    args = {
      title: "Dispatch window",
      summary: subject + " dispatches every Thursday.",
    };
  const h = host(cwd);
  await h.event("session_start");
  assert.equal(h.dashboards.at(-1).items[0].id, "project-memory");
  assert.match(await h.call("bookie_remember", args), /saved/i);
  assert.match(await h.call("bookie_remember", args), /already saved/i);
  assert.match(await h.call("bookie_search", { query: subject }), /Moonstone/);
  assert.deepEqual(await readdir(cwd), []);
  h.revoke();
  assert.equal(h.dashboards.at(-1), "closed");
  await assert.rejects(h.call("bookie_search", { query: subject }), /withheld/);
  await assert.rejects(h.call("bookie_remember", args));
  await h.event("session_shutdown");
  const next = host(cwd);
  await next.event("session_start");
  assert.match(
    await next.call("bookie_search", { query: subject }),
    /Moonstone/,
  );
  const separate = host(other);
  await separate.event("session_start");
  assert.doesNotMatch(
    await separate.call("bookie_search", { query: subject }),
    /Moonstone/,
  );
  const off = host(other, false);
  await off.event("session_start");
  await assert.rejects(
    off.call("bookie_search", { query: subject }),
    /withheld/,
  );
  await assert.rejects(
    next.call("bookie_search", { query: subject, vault: other }),
    /withheld/,
  );
  await next.commands.get("bookie-capture").handler("off", next.ctx);
  await assert.rejects(next.call("bookie_remember", args));
  assert.match(
    await next.call("bookie_search", { query: subject }),
    /Moonstone/,
  );
  const original = next.ctx.model;
  next.ctx.model = { ...original, id: "unselected" };
  await assert.rejects(
    next.call("bookie_search", { query: subject }),
    /withheld/,
  );
  next.ctx.model = original;
  await next.commands.get("bookie-context").handler("off", next.ctx);
  await assert.rejects(
    next.call("bookie_search", { query: subject }),
    /withheld/,
  );
});

test("headless and untrusted sessions cannot claim workspace memory from a live parent signal", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bookie-denied-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const override of [
    { hasUI: false },
    { isProjectTrusted: () => false },
  ]) {
    const h = host(root);
    Object.assign(h.ctx, override);
    await h.event("session_start");
    assert.equal(h.dashboards.length, 0);
    await assert.rejects(
      h.call("bookie_search", { query: "ship" }),
      /withheld/,
    );
    await assert.rejects(
      h.call("bookie_remember", { title: "ship", summary: "Thursday" }),
    );
  }
});
