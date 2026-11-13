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
test("managed recall finds reordered words, offers bounded recent notes, and preserves exact mode after a fresh session", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bookie-managed-recall-"));
  const old = process.env.PI_CODING_AGENT_DIR;
  const agent = join(root, "agent"),
    cwd = join(root, "project"),
    other = join(root, "other");
  process.env.PI_CODING_AGENT_DIR = agent;
  t.after(async () => {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = old;
    await rm(root, { recursive: true, force: true });
  });
  await Promise.all(
    [agent, cwd, other].map((path) => mkdir(path, { mode: 0o700 })),
  );
  const first = host(cwd);
  await first.event("session_start");
  await first.call("bookie_remember", {
    title: "Workshop learning resource",
    summary: "Café participants will use printed maps.",
  });
  await first.call("bookie_remember", {
    title: "Workshop room",
    summary: "The room is reserved.",
  });
  await first.event("session_shutdown");
  const next = host(cwd, true, "fresh-parent");
  await next.event("session_start");
  const search = async (args) =>
    JSON.parse(await next.call("bookie_search", args)).result;
  const terms = await search({ query: "RESOURCE workshop maps CAFÉ" });
  assert.equal(terms.complete, true);
  assert.equal(terms.matching, "nfkc-lowercase-all-word-tokens");
  assert.equal(terms.results.length, 1);
  assert.equal(terms.results[0].title, "Workshop learning resource");
  assert.equal(
    (await search({ mode: "exact", query: "workshop resource" })).results
      .length,
    0,
  );
  assert.equal(
    (await search({ mode: "exact", query: "Workshop learning resource" }))
      .results.length,
    1,
  );
  const recent = await search({ mode: "recent", type: "Activity", limit: 1 });
  assert.equal(recent.results.length, 1);
  assert.equal(recent.matchedCount, 2);
  assert.equal(recent.resultsTruncated, true);
  assert.equal(recent.scanComplete, true);
  assert.equal(recent.complete, false);
  const all = await search({ mode: "recent", type: "Activity", limit: 2 });
  assert.equal(all.complete, true);
  assert.equal(all.results.length, 2);
  for (const args of [
    { query: "!!!" },
    { mode: "recent", query: "workshop" },
    { mode: "recent", limit: 51 },
    {},
  ])
    await assert.rejects(search(args), /needs words in query/);
  const separate = host(other, true, "other-parent");
  await separate.event("session_start");
  assert.deepEqual(
    JSON.parse(
      await separate.call("bookie_search", {
        mode: "recent",
        type: "Activity",
      }),
    ).result.results,
    [],
  );
  next.revoke();
  await assert.rejects(search({ mode: "recent" }), /withheld/);
});

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
  const { readChoice, answerChoice } = await import("../dist/choice-answer.js");
  const access = {
    root: join(store, ledger, "vault"),
    scope: { project: { path: "/projects/workspace/project.md" } },
    allows: () => true,
    assertCurrent: async () => {},
  };
  const id = next.dashboards
    .at(-1)
    .items.find((item) => item.label === choice).id;
  const restored = await readChoice(access, id);
  assert.deepEqual(restored.options, [
    "StarDome foldout",
    "a physical planisphere",
  ]);
  assert.equal(restored.recommendation, undefined);
  assert.equal(
    await answerChoice(
      access,
      { id, revision: restored.revision, answer: restored.options[0] },
      "restore",
    ),
    "saved",
  );
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

