import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { fork } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  rm,
  rename,
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
function host(
  cwd,
  enabled = true,
  sessionId = "root-session",
  inventory = false,
  capabilities = {},
) {
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
  const dashboards = [],
    dashboardRequests = [],
    choiceControls = [];
  events.on("pi-daddy:bookie-choice-controls:v1", (q) => {
    choiceControls.push(q);
    q.reply({ version: 1, ok: true, close() {} });
  });
  events.on("pi-daddy:dashboard-source:v1", (q) => {
    if (q.producer === "bookie-memory") {
      dashboardRequests.push(q);
      q.reply({
        ...(inventory
          ? {
              generation: "inventory-source",
              capabilities: { inventory: 1, refresh: 1, ...capabilities },
            }
          : {}),
        version: 1,
        ok: true,
        publish: (update) => {
          dashboards.push(update);
          return true;
        },
        close: () => dashboards.push("closed"),
      });
    }
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
    events,
    dashboards,
    dashboardRequests,
    get choiceControls() {
      return choiceControls.at(-1);
    },
    commands,
    async event(name, payload = {}) {
      let result;
      for (const h of hooks.get(name) || []) {
        const response = await h(payload, ctx);
        if (response?.block) result = response;
      }
      return result;
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
test("a bounded native observation survives /new and late publishers lose authority when the task changes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bookie-task-parent-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  const cwd = join(root, "workspace");
  await Promise.all(
    [cwd, process.env.PI_CODING_AGENT_DIR].map((path) =>
      mkdir(path, { mode: 0o700 }),
    ),
  );
  const a = host(cwd);
  await a.event("session_start");
  await a.event("before_agent_start");
  let publish;
  a.events.emit("pi.task-history.v1.bind", {
    version: 1,
    owner: "principal",
    cwd,
    sessionId: "root-session",
    accept: (p) => {
      publish = p;
    },
  });
  assert.equal(typeof publish, "function");
  const event = {
    version: 1,
    owner: "principal",
    operationId: "one",
    kind: "workflow",
    state: "retained",
    label: "Result retained",
  };
  await publish(event);
  await publish(event);
  const saved = JSON.parse(
    await a.call("bookie_remember", {
      title: "Project decision",
      summary: "Keep the existing project choice.",
    }),
  );
  assert.equal(saved.status, "saved");
  const before = JSON.parse(
    await a.call("bookie_task_history", { view: "recent" }),
  );
  assert.equal(before.summary.observations, 1);
  assert.equal(before.notes[0].path, saved.readBack.value);
  await a.event("session_shutdown");
  await assert.rejects(publish({ ...event, state: "complete" }));
  const b = host(cwd, true, "after-new");
  await b.event("session_start");
  const restored = JSON.parse(
    await b.call("bookie_task_history", { view: "recent" }),
  );
  assert.deepEqual(restored.summary, before.summary);
  assert.deepEqual(restored.notes, before.notes);
  assert.deepEqual(restored.observations, before.observations);
  let oldPublisher;
  b.events.emit("pi.task-history.v1.bind", {
    version: 1,
    owner: "principal",
    cwd,
    sessionId: "after-new",
    accept: (p) => {
      oldPublisher = p;
    },
  });
  await b.commands.get("bookie-task").handler("new", {
    ...b.ctx,
    mode: "tui",
    isIdle: () => true,
    ui: { ...b.ctx.ui, input: async () => "Separate task" },
  });
  await assert.rejects(oldPublisher({ ...event, state: "complete" }));
  assert.equal(
    JSON.parse(await b.call("bookie_task_history", {})).summary.observations,
    0,
  );
  b.revoke();
  await assert.rejects(b.call("bookie_task_history", {}));
});

test("a fresh controller distinguishes positively empty folders from an enrolled task with unavailable recovery evidence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bookie-enrollment-"));
  const prior = process.env.PI_CODING_AGENT_DIR;
  const agent = join(root, "agent"),
    cwd = join(root, "work"),
    other = join(root, "separate");
  process.env.PI_CODING_AGENT_DIR = agent;
  t.after(async () => {
    if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prior;
    await rm(root, { recursive: true, force: true });
  });
  await Promise.all([agent, cwd, other].map((p) => mkdir(p, { mode: 0o700 })));
  function lookup(h) {
    let result = "absent";
    h.events.emit("pi.task-history.v1.scope", {
      version: 1,
      cwd: h.ctx.cwd,
      sessionId: h.ctx.sessionManager.getSessionId(),
      accept: (lease) => {
        result = lease;
      },
      unavailable: () => {
        result = "unavailable";
      },
    });
    return result;
  }
  const fresh = host(other, false, "standalone");
  await fresh.event("session_start");
  assert.equal(lookup(fresh), "absent");
  const first = host(cwd, true, "before-reset");
  await first.event("session_start");
  await first.event("before_agent_start");
  const lease = lookup(first);
  assert.equal(typeof lease.taskId, "string");
  await first.event("session_shutdown");
  const store = join(agent, "bookie-project-memory");
  const ledger = (await readdir(store)).find((n) => n.startsWith("ledger-"));
  const database = join(store, ledger, "task-history-v1.sqlite");
  await rename(database, database + ".offline");
  const recovered = host(cwd, true, "after-reset");
  assert.equal(
    lookup(recovered),
    "unavailable",
    "pending startup cannot grant standalone execution",
  );
  await recovered.event("session_start");
  await recovered.event("before_agent_start");
  assert.equal(lookup(recovered), "unavailable");
  assert.equal(
    existsSync(database),
    false,
    "no replacement task or ledger was created",
  );
  await recovered.event("session_shutdown");
  await rename(database + ".offline", database);
  const back = host(cwd, true, "restored");
  await back.event("session_start");
  assert.equal(lookup(back).taskId, lease.taskId);
  const denied = host(cwd, false, "revoked");
  await denied.event("session_start");
  assert.equal(lookup(denied), "unavailable");
});
test("native edits capture an opted-in new source file before and after, and optional gaps do not refuse work", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bookie-edit-boundaries-"));
  const prior = process.env.PI_CODING_AGENT_DIR;
  const cwd = join(root, "work"),
    agent = join(root, "agent");
  process.env.PI_CODING_AGENT_DIR = agent;
  t.after(async () => {
    if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prior;
    await rm(root, { recursive: true, force: true });
  });
  await Promise.all([cwd, agent].map((p) => mkdir(p, { mode: 0o700 })));
  const h = host(cwd);
  await h.event("session_start");
  await h.event("before_agent_start");
  const messages = [];
  const cmd = {
    ...h.ctx,
    mode: "tui",
    isIdle: () => true,
    ui: {
      ...h.ctx.ui,
      select: async () => "Enable",
      editor: async () => "secret.txt",
      confirm: async () => true,
      notify: (s) => messages.push(s),
    },
  };
  const changes = (toolCallId, file) => ({
    toolName: "write",
    toolCallId,
    input: { path: file },
  });
  const first = changes("file-1", "draft.md");
  assert.equal(await h.event("tool_call", first), undefined);
  assert.equal(
    JSON.parse(await h.call("bookie_task_history", {})).summary.lastCheckpoint,
    undefined,
  );
  await h.commands.get("bookie-task").handler("auto-files", cmd);
  assert.equal(await h.event("tool_call", first), undefined);
  await writeFile(join(cwd, "draft.md"), "Original manuscript.");
  await h.event("tool_result", first);
  await h.commands.get("bookie-task").handler("export", cmd);
  const file = messages.at(-1).match(/ to (.+?\.json)(?:\.|$)/u)[1];
  const exported = JSON.parse(await readFile(file, "utf8"));
  const points = exported.bundles[0].checkpoints;
  assert.deepEqual(
    points.map((c) => c.boundary.stage),
    ["before", "after"],
  );
  assert.equal(points[0].boundary.callId, points[1].boundary.callId);
  assert.equal(points[0].manifest.entries[0].status, "missing");
  assert.equal(
    Buffer.from(exported.bundles[0].blobs[0].data, "base64").toString(),
    "Original manuscript.",
  );
  await h.commands.get("bookie-task").handler("track", cmd);
  await writeFile(join(cwd, "secret.txt"), Buffer.from([0, 255]));
  assert.equal(
    await h.event("tool_call", changes("optional", "secret.txt")),
    undefined,
  );
  await h.commands.get("bookie-task").handler("protection", cmd);
  assert.equal(
    (await h.event("tool_call", changes("protected", "secret.txt"))).block,
    true,
  );
  assert.equal(
    await h.event("tool_call", changes("unrelated", "report.md")),
    undefined,
  );
  await h.event("tool_result", changes("unrelated", "report.md"));
  await h.event("session_shutdown");
});

