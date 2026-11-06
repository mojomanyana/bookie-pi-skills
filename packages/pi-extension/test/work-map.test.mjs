import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  computeConceptSourceHash,
  renderWorkMapBody,
  workTaskRevision,
  readRecallState,
  registerProducerReference,
} from "pi-bookie-core";
import registerBookie from "../dist/index.js";
import {
  authorizeDisclosure,
  labelFixture,
  modelContext,
} from "./disclosure-fixture.mjs";

const hash = (text) => computeConceptSourceHash(Buffer.from(text));
const taskId = "TSK-00000000000000000000000002",
  planId = "DOC-00000000000000000000000011";
test("trusted work selection connects exact task ownership while model reads cannot select or restore it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bookie-work-pi-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(
    resolve(import.meta.dirname, "../../../fixtures/valid-vault"),
    root,
    { recursive: true },
  );
  await labelFixture(root);
  const taskText = await readFile(
      root + "/projects/fixture/tasks/task.md",
      "utf8",
    ),
    projectText = await readFile(root + "/projects/fixture/project.md", "utf8");
  const meta = JSON.parse(taskText.slice(4, taskText.indexOf("\n---\n", 4)));
  async function doc(path, uid, body) {
    const fm = { ...meta, type: "Document", bookie: { ...meta.bookie, uid } };
    delete fm.bookie.state;
    const text = "---\n" + JSON.stringify(fm) + "\n---\n" + body;
    await writeFile(root + path, text);
    return { path, uid, sourceHash: hash(text) };
  }
  const plan = await doc(
    "/projects/fixture/plan.md",
    planId,
    "A synthetic plan.",
  );
  const map = {
    schemaVersion: 1,
    project: {
      uid: "PRJ-00000000000000000000000001",
      sourceHash: hash(projectText),
    },
    plans: [{ document: plan, taskIds: [taskId] }],
    tasks: [
      {
        concept: {
          path: "/projects/fixture/tasks/task.md",
          uid: taskId,
          sourceHash: hash(taskText),
        },
        dependsOn: [],
        inputs: [],
        requiredOutputs: [{ id: "draft", description: "Reviewed draft" }],
        resources: [{ owner: "test", reference: { kind: "display-probe" } }],
        outputRefs: [],
        judgments: [],
      },
    ],
    suggestions: [],
  };
  const mapRef = await doc(
    "/projects/fixture/work.md",
    "DOC-00000000000000000000000013",
    renderWorkMapBody(map),
  );
  const commands = new Map(),
    tools = new Map(),
    handlers = new Map(),
    events = new Map(),
    branch = [];
  const pi = {
    registerTool: (tool) => tools.set(tool.name, tool),
    registerCommand: (name, command) => commands.set(name, command),
    on: (name, fn) => handlers.set(name, [...(handlers.get(name) || []), fn]),
    appendEntry: (customType, data) =>
      branch.push({ type: "custom", customType, data }),
    events: {
      on: (name, fn) => {
        events.set(name, fn);
        return () => events.delete(name);
      },
      emit: (name, request) => events.get(name)?.(request),
    },
  };
  registerBookie(pi);
  let modelReturned = false,
    displayOwnerChecks = 0,
    mutateOnOwnerRead;
  events.set("bookie:work-reference:v1", async (request) => {
    const mutate = mutateOnOwnerRead;
    mutateOnOwnerRead = undefined;
    if (mutate) await mutate();
    request.reply({
      version: 1,
      requestId: request.requestId,
      sessionId: request.sessionId,
      cwd: request.cwd,
      result: {
        status: "current",
        reference: request.reference,
        assertCurrent: async () => {
          if (modelReturned) displayOwnerChecks++;
        },
      },
    });
  });
  events.set("pi-daddy:initiative:v1", (request) =>
    request.reply({
      version: 1,
      requestId: request.requestId,
      sessionId: request.sessionId,
      cwd: request.cwd,
      ok: false,
    }),
  );
  const ctx = modelContext({
    cwd: root,
    hasUI: false,
    isProjectTrusted: () => true,
    sessionManager: {
      getSessionId: () => "session-work",
      getBranch: () => branch,
    },
    ui: { notify() {} },
  });
  async function emit(name, value = {}) {
    for (const fn of handlers.get(name) || []) await fn(value, ctx);
  }
  await emit("session_start");
  await authorizeDisclosure(commands, root, ctx);
  assert.ok(tools.has("bookie_work"));
  const help = JSON.parse(
    (
      await tools
        .get("bookie_work")
        .execute("schema-help", { action: "schema" }, undefined, undefined, ctx)
    ).content[0].text,
  );
  assert.equal(help.purpose, "public-authoring-contract");
  assert.equal(help.exampleIsSynthetic, true);
  assert.ok(!JSON.stringify(help).includes(root));
  const call = () =>
    tools
      .get("bookie_work")
      .execute("work-call", {}, undefined, undefined, ctx);
  await assert.rejects(call, /selection/);
  let dashboardClosed = false,
    published;
  const publication = new Promise((resolve) => (published = resolve));
  events.set("pi-daddy:dashboard-source:v1", (request) => {
    assert.equal(request.producer, "bookie");
    assert.equal(request.sessionId, "session-work");
    request.reply({
      version: 1,
      ok: true,
      generation: 1,
      publish: (value) => {
        published(value);
        return true;
      },
      close: () => {
        dashboardClosed = true;
      },
    });
  });
  let admitted,
    disposed = false;
  events.set("pi-daddy:initiative:v1", async (request) => {
    const envelope = {
      version: 1,
      requestId: request.requestId,
      sessionId: request.sessionId,
      cwd: request.cwd,
      initiativeId: request.initiativeId,
    };
    if (request.action === "status")
      return request.reply({
        ...envelope,
        ok: true,
        revision: null,
        generation: null,
        state: "absent",
      });
    await request.assertSelection();
    admitted = request;
    disposed = false;
    request.reply({
      ...envelope,
      ok: true,
      generation: 1,
      revision: "state-one",
      handle: {
        observe: async (identity) => ({
          status: "observed",
          ...identity,
          ownerGeneration: 1,
          claim: "unclaimed",
          execution: "none",
          reconciliationRequired: false,
          assertCurrent: async () => {
            if (disposed) throw Error("changed");
          },
        }),
        release: async () => {
          disposed = true;
        },
        close: async () => {
          disposed = true;
        },
      },
    });
  });
  const trusted = {
    ...ctx,
    hasUI: true,
    ui: {
      notify() {},
      input: async () => mapRef.path,
      select: async (_, choices) => choices[0],
      confirm: async () => true,
    },
  };
  await commands.get("bookie-work").handler("", trusted);
  assert.equal(typeof admitted.assertObservationAuthority, "function");
  assert.equal(admitted.tasks.length, 1);
  assert.equal(admitted.tasks[0].effectScope, "unknown");
  const result = JSON.parse((await call()).content[0].text);
  assert.match(result.tasks[0].taskRevision, /^sha256:[a-f0-9]{64}$/);
  modelReturned = true;
  assert.equal(result.tasks[0].state, "ready");
  assert.equal(result.executionAuthority, false);
  const shown = await publication;
  assert.equal(
    displayOwnerChecks,
    0,
    "Optional dashboard must not replay owner observations after the guarded model return",
  );
  modelReturned = false;
  assert.ok(shown.items.length <= 8);
  assert.ok(shown.items.some((row) => row.kind === "review"));
  assert.ok(Buffer.byteLength(JSON.stringify(shown)) <= 4096);
  assert.ok(JSON.stringify(shown).includes("Registry publication: unknown"));
  assert.ok(JSON.stringify(shown).includes(taskId));
  assert.ok(JSON.stringify(shown).includes("Last observed:"));

  const recall = await readRecallState(root);
  const record = {
    producer: "test",
    producerInstance: "metadata-only",
    owner: { sessionId: "work", cwd: root },
    operationId: "metadata",
    executionId: "one",
    kind: "operation-result",
    reference: {
      locator: "fixture://result/one",
      sha256: "a".repeat(64),
      byteLength: 1,
    },
  };
  const registered = await registerProducerReference(
    root,
    {
      project: {
        path: "/projects/fixture/project.md",
        sourceHash: hash(projectText),
      },
      record,
      sensitivity: "public",
      expectedRevision: recall.revision,
    },
    {
      assertAuthority: async () => {},
      resolveReference: async () => ({
        sha256: record.reference.sha256,
        byteLength: 1,
      }),
    },
  );
  assert.equal(registered.ok, true);
  await admitted.assertObservationAuthority();
  await admitted.assertSelection();
  assert.equal(
    JSON.parse((await call()).content[0].text).tasks[0].taskRevision,
    result.tasks[0].taskRevision,
  );

  mutateOnOwnerRead = () =>
    writeFile(
      root + map.tasks[0].concept.path,
      taskText + "\nChanged during owner resolution.",
    );
  await assert.rejects(call, /stale|unavailable/);
  await writeFile(root + map.tasks[0].concept.path, taskText);
  await admitted.assertTaskReady(admitted.tasks[0]);
  await admitted.assertExecutionScope({
    ...admitted.tasks[0],
    cwd: root,
    workspaceId: null,
  });
  await assert.rejects(() =>
    admitted.assertExecutionScope({
      ...admitted.tasks[0],
      cwd: root + "/projects",
      workspaceId: null,
    }),
  );

  const cancelledMeta = JSON.parse(
    taskText.slice(4, taskText.indexOf("\n---\n", 4)),
  );
  cancelledMeta.bookie.state = "cancelled";
  const cancelled =
    "---\n" + JSON.stringify(cancelledMeta) + "\n---\nCancelled task.";
  await writeFile(root + map.tasks[0].concept.path, cancelled);
  map.tasks[0].concept.sourceHash = hash(cancelled);
  await doc(mapRef.path, mapRef.uid, renderWorkMapBody(map));
  await admitted.assertObservationAuthority(); // A read ticket is not proof that task intent is still current.
  await assert.rejects(admitted.assertSelection);
  await commands.get("bookie-work").handler("", trusted);
  assert.equal(dashboardClosed, true);
  assert.equal(
    JSON.parse((await call()).content[0].text).tasks[0].state,
    "blocked",
  );
  await assert.rejects(() => admitted.assertTaskReady(admitted.tasks[0]));

  await writeFile(
    root + mapRef.path,
    (await readFile(root + mapRef.path, "utf8")) + "\nChanged map",
  );
  await assert.rejects(call, /stale|unavailable/);
  await assert.rejects(admitted.assertSelection);
  await emit("session_start");
  await assert.rejects(admitted.assertObservationAuthority);
  await authorizeDisclosure(commands, root, ctx);
  await assert.rejects(call, /selection/);
  assert.ok(!JSON.stringify(branch).includes("Reviewed draft"));
});

