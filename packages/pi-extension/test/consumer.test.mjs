import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  readRecallState,
  registerProducerReference,
  updateRecallControl,
} from "pi-bookie-core";
import registerBookie from "../dist/index.js";
import {
  authorizeDisclosure,
  labelFixture,
  modelContext,
} from "./disclosure-fixture.mjs";

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "bookie-consumer-")),
    vault = join(dir, "vault");
  await cp(
    resolve(import.meta.dirname, "../../../fixtures/valid-vault"),
    vault,
    { recursive: true },
  );
  await labelFixture(vault);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const commands = new Map(),
    tools = new Map(),
    handlers = new Map(),
    events = new Map(),
    branch = [];
  const pi = {
    registerTool: (tool) => tools.set(tool.name, tool),
    registerCommand: (n, c) => commands.set(n, c),
    on: (n, f) => handlers.set(n, [...(handlers.get(n) || []), f]),
    appendEntry: (customType, data) =>
      branch.push({ type: "custom", customType, data }),
    events: {
      on: (n, f) => {
        events.set(n, f);
        return () => events.delete(n);
      },
      emit: (n, r) => events.get(n)?.(r),
    },
  };
  registerBookie(pi);
  const ctx = modelContext({
    cwd: dir,
    hasUI: false,
    isProjectTrusted: () => true,
    sessionManager: {
      getSessionId: () => "session-one",
      getBranch: () => branch,
    },
    ui: { notify() {}, confirm: async () => true },
  });
  const emit = async (name, event = {}) => {
    let last;
    for (const f of handlers.get(name) || []) last = await f(event, ctx);
    return last;
  };
  await emit("session_start");
  await authorizeDisclosure(commands, vault, ctx);
  let sequence = 0;
  const call = async (name, args) => {
    assert.ok(tools.has(name), "Missing consumer " + name);
    return tools
      .get(name)
      .execute("call-" + ++sequence, args, undefined, undefined, ctx);
  };
  return { dir, vault, commands, tools, events, branch, ctx, emit, call };
}
const task = "/projects/fixture/tasks/task.md";
const parsed = (result) => JSON.parse(result.content[0].text);
async function register(f, operationId = "role:one") {
  const state = await readRecallState(f.vault);
  const project = await import("pi-bookie-core").then((c) =>
    c.inspectConcept(f.vault, { path: "/projects/fixture/project.md" }),
  );
  const record = {
    producer: "pi-daddy",
    producerInstance: "store-one",
    owner: { sessionId: "historical-owner", cwd: f.dir },
    operationId,
    executionId: "exec-one",
    kind: "operation-result",
    reference: {
      locator: "/private/result.json",
      sha256: "a".repeat(64),
      byteLength: 128,
    },
  };
  const result = await registerProducerReference(
    f.vault,
    {
      project: {
        path: project.source.path,
        sourceHash: project.source.sourceHash,
      },
      record,
      sensitivity: "public",
      expectedRevision: state.revision,
    },
    {
      assertAuthority: async () => {},
      resolveReference: async (r) => ({
        sha256: r.reference.sha256,
        byteLength: r.reference.byteLength,
      }),
    },
  );
  assert.equal(result.ok, true);
  return { result, record, project };
}
function bridge(f, text = "Synthetic retained result") {
  f.events.set("pi-daddy:operation-artifacts:v1", async (request) => {
    await request.authorize?.();
    request.reply({
      version: 1,
      requestId: request.requestId,
      sessionId: request.sessionId,
      cwd: request.cwd,
      ok: true,
      producerInstance: "store-one",
      manifest: {
        version: 1,
        producer: "pi-daddy",
        owner: request.reference.owner,
        operation: {
          operationId: request.reference.operationId,
          executionId: request.reference.executionId,
          state: "settled",
          runtime: { work: "failed" },
        },
      },
      final: { text },
    });
  });
}