test("explicit export retains linked canonical question and verified answer without including another task", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bookie-project-pack-"));
  const prior = process.env.PI_CODING_AGENT_DIR;
  const agent = join(root, "agent"),
    cwd = join(root, "workspace");
  process.env.PI_CODING_AGENT_DIR = agent;
  t.after(async () => {
    if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prior;
    await rm(root, { recursive: true, force: true });
  });
  await Promise.all([agent, cwd].map((p) => mkdir(p, { mode: 0o700 })));
  const h = host(cwd, true, "source", true);
  await h.event("session_start");
  await h.event("before_agent_start");
  const ask = {
    title: "Publication date",
    summary: "The editor owns the publication decision.",
    openChoice: "Which day should the issue appear?",
    choiceOptions: ["Monday", "Friday"],
  };
  const receipt = JSON.parse(await h.call("bookie_remember", ask));
  assert.equal(receipt.status, "saved");
  const row = h.dashboards.at(-1).items.find((r) => r.label === ask.openChoice);
  const detail = await h.choiceControls.inspect(row.id, () => {});
  assert.equal(
    await h.choiceControls.answer(
      row.id,
      detail.revision,
      { option: "Friday" },
      () => {},
    ),
    "saved",
  );
  const messages = [];
  const cmd = {
    ...h.ctx,
    mode: "tui",
    isIdle: () => true,
    ui: {
      ...h.ctx.ui,
      confirm: async () => true,
      input: async () => "Separate design study",
      notify: (s) => messages.push(s),
    },
  };
  await h.commands.get("bookie-task").handler("export", cmd);
  const readLatest = async () => {
    const message = messages.at(-1);
    const file = message.match(/ to (.+?\.json)(?:\.|$)/u)?.[1];
    assert.ok(file, message);
    return JSON.parse(await readFile(file, "utf8"));
  };
  const first = await readLatest();
  assert.equal(first.scope, "task");
  assert.ok(
    first.memory.records.some((r) => r.path === receipt.readBack.value),
  );
  const answers = first.memory.records.filter((r) => /\/answer-/u.test(r.path));
  assert.equal(answers.length, 1);
  assert.match(answers[0].sourceText, /Answer: Friday/);
  assert.deepEqual(answers[0].tasks, [first.selectedTaskId]);
  await h.commands.get("bookie-task").handler("new", cmd);
  await h.call("bookie_remember", {
    title: "Unrelated study",
    summary: "Review public signage.",
  });
  await h.commands.get("bookie-task").handler("export", cmd);
  assert.equal(
    (await readLatest()).memory.records.some((r) =>
      r.sourceText.includes("Answer: Friday"),
    ),
    false,
  );
  await h.commands.get("bookie-task").handler("export-project", cmd);
  const whole = await readLatest();
  assert.equal(whole.bundles.length, 2);
  assert.ok(whole.memory.records.some((r) => r.path === answers[0].path));
  assert.ok(
    whole.memory.records.some((r) =>
      r.sourceText.includes("Review public signage."),
    ),
  );
});

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
  assert.equal(terms.nextStep, undefined);
  const noStrictMatch = await search({ query: "workshop atlas" });
  assert.equal(noStrictMatch.complete, true);
  assert.equal(noStrictMatch.matchedCount, 0);
  assert.match(noStrictMatch.nextStep, /mode=candidates/);
  assert.match(noStrictMatch.nextStep, /shorter/);
  const candidates = await search({
    mode: "candidates",
    query: "workshop atlas",
    limit: 1,
  });
  assert.equal(candidates.queryMode, "candidates");
  assert.equal(candidates.results.length, 1);
  assert.equal(candidates.matchedCount, 2);
  assert.equal(candidates.complete, false);
  assert.equal(candidates.scanComplete, true);
  assert.equal(candidates.resultsTruncated, true);
  assert.equal(candidates.nextStep, undefined);
  assert.equal(candidates.results[0].candidateStatus, "unconfirmed");
  assert.deepEqual(candidates.results[0].matchedTerms, ["workshop"]);
  assert.match(candidates.interpretation, /unconfirmed/i);
  const selected = JSON.parse(
    await next.call("bookie_read", {
      selector: "path",
      value: candidates.results[0].source.path,
    }),
  ).result;
  assert.deepEqual(selected.source, candidates.results[0].source);
  assert.equal(
    (await search({ mode: "recent", type: "Activity", limit: 50 }))
      .matchedCount,
    2,
  );
  const noCandidates = await search({ mode: "candidates", query: "unrelated" });
  assert.equal(noCandidates.results.length, 0);
  assert.equal(noCandidates.nextStep, undefined);
  const recent = await search({ mode: "recent", type: "Activity", limit: 1 });
  assert.equal(recent.results.length, 1);
  assert.equal(recent.matchedCount, 2);
  assert.equal(recent.resultsTruncated, true);
  assert.equal(recent.scanComplete, true);
  assert.equal(recent.complete, false);
  assert.equal(recent.nextStep, undefined);
  const all = await search({ mode: "recent", type: "Activity", limit: 2 });
  assert.equal(all.complete, true);
  assert.equal(all.results.length, 2);
  for (const args of [
    { query: "!!!" },
    { mode: "candidates", query: "!!!" },
    { mode: "candidates", query: "workshop", limit: 51 },
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
  assert.equal(
    JSON.parse(
      await separate.call("bookie_search", {
        mode: "candidates",
        query: "workshop atlas",
      }),
    ).result.matchedCount,
    0,
  );
  await assert.rejects(
    search({ mode: "candidates", query: "workshop", vault: cwd }),
    /withheld/,
  );
  next.revoke();
  await assert.rejects(search({ mode: "recent" }), /withheld/);
  await assert.rejects(
    search({ mode: "candidates", query: "workshop atlas" }),
    /withheld/,
  );
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

async function reclassificationFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "bookie-choice-classification-"));
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
  const h = host(cwd, true, "first-parent", true);
  await h.event("session_start");
  const inputs = [
    {
      title: "Budget Split browser",
      summary: "Interface remains optional.",
      openChoice: "Should we add a browser interface next?",
      choiceOptions: ["Browser interface", "Keep the command line"],
    },
    {
      title: "Budget Split export",
      summary: "Export remains optional.",
      openChoice: "CSV ou JSON; quel format convient au projet",
      choiceOptions: ["CSV", "JSON", "No export"],
    },
    {
      title: "Budget Split progress",
      summary:
        "Delivered and reviewed. Both decisions are already saved separately.",
      openChoice:
        "Keep these two decisions open: should we add a browser interface next; which export should Budget Split 19 offer first",
    },
  ];
  for (const input of inputs) await h.call("bookie_remember", input);
  const rows = h.dashboards
    .at(-1)
    .items.filter((item) => item.id.startsWith("open-choice-"));
  const parent = join(agent, "bookie-project-memory");
  const ledger = (await readdir(parent)).find((n) => n.startsWith("ledger-"));
  const vault = join(parent, ledger, "vault");
  const activityDir = join(vault, "projects/workspace/activities");
  const originals = new Map(
    await Promise.all(
      (await readdir(activityDir)).map(async (name) => [
        name,
        await readFile(join(activityDir, name), "utf8"),
      ]),
    ),
  );
  return {
    h,
    cwd,
    inputs,
    rows,
    activityDir,
    originals,
    vault,
    async read(host, name) {
      return JSON.parse(
        await host.call("bookie_read", {
          selector: "path",
          value: "/projects/workspace/activities/" + name,
        }),
      ).result;
    },
    async untouched() {
      for (const [name, text] of originals)
        assert.equal(await readFile(join(activityDir, name), "utf8"), text);
    },
  };
}