async function workFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "bookie-work-boundary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(
    resolve(import.meta.dirname, "../../../fixtures/valid-vault"),
    root,
    { recursive: true },
  );
  await labelFixture(root);
  const taskText = await readFile(
      root + "/projects/fixture/tasks/task.md",
      "utf8",
    ),
    projectText = await readFile(root + "/projects/fixture/project.md", "utf8");
  const meta = JSON.parse(taskText.slice(4, taskText.indexOf("\n---\n", 4)));
  async function doc(path, uid, body, type = "Document") {
    const fm = { ...meta, type, bookie: { ...meta.bookie, uid } };
    delete fm.bookie.state;
    if (type === "Decision") {
      fm.bookie.state = "accepted";
      fm.status = "stable";
    }
    const text = "---\n" + JSON.stringify(fm) + "\n---\n" + body;
    await writeFile(root + path, text);
    return { path, uid, sourceHash: hash(text) };
  }
  const plan = await doc(
    "/projects/fixture/plan.md",
    planId,
    "Selected bounded plan.",
  );
  const map = {
    schemaVersion: 1,
    project: {
      uid: "PRJ-00000000000000000000000001",
      sourceHash: hash(projectText),
    },
    plans: [{ document: plan, taskIds: [taskId] }],
    tasks: [
      {
        concept: {
          path: "/projects/fixture/tasks/task.md",
          uid: taskId,
          sourceHash: hash(taskText),
        },
        dependsOn: [],
        inputs: [],
        requiredOutputs: [{ id: "draft", description: "Reviewed draft" }],
        resources: [],
        effectScope: "external",
        outputRefs: [],
        judgments: [],
      },
    ],
    suggestions: [],
  };
  const save = () =>
    doc(
      "/projects/fixture/work.md",
      "DOC-00000000000000000000000013",
      renderWorkMapBody(map),
    );
  const mapRef = await save();
  const commands = new Map(),
    tools = new Map(),
    handlers = new Map(),
    events = new Map(),
    branch = [];
  const pi = {
    registerTool: (tool) => tools.set(tool.name, tool),
    registerCommand: (name, command) => commands.set(name, command),
    on: (name, fn) => handlers.set(name, [...(handlers.get(name) || []), fn]),
    appendEntry: (customType, data) =>
      branch.push({ type: "custom", customType, data }),
    events: {
      on: (name, fn) => {
        events.set(name, fn);
        return () => events.delete(name);
      },
      emit: (name, request) => events.get(name)?.(request),
    },
  };
  registerBookie(pi);
  events.set("pi-daddy:initiative:v1", (request) =>
    request.reply({
      version: 1,
      requestId: request.requestId,
      sessionId: request.sessionId,
      cwd: request.cwd,
      ok: false,
    }),
  );
  const ctx = modelContext({
    cwd: root,
    hasUI: false,
    isProjectTrusted: () => true,
    sessionManager: {
      getSessionId: () => "work-boundary-session",
      getBranch: () => branch,
    },
    ui: { notify() {} },
  });
  const emit = async (name) => {
    for (const fn of handlers.get(name) || []) await fn({}, ctx);
  };
  await emit("session_start");
  await authorizeDisclosure(commands, root, ctx);
  let input = mapRef.path,
    confirm = () => true;
  const prompts = [];
  const trusted = {
    ...ctx,
    hasUI: true,
    ui: {
      notify() {},
      input: async (title, hint) => {
        prompts.push({ title, hint });
        return input;
      },
      select: async (_, choices) => choices[0],
      confirm: async (title, body) => confirm(title, body),
    },
  };
  const select = () => commands.get("bookie-work").handler("", trusted),
    command = (args) => commands.get("bookie-work").handler(args, trusted);
  const call = async () =>
    JSON.parse(
      (
        await tools
          .get("bookie_work")
          .execute("work-boundary", {}, undefined, undefined, ctx)
      ).content[0].text,
    );
  return {
    root,
    map,
    mapRef,
    save,
    doc,
    commands,
    events,
    branch,
    ctx,
    trusted,
    emit,
    select,
    command,
    call,
    prompts,
    setInput: (value) => (input = value),
    setConfirm: (value) => (confirm = value),
  };
}