test("no-shell context consumers retain references only and refuse stale or restored authority", async (t) => {
  const f = await fixture(t);
  const prepared = parsed(
    await f.call("bookie_context_prepare", {
      selectors: [{ path: task }],
      maxBytes: 2000,
    }),
  );
  assert.equal(prepared.status, "prepared");
  assert.ok(prepared.bundleId);
  assert.ok(!JSON.stringify(f.branch).includes("Fixture task body"));
  const read = parsed(
    await f.call("bookie_context_read", {
      bundleId: prepared.bundleId,
      maxBytes: 2000,
    }),
  );
  assert.equal(read.status, "resolved");
  assert.match(read.excerpt, /Fixture task/);
  assert.equal(read.untrusted, true);
  const checked = parsed(
    await f.call("bookie_context_read", {
      bundleId: prepared.bundleId,
      action: "revalidate",
    }),
  );
  assert.equal(checked.status, "resolved");
  assert.equal(checked.excerpt, "");
  await f.emit("session_start");
  await assert.rejects(
    f.call("bookie_context_read", { bundleId: prepared.bundleId }),
    /denied/,
  );
  await authorizeDisclosure(f.commands, f.vault, f.ctx);
  await assert.rejects(
    f.call("bookie_context_read", { bundleId: prepared.bundleId }),
    /stale/,
  );
  const rebuilt = parsed(
    await f.call("bookie_context_prepare", { fromBundleId: prepared.bundleId }),
  );
  assert.notEqual(rebuilt.bundleId, prepared.bundleId);
  await writeFile(
    join(f.vault, task),
    (await readFile(join(f.vault, task), "utf8")) + "\nAmended task\n",
  );
  await assert.rejects(
    f.call("bookie_context_read", { bundleId: rebuilt.bundleId }),
    /stale/,
  );
  const history = await f.emit("context", {
    messages: [
      {
        role: "toolResult",
        toolName: "bookie_context_read",
        toolCallId: "old",
        content: [{ type: "text", text: "OLD PRIVATE TEXT" }],
        details: { secret: "PRIVATE DETAILS" },
        isError: false,
        timestamp: 1,
      },
    ],
  });
  assert.ok(!JSON.stringify(history).includes("PRIVATE"));
  const restored = await f.emit("context", {
    messages: [
      {
        role: "toolResult",
        toolName: "bookie_context_prepare",
        toolCallId: "lost",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ...prepared,
              privateBody: "DO NOT RESTORE",
            }),
          },
        ],
        isError: false,
        timestamp: 1,
      },
    ],
  });
  assert.ok(JSON.stringify(restored).includes(prepared.bundleId));
  assert.ok(!JSON.stringify(restored).includes("DO NOT RESTORE"));
  assert.ok(!JSON.stringify(restored).includes(task));
});

test("producer metadata permission never grants body disclosure; explicit scoped permission reads bounded exact text", async (t) => {
  const f = await fixture(t);
  const { result } = await register(f);
  bridge(f, "😀".repeat(1000));
  await assert.rejects(
    f.call("bookie_reference_read", {
      registrationId: result.registrationId,
      part: "final",
    }),
    /denied/,
  );
  await f.commands.get("bookie-context").handler("producer", {
    ...f.ctx,
    hasUI: true,
    ui: {
      notify() {},
      confirm: async () => true,
      select: async (_, choices) => choices[0],
    },
  });
  const read = parsed(
    await f.call("bookie_reference_read", {
      registrationId: result.registrationId,
      part: "final",
      maxBytes: 20,
    }),
  );
  assert.equal(read.status, "resolved");
  assert.equal(read.truncated, true);
  assert.equal(read.complete, false);
  assert.equal(Buffer.byteLength(read.excerpt), 20);
  assert.ok(!read.excerpt.includes("�"));
  assert.equal(read.references[0].registrationId, result.registrationId);
  assert.equal(read.references[0].execution.work, "failed");
  assert.equal(read.references[0].approval, false);
  await assert.rejects(
    f.call("bookie_reference_read", {
      registrationId: result.registrationId,
      part: "partial",
    }),
    /incomplete/,
  );
  f.events.delete("pi-daddy:operation-artifacts:v1");
  await assert.rejects(
    f.call("bookie_reference_read", {
      registrationId: result.registrationId,
      part: "final",
    }),
    /unavailable/,
  );
  f.events.set("pi-daddy:operation-artifacts:v1", (request) =>
    request.reply({
      version: 1,
      requestId: "wrong-request",
      sessionId: request.sessionId,
      cwd: request.cwd,
      ok: false,
      code: "not-found",
      reason: "PRIVATE CAUSE",
    }),
  );
  await assert.rejects(
    f.call("bookie_reference_read", {
      registrationId: result.registrationId,
      part: "final",
    }),
    (error) =>
      error.status === "unavailable" &&
      error.causeUnknown === true &&
      !error.message.includes("PRIVATE"),
  );
  f.events.set("pi-daddy:operation-artifacts:v1", (request) =>
    request.reply({
      version: 1,
      requestId: request.requestId,
      sessionId: request.sessionId,
      cwd: request.cwd,
      ok: false,
      reason: "Unavailable",
      code: "not-found",
    }),
  );
  await assert.rejects(
    f.call("bookie_reference_read", {
      registrationId: result.registrationId,
      part: "final",
    }),
    /missing/,
  );
});