test("explicit reclassification removes only the selected recap, preserves answers and is recalled after a fresh session", async (t) => {
  const f = await reclassificationFixture(t);
  const { h, rows } = f;
  assert.equal(
    rows.length,
    3,
    "no wording heuristic silently removes even an explicit mistaken choice",
  );
  const selected = rows.find((row) => row.label === f.inputs[2].openChoice);
  const detail = await h.choiceControls.inspect(selected.id, () => {});
  assert.equal(typeof h.choiceControls.reclassify, "function");
  assert.equal(
    await h.choiceControls.reclassify(selected.id, detail.revision, () => {}),
    "saved",
  );
  assert.equal(
    await h.choiceControls.reclassify(selected.id, detail.revision, () => {}),
    "saved",
  );
  const remaining = h.dashboards
    .at(-1)
    .items.filter((row) => row.id.startsWith("open-choice-"));
  assert.deepEqual(
    new Set(remaining.map((row) => row.label)),
    new Set(f.inputs.slice(0, 2).map((input) => input.openChoice)),
  );
  assert.equal(
    await h.choiceControls.inspect(selected.id, () => {}),
    undefined,
  );
  assert.equal(
    await h.choiceControls.answer(
      selected.id,
      detail.revision,
      { custom: "Not an answer" },
      () => {},
    ),
    "refused",
  );
  const answered = remaining.find(
    (row) => row.label === f.inputs[0].openChoice,
  );
  const answerDetail = await h.choiceControls.inspect(answered.id, () => {});
  assert.equal(
    await h.choiceControls.answer(
      answered.id,
      answerDetail.revision,
      { option: "Browser interface" },
      () => {},
    ),
    "saved",
  );
  assert.equal(
    await h.choiceControls.reclassify(
      answered.id,
      answerDetail.revision,
      () => {},
    ),
    "refused",
  );
  await f.untouched();
  await h.event("session_shutdown");
  const next = host(f.cwd, true, "after-new", true);
  await next.event("session_start");
  assert.deepEqual(
    next.dashboards
      .at(-1)
      .items.filter((row) => row.id.startsWith("open-choice-"))
      .map((row) => row.label),
    [f.inputs[1].openChoice],
  );
  const digest = selected.id.replace("open-choice-", "");
  const old = await f.read(next, "note-" + digest + ".md");
  assert.equal(old.choiceDisposition.status, "not-a-decision");
  assert.equal(old.choiceDisposition.question, selected.label);
  assert.equal(
    old.choiceResolution,
    undefined,
    "a classification must not manufacture an answer",
  );
  const names = await readdir(f.activityDir);
  assert.equal(
    names.filter((name) => name.startsWith("classification-")).length,
    1,
  );
  assert.equal(names.filter((name) => name.startsWith("answer-")).length, 1);
  const receipt = await f.read(next, "classification-" + digest + ".md");
  assert.deepEqual(receipt.choiceDisposition, old.choiceDisposition);
  const answer = await f.read(
    next,
    "answer-" + answered.id.replace("open-choice-", "") + ".md",
  );
  assert.equal(answer.choiceResolution.answer, "Browser interface");
  // Force indexed general recall, which must not skip classification metadata.
  for (let i = 0; i < 9; i++)
    await next.call("bookie_remember", {
      title: "Budget Split archive " + i,
      summary: "Historical context only.",
    });
  const search = JSON.parse(
    await next.call("bookie_search", { query: "Budget Split", limit: 30 }),
  ).result;
  assert.equal(search.complete, true);
  assert.equal(
    search.results.find((hit) =>
      hit.source.path.endsWith("note-" + digest + ".md"),
    ).choiceDisposition.status,
    "not-a-decision",
  );
  const lastRow = remaining.find((row) => row.id !== answered.id);
  const lastDetail = await next.choiceControls.inspect(lastRow.id, () => {});
  assert.equal(
    await next.choiceControls.reclassify(
      lastRow.id,
      lastDetail.revision,
      () => {},
    ),
    "saved",
  );
  await next.event("session_shutdown");
  const noChoices = host(f.cwd, true, "after-last-correction", true);
  await noChoices.event("session_start");
  const inventory = noChoices.dashboards.at(-1);
  assert.deepEqual(
    inventory.items.map((row) => row.id),
    ["project-memory"],
  );
  assert.equal(inventory.items[0].state, "observed");
  assert.equal(inventory.inventory.state, "available");
  assert.equal(inventory.inventory.count, 15);
  assert.equal(
    inventory.inventory.limited,
    true,
    "the recent preview remains honestly bounded to twelve of fifteen notes",
  );
  assert.equal(
    (await f.read(noChoices, "note-" + digest + ".md")).choiceDisposition
      .status,
    "not-a-decision",
  );
  await f.untouched();
});