test("receipt-only refresh cannot invent acceptance; human Decision confirmation is exact and is not restored", async (t) => {
  const f = await workFixture(t);
  await f.select();
  const output = await f.doc(
      "/projects/fixture/output.md",
      "DOC-00000000000000000000000015",
      "A scoped draft reviewed by the operator.",
    ),
    decision = await f.doc(
      "/projects/fixture/acceptance.md",
      "DSN-00000000000000000000000016",
      "Operator reviewed this exact draft and accepted it.",
      "Decision",
    );
  const reference = {
    owner: "bookie",
    reference: { kind: "concept", concept: output },
  };
  f.map.tasks[0].outputRefs = [{ outputId: "draft", reference }];
  f.map.tasks[0].judgments = [
    {
      owner: "bookie",
      reference: {
        kind: "human-decision",
        decision,
        taskId,
        taskRevision: workTaskRevision(f.map, taskId),
        outputId: "draft",
        outputReference: reference,
        reviewScope: "task",
      },
    },
  ];
  await f.save();
  assert.equal((await f.call()).tasks[0].outputs[0].status, "unverified");
  await f.command("accept");
  assert.equal((await f.call()).tasks[0].outputs[0].status, "accepted");
  assert.ok(!JSON.stringify(f.branch).includes("Operator reviewed"));
  const saved = f.branch.find(
    (entry) => entry.customType === "bookie-work-selection-v1",
  );
  assert.deepEqual(saved.data.taskIds, [taskId]);
  assert.equal(saved.data.map.uid, f.mapRef.uid);
  await f.emit("session_start");
  await authorizeDisclosure(f.commands, f.root, f.ctx);
  await assert.rejects(f.call, /selection/);
  await f.select();
  assert.equal(f.prompts.at(-1).hint, f.mapRef.path);
  assert.equal((await f.call()).tasks[0].outputs[0].status, "unverified");
  f.map.tasks[0].requiredOutputs[0].description = "Different intent";
  await f.save();
  await assert.rejects(f.call, /stale|unavailable/);
});

