import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  mkdtemp,
  mkdir,
  rm,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import registerBookie from "../dist/index.js";
import { modelContext } from "./disclosure-fixture.mjs";

const channel = "pi-daddy:request-project-memory-owner-v1";
function host(cwd, enabled = true, sessionId = "root-session") {
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
    async event(name, payload = {}) {
      for (const h of hooks.get(name) || []) await h(payload, ctx);
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
    /no active Pi Daddy Auto connection.*history is unknown/i,
  );
  // A plausible model mistake in a fresh session is to name the repository as
  // the private vault. It receives actionable guidance without changing scope.
  for (const vault of [".", other, join(cwd, "absent")]) {
    for (const [name, args] of [
      ["bookie_search", { query: subject }],
      [
        "bookie_read",
        { selector: "path", value: "/projects/workspace/project.md" },
      ],
    ]) {
      await assert.rejects(next.call(name, { ...args, vault }), {
        message:
          "Bookie lookup withheld. The supplied vault does not match the selected project memory. If the request is about that project, retry once with the vault argument omitted.",
      });
    }
  }
  assert.match(
    await next.call("bookie_search", { query: subject }),
    /Moonstone/,
  );
  assert.match(
    await next.call("bookie_read", {
      selector: "path",
      value: "/projects/workspace/project.md",
    }),
    /Workspace memory/,
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
    /could not verify the current Pi model destination.*history is unknown/i,
  );
  await assert.rejects(
    next.call("bookie_search", { vault: ".", query: subject }),
    (e) => /withheld/.test(e.message) && !e.message.includes("retry once"),
  );
  next.ctx.model = original;
  await next.commands.get("bookie-context").handler("off", next.ctx);
  await assert.rejects(
    next.call("bookie_search", { query: subject }),
    /no current authorization.*history is unknown/i,
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
      override.hasUI === false
        ? /needs an interactive parent Pi session.*history is unknown/i
        : /has not trusted this folder.*history is unknown/i,
    );
    await assert.rejects(
      h.call("bookie_remember", { title: "ship", summary: "Thursday" }),
    );
  }
});

test("lookup readiness failures identify the failed check without exposing its private details", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bookie-readiness-"));
  const agent = join(root, "agent");
  const project = join(root, "project");
  await mkdir(agent, { mode: 0o700 });
  await mkdir(project);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  const privateDetail = "private-diagnostic-do-not-disclose";
  const h = host(project);
  const lookup = () => h.call("bookie_search", { query: "keyboard" });
  const originalRegistry = h.ctx.modelRegistry;
  h.ctx.modelRegistry = {
    getApiKeyAndHeaders: async () => {
      throw Error(privateDetail);
    },
  };
  await h.event("session_start");
  await assert.rejects(
    lookup(),
    (err) =>
      /could not verify the current Pi model destination.*history is unknown/i.test(
        err.message,
      ) && !err.message.includes(privateDetail),
  );
  h.ctx.modelRegistry = originalRegistry;
  assert.deepEqual(JSON.parse(await lookup()).result.results, []);
  await h.event("session_shutdown");
  process.env.PI_CODING_AGENT_DIR = join(root, privateDetail);
  const next = host(project);
  await next.event("session_start");
  await assert.rejects(
    next.call("bookie_search", { query: "keyboard" }),
    (err) =>
      /could not verify this folder.s private memory.*history is unknown/i.test(
        err.message,
      ) && !err.message.includes(privateDetail),
  );
});