test("trusted resolver binds owner and exact authority through aggregate final checks", async (t) => {
  const f = await fixture(t);
  const { result, record, project } = await register(f);
  bridge(f);
  let allowed = true;
  let observed;
  const resolveRequest = (extra = {}) =>
    new Promise((resolve) =>
      f.events.get("bookie:resolve:v1")({
        version: 1,
        requestId: "test-request",
        sessionId: "session-one",
        cwd: f.dir,
        reference: {
          kind: "producer",
          registrationId: result.registrationId,
          part: "final",
        },
        authorizeBody: async (scope) => {
          observed = scope;
          if (!allowed) throw Error("private cause");
          return { sensitivity: "public" };
        },
        reply: resolve,
        ...extra,
      }),
    );
  const reply = await resolveRequest();
  assert.equal(reply.ok, true);
  assert.equal(reply.result.status, "resolved");
  assert.equal(observed.record.reference.sha256, record.reference.sha256);
  assert.equal(observed.part, "final");
  assert.equal(typeof reply.assertCurrent, "function");
  await reply.assertCurrent();
  allowed = false;
  await assert.rejects(reply.assertCurrent());
  allowed = true;
  const changed = await resolveRequest();
  bridge(f, "Amended retained result");
  await assert.rejects(changed.assertCurrent(), /stale/);
  bridge(f);
  const malformed = await resolveRequest({
    requestId: { private: "DO NOT REFLECT" },
    cwd: "x".repeat(5000),
  });
  assert.equal(malformed.ok, false);
  assert.ok(!JSON.stringify(malformed).includes("DO NOT REFLECT"));
  assert.ok(Buffer.byteLength(JSON.stringify(malformed)) < 1000);
  const wrong = await resolveRequest({ sessionId: "other" });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.status, "denied");
  allowed = true;
  const state = await readRecallState(f.vault);
  await updateRecallControl(
    f.vault,
    {
      project: {
        path: project.source.path,
        sourceHash: project.source.sourceHash,
      },
      expectedRevision: state.revision,
      control: {
        target: { kind: "producer", registrationId: result.registrationId },
        disposition: "suppressed",
      },
    },
    { assertAuthority: async () => {} },
  );
  const suppressed = await resolveRequest();
  assert.equal(suppressed.status, "suppressed");
  assert.ok(!JSON.stringify(suppressed).includes("Synthetic retained"));
});

test("context restoration withholds earlier outputs when a later aggregate check revokes authority", async () => {
  const { createBookieContextFilter } =
    await import("../dist/context-filter.js");
  const handlers = new Map();
  const filter = createBookieContextFilter({
    on: (name, fn) => handlers.set(name, fn),
  });
  const messages = ["one", "two"].map((id) => ({
    role: "toolResult",
    toolName: "bookie_context_read",
    toolCallId: id,
    content: [{ type: "text", text: "PROTECTED " + id }],
    details: { data: "PROTECTED DETAIL" },
    timestamp: 1,
    isError: false,
  }));
  let allowed = true;
  filter.remember("one", messages[0], async () => {
    if (!allowed) throw Error("revoked");
  });
  filter.remember("two", messages[1], async () => {
    allowed = false;
  });
  const changed = await handlers.get("context")({ messages });
  assert.ok(!JSON.stringify(changed).includes("PROTECTED"));
  allowed = true;
  filter.remember("one", messages[0], async () => {});
  filter.remember("two", messages[1], async () =>
    handlers.get("model_select")(),
  );
  const reset = await handlers.get("context")({ messages });
  assert.ok(!JSON.stringify(reset).includes("PROTECTED"));
});