test("saving a chosen or typed answer closes only its exact note and a fresh Pi reads the user's decisions", async (t) => {
  const { readChoice, answerChoice } = await import("../dist/choice-answer.js");
  const root = await mkdtemp(join(tmpdir(), "bookie-answers-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  const agent = join(root, "agent"),
    cwd = join(root, "project");
  process.env.PI_CODING_AGENT_DIR = agent;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  await Promise.all([agent, cwd].map((p) => mkdir(p, { mode: 0o700 })));
  const first = host(cwd);
  await first.event("session_start");
  const note = {
    title: "Orion workshop",
    summary: "Participants already have a printed chart.",
    openChoice: "Which guide should we use?",
    choiceOptions: ["Printed chart", "Mobile sky map", "Both"],
    choiceRecommendation: {
      option: "Printed chart",
      reason: "Everyone can follow along offline.",
      evidence: "Participants already have a printed chart.",
    },
  };
  for (const bad of [
    { ...note, openChoice: undefined },
    { ...note, choiceOptions: [] },
    { ...note, choiceOptions: ["Same", "Same"] },
    {
      ...note,
      choiceRecommendation: { ...note.choiceRecommendation, option: "Neither" },
    },
    {
      ...note,
      choiceRecommendation: {
        ...note.choiceRecommendation,
        evidence: "Unrecorded support",
      },
    },
  ])
    await assert.rejects(first.call("bookie_remember", bad));
  await first.call("bookie_remember", note);
  assert.match(await first.call("bookie_remember", note), /already saved/);
  const selected = first.dashboards.at(-1).items.at(-1);
  const secondNote = {
    title: "Lyra workshop",
    summary: "The second group is meeting.",
    openChoice: note.openChoice,
  };
  await first.call("bookie_remember", secondNote);
  assert.match(
    await first.call("bookie_remember", { ...secondNote, choiceOptions: [] }),
    /already saved/,
  );
  await first.call("bookie_remember", {
    title: "Remaining workshop",
    summary: "Venue pending.",
    openChoice: "Which venue?",
  });
  const all = first.dashboards
    .at(-1)
    .items.filter((r) => r.id.startsWith("open-choice-"));
  assert.equal(all.length, 3);
  const other = all.find(
    (r) => r.label === selected.label && r.id !== selected.id,
  );
  assert.ok(other);
  const parent = join(agent, "bookie-project-memory");
  const ledger = (await readdir(parent)).find((n) => n.startsWith("ledger-"));
  const access = {
    root: join(parent, ledger, "vault"),
    scope: { project: { path: "/projects/workspace/project.md" } },
    allows: () => true,
    assertCurrent: async () => {},
  };
  const selectedInfo = await readChoice(access, selected.id);
  assert.equal(selectedInfo.label, note.openChoice);
  assert.deepEqual(selectedInfo.options, note.choiceOptions);
  assert.deepEqual(selectedInfo.recommendation, note.choiceRecommendation);
  const otherInfo = await readChoice(access, other.id);
  assert.deepEqual(otherInfo.options, []);
  assert.equal(otherInfo.recommendation, undefined);
  const payload = {
    id: selected.id,
    revision: selectedInfo.revision,
    answer: note.choiceOptions[0],
  };
  for (const bad of [
    { ...payload, revision: "sha256:" + "0".repeat(64) },
    { ...payload, id: "../other" },
    { ...payload, answer: "A\n# Outcome\nInjected" },
    { ...payload, answer: "token=private0123456789012345" },
  ])
    await assert.rejects(answerChoice(access, bad, "root-session"));
  await assert.rejects(
    answerChoice(
      {
        ...access,
        assertCurrent: async () => {
          throw Error("revoked");
        },
      },
      payload,
      "root-session",
    ),
  );
  assert.deepEqual(
    (
      await Promise.all([
        answerChoice(access, payload, "root-session"),
        answerChoice(access, payload, "session-2"),
      ])
    ).sort(),
    ["already saved", "saved"],
  );
  await assert.rejects(
    answerChoice(
      access,
      { ...payload, answer: "Conflicting choice" },
      "root-session",
    ),
  );
  assert.equal(await readChoice(access, selected.id), undefined);
  assert.ok(await readChoice(access, other.id));
  const typed = { id: other.id, revision: otherInfo.revision, answer: "None" };
  assert.equal(await answerChoice(access, typed, "root-session"), "saved");
  await first.event("session_shutdown");
  const next = host(cwd, true, "fresh-parent");
  await next.event("session_start");
  assert.deepEqual(
    next.dashboards
      .at(-1)
      .items.filter((r) => r.id.startsWith("open-choice-"))
      .map((r) => r.label),
    ["Which venue?"],
  );
  const hits = JSON.parse(
    await next.call("bookie_search", { query: note.title }),
  ).result.results;
  const source = hits.find((h) => h.source.path.includes("/note-"));
  const receipt = hits.find((h) => h.source.path.includes("/answer-"));
  assert.ok(receipt);
  assert.equal(source.choiceResolution.answer, "Printed chart");
  const topicHit = JSON.parse(
    await next.call("bookie_search", {
      query: "Participants already have a printed chart.",
    }),
  ).result.results;
  assert.equal(topicHit.length, 1);
  assert.equal(topicHit[0].choiceResolution.answer, "Printed chart");
  const read = async (h) =>
    JSON.parse(
      await next.call("bookie_read", {
        selector: "path",
        value: h.source.path,
      }),
    ).result;
  assert.equal((await read(source)).choiceResolution.answer, "Printed chart");
  assert.match((await read(receipt)).sourceText, /Printed chart/);
  const { historyChoice, projectChoiceHistory } =
    await import("../dist/choice-answer.js");
  for (const hit of [source, receipt]) {
    const ref = historyChoice(access, hit);
    await assert.rejects(
      projectChoiceHistory(access, {
        ...ref,
        revision: "sha256:" + "0".repeat(64),
      }),
    );
    for (const hidden of [source.uid, receipt.uid]) {
      await assert.rejects(
        projectChoiceHistory(
          { ...access, allows: (record) => record.uid !== hidden },
          ref,
        ),
      );
    }
  }
});