test("remember a delivered workshop resource only after it appears in a completed reply; recall both records in a new session", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bookie-delivery-"));
  const cwd = join(root, "project");
  const agent = join(root, "agent");
  await mkdir(cwd);
  await mkdir(agent, { mode: 0o700 });
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  t.after(async () => {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = old;
    await rm(root, { recursive: true, force: true });
  });
  const h = host(cwd);
  await h.event("session_start");
  await h.call("bookie_remember", {
    title: "Workshop topic",
    summary: "The user chose modern web design. A learning resource is due.",
  });
  const deliveryUrl = "https://web.dev/learn";
  const planned = {
    title: "Workshop learning resource",
    summary: "Publisher's beginner course for the community workshop.",
    deliveryUrl,
  };
  const lookup = async (who, query) =>
    JSON.parse(await who.call("bookie_search", { query })).result.results;
  const deliver = async (text, stopReason = "stop") => {
    await h.event("agent_end", {
      messages: [
        {
          role: "toolResult",
          toolName: "bookie_remember",
          toolCallId: "id",
          isError: false,
          content: [],
        },
        { role: "assistant", stopReason, content: [{ type: "text", text }] },
      ],
    });
  };
  for (const [reply, reason] of [
    ["I will find one.", "stop"],
    [deliveryUrl, "aborted"],
    [deliveryUrl + "ing", "stop"],
  ]) {
    await h.event("agent_start");
    assert.match(await h.call("bookie_remember", planned), /pending/);
    assert.equal((await lookup(h, deliveryUrl)).length, 0);
    await deliver(reply, reason);
    assert.equal((await lookup(h, deliveryUrl)).length, 0);
  }
  for (let i = 0; i < 2; i++) {
    await h.event("agent_start");
    await h.call("bookie_remember", planned);
    await deliver(
      "Start here: [Learn web development](" +
        deliveryUrl +
        "). What would you like to do next?",
    );
  }
  await h.event("session_shutdown");
  const next = host(cwd, true, "second-session");
  await next.event("session_start");
  assert.equal((await lookup(next, "Workshop")).length, 2);
  const shared = await lookup(next, deliveryUrl);
  assert.equal(shared.length, 1);
  const doc = await next.call("bookie_read", {
    selector: "path",
    value: shared[0].source.path,
  });
  assert.match(doc, /https:\/\/web.dev\/learn/);
  assert.match(doc, /shared/i);
  await next.event("agent_start");
  await next.call("bookie_remember", {
    ...planned,
    deliveryUrl: "https://web.dev/learn/css",
  });
  await next.commands.get("bookie-capture").handler("off", next.ctx);
  await next.event("agent_end", {
    messages: [
      {
        role: "toolResult",
        toolName: "bookie_remember",
        toolCallId: "id",
        isError: false,
        content: [],
      },
      {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "https://web.dev/learn/css" }],
      },
    ],
  });
  assert.equal((await lookup(next, "https://web.dev/learn/css")).length, 0);
});

test("remember puts the user's open choice under Unresolved work, including a final-only delivery handoff", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bookie-open-choice-"));
  const cwd = join(root, "project"),
    agent = join(root, "agent");
  await mkdir(cwd);
  await mkdir(agent, { mode: 0o700 });
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  t.after(async () => {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = old;
    await rm(root, { recursive: true, force: true });
  });
  const h = host(cwd);
  await h.event("session_start");
  const read = async (who, topic) => {
    const {
      result: { results },
    } = JSON.parse(await who.call("bookie_search", { query: topic }));
    assert.equal(results.length, 1);
    const result = JSON.parse(
      await who.call("bookie_read", {
        selector: "path",
        value: results[0].source.path,
      }),
    );
    return result.result.sourceText;
  };
  const choice =
    "Which chart should participants hold: the StarDome foldout or the local planisphere?";
  const planned = {
    title: "Sky workshop",
    summary: "Participants will learn the constellations.",
    deliveryUrl: "https://www.astronomy.com/observing/how-to-use-a-star-chart/",
  };
  const deliver = async () => {
    await h.event("agent_start");
    await h.call("bookie_remember", planned);
    await h.event("agent_end", {
      messages: [
        {
          role: "toolResult",
          toolCallId: "id",
          toolName: "bookie_remember",
          isError: false,
          content: [],
        },
        {
          role: "assistant",
          stopReason: "stop",
          content: [
            {
              type: "text",
              text: planned.deliveryUrl + "\n\nOpen choice: " + choice,
            },
          ],
        },
      ],
    });
  };
  await deliver();
  await deliver();
  await h.event("session_shutdown");
  const next = host(cwd, true, "resumed-choices");
  await next.event("session_start");
  const body = await read(next, "Sky workshop");
  assert.ok(
    body.includes("# Unresolved work\n\n" + choice + "\n\n# Next action"),
  );
  const input = {
    title: "Bootcamp",
    summary: "Location selected.",
    openChoice: "Will participants use tablets or laptops?",
  };
  assert.match(await next.call("bookie_remember", input), /saved/);
  assert.match(await next.call("bookie_remember", input), /already saved/);
  assert.ok(
    (await read(next, "Bootcamp")).includes(
      "# Unresolved work\n\n" + input.openChoice + "\n\n# Next action",
    ),
  );
  await assert.rejects(
    next.call("bookie_remember", {
      ...input,
      openChoice: "Overlong " + "x".repeat(240),
    }),
  );
});