test("single-result context revalidates once per request without retaining validity", async () => {
  const { createBookieContextFilter } =
    await import("../dist/context-filter.js");
  const handlers = new Map();
  const filter = createBookieContextFilter({
    on: (name, fn) => handlers.set(name, fn),
  });
  const message = {
    role: "toolResult",
    toolName: "bookie_work",
    toolCallId: "single",
    content: [{ type: "text", text: "PROTECTED CURRENT BODY" }],
    details: { text: "PROTECTED DETAIL" },
    timestamp: 1,
    isError: false,
  };
  const ordinary = { role: "user", content: "Unrelated message", timestamp: 2 };
  let allowed = true;
  let calls = 0;
  filter.remember("single", message, async () => {
    calls++;
    await Promise.resolve();
    if (!allowed) throw Error("revoked");
  });
  for (let request = 1; request <= 2; request++) {
    const result = await handlers.get("context")({
      messages: [message, ordinary],
    });
    assert.deepEqual(result.messages[0].content, message.content);
    assert.equal("details" in result.messages[0], false);
    assert.equal(result.messages[1], ordinary);
    assert.equal(calls, request, "exactly one fresh validation per request");
  }
  allowed = false;
  const refused = await handlers.get("context")({ messages: [message] });
  assert.equal(calls, 3, "later requests must revalidate authority");
  assert.ok(!JSON.stringify(refused).includes("PROTECTED"));
});

test("single-result context withholds rejection and lifecycle reset during validation", async (t) => {
  const { createBookieContextFilter } =
    await import("../dist/context-filter.js");
  for (const action of [
    "reject",
    "session_start",
    "session_shutdown",
    "session_tree",
    "model_select",
  ]) {
    await t.test(action, async () => {
      const handlers = new Map();
      const filter = createBookieContextFilter({
        on: (name, fn) => handlers.set(name, fn),
      });
      const message = {
        role: "toolResult",
        toolName: "bookie_context_read",
        toolCallId: "pending",
        content: [{ type: "text", text: "PROTECTED BODY" }],
        details: { text: "PROTECTED DETAIL" },
        timestamp: 1,
        isError: false,
      };
      const entered = Promise.withResolvers();
      const release = Promise.withResolvers();
      let allowed = true;
      let calls = 0;
      filter.remember("pending", message, async () => {
        calls++;
        entered.resolve();
        await release.promise;
        if (!allowed) throw Error("PROTECTED PRIVATE CAUSE");
      });
      const pending = handlers.get("context")({ messages: [message] });
      await entered.promise;
      if (action === "reject") allowed = false;
      else handlers.get(action)();
      release.resolve();
      const refused = await pending;
      assert.equal(calls, 1);
      assert.ok(!JSON.stringify(refused).includes("PROTECTED"));
      assert.equal("details" in refused.messages[0], false);
    });
  }
});

test("a later failed context validator withholds the earlier sole successful result", async () => {
  const { createBookieContextFilter } =
    await import("../dist/context-filter.js");
  const handlers = new Map();
  const filter = createBookieContextFilter({
    on: (name, fn) => handlers.set(name, fn),
  });
  const messages = ["valid", "rejected"].map((id) => ({
    role: "toolResult",
    toolName: "bookie_context_read",
    toolCallId: id,
    content: [{ type: "text", text: "PROTECTED " + id }],
    details: { text: "PROTECTED DETAIL" },
    timestamp: 1,
    isError: false,
  }));
  const calls = [];
  filter.remember("valid", messages[0], async () => calls.push("valid"));
  filter.remember("rejected", messages[1], async () => {
    calls.push("rejected");
    await Promise.resolve();
    throw Error("PROTECTED PRIVATE CAUSE");
  });
  const result = await handlers.get("context")({ messages });
  assert.deepEqual(calls, ["valid", "rejected"]);
  assert.ok(!JSON.stringify(result).includes("PROTECTED"));
});