test("reclassification refuses stale revisions, revoked access and an already answered item", async (t) => {
  const f = await reclassificationFixture(t);
  const row = f.rows[0],
    controls = f.h.choiceControls;
  const detail = await controls.inspect(row.id, () => {});
  assert.equal(typeof controls.reclassify, "function");
  const before = await readdir(f.activityDir);
  for (const [id, revision, assertCurrent] of [
    [row.id, "sha256:" + "0".repeat(64), () => {}],
    ["../other", detail.revision, () => {}],
    [
      row.id,
      detail.revision,
      () => {
        throw Error("PRIVATE owner changed");
      },
    ],
  ])
    assert.equal(
      await controls.reclassify(id, revision, assertCurrent),
      "refused",
    );
  assert.deepEqual(await readdir(f.activityDir), before);
  const sourceName = "note-" + row.id.replace("open-choice-", "") + ".md";
  await writeFile(
    join(f.activityDir, sourceName),
    f.originals.get(sourceName) + "\n",
  );
  assert.equal(
    await controls.reclassify(row.id, detail.revision, () => {}),
    "refused",
  );
  assert.deepEqual(await readdir(f.activityDir), before);
  await writeFile(join(f.activityDir, sourceName), f.originals.get(sourceName));
  f.h.revoke();
  assert.equal(
    await controls.reclassify(row.id, detail.revision, () => {}),
    "refused",
  );
  assert.deepEqual(await readdir(f.activityDir), before);
  await f.untouched();
});

