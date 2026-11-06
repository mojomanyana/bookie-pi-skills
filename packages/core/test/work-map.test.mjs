import { test } from "node:test";
import assert from "node:assert/strict";
import * as core from "../dist/index.js";
import { cp, mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const hash = (value) => core.computeConceptSourceHash(Buffer.from(value));
const ref = (path, uid, content = path) => ({
  path,
  uid,
  sourceHash: hash(content),
});
const taskUid = "TSK-00000000000000000000000002";
const projectUid = "PRJ-00000000000000000000000001";
const planUid = "DOC-00000000000000000000000011";
function sample() {
  return {
    schemaVersion: 1,
    project: { uid: projectUid, sourceHash: hash("project") },
    plans: [
      {
        document: ref("/projects/fixture/plan.md", planUid),
        taskIds: [taskUid],
      },
    ],
    tasks: [
      {
        concept: ref("/projects/fixture/tasks/task.md", taskUid),
        dependsOn: [],
        inputs: [],
        requiredOutputs: [{ id: "draft", description: "Reviewed draft" }],
        resources: [],
        outputRefs: [],
        judgments: [],
      },
    ],
    suggestions: [],
  };
}

test("bounded work maps share one task across plans and reject cycles or invented acceptance fields", () => {
  assert.equal(typeof core.validateWorkMap, "function");
  const help = core.describeWorkMap();
  assert.equal(core.validateWorkMap(help.example).ok, true);
  assert.equal(help.exampleIsSynthetic, true);
  assert.ok(Buffer.byteLength(JSON.stringify(help)) < 8000);
  const value = sample();
  value.plans.push({
    document: ref(
      "/projects/fixture/other-plan.md",
      "DOC-00000000000000000000000012",
    ),
    taskIds: [taskUid],
  });
  assert.equal(core.validateWorkMap(value).ok, true);
  assert.deepEqual(core.parseWorkMapBody(core.renderWorkMapBody(value)), value);
  assert.equal(
    core.parseWorkMapBody(
      core
        .renderWorkMapBody(value)
        .replace(/schemaVersion":\s*1/, 'schemaVersion":2'),
    ),
    undefined,
  );
  assert.equal(core.validateWorkMap({ ...value, approved: true }).ok, false);
  value.tasks[0].dependsOn.push(taskUid);
  assert.equal(core.validateWorkMap(value).ok, false);
  value.tasks[0].dependsOn = ["TSK-00000000000000000000000099"];
  assert.equal(core.validateWorkMap(value).ok, false);
});

test("task revision excludes receipt attachments and unrelated plans but binds exact applicable inputs", () => {
  assert.equal(typeof core.workTaskRevision, "function");
  const value = sample(),
    first = core.workTaskRevision(value, taskUid);
  value.tasks[0].outputRefs.push({
    outputId: "draft",
    reference: { owner: "test", reference: { id: "output-1" } },
  });
  value.tasks[0].judgments.push({
    owner: "test",
    reference: { id: "review-1" },
  });
  value.plans[0].document.sourceHash = hash("plan amendment");
  assert.equal(core.workTaskRevision(value, taskUid), first);
  value.tasks[0].inputs.push(
    ref("/projects/fixture/decision.md", "DSN-00000000000000000000000003"),
  );
  assert.notEqual(core.workTaskRevision(value, taskUid), first);
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "bookie-work-map-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(new URL("../../../fixtures/valid-vault/", import.meta.url), root, {
    recursive: true,
  });
  const { readdir } = await import("node:fs/promises");
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (path.endsWith(".md") && entry.name !== "index.md") {
        const text = await readFile(path, "utf8");
        const end = text.indexOf("\n---\n", 4);
        const meta = JSON.parse(text.slice(4, end));
        meta.bookie.sensitivity = "public";
        await writeFile(
          path,
          "---\n" + JSON.stringify(meta) + "\n---\n" + text.slice(end + 5),
        );
      }
    }
  }
  await walk(root);
  const manifest = parseYaml(await readFile(join(root, "bookie.yaml"), "utf8"));
  manifest.policy.sensitivity = {
    classes: ["public", "internal", "restricted"],
    excluded_classes: ["restricted"],
  };
  await writeFile(join(root, "bookie.yaml"), JSON.stringify(manifest));
  const projectPath = "/projects/fixture/project.md";
  const projectText = await readFile(root + projectPath, "utf8");
  const taskText = await readFile(
    root + "/projects/fixture/tasks/task.md",
    "utf8",
  );
  const taskMeta = JSON.parse(
    taskText.slice(4, taskText.indexOf("\n---\n", 4)),
  );
  const doc = async (path, uid, body) => {
    const meta = {
      ...taskMeta,
      type: "Document",
      title: "Work plan",
      bookie: { ...taskMeta.bookie, uid },
    };
    delete meta.bookie.state;
    const text = "---\n" + JSON.stringify(meta) + "\n---\n" + body;
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(root + path, text);
    return ref(path, uid, text);
  };
  const plan = await doc(
    "/projects/fixture/plan.md",
    planUid,
    "Synthetic reviewed plan.",
  );
  const value = sample();
  value.project.sourceHash = hash(projectText);
  value.tasks[0].concept.sourceHash = hash(taskText);
  value.plans[0].document = plan;
  const map = await doc(
    "/projects/fixture/work.md",
    "DOC-00000000000000000000000013",
    core.renderWorkMapBody(value),
  );
  const project = { path: projectPath, sourceHash: hash(projectText) };
  assert.equal(
    (
      await core.initializeRecallState(root, {
        assertAuthority: async () => {},
      })
    ).ok,
    true,
  );
  const binding = {
    policyRevision: "test-human-selection",
    destination: { provider: "test", model: "test", endpoint: "local" },
  };
  return { root, value, project, map, plan, binding, doc };
}