test("a rejected historical ticket cannot poison a later fresh authorized read", async () => {
  const { createBookieContextFilter } =
    await import("../dist/context-filter.js");
  const handlers = new Map();
  const filter = createBookieContextFilter({
    on: (name, fn) => handlers.set(name, fn),
  });
  const message = (id, text) => ({
    role: "toolResult",
    toolName: "bookie_context_read",
    toolCallId: id,
    content: [{ type: "text", text }],
    details: { private: "DETAIL" },
    timestamp: 1,
    isError: false,
  });
  const old = message("old", "OLD BODY"),
    first = message("fresh-one", "FRESH ONE");
  filter.remember("old", old, async () => {
    throw Error("private old-source cause");
  });
  filter.remember("fresh-one", first, async () => {});
  const refused = await handlers.get("context")({ messages: [old, first] });
  assert.ok(!JSON.stringify(refused).includes("OLD BODY"));
  assert.ok(!JSON.stringify(refused).includes("FRESH ONE"));
  const second = message("fresh-two", "FRESH TWO");
  filter.remember("fresh-two", second, async () => {});
  const recovered = await handlers.get("context")({
    messages: [old, first, second],
  });
  assert.ok(!JSON.stringify(recovered).includes("OLD BODY"));
  assert.ok(!JSON.stringify(recovered).includes("private old-source cause"));
  assert.deepEqual(recovered.messages[2].content, second.content);
  assert.equal("details" in recovered.messages[2], false);
});

test("canonical read search validation and context survive producer metadata without producer body access", async (t) => {
  const f = await fixture(t);
  let producerReads = 0;
  f.events.set("pi-daddy:operation-artifacts:v1", () => {
    producerReads++;
    throw Error("PRODUCER BODY MUST STAY PRIVATE");
  });
  const messages = [];
  for (const [name, args] of [
    ["bookie_read", { vault: f.vault, selector: "path", value: task }],
    ["bookie_search", { vault: f.vault, query: "Fixture" }],
    ["bookie_validate", { vault: f.vault }],
  ]) {
    const value = await f.tools
      .get(name)
      .execute(name, args, undefined, undefined, f.ctx);
    messages.push({
      role: "toolResult",
      toolName: name,
      toolCallId: name,
      ...value,
      timestamp: 1,
      isError: false,
    });
  }
  const prepared = parsed(
    await f.call("bookie_context_prepare", {
      selectors: [{ path: task }],
      maxBytes: 2000,
    }),
  );
  const { result } = await register(f);
  const history = await f.emit("context", { messages });
  for (let i = 0; i < messages.length; i++)
    assert.deepEqual(history.messages[i].content, messages[i].content);
  const read = parsed(
    await f.call("bookie_context_read", {
      bundleId: prepared.bundleId,
      action: "read",
    }),
  );
  assert.equal(read.status, "resolved");
  assert.match(read.excerpt, /Fixture task/);
  await assert.rejects(
    f.call("bookie_read", {
      vault: f.vault,
      selector: "path",
      value: "/private/result.json",
    }),
  );
  await assert.rejects(
    f.call("bookie_context_prepare", {
      selectors: [{ path: "/private/result.json" }],
    }),
  );
  await assert.rejects(
    f.call("bookie_reference_read", {
      registrationId: result.registrationId,
      part: "final",
    }),
    /denied/,
  );
  assert.equal(producerReads, 0);
  assert.doesNotMatch(
    JSON.stringify({ history, read }),
    /PRODUCER BODY MUST STAY PRIVATE/,
  );
  await f.commands
    .get("bookie-context")
    .handler("off", { ...f.ctx, hasUI: true });
  await authorizeDisclosure(f.commands, f.vault, f.ctx);
  await assert.rejects(
    f.call("bookie_context_read", {
      bundleId: prepared.bundleId,
      action: "read",
    }),
    /stale/,
  );
  const revoked = await f.emit("context", { messages });
  assert.doesNotMatch(JSON.stringify(revoked), /Fixture task/);
});

