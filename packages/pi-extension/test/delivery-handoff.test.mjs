import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import registerBookie from "../dist/index.js";
import { registerDeliveryHandoff } from "../dist/delivery-handoff.js";
import { modelContext } from "./disclosure-fixture.mjs";

const guide = "https://web.dev/learn/css";
const explicit = {
  title: "Workshop guide",
  summary: "A CSS course.",
  deliveryUrl: guide,
};

function scoutResult(urls) {
  const sources = urls.map((locator, index) => ({
    id: "ref-" + index,
    locator,
    sha256: "b".repeat(64),
  }));
  const findings = [];
  for (let i = 0; i < sources.length; i += 4) {
    findings.push({
      status: "supported",
      citations: sources
        .slice(i, i + 4)
        .map(({ id: sourceId, locator, sha256 }) => ({
          sourceId,
          locator,
          sha256,
        })),
    });
  }
  return {
    result: {
      type: "result",
      version: 1,
      status: "complete",
      brief: { version: 1, findings },
      sources,
    },
  };
}

function fixture(cwd = "/workspace") {
  const tools = new Map(),
    hooks = new Map(),
    messages = [],
    warnings = [];
  const pi = {
    events: new EventEmitter(),
    registerTool: (tool) => tools.set(tool.name, tool),
    registerCommand() {},
    on: (name, hook) => hooks.set(name, [...(hooks.get(name) || []), hook]),
  };
  const ctx = modelContext({
    cwd,
    hasUI: true,
    isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "handoff-run", getBranch: () => [] },
    ui: { notify: (message) => warnings.push(message) },
  });
  const emit = async (type, fields = {}) => {
    for (const hook of hooks.get(type) || [])
      await hook({ type, ...fields }, ctx);
  };
  const result = async (toolName, toolCallId, input, response) => {
    const message = {
      role: "toolResult",
      toolName,
      toolCallId,
      isError: false,
      ...response,
    };
    await emit("tool_result", { ...message, input });
    messages.push(message);
  };
  const scout = async (urls) =>
    result(
      "scout_research",
      "research",
      { question: "Learn CSS" },
      { details: scoutResult(urls), content: [] },
    );
  const finish = (text) =>
    emit("agent_end", {
      messages: [
        ...messages,
        {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text }],
        },
      ],
    });
  return { tools, pi, ctx, emit, result, scout, finish, warnings };
}

async function simulatedRun() {
  const h = fixture(),
    writes = [];
  const scope = {
    save: async (note) => {
      writes.push(note);
      return "saved";
    },
  };
  const controller = registerDeliveryHandoff(h.pi, async () => scope);
  await h.emit("agent_start");
  const stage = async (target = scope) => {
    controller.stage("delivery", h.ctx, target, explicit);
    await h.result("bookie_remember", "delivery", explicit, {
      content: [],
      details: { status: "pending final reply" },
    });
  };
  return { ...h, writes, stage };
}

test("an uncertain explicit save leaves one attempted write when Scout also observed the same link", async () => {
  const h = await simulatedRun();
  await h.scout([guide]);
  await h.stage({
    save: async (note) => {
      h.writes.push(note);
      throw Error("Writer may already have published the Activity.");
    },
  });
  await h.finish(guide);
  assert.deepEqual(h.writes, [explicit]);
  assert.equal(h.warnings.length, 1);
});

const others = Array.from(
  { length: 16 },
  (_, i) => "https://web.dev/learn/course-" + (i + 1),
);
test("Scout can deliver only the seventeenth cited resource", async () => {
  const h = await simulatedRun();
  await h.scout([...others, guide]);
  await h.finish("Start here: " + guide);
  assert.deepEqual(
    h.writes.map((note) => note.deliveryUrl),
    [guide],
  );
});

test("an explicit handoff still stages after a Scout result with seventeen citations", async () => {
  const h = await simulatedRun();
  await h.scout([...others, "https://web.dev/learn/layout"]);
  await h.stage();
  await h.finish("Start here: " + guide);
  assert.deepEqual(h.writes, [explicit]);
});

test("a saved meeting decision cannot give a later research link the meeting's title", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bookie-attribution-"));
  const cwd = join(root, "workspace"),
    agent = join(root, "agent");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  await Promise.all([mkdir(cwd), mkdir(agent, { mode: 0o700 })]);
  const h = fixture(cwd);
  h.pi.events.on("pi-daddy:request-project-memory-owner-v1", (request) =>
    request.reply({
      version: 1,
      cwd,
      sessionId: "handoff-run",
      isCurrent: () => true,
    }),
  );
  registerBookie(h.pi);
  const call = (name, id, args) =>
    h.tools.get(name).execute(id, args, undefined, undefined, h.ctx);
  await h.emit("session_start");
  await h.emit("agent_start");
  const note = {
    title: "Budget meeting",
    summary: "The budget meeting starts at noon.",
  };
  await h.result(
    "bookie_remember",
    "meeting",
    note,
    await call("bookie_remember", "meeting", note),
  );
  await h.scout([guide]);
  await h.finish(
    "The budget meeting starts at noon. For the separate workshop, read " +
      guide +
      ".",
  );
  const search = await call("bookie_search", "find-resource", { query: guide });
  const rows = JSON.parse(search.content[0].text).result.results;
  assert.equal(rows.length, 1);
  const read = await call("bookie_read", "read-resource", {
    selector: "path",
    value: rows[0].source.path,
  });
  assert.match(read.content[0].text, /shared resource/i);
  assert.doesNotMatch(read.content[0].text, /budget meeting/i);
  await h.emit("session_shutdown");
});