test("current output alone is not acceptance; exact trusted review and runtime remain separate", async (t) => {
  const f = await fixture(t);
  const output = { owner: "test", reference: { id: "output" } };
  const judgment = { owner: "test", reference: { id: "judgment" } };
  f.value.tasks[0].outputRefs.push({ outputId: "draft", reference: output });
  f.value.tasks[0].judgments.push(judgment);
  f.map = await f.doc(f.map.path, f.map.uid, core.renderWorkMapBody(f.value));
  const request = { project: f.project, map: f.map, planId: planUid };
  let accepted = false,
    revoked = false;
  const options = {
    binding: f.binding,
    resolveReference: async (reference, purpose) => ({
      status: "current",
      reference,
      ...(purpose.purpose === "judgment" && accepted
        ? {
            judgment: {
              subjectRevision: purpose.taskRevision,
              outputId: "draft",
              outputReference: output,
              verdict: "accepted",
              reviewScope: "task",
            },
          }
        : {}),
      assertCurrent: async () => {
        if (revoked) throw Error("revoked");
      },
    }),
  };
  const first = await core.projectWorkMap(f.root, request, options);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.projection.tasks[0].state, "awaiting-acceptance");
  assert.equal(first.projection.tasks[0].runtime.status, "unavailable");
  accepted = true;
  const second = await core.projectWorkMap(f.root, request, options);
  assert.equal(second.ok, true);
  assert.equal(second.projection.tasks[0].outputs[0].status, "accepted");
  assert.equal(second.projection.tasks[0].state, "unavailable");
  assert.equal(second.projection.executionAuthority, false);
  revoked = true;
  await assert.rejects(second.assertCurrent);
  const suppressed = await core.readRecallState(f.root);
  const suppression = await core.updateRecallControl(
    f.root,
    {
      project: { ...f.project, uid: projectUid },
      expectedRevision: suppressed.revision,
      control: {
        target: { kind: "concept", uid: taskUid },
        disposition: "suppressed",
      },
    },
    { assertAuthority: async () => {} },
  );
  assert.equal(suppression.ok, true);
  assert.equal((await core.projectWorkMap(f.root, request, options)).ok, false);
});

test("trusted runtime is identity bound; a later callback revocation withholds the projection", async (t) => {
  const f = await fixture(t);
  f.value.tasks[0].resources.push({
    owner: "test",
    reference: { id: "workspace" },
  });
  f.map = await f.doc(f.map.path, f.map.uid, core.renderWorkMapBody(f.value));
  let revoked = false;
  const request = { project: f.project, map: f.map, planId: planUid };
  const options = {
    binding: f.binding,
    resolveReference: async (reference) => ({
      status: "current",
      reference,
      assertCurrent: async () => {
        if (revoked) throw Error("stale");
      },
    }),
    observeRuntime: async (identity) => ({
      status: "observed",
      ...identity,
      ownerGeneration: 1,
      ignoredProducerText: "must-not-appear",
      claim: "unclaimed",
      execution: "none",
      reconciliationRequired: false,
      assertCurrent: async () => {},
    }),
  };
  const ready = await core.projectWorkMap(f.root, request, options);
  assert.equal(ready.ok, true, JSON.stringify(ready));
  assert.equal(ready.projection.tasks[0].state, "ready");
  assert.ok(!JSON.stringify(ready.projection).includes("must-not-appear"));
  options.observeRuntime = async (identity) => {
    revoked = true;
    return {
      status: "observed",
      ...identity,
      ownerGeneration: 1,
      ignoredProducerText: "must-not-appear",
      claim: "unclaimed",
      execution: "none",
      reconciliationRequired: false,
      assertCurrent: async () => {},
    };
  };
  assert.equal((await core.projectWorkMap(f.root, request, options)).ok, false);
});