test("concurrent answer and reclassification settle only one result without overwriting the source", async (t) => {
  const f = await reclassificationFixture(t);
  const controls = f.h.choiceControls,
    row = f.rows[0];
  const detail = await controls.inspect(row.id, () => {});
  assert.equal(typeof controls.reclassify, "function");
  const results = await Promise.all([
    controls.reclassify(row.id, detail.revision, () => {}),
    controls.answer(row.id, detail.revision, { custom: "My answer" }, () => {}),
  ]);
  assert.deepEqual(results.sort(), ["refused", "saved"]);
  assert.equal(
    (await readdir(f.activityDir)).filter((name) =>
      /^(?:answer|classification)-/u.test(name),
    ).length,
    1,
  );
  assert.equal(await controls.inspect(row.id, () => {}), undefined);
  await f.untouched();
});

test(
  "two processes cannot both publish an answer and a classification after reading the same open source",
  { timeout: 30000 },
  async (t) => {
    for (const winner of [0, 1])
      await t.test(
        winner === 0
          ? "answer publishes first"
          : "classification publishes first",
        async (t) => {
          const f = await reclassificationFixture(t),
            row = f.rows[0];
          const detail = await f.h.choiceControls.inspect(row.id, () => {});
          const writers = ["answer", "classify"].map((action) => {
            const child = fork(
              new URL("./fixtures/choice-writer.mjs", import.meta.url),
              [
                JSON.stringify({
                  root: f.vault,
                  id: row.id,
                  revision: detail.revision,
                  action,
                }),
              ],
              { stdio: ["ignore", "ignore", "pipe", "ipc"] },
            );
            let ready, finish, failReady, failResult;
            const readyPromise = new Promise((resolve, reject) => {
              ready = resolve;
              failReady = reject;
            });
            const resultPromise = new Promise((resolve, reject) => {
              finish = resolve;
              failResult = reject;
            });
            child.on("message", (message) => {
              if (message.ready) ready();
              if (message.result) finish(message.result);
            });
            child.on("error", (error) => {
              failReady(error);
              failResult(error);
            });
            child.on("exit", (code) => {
              if (code !== 0) {
                const error = Error("Choice writer exited " + code);
                failReady(error);
                failResult(error);
              }
            });
            t.after(() => {
              if (child.exitCode === null) child.kill();
            });
            return { child, readyPromise, resultPromise };
          });
          await Promise.all(writers.map((writer) => writer.readyPromise));
          writers[winner].child.send({ continue: true });
          assert.equal(await writers[winner].resultPromise, "saved");
          writers[1 - winner].child.send({ continue: true });
          const results = await Promise.all(
            writers.map((writer) => writer.resultPromise),
          );
          assert.deepEqual(results.sort(), ["refused", "saved"]);
          assert.equal(
            (await readdir(f.activityDir)).filter((name) =>
              /^(?:answer|classification)-/u.test(name),
            ).length,
            1,
          );
          await f.untouched();
        },
      );
  },
);

test("an older writer's answer after classification remains readable and the conflict is explicit", async (t) => {
  const f = await reclassificationFixture(t),
    row = f.rows[0],
    controls = f.h.choiceControls;
  const detail = await controls.inspect(row.id, () => {});
  assert.equal(
    await controls.answer(
      row.id,
      detail.revision,
      { custom: "Original saved answer" },
      () => {},
    ),
    "saved",
  );
  const answerName = "answer-" + row.id.replace("open-choice-", "") + ".md";
  const answerPath = join(f.activityDir, answerName),
    answerBytes = await readFile(answerPath);
  // A valid receipt from the real answer writer models an older process unaware of the new slot.
  await rm(answerPath);
  assert.equal(
    await controls.reclassify(row.id, detail.revision, () => {}),
    "saved",
  );
  await writeFile(answerPath, answerBytes);
  const answer = await f.read(f.h, answerName);
  assert.equal(answer.choiceResolution.answer, "Original saved answer");
  assert.equal(answer.choiceDisposition.status, "conflict");
  assert.equal(
    await controls.reclassify(row.id, detail.revision, () => {}),
    "refused",
  );
  assert.deepEqual(await readFile(answerPath), answerBytes);
  await f.untouched();
});

