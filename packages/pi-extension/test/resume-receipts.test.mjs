import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import registerBookie from "../dist/index.js";
import { modelContext } from "./disclosure-fixture.mjs";

function host(cwd, sessionId, enabled = true) {
  const events = new EventEmitter(),
    tools = new Map(),
    commands = new Map(),
    hooks = new Map();
  const ctx = modelContext({
    cwd,
    hasUI: true,
    isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => sessionId, getBranch: () => [] },
    ui: { notify() {} },
  });
  let onPublish;
  const owner = { version: 1, cwd, sessionId, isCurrent: () => enabled };
  events.on("pi-daddy:request-project-memory-owner-v1", (q) => {
    if (enabled && q.cwd === cwd && q.sessionId === sessionId) q.reply(owner);
  });
  events.on("pi-daddy:dashboard-source:v1", (q) => {
    if (q.producer === "bookie-memory")
      q.reply({
        version: 1,
        ok: true,
        publish() {
          onPublish?.();
          return true;
        },
        close() {},
      });
  });
  registerBookie({
    events,
    registerTool: (t) => tools.set(t.name, t),
    registerCommand: (k, v) => commands.set(k, v),
    on: (k, h) => hooks.set(k, [...(hooks.get(k) || []), h]),
  });
  return {
    ctx,
    commands,
    whenPublished(fn) {
      onPublish = fn;
    },
    revoke() {
      enabled = false;
      events.emit("pi-daddy:project-memory-owner-v1", owner);
    },
    async event(name, payload = {}) {
      let result;
      for (const h of hooks.get(name) || []) {
        const value = await h(payload, ctx);
        if (value !== undefined) result = value;
      }
      return result;
    },
    async call(name, args, id = "call", signal) {
      const tool = tools.get(name);
      assert.ok(tool);
      return tool.execute(id, args, signal, undefined, ctx);
    },
  };
}
const json = (result) => JSON.parse(result.content[0].text);
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "bookie-resume-receipt-"));
  const cwd = join(root, "project"),
    agent = join(root, "agent"),
    other = join(root, "other");
  await Promise.all(
    [cwd, agent, other].map((path) => mkdir(path, { mode: 0o700 })),
  );
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  return { cwd, agent, other };
}
function receipt(result, status) {
  const value = json(result);
  assert.equal(value.status, status);
  assert.deepEqual(result.details, value);
  assert.deepEqual(Object.keys(value).sort(), ["readBack", "status"]);
  assert.deepEqual(Object.keys(value.readBack).sort(), ["selector", "value"]);
  assert.equal(value.readBack.selector, "path");
  assert.match(
    value.readBack.value,
    /^\/projects\/workspace\/activities\/note-[a-f0-9]{32}\.md$/,
  );
  return value;
}

test("immediate receipts disambiguate same-title notes, idempotent retries and exact reads after a fresh session", async (t) => {
  const { cwd, other } = await fixture(t),
    h = host(cwd, "first");
  await h.event("session_start");
  const oldNote = {
    title: "Workshop progress",
    summary: "Earlier report: route A lacked its research runtime.",
  };
  const currentNote = {
    title: "Workshop progress",
    summary:
      "The user allowed route B; its independent backend work completed.",
  };
  const old = receipt(await h.call("bookie_remember", oldNote, "old"), "saved");
  const current = receipt(
    await h.call("bookie_remember", currentNote, "new"),
    "saved",
  );
  assert.notEqual(old.readBack.value, current.readBack.value);
  const retry = receipt(
    await h.call("bookie_remember", currentNote, "retry"),
    "already saved",
  );
  assert.deepEqual(retry.readBack, current.readBack);
  assert.equal(
    json(await h.call("bookie_search", { query: "Workshop progress" })).result
      .results.length,
    2,
  );
  const read = json(await h.call("bookie_read", current.readBack)).result;
  assert.equal(read.source.path, current.readBack.value);
  assert.equal(read.sourceTruncated, false);
  assert.ok(read.sourceText.includes(currentNote.summary));
  assert.ok(!read.sourceText.includes(oldNote.summary));
  await h.event("session_shutdown");
  const next = host(cwd, "fresh");
  await next.event("session_start");
  const restored = json(
    await next.call("bookie_read", current.readBack),
  ).result;
  assert.equal(restored.source.sourceHash, read.source.sourceHash);
  assert.ok(restored.sourceText.includes(currentNote.summary));
  const unrelated = host(other, "unrelated");
  await unrelated.event("session_start");
  await assert.rejects(unrelated.call("bookie_read", current.readBack));
});

test("pending final deliveries never expose an immediate locator or mutate their earlier receipt", async (t) => {
  const { cwd } = await fixture(t),
    h = host(cwd, "delivery");
  await h.event("session_start");
  await h.event("agent_start");
  const note = {
    title: "Workshop handout",
    summary: "A public workshop guide.",
    deliveryUrl: "https://workshop.example.org/guide",
  };
  const result = await h.call("bookie_remember", note, "delivery-save");
  assert.deepEqual(json(result), { status: "pending final reply" });
  assert.deepEqual(result.details, { status: "pending final reply" });
  assert.equal(
    json(await h.call("bookie_search", { query: "Workshop handout" })).result
      .results.length,
    0,
  );
  await h.event("agent_end", {
    messages: [
      { role: "user", content: [{ type: "text", text: "Share the guide." }] },
      {
        role: "toolResult",
        toolName: "bookie_remember",
        toolCallId: "delivery-save",
        isError: false,
        ...result,
      },
      {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: note.deliveryUrl }],
      },
    ],
  });
  assert.deepEqual(json(result), { status: "pending final reply" });
  assert.deepEqual(result.details, { status: "pending final reply" });
  await h.event("session_shutdown");
  const next = host(cwd, "delivery-fresh");
  await next.event("session_start");
  const hits = json(
    await next.call("bookie_search", { query: "Workshop handout" }),
  ).result.results;
  assert.equal(hits.length, 1);
  assert.ok(
    json(
      await next.call("bookie_read", {
        selector: "path",
        value: hits[0].source.path,
      }),
    ).result.sourceText.includes(note.deliveryUrl),
  );
});