test("prerequisite evidence gates continuation and handled suggestions reopen only on their exact trigger change", async (t) => {
  const f = await fixture(t),
    secondId = "TSK-00000000000000000000000022";
  const firstText = await readFile(
    f.root + "/projects/fixture/tasks/task.md",
    "utf8",
  );
  const meta = JSON.parse(firstText.slice(4, firstText.indexOf("\n---\n", 4)));
  meta.bookie.uid = secondId;
  meta.bookie.state = "done";
  const secondPath = "/projects/fixture/tasks/second.md",
    secondText = "---\n" + JSON.stringify(meta) + "\n---\nSecond task.";
  await writeFile(f.root + secondPath, secondText);
  const second = {
    ...structuredClone(f.value.tasks[0]),
    concept: ref(secondPath, secondId, secondText),
    dependsOn: [taskUid],
  };
  f.value.tasks.push(second);
  f.value.plans[0].taskIds.push(secondId);
  f.value.suggestions = [
    {
      id: "reconsider-second",
      taskId: secondId,
      text: "Reconsider the second output after its brief changes.",
      trigger: second.concept,
      disposition: "dismissed",
      handledTriggerHash: second.concept.sourceHash,
    },
  ];
  const initialRevision = core.workTaskRevision(f.value, secondId);
  f.map = await f.doc(f.map.path, f.map.uid, core.renderWorkMapBody(f.value));
  const options = {
    binding: f.binding,
    observeRuntime: async (identity) => ({
      status: "observed",
      ...identity,
      ownerGeneration: 1,
      ignoredProducerText: "must-not-appear",
      claim: "unclaimed",
      execution: "none",
      reconciliationRequired: false,
      assertCurrent: async () => {},
    }),
  };
  const request = () => ({ project: f.project, map: f.map, planId: planUid });
  const blocked = await core.projectWorkMap(f.root, request(), options);
  assert.equal(blocked.ok, true, JSON.stringify(blocked));
  assert.equal(blocked.projection.tasks[1].state, "blocked");
  assert.equal(blocked.projection.tasks[1].lifecycle, "done");
  assert.equal(blocked.projection.suggestions.length, 0);
  const output = { owner: "test", reference: { id: "prerequisite" } };
  f.value.tasks[0].outputRefs = [{ outputId: "draft", reference: output }];
  f.value.tasks[0].judgments = [{ owner: "test", reference: { id: "review" } }];
  f.map = await f.doc(f.map.path, f.map.uid, core.renderWorkMapBody(f.value));
  options.resolveReference = async (reference, purpose) => ({
    status: "current",
    reference,
    ...(purpose.purpose === "judgment"
      ? {
          judgment: {
            subjectRevision: purpose.taskRevision,
            outputId: "draft",
            outputReference: output,
            verdict: "accepted",
            reviewScope: "task",
          },
        }
      : {}),
    assertCurrent: async () => {},
  });
  const ready = await core.projectWorkMap(f.root, request(), options);
  assert.equal(ready.ok, true, JSON.stringify(ready));
  assert.equal(ready.projection.tasks[1].state, "blocked");
  assert.ok(
    ready.projection.tasks[1].reasons.includes("task-lifecycle-not-ready"),
  );
  assert.equal(core.workTaskRevision(f.value, secondId), initialRevision);
  const changedText = secondText + "\nUpdated requested output.";
  await writeFile(f.root + secondPath, changedText);
  second.concept.sourceHash = hash(changedText);
  f.value.suggestions[0].trigger = structuredClone(second.concept);
  f.map = await f.doc(f.map.path, f.map.uid, core.renderWorkMapBody(f.value));
  const changed = await core.projectWorkMap(f.root, request(), options);
  assert.equal(changed.ok, true, JSON.stringify(changed));
  assert.equal(changed.projection.suggestions[0].reconsider, true);
  assert.notEqual(core.workTaskRevision(f.value, secondId), initialRevision);
  const thirdId = "TSK-00000000000000000000000023";
  for (const [id, name, dependencies] of [
    [thirdId, "third", [secondId]],
    ["TSK-00000000000000000000000024", "unrelated", []],
  ]) {
    const path = `/projects/fixture/tasks/${name}.md`;
    const text =
      "---\n" +
      JSON.stringify({
        ...meta,
        bookie: { ...meta.bookie, uid: id, state: "ready" },
      }) +
      "\n---\n" +
      name;
    await writeFile(f.root + path, text);
    f.value.tasks.push({
      ...structuredClone(f.value.tasks[0]),
      concept: ref(path, id, text),
      dependsOn: dependencies,
      outputRefs: [],
      judgments: [],
    });
    f.value.plans[0].taskIds.push(id);
  }
  f.map = await f.doc(f.map.path, f.map.uid, core.renderWorkMapBody(f.value));
  const selective = await core.projectWorkMap(
    f.root,
    { ...request(), taskIds: [thirdId] },
    options,
  );
  assert.equal(selective.ok, true);
  assert.deepEqual(
    selective.projection.tasks.map((task) => task.taskId),
    [taskUid, secondId, thirdId],
    "Target-only admission retains every transitive prerequisite and omits unrelated selected tasks",
  );
  f.value.plans[0].taskIds = [thirdId];
  f.map = await f.doc(f.map.path, f.map.uid, core.renderWorkMapBody(f.value));
  const prerequisite = await core.projectWorkMap(
    f.root,
    { ...request(), taskIds: [secondId] },
    options,
  );
  assert.equal(
    prerequisite.ok,
    true,
    "A selected plan's transitive prerequisite can be checked independently",
  );
  assert.deepEqual(
    prerequisite.projection.tasks.map((task) => task.taskId),
    [taskUid, secondId],
  );
  assert.equal(
    (
      await core.projectWorkMap(
        f.root,
        { ...request(), taskIds: ["TSK-00000000000000000000000024"] },
        options,
      )
    ).ok,
    false,
    "Unrelated task is outside the selected plan's prerequisite closure",
  );
});