test("aggregate rejection retires only the failed history entry for the next request", async () => {
  const { createBookieContextFilter } =
    await import("../dist/context-filter.js");
  const handlers = new Map(),
    filter = createBookieContextFilter({ on: (n, f) => handlers.set(n, f) });
  const message = (id) => ({
    role: "toolResult",
    toolName: "bookie_context_read",
    toolCallId: id,
    content: [{ type: "text", text: "BODY " + id }],
    timestamp: 1,
    isError: false,
  });
  const old = message("old"),
    fresh = message("fresh");
  let calls = 0;
  filter.remember("old", old, async () => {
    if (++calls > 1) throw Error("private cause");
  });
  filter.remember("fresh", fresh, async () => {});
  const first = await handlers.get("context")({ messages: [old, fresh] });
  assert.doesNotMatch(JSON.stringify(first), /BODY/);
  const next = await handlers.get("context")({ messages: [old, fresh] });
  assert.doesNotMatch(JSON.stringify(next.messages[0]), /BODY old/);
  assert.deepEqual(next.messages[1].content, fresh.content);
});

test("failed history retirement preserves a replacement remembered during validation", async (t) => {
  const { createBookieContextFilter } =
    await import("../dist/context-filter.js");
  for (const phase of ["initial", "aggregate"]) {
    await t.test(phase, async () => {
      const handlers = new Map(),
        filter = createBookieContextFilter({
          on: (n, f) => handlers.set(n, f),
        });
      const message = (id, text) => ({
        role: "toolResult",
        toolName: "bookie_context_read",
        toolCallId: id,
        content: [{ type: "text", text }],
        timestamp: 1,
        isError: false,
      });
      const old = message("same", "OLD BODY"),
        replacement = message("same", "NEW BODY"),
        other = message("other", "OTHER BODY");
      const entered = Promise.withResolvers(),
        release = Promise.withResolvers();
      let calls = 0;
      filter.remember("same", old, async () => {
        if (++calls === (phase === "initial" ? 1 : 2)) {
          entered.resolve();
          await release.promise;
          throw Error("private cause");
        }
      });
      filter.remember("other", other, async () => {});
      const pending = handlers.get("context")({
        messages: phase === "initial" ? [old] : [old, other],
      });
      await entered.promise;
      filter.remember("same", replacement, async () => {});
      release.resolve();
      assert.doesNotMatch(JSON.stringify(await pending), /BODY/);
      const next = await handlers.get("context")({
        messages: [old, replacement],
      });
      assert.doesNotMatch(JSON.stringify(next.messages[0]), /OLD BODY/);
      assert.deepEqual(next.messages[1].content, replacement.content);
    });
  }
});

test("producer bodies retain registry currentness during the owner read", async (t) => {
  const f = await fixture(t);
  const { result } = await register(f);
  bridge(f, "PRIVATE PRODUCER BODY");
  await f.commands.get("bookie-context").handler("producer", {
    ...f.ctx,
    hasUI: true,
    ui: {
      notify() {},
      confirm: async () => true,
      select: async (_, choices) => choices[0],
    },
  });
  const owner = f.events.get("pi-daddy:operation-artifacts:v1");
  f.events.set("pi-daddy:operation-artifacts:v1", async (request) => {
    await request.authorize();
    await register(f, "role:two");
    // The owner completes its already-authorized read after registration changes;
    // the consumer must independently reject the returned body on its final check.
    await owner({ ...request, authorize: undefined });
  });
  await assert.rejects(
    f.call("bookie_reference_read", {
      registrationId: result.registrationId,
      part: "final",
    }),
    (error) => {
      assert.doesNotMatch(error.message, /PRIVATE PRODUCER BODY/);
      assert.match(error.message, /denied|unavailable|withheld/);
      return true;
    },
  );
});