test("lost access after a durable classification reports unconfirmed and a fresh session can verify it", async (t) => {
  const f = await reclassificationFixture(t),
    row = f.rows[0],
    controls = f.h.choiceControls;
  const detail = await controls.inspect(row.id, () => {});
  const path = join(
    f.activityDir,
    "classification-" + row.id.replace("open-choice-", "") + ".md",
  );
  assert.equal(
    await controls.reclassify(row.id, detail.revision, () => {
      if (existsSync(path))
        throw Error("PRIVATE owner revoked after publication");
    }),
    "unconfirmed",
  );
  assert.equal(existsSync(path), true);
  await f.h.event("session_shutdown");
  const next = host(f.cwd, true, "after-uncertain-ack", true);
  await next.event("session_start");
  assert.ok(!next.dashboards.at(-1).items.some((item) => item.id === row.id));
  const receipt = await f.read(
    next,
    "classification-" + row.id.replace("open-choice-", "") + ".md",
  );
  assert.equal(receipt.choiceDisposition.status, "not-a-decision");
  await f.untouched();
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
  const first = host(cwd, true, "root-session", true);
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
  const typed = {
    id: other.id,
    revision: otherInfo.revision,
    answer: "Large tactile controls",
  };
  assert.equal(await answerChoice(access, typed, "root-session"), "saved");
  await first.event("session_shutdown");
  const next = host(cwd, true, "fresh-parent", true);
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
  assert.equal(receipt.choiceResolution.answer, "Printed chart");
  assert.equal(receipt.choiceResolution.question, note.openChoice);
  assert.equal(source.choiceResolution.answer, "Printed chart");
  // These words occur only in the typed answer, not in either question/title.
  const discovered = JSON.parse(
    await next.call("bookie_search", { query: "tactile controls" }),
  ).result;
  assert.equal(discovered.complete, true);
  assert.equal(discovered.results.length, 1);
  assert.equal(discovered.results[0].choiceResolution.answer, typed.answer);
  assert.equal(
    discovered.results[0].choiceResolution.question,
    otherInfo.label,
  );
  const inventory = next.dashboards.at(-1).inventory;
  assert.equal(inventory.count, 5);
  assert.ok(
    inventory.entries.some(
      (row) => row.summary === "Answered: " + typed.answer,
    ),
  );
  assert.ok(
    inventory.entries.some((row) => row.summary === "Answered: Printed chart"),
  );
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
  assert.equal((await read(receipt)).choiceResolution.answer, "Printed chart");
  assert.equal(
    (await read(discovered.results[0])).choiceResolution.answer,
    typed.answer,
  );
  const { dashboardMemoryInventory, createMemoryAnswerCache } =
    await import("../dist/dashboard-memory-inventory.js");
  const previewCache = createMemoryAnswerCache();
  let fullRecordChecks = 0;
  const countedAccess = {
    ...access,
    allows: (record) => {
      if ("sourceText" in record) fullRecordChecks++;
      return true;
    },
  };
  const coldPreview = await dashboardMemoryInventory(
    countedAccess,
    undefined,
    previewCache,
  );
  assert.equal(
    fullRecordChecks,
    4,
    "cold preview verifies both question/answer pairs",
  );
  fullRecordChecks = 0;
  assert.deepEqual(
    await dashboardMemoryInventory(countedAccess, undefined, previewCache),
    coldPreview,
  );
  assert.equal(
    fullRecordChecks,
    0,
    "unchanged warm preview uses fresh scan metadata, not four repeated inspections",
  );
  const hiddenOriginal = await dashboardMemoryInventory(
    {
      ...access,
      allows: (record) => record.uid !== source.uid,
    },
    undefined,
    previewCache,
  );
  assert.equal(hiddenOriginal.limited, true);
  assert.equal(
    hiddenOriginal.entries.find((row) => row.id === receipt.uid).summary,
    "Saved answer unavailable in this preview.",
  );
  let accessChecks = 0;
  await assert.rejects(
    dashboardMemoryInventory(
      {
        ...access,
        assertCurrent: async () => {
          if (++accessChecks === 3) throw Error("revoked during answer read");
        },
      },
      undefined,
      previewCache,
    ),
    /revoked during answer read/,
  );
  assert.equal(
    previewCache.answers.size,
    0,
    "access loss clears derived previews",
  );
  await dashboardMemoryInventory(access, undefined, previewCache);
  const answerFile = join(access.root, receipt.source.path.slice(1));
  const originalBytes = await readFile(answerFile);
  try {
    await writeFile(
      answerFile,
      originalBytes.toString().replace("Question: ", "Changed question: "),
    );
    const damaged = await dashboardMemoryInventory(
      access,
      undefined,
      previewCache,
    );
    assert.equal(damaged.limited, true);
    assert.equal(
      damaged.entries.find((row) => row.id === receipt.uid).summary,
      "Saved answer unavailable in this preview.",
    );
    const damagedSearch = JSON.parse(
      await next.call("bookie_search", { query: note.title }),
    ).result;
    assert.equal(damagedSearch.complete, false);
    assert.ok(
      !damagedSearch.results.some((hit) => hit.choiceResolution?.answer),
    );
  } finally {
    await writeFile(answerFile, originalBytes);
  }
  assert.deepEqual(await readFile(answerFile), originalBytes);
  await dashboardMemoryInventory(access, undefined, previewCache);
  for (let n = 0; n < 11; n++)
    await next.call("bookie_remember", {
      title: "Later progress " + n,
      summary: "Recorded a later project update.",
    });
  fullRecordChecks = 0;
  const page = await dashboardMemoryInventory(
    countedAccess,
    undefined,
    previewCache,
  );
  assert.equal(page.entries.length, 12);
  assert.ok(!page.entries.some((row) => row.reference === source.source.path));
  assert.ok(
    page.entries.some((row) => row.summary === "Answered: " + typed.answer),
  );
  assert.equal(
    fullRecordChecks,
    0,
    "fresh scan checks the original even outside the displayed page",
  );
  assert.ok(previewCache.answers.size <= 12);
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

test("dashboard inventory restores saved contents across a new session and refreshes readiness with no choices", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bookie-inventory-session-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const cwd = join(root, "workspace");
  await Promise.all([mkdir(cwd), mkdir(process.env.PI_CODING_AGENT_DIR)]);
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  const first = host(cwd, true, "inventory-first", true);
  await first.event("session_start");
  assert.equal(first.dashboards.at(-1).inventory.state, "empty");
  assert.equal(first.dashboards.at(-1).inventory.count, 0);
  assert.equal(first.dashboards.at(-1).inventory.limited, false);
  await first.call("bookie_remember", {
    title: "Orchid workshop",
    summary: "Participants use a printed atlas.",
  });
  const saved = first.dashboards.at(-1);
  assert.equal(saved.inventory.count, 1);
  assert.equal(saved.inventory.entries[0].title, "Orchid workshop");
  assert.match(saved.inventory.entries[0].summary, /printed atlas/);
  assert.equal(saved.items.length, 1);
  assert.equal(saved.items[0].id, "project-memory");
  const request = first.dashboardRequests.at(-1);
  assert.equal(typeof request.refresh, "function");
  const published = first.dashboards.length;
  const renewed = await request.refresh({
    signal: new AbortController().signal,
  });
  assert.equal(
    first.dashboards.length,
    published,
    "refresh must return, never publish internally",
  );
  assert.equal(renewed.inventory.count, 1);
  assert.equal(renewed.items[0].state, "observed");
  assert.ok(renewed.sequence > saved.sequence);
  const store = join(process.env.PI_CODING_AGENT_DIR, "bookie-project-memory");
  const ledger = (await readdir(store)).find((name) =>
    name.startsWith("ledger-"),
  );
  const broken = join(store, ledger, "vault/projects/workspace/broken.md");
  await writeFile(broken, "---\n{ broken\n---\nUnparseable note.\n");
  const partial = await request.refresh({
    signal: new AbortController().signal,
  });
  assert.equal(partial.items[0].state, "unknown");
  assert.equal(partial.inventory.state, "available");
  assert.equal(partial.inventory.limited, true);
  assert.equal(partial.inventory.count, undefined);
  await rm(broken);
  await first.event("session_shutdown");
  assert.equal(
    await request.refresh({ signal: new AbortController().signal }),
    undefined,
  );
  const next = host(cwd, true, "inventory-next", true);
  next.ctx.modelRegistry.getApiKeyAndHeaders = async () => {
    throw Error("Dashboard must not resolve provider auth");
  };
  await next.event("session_start");
  assert.equal(
    next.dashboards.at(-1).inventory.entries[0].title,
    "Orchid workshop",
  );
  assert.equal(next.dashboards.at(-1).inventory.count, 1);
  const other = join(root, "other");
  await mkdir(other);
  const unrelated = host(other, true, "inventory-other", true);
  await unrelated.event("session_start");
  assert.equal(unrelated.dashboards.at(-1).inventory.state, "empty");
  assert.equal(unrelated.dashboards.at(-1).inventory.count, 0);
});

test("dashboard inventories preserve open-choice slots and older hosts retain legacy updates", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bookie-inventory-choices-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const cwd = join(root, "workspace");
  await Promise.all([mkdir(cwd), mkdir(process.env.PI_CODING_AGENT_DIR)]);
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  const modern = host(cwd, true, "modern", true);
  await modern.event("session_start");
  for (let n = 0; n < 2; n++)
    await modern.call("bookie_remember", {
      title: "Planning " + n,
      summary: "A saved planning note.",
      openChoice: "Which venue " + n + "?",
    });
  const update = await modern.dashboardRequests
    .at(-1)
    .refresh({ signal: new AbortController().signal });
  assert.equal(update.inventory.count, 2);
  assert.equal(
    update.items.filter((row) => row.id.startsWith("open-choice-")).length,
    2,
  );
  assert.equal(update.items.length, 3);
  assert.ok(
    Buffer.byteLength(
      JSON.stringify({ sequence: update.sequence, items: update.items }),
    ) <= 4096,
  );
  await modern.event("session_shutdown");
  const legacy = host(cwd, true, "legacy");
  await legacy.event("session_start");
  assert.equal(legacy.dashboards.at(-1).inventory, undefined);
  assert.deepEqual(Object.keys(legacy.dashboards.at(-1)).sort(), [
    "items",
    "sequence",
  ]);
  assert.equal(
    legacy.dashboards
      .at(-1)
      .items.filter((row) => row.id.startsWith("open-choice-")).length,
    2,
  );
});