test("ordinary work-map Document amendments retain expected-revision and trusted-authority enforcement", async (t) => {
  const f = await fixture(t),
    before = await readFile(f.root + f.map.path);
  let invoked = 0;
  const denied = await core.amendConceptWithPolicy(
    f.root,
    {
      path: f.map.path.slice(1),
      expectedSourceHash: f.map.sourceHash,
      edits: [],
      bodyText: core.renderWorkMapBody(f.value),
    },
    {
      assertAuthority: async () => {
        invoked++;
        throw Error("revoked");
      },
    },
  );
  assert.equal(denied.ok, false);
  assert.equal(invoked, 1, JSON.stringify(denied));
  assert.deepEqual(await readFile(f.root + f.map.path), before);
  const next = structuredClone(f.value);
  next.tasks[0].requiredOutputs[0].description =
    "A more precise reviewed draft";
  const accepted = await core.amendConceptWithPolicy(
    f.root,
    {
      path: f.map.path.slice(1),
      expectedSourceHash: f.map.sourceHash,
      edits: [],
      bodyText: core.renderWorkMapBody(next),
    },
    { assertAuthority: async () => {} },
  );
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  const stale = await core.amendConceptWithPolicy(
    f.root,
    {
      path: f.map.path.slice(1),
      expectedSourceHash: f.map.sourceHash,
      edits: [],
      bodyText: core.renderWorkMapBody(f.value),
    },
    { assertAuthority: async () => {} },
  );
  assert.equal(stale.ok, false);
  assert.ok(
    (await readFile(f.root + f.map.path, "utf8")).includes("more precise"),
  );
});