async function commitExportFixture(f) {
  // The existing consumer fixture labels only project records; the whole-vault
  // exporter also correctly requires the unselected Person's classification.
  const personPath = join(f.vault, "people/owner.md");
  const source = await readFile(personPath, "utf8"),
    end = source.indexOf("\n---\n", 4);
  const fm = JSON.parse(source.slice(4, end));
  fm.bookie.sensitivity = "public";
  await writeFile(personPath, "---\n" + JSON.stringify(fm) + source.slice(end));
  const git = (args) => {
    const result = spawnSync(
      "git",
      [
        "-c",
        "user.name=Bookie Export Tests",
        "-c",
        "user.email=bookie@example.invalid",
        "-c",
        "commit.gpgSign=false",
        "-C",
        f.vault,
        ...args,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(["init", "-q"]);
  git(["add", "-A"]);
  git(["commit", "-qm", "synthetic export source"]);
  return git(["rev-parse", "HEAD"]);
}

test("bounded Pi export returns real selected JSONL and rechecks disclosure on replay", async (t) => {
  const f = await fixture(t),
    commit = await commitExportFixture(f);
  const args = { selectors: [{ path: task }], commit };
  const result = await f.call("bookie_export", args),
    value = parsed(result);
  assert.equal(value.status, "exported");
  assert.equal(value.scope, "selected-records");
  assert.equal(value.complete, true);
  assert.equal(value.recordCount, 1);
  assert.equal(JSON.parse(value.jsonl.trim()).path, task);
  assert.equal(JSON.parse(value.jsonl.trim()).source_commit, commit);
  assert.equal(value.untrusted, true);
  assert.equal("sourceManifest" in value, false);
  const message = {
    role: "toolResult",
    toolName: "bookie_export",
    toolCallId: "call-1",
    content: result.content,
  };
  assert.match(
    JSON.stringify(await f.emit("context", { messages: [message] })),
    /Completed alongside/,
  );
  await register(f);
  assert.match(
    JSON.stringify(await f.emit("context", { messages: [message] })),
    /Completed alongside/,
    "metadata-only registration leaves canonical export usable",
  );
  await writeFile(
    join(f.vault, task),
    (await readFile(join(f.vault, task), "utf8")) +
      "\nCurrent body amendment\n",
  );
  assert.match(
    JSON.stringify(await f.emit("context", { messages: [message] })),
    /Completed alongside/,
    "permitted old committed body survives current body edits",
  );
  await f.commands
    .get("bookie-context")
    .handler("off", { ...f.ctx, hasUI: true });
  const replay = await f.emit("context", { messages: [message] });
  assert.doesNotMatch(JSON.stringify(replay), /Completed alongside/);
  await assert.rejects(f.call("bookie_export", args), /denied/);
});

test("bounded Pi export hides unselected preflight diagnostics and refuses replay after reclassification", async (t) => {
  const f = await fixture(t),
    commit = await commitExportFixture(f);
  const result = await f.call("bookie_export", {
    selectors: [{ path: task }],
    commit,
  });
  const message = {
    role: "toolResult",
    toolName: "bookie_export",
    toolCallId: "call-1",
    content: result.content,
  };
  const path = join(f.vault, task),
    original = await readFile(path, "utf8");
  await writeFile(
    path,
    original.replace('"sensitivity":"public"', '"sensitivity":"internal"'),
  );
  assert.doesNotMatch(
    JSON.stringify(await f.emit("context", { messages: [message] })),
    /Completed alongside/,
  );
  await writeFile(path, original);
  const hiddenPath = join(f.vault, "projects/fixture/research/Δ-findings.md");
  await writeFile(
    hiddenPath,
    "---\n" +
      JSON.stringify({ title: "PRIVATE UNSELECTED DIAGNOSTIC" }) +
      "\n---\nHidden bad record\n",
  );
  const invalidCommit = await commitExportFixture(f);
  await assert.rejects(
    f.call("bookie_export", {
      selectors: [{ path: task }],
      commit: invalidCommit,
    }),
    (error) => {
      assert.equal(error.message, "Bookie consumer failed: unavailable.");
      assert.doesNotMatch(
        JSON.stringify(error),
        /PRIVATE|Hidden|findings|sourceManifest|recordCount|outputHash/,
      );
      return true;
    },
  );
});