test("dashboard refresh refuses aborted or revoked owners and does not confuse disclosure failure with an empty store", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bookie-inventory-revocation-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const cwd = join(root, "workspace");
  await Promise.all([mkdir(cwd), mkdir(process.env.PI_CODING_AGENT_DIR)]);
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  const h = host(cwd, true, "inventory-owner", true);
  await h.event("session_start");
  await h.call("bookie_remember", {
    title: "Private project title",
    summary: "Authorized local note.",
  });
  const request = h.dashboardRequests.at(-1);
  const count = h.dashboards.length;
  const controller = new AbortController();
  controller.abort();
  assert.equal(await request.refresh({ signal: controller.signal }), undefined);
  assert.equal(h.dashboards.length, count);
  let authCalls = 0;
  h.ctx.modelRegistry.getApiKeyAndHeaders = async () => {
    authCalls++;
    throw Error("Dashboard must not resolve provider auth");
  };
  const refreshed = await request.refresh({
    signal: new AbortController().signal,
  });
  assert.equal(refreshed.inventory.count, 1);
  assert.equal(refreshed.items[0].state, "observed");
  assert.equal(authCalls, 0);
  const store = join(process.env.PI_CODING_AGENT_DIR, "bookie-project-memory");
  const ledger = (await readdir(store)).find((name) =>
    name.startsWith("ledger-"),
  );
  const controlsPath = join(store, ledger, "vault", "bookie-recall.json");
  const controls = await readFile(controlsPath, "utf8");
  await writeFile(controlsPath, "broken controls");
  const denied = await request.refresh({
    signal: new AbortController().signal,
  });
  assert.equal(denied.inventory.state, "unavailable");
  assert.deepEqual(denied.inventory.entries, []);
  assert.equal(denied.inventory.count, undefined);
  assert.ok(!JSON.stringify(denied).includes("Private project title"));
  await writeFile(controlsPath, controls);
  const pending = request.refresh({ signal: new AbortController().signal });
  await h.commands.get("bookie-context").handler("off", h.ctx);
  assert.equal(await pending, undefined);
  assert.equal(h.dashboards.at(-1), "closed");
  assert.equal(authCalls, 0);
});