test("accepted outputs do not bypass stale resources, upstream acceptance, goal amendments or unknown external effects", async (t) => {
  const f = await fixture(t),
    task = f.value.tasks[0],
    output = { owner: "test", reference: { id: "output" } },
    review = { owner: "test", reference: { id: "review" } },
    resource = { owner: "test", reference: { id: "resource" } };
  task.effectScope = "local";
  task.resources = [resource];
  task.outputRefs = [{ outputId: "draft", reference: output }];
  task.judgments = [review];
  let stale = false;
  const reviewedRevision = core.workTaskRevision(f.value, taskUid);
  const options = {
    binding: f.binding,
    resolveReference: async (reference, purpose) => ({
      status: purpose.purpose === "resource" && stale ? "stale" : "current",
      reference,
      ...(purpose.purpose === "judgment"
        ? {
            judgment: {
              subjectRevision: reviewedRevision,
              outputId: "draft",
              outputReference: output,
              reviewScope: "task",
              verdict: "accepted",
            },
          }
        : {}),
      assertCurrent: async () => {},
    }),
  };
  const read = async () => {
    f.map = await f.doc(f.map.path, f.map.uid, core.renderWorkMapBody(f.value));
    const result = await core.projectWorkMap(
      f.root,
      { project: f.project, map: f.map, planId: planUid },
      options,
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.projection;
  };
  assert.equal((await read()).tasks[0].state, "completed");
  stale = true;
  assert.equal((await read()).tasks[0].state, "blocked");
  stale = false;
  const oldProject = f.project.sourceHash,
    text =
      (await readFile(f.root + f.project.path, "utf8")) + "\nAmended goal.";
  await writeFile(f.root + f.project.path, text);
  f.project = { ...f.project, sourceHash: hash(text) };
  f.value.project.sourceHash = f.project.sourceHash;
  assert.notEqual(core.workTaskRevision(f.value, taskUid), reviewedRevision);
  const amended = await read();
  assert.equal(amended.tasks[0].outputs[0].status, "unverified");
  assert.notEqual(amended.tasks[0].state, "completed");
  assert.notEqual(oldProject, f.project.sourceHash);
  task.effectScope = "external";
  options.resolveReference = async (reference, purpose) => ({
    status: "current",
    reference,
    ...(purpose.purpose === "judgment"
      ? {
          judgment: {
            subjectRevision: purpose.taskRevision,
            outputId: "draft",
            outputReference: output,
            reviewScope: "task",
            verdict: "accepted",
          },
        }
      : {}),
    assertCurrent: async () => {},
  });
  assert.equal((await read()).tasks[0].state, "unavailable");
  const nextId = "TSK-00000000000000000000000023",
    nextPath = "/projects/fixture/tasks/consumer.md";
  const nextText = (
    await readFile(f.root + task.concept.path, "utf8")
  ).replaceAll(taskUid, nextId);
  await writeFile(f.root + nextPath, nextText);
  task.effectScope = "local";
  const next = {
    ...structuredClone(task),
    concept: ref(nextPath, nextId, nextText),
    dependsOn: [taskUid],
    resources: [],
  };
  f.value.tasks.push(next);
  f.value.plans[0].taskIds.push(nextId);
  let upstreamMissing = false;
  options.resolveReference = async (reference, purpose) => ({
    status:
      upstreamMissing &&
      purpose.taskId === taskUid &&
      purpose.purpose === "output"
        ? "missing"
        : "current",
    reference,
    ...(purpose.purpose === "judgment"
      ? {
          judgment: {
            subjectRevision: purpose.taskRevision,
            outputId: "draft",
            outputReference: output,
            reviewScope: "task",
            verdict: "accepted",
          },
        }
      : {}),
    assertCurrent: async () => {},
  });
  assert.equal((await read()).tasks[1].state, "completed");
  upstreamMissing = true;
  const upstream = await read();
  assert.equal(upstream.tasks[1].outputs[0].status, "accepted");
  assert.equal(upstream.tasks[1].state, "blocked");
  const projectText = await readFile(f.root + f.project.path, "utf8"),
    projectMeta = JSON.parse(
      projectText.slice(4, projectText.indexOf("\n---\n", 4)),
    );
  projectMeta.bookie.state = "paused";
  const paused =
    "---\n" + JSON.stringify(projectMeta) + "\n---\nPaused current goal.";
  await writeFile(f.root + f.project.path, paused);
  f.project = { ...f.project, sourceHash: hash(paused) };
  f.value.project.sourceHash = f.project.sourceHash;
  task.outputRefs = [];
  task.judgments = [];
  const pausedProjection = await read();
  assert.equal(pausedProjection.projectLifecycle, "paused");
  assert.equal(pausedProjection.tasks[0].state, "blocked");
  assert.ok(
    pausedProjection.tasks[0].reasons.includes("project-lifecycle-not-active"),
  );
});

test("exact target outcomes stay separate from accepted outputs and never invent publication", async (t) => {
  const f = await fixture(t);
  const output = { owner: "test", reference: { id: "output" } };
  f.value.tasks[0].effectScope = "external";
  f.value.tasks[0].effectTarget = {
    owner: "test",
    kind: "delivery",
    reference: JSON.stringify({ kind: "delivery", id: "target-a" }),
  };
  f.value.tasks[0].outputRefs = [{ outputId: "draft", reference: output }];
  f.value.tasks[0].judgments = [{ owner: "test", reference: { id: "review" } }];
  const revision = core.workTaskRevision(f.value, taskUid);
  const changed = structuredClone(f.value);
  changed.tasks[0].effectTarget.reference = JSON.stringify({
    kind: "delivery",
    id: "target-b",
  });
  assert.notEqual(core.workTaskRevision(changed, taskUid), revision);
  f.map = await f.doc(f.map.path, f.map.uid, core.renderWorkMapBody(f.value));
  const request = { project: f.project, map: f.map, planId: planUid };
  let outcome = "pending",
    targetCurrent = true,
    runtimeAvailable = true;
  const options = {
    binding: f.binding,
    resolveReference: async (reference, purpose) => ({
      status:
        reference.reference.kind === "delivery" && !targetCurrent
          ? "stale"
          : "current",
      reference,
      ...(purpose.purpose === "judgment"
        ? {
            judgment: {
              subjectRevision: purpose.taskRevision,
              outputId: "draft",
              outputReference: output,
              verdict: "accepted",
              reviewScope: "task",
            },
          }
        : {}),
      assertCurrent: async () => {},
    }),
    observeRuntime: async (identity) =>
      runtimeAvailable
        ? {
            ...identity,
            status: "observed",
            ownerGeneration: 1,
            claim: "unclaimed",
            execution: outcome === "pending" ? "none" : "settled",
            reconciliationRequired: outcome === "unknown",
            effectObservation: {
              target: f.value.tasks[0].effectTarget,
              outcome,
              provenance:
                outcome === "pending" ? "not-observed" : "operator-attested",
              ...(outcome === "pending"
                ? {}
                : {
                    receipt: {
                      reference: "exact-receipt",
                      sha256: "a".repeat(64),
                    },
                    attempt: {
                      owner: { sessionId: "original", cwd: f.root },
                      operationId: "op",
                      executionId: "exec",
                    },
                  }),
            },
            assertCurrent: async () => {},
          }
        : { status: "unavailable" },
  };
  const check = () => core.projectWorkMap(f.root, request, options);
  let value = await check();
  assert.equal(value.ok, true);
  assert.notEqual(value.projection.tasks[0].state, "completed");
  assert.equal(
    value.projection.tasks[0].runtime.effectObservation.outcome,
    "pending",
  );
  outcome = "applied";
  value = await check();
  assert.equal(value.projection.tasks[0].state, "completed");
  assert.equal(
    value.projection.tasks[0].runtime.effectObservation.provenance,
    "operator-attested",
  );
  outcome = "not-applied";
  value = await check();
  assert.notEqual(value.projection.tasks[0].state, "completed");
  outcome = "unknown";
  value = await check();
  assert.equal(value.projection.tasks[0].state, "reconcile");
  outcome = "applied";
  targetCurrent = false;
  value = await check();
  assert.equal(value.projection.tasks[0].state, "blocked");
  assert.notEqual(
    value.projection.tasks[0].runtime.effectObservation.outcome,
    "applied",
  );
  targetCurrent = true;
  runtimeAvailable = false;
  value = await check();
  assert.equal(value.projection.tasks[0].state, "unavailable");
  runtimeAvailable = true;
  f.value.tasks[0].outputRefs = [];
  f.value.tasks[0].judgments = [];
  request.map = await f.doc(
    f.map.path,
    f.map.uid,
    core.renderWorkMapBody(f.value),
  );
  value = await check();
  assert.equal(value.projection.tasks[0].runtime.claim, "unclaimed");
  assert.equal(
    value.projection.tasks[0].runtime.effectObservation.outcome,
    "applied",
  );
  assert.equal(value.projection.tasks[0].outputs[0].status, "missing");
  assert.equal(value.projection.tasks[0].state, "awaiting-acceptance");
  assert.ok(
    value.projection.tasks[0].reasons.includes(
      "applied-effect-awaiting-output-acceptance",
    ),
  );
});