test("recovery-only reconciliation binds original attempt and exact canonical receipt without dispatch", async (t) => {
  const f = await workFixture(t);
  const originalTarget = {
    owner: "test",
    kind: "delivery",
    reference: JSON.stringify({ kind: "delivery", version: "1.0.0" }),
  };
  f.map.tasks[0].effectTarget = originalTarget;
  let callbacks,
    reconciled,
    closed = false,
    acquires = 0;
  const original = {
    initiativeId: "",
    taskId,
    taskRevision: workTaskRevision(f.map, taskId),
    owner: { sessionId: "old-owner", cwd: f.root },
    operationId: "original-operation",
    executionId: "original-execution",
    effectScope: "external",
    effectTarget: originalTarget,
  };
  f.events.set("pi-daddy:initiative:v1", async (request) => {
    const envelope = {
      version: 1,
      requestId: request.requestId,
      sessionId: request.sessionId,
      cwd: request.cwd,
      initiativeId: request.initiativeId,
    };
    original.initiativeId = request.initiativeId;
    if (request.action === "status")
      return request.reply({
        ...envelope,
        ok: true,
        revision: "retained-state",
        generation: 3,
        state: "owned",
      });
    if (request.action === "acquire") {
      acquires++;
      return request.reply({ ...envelope, ok: false });
    }
    assert.equal(request.action, "recover");
    await request.assertSelection();
    callbacks = request;
    request.reply({
      ...envelope,
      ok: true,
      generation: 3,
      revision: "retained-state",
      recoveryOnly: true,
      handle: {
        recoveryOnly: true,
        pendingEffects: async () => [{ ...original, execution: "settled" }],
        reconcileEffect: async (value) => {
          await request.assertEffectReconciled(value);
          reconciled = value;
          return {
            reconciled: value.receipt.observation?.outcome !== "unknown",
            taskAccepted: false,
            executionAuthorized: false,
          };
        },
        observe: async () => ({ status: "unavailable" }),
        release: async () => {},
        close: async () => {
          closed = true;
        },
      },
    });
  });
  const amendedGoal =
    (await readFile(f.root + "/projects/fixture/project.md", "utf8")) +
    "\nCorrected initiative intent.";
  await writeFile(f.root + "/projects/fixture/project.md", amendedGoal);
  f.map.project.sourceHash = hash(amendedGoal);
  f.map.tasks[0].effectTarget = {
    ...originalTarget,
    reference: JSON.stringify({ kind: "delivery", version: "2.0.0" }),
  };
  await f.save();
  await authorizeDisclosure(f.commands, f.root, f.ctx);
  assert.notEqual(workTaskRevision(f.map, taskId), original.taskRevision);
  f.setConfirm((title) => title !== "Connect Pi Daddy coordination?");
  await f.select();
  assert.equal(acquires, 0);
  const receipt = await f.doc(
    "/projects/fixture/receipt.md",
    "DOC-00000000000000000000000017",
    "Synthetic provider receipt: original action was cancelled and no external action remains pending.",
  );
  f.setInput(receipt.path);
  let outcome = "Unknown";
  f.trusted.ui.select = async (title, choices) => {
    if (title === "Observed outcome for this exact original target") {
      assert.deepEqual(choices, ["Applied", "Not applied", "Unknown"]);
      return outcome;
    }
    return choices[0];
  };
  await f.command("reconcile");
  assert.equal(reconciled.receipt.observation.outcome, "unknown");
  assert.equal(reconciled.receipt.observation.provenance, "operator-attested");
  assert.deepEqual(reconciled.receipt.observation.target, originalTarget);
  await assert.rejects(() =>
    callbacks.assertEffectReconciled({
      ...reconciled,
      receipt: {
        ...reconciled.receipt,
        observation: {
          ...reconciled.receipt.observation,
          provenance: "owner-verified",
        },
      },
    }),
  );
  outcome = "Not applied";
  await f.command("reconcile");
  assert.equal(reconciled.receipt.observation.outcome, "not-applied");
  assert.deepEqual(reconciled.receipt.observation.target, originalTarget);
  assert.notEqual(
    reconciled.receipt.observation.target.reference,
    f.map.tasks[0].effectTarget.reference,
  );
  assert.equal(reconciled.operationId, original.operationId);
  assert.equal(reconciled.taskRevision, original.taskRevision);
  assert.deepEqual(reconciled.owner, original.owner);
  assert.equal(reconciled.receipt.sha256, receipt.sourceHash.slice(7));
  assert.equal(acquires, 0);
  await assert.rejects(() =>
    callbacks.assertEffectReconciled({
      ...reconciled,
      executionId: "replacement-execution",
    }),
  );
  await writeFile(
    f.root + receipt.path,
    (await readFile(f.root + receipt.path, "utf8")) + "\nChanged receipt",
  );
  await assert.rejects(() => callbacks.assertEffectReconciled(reconciled));
  await f.emit("session_start");
  assert.equal(closed, true);
  await assert.rejects(() => callbacks.assertEffectReconciled(reconciled));
});