test("refused, cancelled and changed existing notes cannot produce a successful saved locator", async (t) => {
  const { cwd, agent } = await fixture(t),
    h = host(cwd, "changed");
  await h.event("session_start");
  const note = {
    title: "Route decision",
    summary: "Use the independent backend.",
  };
  const saved = receipt(await h.call("bookie_remember", note), "saved");
  const store = join(agent, "bookie-project-memory"),
    ledger = (await readdir(store)).find((n) => n.startsWith("ledger-"));
  const path = join(store, ledger, "vault", saved.readBack.value.slice(1));
  const bytes = await readFile(path, "utf8");
  await writeFile(
    path,
    bytes.replace(note.summary, "Changed external observation."),
  );
  await assert.rejects(
    h.call("bookie_remember", note),
    (error) => !error.message.includes(saved.readBack.value),
  );
  assert.equal(
    await readFile(path, "utf8"),
    bytes.replace(note.summary, "Changed external observation."),
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    h.call(
      "bookie_remember",
      { title: "Cancelled", summary: "Must not save." },
      "cancelled",
      controller.signal,
    ),
    { name: "AbortError" },
  );
  await assert.rejects(
    h.call("bookie_remember", { title: "", summary: "Invalid input." }),
  );
  const denied = host(cwd, "denied", false);
  await denied.event("session_start");
  await assert.rejects(
    denied.call("bookie_remember", {
      title: "Denied",
      summary: "No authority.",
    }),
  );
});

test("authority loss after publication withholds the receipt and a fresh authorized session can recover the exact note", async (t) => {
  const { cwd } = await fixture(t),
    h = host(cwd, "revoke-after-save");
  await h.event("session_start");
  let revoked = false;
  h.whenPublished(() => {
    if (!revoked) {
      revoked = true;
      h.revoke();
    }
  });
  await assert.rejects(
    h.call("bookie_remember", {
      title: "Recovery note",
      summary: "A local change was saved before authority was revoked.",
    }),
    /could not confirm the save/,
  );
  assert.equal(revoked, true);
  await h.event("session_shutdown");
  const next = host(cwd, "recover");
  await next.event("session_start");
  const hit = json(await next.call("bookie_search", { query: "Recovery note" }))
    .result.results;
  assert.equal(hit.length, 1);
  assert.ok(
    json(
      await next.call("bookie_read", {
        selector: "path",
        value: hit[0].source.path,
      }),
    ).result.sourceText.includes("saved before authority was revoked"),
  );
});

test("saved locators are scrubbed on disclosure revocation and are not replayed as restored permission", async (t) => {
  const { cwd } = await fixture(t),
    h = host(cwd, "replay");
  await h.event("session_start");
  const result = await h.call(
    "bookie_remember",
    {
      title: "Scoped receipt",
      summary: "Only this current project may read it.",
    },
    "receipt",
  );
  const saved = receipt(result, "saved");
  const message = {
    role: "toolResult",
    toolName: "bookie_remember",
    toolCallId: "receipt",
    isError: false,
    ...result,
  };
  assert.ok(
    JSON.stringify(await h.event("context", { messages: [message] })).includes(
      saved.readBack.value,
    ),
  );
  await h.commands.get("bookie-context").handler("off", h.ctx);
  const withheld = await h.event("context", { messages: [message] });
  assert.ok(!JSON.stringify(withheld).includes(saved.readBack.value));
  assert.ok(!JSON.stringify(withheld).includes("readBack"));
  await h.event("session_shutdown");
  const next = host(cwd, "replay-fresh");
  await next.event("session_start");
  assert.ok(
    !JSON.stringify(
      await next.event("context", { messages: [message] }),
    ).includes(saved.readBack.value),
  );
});

test("managed readiness always injects historical applicability and requested read-back guidance without changing the user's prompt", async (t) => {
  const { cwd } = await fixture(t),
    h = host(cwd, "guidance");
  await h.event("session_start");
  const original =
    "Current request: continue independent route B. Preserve explicit stop conditions.";
  const result = await h.event("before_agent_start", {
    systemPrompt: original,
  });
  assert.ok(result.systemPrompt.startsWith(original));
  assert.match(result.systemPrompt, /historical/i);
  assert.match(result.systemPrompt, /current.*(?:scope|request)/i);
  assert.match(result.systemPrompt, /independent authorized work/i);
  assert.match(result.systemPrompt, /explicit stop conditions/i);
  assert.match(result.systemPrompt, /read-back/i);
  assert.match(result.systemPrompt, /bookie_read/);
  h.revoke();
  assert.equal(
    await h.event("before_agent_start", { systemPrompt: original }),
    undefined,
  );
});