test("dashboard progress requires both capabilities and a live enrolled task binding", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bookie-dashboard-progress-"));
  const previous = process.env.PI_CODING_AGENT_DIR,
    agent = join(root, "agent"),
    cwd = join(root, "project");
  process.env.PI_CODING_AGENT_DIR = agent;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  await Promise.all([agent, cwd].map((p) => mkdir(p, { mode: 0o700 })));
  const a = host(cwd, true, "progress", true, {
    taskHistory: 1,
    taskProgress: 1,
  });
  await a.event("session_start");
  await a.event("before_agent_start");
  const scope = (h) => {
    let lease;
    h.events.emit("pi.task-history.v1.scope", {
      version: 1,
      cwd,
      sessionId: h.ctx.sessionManager.getSessionId(),
      accept: (value) => {
        lease = value;
      },
    });
    return lease;
  };
  const first = scope(a);
  assert.ok(first);
  await a.event("before_agent_start");
  assert.equal(
    scope(a).assertCurrent,
    first.assertCurrent,
    "current healthy grant can be reused on the next turn",
  );
  let emit;
  a.events.emit("pi.task-history.v1.bind", {
    version: 1,
    owner: "scout",
    cwd,
    sessionId: "progress",
    accept: (fn) => {
      emit = fn;
    },
  });
  for (const [index, kind, state] of [
    [0, "phase", "retained"],
    [1, "phase", "retained"],
    [2, "phase", "failed"],
    [3, "phase", "partial"],
    [4, "phase", "retained"],
    [5, "heartbeat", "running"],
    [6, "poll", "heartbeat"],
  ]) {
    await emit({
      version: 1,
      owner: "scout",
      operationId: "work-" + index,
      kind,
      state,
      label: "local-step-" + index,
    });
  }
  const cmd = {
    ...a.ctx,
    mode: "tui",
    isIdle: () => true,
    ui: { ...a.ctx.ui, editor: async () => "agenda.md\nabsent.md" },
  };
  await writeFile(join(cwd, "agenda.md"), "Public agenda");
  await a.commands.get("bookie-task").handler("track", cmd);
  await a.commands.get("bookie-task").handler("checkpoint", cmd);
  const refresh = async (h) =>
    h.dashboardRequests
      .at(-1)
      .refresh({ signal: new AbortController().signal });
  const watched = (await refresh(a)).taskHistory;
  assert.equal(watched.taskId, first.taskId);
  assert.ok(["captured", "published"].includes(watched.lastCheckpoint.state));
  assert.equal(watched.lastCheckpoint.files, 1);
  assert.equal(watched.lastCheckpoint.missing, 1);
  assert.equal(watched.lastCheckpoint.excluded, 0);
  assert.match(watched.lastCheckpoint.capturedAt, /^\d{4}-/u);
  assert.deepEqual(Object.keys(watched.lastCheckpoint).sort(), [
    "capturedAt",
    "excluded",
    "files",
    "missing",
    "state",
  ]);
  assert.equal(watched.lastObservation.state, "heartbeat");
  assert.deepEqual(
    watched.recentProgress.map((p) => p.label),
    ["local-step-4", "local-step-3", "local-step-2", "local-step-1"],
  );
  assert.deepEqual(
    watched.recentProgress.map((p) => p.state),
    ["retained", "partial", "failed", "retained"],
  );
  assert.ok(
    watched.recentProgress.every(
      (p) => p.owner === "scout" && Object.keys(p).length === 4,
    ),
  );
  // A different session can select another task in the same store. Recheck
  // the exact active revision before using a cached session binding.
  const other = host(cwd, true, "other", true, { taskHistory: 1 });
  await other.event("session_start");
  const legacy = (await refresh(other)).taskHistory;
  assert.equal(legacy.taskId, first.taskId);
  assert.equal(legacy.lastObservation.label, "local-step-6");
  assert.ok(!("lastCheckpoint" in legacy) && !("recentProgress" in legacy));
  await other.commands.get("bookie-task").handler("new", {
    ...other.ctx,
    mode: "tui",
    isIdle: () => true,
    ui: { ...other.ctx.ui, input: async () => "Other project task" },
  });
  await a.event("before_agent_start");
  assert.notEqual(scope(a).taskId, first.taskId);
  assert.deepEqual((await refresh(a)).taskHistory.recentProgress, []);
  await assert.rejects(first.assertCurrent());
  await other.event("session_shutdown");
  const partial = host(cwd, true, "partial", true, { taskProgress: 1 });
  await partial.event("session_start");
  assert.ok(!("taskHistory" in (await refresh(partial))));
  await partial.event("session_shutdown");
  a.revoke();
  assert.equal(await refresh(a), undefined);
  await a.event("session_shutdown");
});