test("retrying a prose-only legacy Activity confirms its full old body without changing bytes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bookie-legacy-choice-"));
  const agent = join(root, "agent"),
    cwd = join(root, "workspace");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(agent, { mode: 0o700 });
  await mkdir(cwd);
  const first = host(cwd);
  await first.event("session_start");
  const choice =
    "which printed chart participants will hold (StarDome foldout vs. a physical planisphere).";
  const note = {
    title: "Workshop for stargazers",
    summary: "Worked example uses a printed guide (April sky). Open: " + choice,
  };
  await first.call("bookie_remember", note);
  const { result } = JSON.parse(
    await first.call("bookie_search", { query: "stargazers" }),
  );
  assert.equal(result.results.length, 1);
  const store = join(agent, "bookie-project-memory");
  const ledger = (await readdir(store)).find((name) =>
    name.startsWith("ledger-"),
  );
  const file = join(store, ledger, "vault", result.results[0].source.path);
  const structured = await readFile(file, "utf8");
  assert.match(structured, /^tags:\n {2}- open-choice$/mu);
  const legacy = structured
    .replace(/^tags:\n {2}- open-choice\n/mu, "")
    .replace(
      "# Unresolved work\n\n" + choice,
      "# Unresolved work\n\nNo additional information recorded.",
    );
  assert.notEqual(structured, legacy);
  await writeFile(file, legacy);
  await first.event("session_shutdown");
  const next = host(cwd, true, "restore");
  await next.event("session_start");
  assert.ok(next.dashboards.at(-1).items.some((item) => item.label === choice));
  assert.match(await next.call("bookie_remember", note), /already saved/);
  assert.equal(await readFile(file, "utf8"), legacy);
  const modified = legacy.replace("Worked example", "Unrelated edit");
  await writeFile(file, modified);
  await assert.rejects(next.call("bookie_remember", note));
  assert.equal(await readFile(file, "utf8"), modified);
});

test("a fresh dashboard restores only explicitly open choices from this project's saved notes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bookie-choice-dashboard-"));
  const prev = process.env.PI_CODING_AGENT_DIR;
  const agent = join(root, "agent"),
    cwd = join(root, "workshop"),
    other = join(root, "elsewhere");
  process.env.PI_CODING_AGENT_DIR = agent;
  t.after(async () => {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
    await rm(root, { recursive: true, force: true });
  });
  await Promise.all([cwd, other, agent].map((p) => mkdir(p, { mode: 0o700 })));
  const original = host(cwd);
  await original.event("session_start");
  await original.call("bookie_remember", {
    title: "Sky workshop",
    summary: "Guide delivered.",
    openChoice: "StarDome foldout or local planisphere?",
  });
  await original.call("bookie_remember", {
    title: "Completed setup",
    summary: "The venue is open on Saturday.",
  });
  // Place both the tagged note and a pre-tag receipt beyond a full page of
  // closed activities. The old receipt stores its choice inline in Outcome.
  const closed = JSON.parse(
    await original.call("bookie_search", { query: "Completed setup" }),
  ).result.results[0];
  const store = join(agent, "bookie-project-memory");
  const ledger = (await readdir(store)).find((name) =>
    name.startsWith("ledger-"),
  );
  const vault = join(store, ledger, "vault");
  const template = await readFile(join(vault, closed.source.path), "utf8");
  const legacyDigest = "f".repeat(32);
  const legacyChoice = "Printed maps or a wall projection?";
  const legacyReceipt = template
    .replace(closed.uid, "ACT-0" + legacyDigest.slice(0, 25).toUpperCase())
    .replace(
      "The venue is open on Saturday.",
      "Guide delivered. Open choice: " + legacyChoice,
    );
  await writeFile(
    join(
      vault,
      "projects/workspace/activities",
      "note-" + legacyDigest + ".md",
    ),
    legacyReceipt,
  );
  for (let n = 0; n < 52; n++) {
    const digest = n.toString(16).padStart(6, "0") + "0".repeat(26);
    await writeFile(
      join(vault, "projects/workspace/activities", "note-" + digest + ".md"),
      template.replace(closed.uid, "ACT-0" + digest.slice(0, 25).toUpperCase()),
    );
  }
  const choices = (h) =>
    h.dashboards
      .at(-1)
      .items.filter((item) => item.id.startsWith("open-choice-"));
  const selected = choices(original);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].label, "StarDome foldout or local planisphere?");
  assert.equal(selected[0].state, "observed");
  await original.event("session_shutdown");
  const next = host(cwd, true, "new-parent");
  await next.event("session_start");
  const restored = choices(next);
  assert.equal(restored.length, 2);
  assert.deepEqual(
    restored.find((row) => row.id === selected[0].id),
    selected[0],
  );
  assert.equal(
    restored.find((row) => row.label === legacyChoice)?.state,
    "observed",
  );
  const unrelated = host(other, true, "unrelated-parent");
  await unrelated.event("session_start");
  assert.deepEqual(choices(unrelated), []);
  next.revoke();
  assert.equal(next.dashboards.at(-1), "closed");
});
