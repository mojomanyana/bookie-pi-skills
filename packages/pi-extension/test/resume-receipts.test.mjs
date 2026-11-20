import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
import { validateToolArguments } from "@earendil-works/pi-ai";
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
  const dashboards = [];
  const owner = { version: 1, cwd, sessionId, isCurrent: () => enabled };
  events.on("pi-daddy:request-project-memory-owner-v1", (q) => {
    if (enabled && q.cwd === cwd && q.sessionId === sessionId) q.reply(owner);
  });
  events.on("pi-daddy:dashboard-source:v1", (q) => {
    if (q.producer === "bookie-memory")
      q.reply({
        version: 1,
        ok: true,
        publish(update) {
          dashboards.push(update);
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
    dashboards,
    tool(name) {
      return tools.get(name);
    },
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
  const { cwd, agent, other } = await fixture(t),
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
  // The pre-nextAction identity is the public retry address: omitting the new
  // field must still address the exact existing note, rather than duplicate it.
  const store = join(agent, "bookie-project-memory");
  const ledger = (await readdir(store)).find((name) =>
    name.startsWith("ledger-"),
  );
  const project = JSON.parse(
    (
      await readFile(
        join(store, ledger, "vault/projects/workspace/project.md"),
        "utf8",
      )
    ).split("\n")[1],
  );
  for (const [note, saved] of [
    [oldNote, old],
    [currentNote, current],
  ]) {
    const legacyId = createHash("sha256")
      .update(JSON.stringify([project.bookie.uid, note.title, note.summary]))
      .digest("hex")
      .slice(0, 32);
    assert.equal(
      saved.readBack.value,
      `/projects/workspace/activities/note-${legacyId}.md`,
    );
  }

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
    nextAction: "Prepare the already-requested workshop outline.",
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
        content: [
          {
            type: "text",
            text:
              note.deliveryUrl + "\n\nOpen choice: Which room should we use?",
          },
        ],
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
  const body = json(
    await next.call("bookie_read", {
      selector: "path",
      value: hits[0].source.path,
    }),
  ).result.sourceText;
  assert.ok(body.includes(note.deliveryUrl));
  assert.ok(body.includes("# Next action\n\n" + note.nextAction));
  assert.ok(body.includes("# Unresolved work\n\nWhich room should we use?"));
});

test("authorized next actions persist independently of user choices across a fresh session", async (t) => {
  const { cwd, agent } = await fixture(t),
    h = host(cwd, "next-action");
  await h.event("session_start");
  const note = {
    title: "Workshop progress",
    summary:
      "The backend is delivered; the user already requested independent review.",
    nextAction:
      "Run the already-authorized independent review with the saved evidence.",
  };
  const saved = receipt(await h.call("bookie_remember", note), "saved");
  assert.deepEqual(
    receipt(await h.call("bookie_remember", note), "already saved"),
    {
      ...saved,
      status: "already saved",
    },
  );
  assert.deepEqual(
    h.dashboards
      .at(-1)
      .items.filter((item) => item.id.startsWith("open-choice-")),
    [],
  );
  const body = json(await h.call("bookie_read", saved.readBack)).result
    .sourceText;
  assert.ok(body.includes("# Next action\n\n" + note.nextAction));
  assert.ok(
    body.includes("# Unresolved work\n\nNo additional information recorded."),
  );
  const choice = receipt(
    await h.call("bookie_remember", {
      ...note,
      title: "Workshop audience",
      openChoice: "Which audience should the update address?",
      choiceOptions: ["Dispatchers", "Workshop attendees"],
    }),
    "saved",
  );
  await h.call("bookie_remember", {
    title: "Workshop date",
    summary: "The preview date remains undecided.",
    openChoice: "Which preview date should we use?",
  });
  const items = h.dashboards
    .at(-1)
    .items.filter((item) => item.id.startsWith("open-choice-"));
  assert.equal(items.length, 2);
  const selected = items.find(
    (item) => item.label === "Which audience should the update address?",
  );
  const parent = join(agent, "bookie-project-memory");
  const ledger = (await readdir(parent)).find((name) =>
    name.startsWith("ledger-"),
  );
  const access = {
    root: join(parent, ledger, "vault"),
    scope: { project: { path: "/projects/workspace/project.md" } },
    allows: () => true,
    assertCurrent: async () => {},
  };
  const { readChoice, answerChoice } = await import("../dist/choice-answer.js");
  const detail = await readChoice(access, selected.id);
  assert.equal(
    await answerChoice(
      access,
      {
        id: selected.id,
        revision: detail.revision,
        answer: "Dispatchers",
      },
      "next-action",
    ),
    "saved",
  );
  await h.event("session_shutdown");
  const next = host(cwd, "next-action-fresh");
  await next.event("session_start");
  const restored = json(await next.call("bookie_read", saved.readBack)).result;
  assert.equal(restored.sourceText, body);
  const answered = json(await next.call("bookie_read", choice.readBack)).result;
  assert.equal(answered.choiceResolution.answer, "Dispatchers");
  assert.ok(
    answered.sourceText.includes("# Next action\n\n" + note.nextAction),
  );
  assert.deepEqual(
    next.dashboards
      .at(-1)
      .items.filter((item) => item.id.startsWith("open-choice-"))
      .map((item) => item.label),
    ["Which preview date should we use?"],
  );

  await t.test(
    "only linked questions and their authorized exact answers travel with the task",
    async () => {
      const {
        openTaskHistory,
        exportHistoryArchive,
        importHistoryArchive,
        readImportedHistoryArchive,
      } = await import("pi-bookie-core");
      const { readArchiveMemory } =
        await import("../dist/task-archive-memory.js");
      const projectText = await readFile(
        join(access.root, "projects/workspace/project.md"),
        "utf8",
      );
      const projectId = JSON.parse(projectText.split("\n")[1]).bookie.uid;
      const db = await openTaskHistory({
        vault: access.root,
        projectId,
        assertCurrent: access.assertCurrent,
      });
      const selectedTask = await db.selectNew("Audience handoff");
      await db.linkNote(
        selectedTask,
        answered.source.path,
        answered.source.sourceHash,
      );
      const readMemory = async (links) => {
        const result = await readArchiveMemory(access, "task", links);
        await result.assertCurrent();
        return result.memory;
      };
      const archive = await exportHistoryArchive(
        db,
        selectedTask,
        "task",
        readMemory,
      );
      const entries = archive.memory.records;
      assert.equal(archive.memory.limited, false);
      assert.deepEqual(
        entries.map((r) => r.path).sort(),
        [answered.source.path, answered.choiceResolution.source.path].sort(),
      );
      const answerRecord = entries.find(
        (r) => r.path === answered.choiceResolution.source.path,
      );
      assert.equal(
        answerRecord.sourceHash,
        answered.choiceResolution.source.sourceHash,
      );
      assert.match(answerRecord.sourceText, /Dispatchers/u);
      assert.deepEqual(answerRecord.tasks, [selectedTask.taskId]);
      const other = await db.selectNew("Other ongoing work");
      const imported = await importHistoryArchive(db, archive);
      assert.equal(imported.duplicate, false);
      assert.deepEqual(
        (await readImportedHistoryArchive(db, archive.archiveId)).memory,
        archive.memory,
      );
      assert.deepEqual(await db.selected(), other);
      const restricted = {
        ...access,
        allows: (record) =>
          record.source.path !== answered.choiceResolution.source.path,
      };
      const projection = await readArchiveMemory(restricted, "task", [
        {
          taskId: selectedTask.taskId,
          path: answered.source.path,
          sourceHash: answered.source.sourceHash,
        },
      ]);
      assert.deepEqual(
        projection.memory.records.map((r) => r.path),
        [answered.source.path],
      );
    },
  );
});

test("native summary validation stays actionable and a corrected checkpoint survives a fresh session", async (t) => {
  const { cwd } = await fixture(t),
    h = host(cwd, "native-validation");
  await h.event("session_start");
  const choice = receipt(
    await h.call("bookie_remember", {
      title: "Export choice",
      summary: "Export is optional and remains undecided.",
      openChoice: "Which export format should we offer?",
      choiceOptions: ["CSV", "JSON"],
    }),
    "saved",
  );
  const note = {
    title: "Repair Desk progress",
    summary: "PRIVATE_ARGUMENT " + "x".repeat(3133),
    nextAction: "Check the browser when available.",
  };
  let executionCount = 0;
  const nativeCall = async (args, id) => {
    let result;
    try {
      const validated = validateToolArguments(h.tool("bookie_remember"), {
        type: "toolCall",
        id,
        name: "bookie_remember",
        arguments: args,
      });
      executionCount++;
      result = await h.call("bookie_remember", validated, id);
    } catch (error) {
      result = {
        isError: true,
        content: [{ type: "text", text: error.message }],
        details: { private: "PRIVATE_DETAILS" },
      };
    }
    const message = {
      ...result,
      role: "toolResult",
      toolName: "bookie_remember",
      toolCallId: id,
      timestamp: 1,
    };
    return { result, message };
  };
  for (const length of [3150, 2632, 2245, 2001]) {
    const { result, message } = await nativeCall(
      { ...note, summary: note.summary.slice(0, length) },
      `rejected-${length}`,
    );
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Validation failed for tool/);
    assert.match(result.content[0].text, /Received arguments/);
    const filtered = await h.event("context", { messages: [message] });
    const visible = filtered.messages[0];
    assert.equal(visible.isError, true);
    assert.equal(visible.toolCallId, message.toolCallId);
    assert.equal(visible.toolName, message.toolName);
    assert.equal(visible.details, undefined);
    assert.match(visible.content[0].text, /summary.*2000/);
    assert.match(visible.content[0].text, /[Cc]orrect.*retry/);
    assert.doesNotMatch(
      JSON.stringify(filtered),
      /PRIVATE|reference-only|Received arguments/,
    );
  }
  assert.equal(executionCount, 0);
  assert.equal(
    json(await h.call("bookie_search", { query: note.title })).result.results
      .length,
    0,
  );
  const corrected = {
    ...note,
    summary: "UI delivered; browser checks remain unrun.",
  };
  const { result } = await nativeCall(corrected, "corrected");
  const saved = receipt(result, "saved");
  assert.equal(executionCount, 1);
  assert.equal(
    receipt(await h.call("bookie_remember", corrected), "already saved")
      .readBack.value,
    saved.readBack.value,
  );
  const body = json(await h.call("bookie_read", saved.readBack)).result
    .sourceText;
  assert.ok(body.includes(corrected.summary));
  assert.ok(body.includes(corrected.nextAction));
  await h.event("session_shutdown");
  const next = host(cwd, "native-validation-new");
  await next.event("session_start");
  assert.equal(
    json(await next.call("bookie_read", saved.readBack)).result.sourceText,
    body,
  );
  assert.equal(
    json(await next.call("bookie_search", { query: note.title })).result.results
      .length,
    1,
  );
  assert.ok(
    json(
      await next.call("bookie_read", choice.readBack),
    ).result.sourceText.includes("Which export format should we offer?"),
  );
  assert.deepEqual(
    next.dashboards
      .at(-1)
      .items.filter((item) => item.id.startsWith("open-choice-"))
      .map((item) => item.label),
    ["Which export format should we offer?"],
  );
});

test("invalid next actions and oversized summaries fail before saving and allow a corrected exact retry", async (t) => {
  const { cwd } = await fixture(t),
    h = host(cwd, "next-action-validation");
  await h.event("session_start");
  const note = {
    title: "Bounded progress",
    summary: "Ready for the authorized check.",
  };
  for (const nextAction of [
    "",
    " ",
    "x".repeat(241),
    "Review\n# Outcome\nInjected",
    "token=private0123456789012345",
  ]) {
    let failure;
    await assert.rejects(
      h.call("bookie_remember", { ...note, nextAction }),
      (error) => {
        failure = error.message;
        assert.match(failure, /nextAction/);
        return true;
      },
    );
    const filtered = await h.event("context", {
      messages: [
        {
          role: "toolResult",
          toolCallId: "rejected-own-input",
          toolName: "bookie_remember",
          isError: true,
          content: [{ type: "text", text: failure }],
        },
      ],
    });
    assert.equal(filtered.messages[0].content[0].text, failure);
  }
  await assert.rejects(
    h.call("bookie_remember", { ...note, summary: "x".repeat(2001) }),
    /summary.*2000/,
  );
  assert.equal(
    json(await h.call("bookie_search", { query: note.title })).result.results
      .length,
    0,
  );
  const corrected = { ...note, nextAction: "x".repeat(240) };
  const saved = receipt(await h.call("bookie_remember", corrected), "saved");
  assert.equal(
    receipt(await h.call("bookie_remember", corrected), "already saved")
      .readBack.value,
    saved.readBack.value,
  );
  assert.equal(
    json(await h.call("bookie_search", { query: note.title })).result.results
      .length,
    1,
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
  assert.match(result.systemPrompt, /nextAction/);
  assert.match(result.systemPrompt, /already-authorized/);
  assert.match(result.systemPrompt, /schema validation/);
  h.revoke();
  assert.equal(
    await h.event("before_agent_start", { systemPrompt: original }),
    undefined,
  );
});
