import {
  computeConceptSourceHash,
  isObject,
} from "./concept-mutation-model.js";
import { loadConcept } from "./concept-loader.js";
import { prepareContext, revalidateContext } from "./prepared-context.js";
import {
  recallFailure,
  safeText,
  validHash,
  validRevision,
} from "./recall-scope.js";
import type {
  ContextOptions,
  ConceptRevision,
  RecallResult,
} from "./recall-model.js";
import type {
  LoadedWorkMap,
  WorkMap,
  WorkConceptReference,
  WorkOwnerReference,
  WorkProjectionOptions,
  WorkProjectionRequest,
  WorkProjection,
  WorkTaskProjection,
  WorkReferenceResolution,
  WorkRuntimeObservation,
  WorkIdentity,
  WorkEffectTarget,
  WorkEffectObservation,
} from "./work-map-model.js";

const WORK_MAP_LIMITS = Object.freeze({
  mapBytes: 32_768,
  projectionBytes: 48_000,
  tasks: 32,
  plans: 8,
  prerequisiteEdges: 64,
  suggestions: 16,
  selectedTasks: 12,
  canonicalInputs: 16,
  ownerReferenceBytes: 4096,
});
const MAP_BYTES = WORK_MAP_LIMITS.mapBytes,
  PROJECTION_BYTES = WORK_MAP_LIMITS.projectionBytes;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (isObject(value))
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ":" + canonical(value[key]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
const hash = (value: unknown) =>
  computeConceptSourceHash(Buffer.from(canonical(value)));
function keys(
  value: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
) {
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => [...required, ...optional].includes(key))
  );
}
const uid = (value: unknown, prefix?: string): value is string =>
  typeof value === "string" &&
  /^(?:PRJ|TSK|DOC|RSC|DSN|ACT|EVD|PER)-[0-7][0-9A-HJKMNP-TV-Z]{25}(?![\s\S])/u.test(
    value,
  ) &&
  (!prefix || value.startsWith(prefix + "-"));
function concept(
  value: unknown,
  prefix?: string,
): value is WorkConceptReference {
  return (
    isObject(value) &&
    keys(value, ["path", "uid", "sourceHash"]) &&
    validRevision(value) &&
    uid(value.uid, prefix)
  );
}
export function isWorkEffectTarget(value: unknown): value is WorkEffectTarget {
  try {
    if (
      !isObject(value) ||
      !keys(value, ["owner", "kind", "reference"]) ||
      !safeText(value.owner, 48) ||
      !safeText(value.kind, 80) ||
      !safeText(value.reference, 2048)
    )
      return false;
    const reference: unknown = JSON.parse(value.reference);
    return isObject(reference) && reference.kind === value.kind;
  } catch {
    return false;
  }
}
export function effectTargetReference(
  target: WorkEffectTarget,
): WorkOwnerReference {
  if (!isWorkEffectTarget(target))
    throw Error("Invalid owner-issued effect target.");
  return {
    owner: target.owner,
    reference: JSON.parse(target.reference) as Record<string, unknown>,
  };
}
function validEffectObservation(
  value: unknown,
  target: WorkEffectTarget,
): value is WorkEffectObservation {
  if (
    !isObject(value) ||
    !keys(value, ["target", "outcome", "provenance"], ["receipt", "attempt"]) ||
    !isWorkEffectTarget(value.target) ||
    canonical(value.target) !== canonical(target) ||
    !["pending", "applied", "not-applied", "unknown"].includes(
      String(value.outcome),
    ) ||
    !["not-observed", "operator-attested", "owner-verified"].includes(
      String(value.provenance),
    )
  )
    return false;
  if (
    value.receipt !== undefined &&
    (!isObject(value.receipt) ||
      !keys(value.receipt, ["reference", "sha256"]) ||
      !safeText(value.receipt.reference, 2048) ||
      typeof value.receipt.sha256 !== "string" ||
      !/^[a-f0-9]{64}(?![\s\S])/.test(value.receipt.sha256))
  )
    return false;
  if (
    value.attempt !== undefined &&
    (!isObject(value.attempt) ||
      !keys(value.attempt, ["owner", "operationId", "executionId"]) ||
      !isObject(value.attempt.owner) ||
      !keys(value.attempt.owner, ["sessionId", "cwd"]) ||
      !safeText(value.attempt.owner.sessionId, 256) ||
      !safeText(value.attempt.owner.cwd, 2048) ||
      !safeText(value.attempt.operationId, 256) ||
      !safeText(value.attempt.executionId, 256))
  )
    return false;
  if (
    ["applied", "not-applied"].includes(String(value.outcome)) &&
    (!value.receipt || !value.attempt || value.provenance === "not-observed")
  )
    return false;
  if (
    value.outcome === "pending" &&
    (value.provenance !== "not-observed" || value.receipt)
  )
    return false;
  return true;
}
export function isWorkOwnerReference(
  value: unknown,
): value is WorkOwnerReference {
  try {
    return (
      isObject(value) &&
      keys(value, ["owner", "reference"]) &&
      safeText(value.owner, 128) &&
      isObject(value.reference) &&
      Buffer.byteLength(canonical(value.reference)) <=
        WORK_MAP_LIMITS.ownerReferenceBytes &&
      isObject(JSON.parse(canonical(value.reference)))
    );
  } catch {
    return false;
  }
}
function array(value: unknown, max: number): value is unknown[] {
  return Array.isArray(value) && value.length <= max;
}
function unique(values: readonly string[]) {
  return new Set(values).size === values.length;
}
export function validateWorkMap(
  value: unknown,
): { ok: true } | { ok: false; reason: "input" | "bounds" | "cycle" } {
  try {
    if (Buffer.byteLength(canonical(value)) > MAP_BYTES)
      return { ok: false, reason: "bounds" };
    if (
      !isObject(value) ||
      !keys(value, [
        "schemaVersion",
        "project",
        "plans",
        "tasks",
        "suggestions",
      ]) ||
      value.schemaVersion !== 1 ||
      !isObject(value.project) ||
      !keys(value.project, ["uid", "sourceHash"]) ||
      !uid(value.project.uid, "PRJ") ||
      !validHash(value.project.sourceHash) ||
      !array(value.plans, WORK_MAP_LIMITS.plans) ||
      !value.plans.length ||
      !array(value.tasks, WORK_MAP_LIMITS.tasks) ||
      !value.tasks.length ||
      !array(value.suggestions, WORK_MAP_LIMITS.suggestions)
    )
      return { ok: false, reason: "input" };
    const taskIds: string[] = [];
    let edges = 0;
    for (const row of value.tasks) {
      if (
        !isObject(row) ||
        !keys(
          row,
          [
            "concept",
            "dependsOn",
            "inputs",
            "requiredOutputs",
            "resources",
            "outputRefs",
            "judgments",
          ],
          ["effectScope", "effectTarget"],
        ) ||
        !concept(row.concept, "TSK") ||
        (row.effectTarget !== undefined &&
          (!isWorkEffectTarget(row.effectTarget) ||
            row.effectScope === "local")) ||
        !array(row.dependsOn, 32) ||
        !row.dependsOn.every((x) => uid(x, "TSK")) ||
        !unique(row.dependsOn as string[]) ||
        !array(row.inputs, 8) ||
        !row.inputs.every((x) => concept(x)) ||
        !array(row.requiredOutputs, 8) ||
        !row.requiredOutputs.length ||
        !row.requiredOutputs.every(
          (x) =>
            isObject(x) &&
            keys(x, ["id", "description"], ["reviewScope"]) &&
            safeText(x.id, 128) &&
            safeText(x.description, 1024) &&
            (x.reviewScope === undefined ||
              ["task", "integrated"].includes(String(x.reviewScope))),
        ) ||
        !array(row.resources, 8) ||
        !row.resources.every(isWorkOwnerReference) ||
        !array(row.outputRefs, 8) ||
        !row.outputRefs.every(
          (x) =>
            isObject(x) &&
            keys(x, ["outputId", "reference"]) &&
            safeText(x.outputId, 128) &&
            isWorkOwnerReference(x.reference),
        ) ||
        !array(row.judgments, 8) ||
        !row.judgments.every(isWorkOwnerReference) ||
        (row.effectScope !== undefined &&
          !["local", "external", "unknown"].includes(String(row.effectScope)))
      )
        return { ok: false, reason: "input" };
      const outputs = row.requiredOutputs as { id: string }[],
        refs = row.outputRefs as { outputId: string }[];
      if (
        !unique(outputs.map((x) => x.id)) ||
        !unique(refs.map((x) => x.outputId)) ||
        refs.some((x) => !outputs.some((o) => o.id === x.outputId))
      )
        return { ok: false, reason: "input" };
      edges += row.dependsOn.length;
      taskIds.push(row.concept.uid);
    }
    if (edges > WORK_MAP_LIMITS.prerequisiteEdges || !unique(taskIds))
      return { ok: false, reason: "bounds" };
    const map = value as unknown as WorkMap;
    if (
      !map.plans.every(
        (p) =>
          isObject(p) &&
          keys(p as unknown as Record<string, unknown>, [
            "document",
            "taskIds",
          ]) &&
          concept(p.document, "DOC") &&
          array(p.taskIds, 32) &&
          p.taskIds.length > 0 &&
          unique(p.taskIds) &&
          p.taskIds.every((id) => taskIds.includes(id)),
      ) ||
      !unique(map.plans.map((p) => p.document.uid))
    )
      return { ok: false, reason: "input" };
    const tasks = new Map(map.tasks.map((t) => [t.concept.uid, t]));
    const visiting = new Set<string>(),
      visited = new Set<string>();
    function visit(id: string): boolean {
      if (visiting.has(id)) return false;
      if (visited.has(id)) return true;
      const row = tasks.get(id);
      if (!row) return false;
      visiting.add(id);
      if (row.dependsOn.some((dep) => !visit(dep))) return false;
      visiting.delete(id);
      visited.add(id);
      return true;
    }
    if (taskIds.some((id) => !visit(id))) return { ok: false, reason: "cycle" };
    if (
      !map.suggestions.every(
        (s) =>
          isObject(s) &&
          keys(
            s as unknown as Record<string, unknown>,
            ["id", "taskId", "text", "trigger", "disposition"],
            ["handledTriggerHash"],
          ) &&
          safeText(s.id, 128) &&
          taskIds.includes(s.taskId) &&
          safeText(s.text, 1024) &&
          concept(s.trigger) &&
          [
            "proposed",
            "accepted",
            "dismissed",
            "deferred",
            "superseded",
            "resolved",
          ].includes(s.disposition) &&
          (s.handledTriggerHash === undefined ||
            validHash(s.handledTriggerHash)) &&
          [tasks.get(s.taskId)!.concept, ...tasks.get(s.taskId)!.inputs].some(
            (input) => canonical(input) === canonical(s.trigger),
          ),
      ) ||
      !unique(map.suggestions.map((s) => s.id))
    )
      return { ok: false, reason: "input" };
    return { ok: true };
  } catch {
    return { ok: false, reason: "input" };
  }
}
/** Public authoring help only. The example is typed and validated by the same reader contract. */
export function describeWorkMap() {
  const sourceHash = `sha256:${"0".repeat(64)}` as const;
  const example: WorkMap = {
    schemaVersion: 1,
    project: { uid: "PRJ-00000000000000000000000001", sourceHash },
    plans: [
      {
        document: {
          path: "/projects/example/plan.md",
          uid: "DOC-00000000000000000000000003",
          sourceHash,
        },
        taskIds: ["TSK-00000000000000000000000002"],
      },
    ],
    tasks: [
      {
        concept: {
          path: "/projects/example/task.md",
          uid: "TSK-00000000000000000000000002",
          sourceHash,
        },
        dependsOn: [],
        inputs: [],
        requiredOutputs: [
          {
            id: "draft",
            description: "The requested output and its acceptance criteria.",
            reviewScope: "task",
          },
        ],
        resources: [],
        effectScope: "local",
        outputRefs: [],
        judgments: [],
      },
    ],
    suggestions: [],
  };
  if (!validateWorkMap(example).ok)
    throw Error("Work-map help does not match the current validator.");
  return {
    schemaVersion: 1,
    purpose: "public-authoring-contract",
    limits: WORK_MAP_LIMITS,
    example,
    bodyFormat: "# Bookie work map\n\n```bookie-work-map-v1\n<JSON map>\n```\n",
    exampleIsSynthetic: true,
    workflow: [
      "Select /bookie-context for current vault/Project/class/destination access. Use bookie_read to obtain real canonical UIDs, paths and source hashes; never calculate or invent them.",
      "Create/amend an ordinary Document through bookie_write with this body format and real references. Existing trusted write approval and expected-source revision checks apply.",
      "Select /bookie-work in trusted UI. bookie_work returns owner-computed taskRevision values; copy those exact values into review bindings.",
      "Attach outputRefs as {outputId,reference:{owner,reference}} and judgments as owner references through ordinary approved Document amendments. They are observations, never approval.",
      "Inputs are the exact consumed concepts; include the plan Document there when its text is a task dependency. dependsOn names accepted hard predecessors; an independent review uses the producer output as a resource instead of an acceptance dependency.",
    ],
    optionalFields: {
      effectScope: ["local", "external", "unknown"],
      effectTarget:
        "One optional exact {owner,kind,reference} from its responsible owner; reference is structured JSON <=2048 bytes. Intent only, not delivery evidence.",
      reviewScope: ["task", "integrated"],
      suggestionDispositions: [
        "proposed",
        "accepted",
        "dismissed",
        "deferred",
        "superseded",
        "resolved",
      ],
    },
    authority:
      "This static contract grants no vault access, write permission, execution, review acceptance, sharing or retry authority. Task must be ready and Project active for new admission; external effects need actual owner reconciliation.",
  };
}
export function renderWorkMapBody(map: WorkMap): string {
  if (!validateWorkMap(map).ok) throw Error("Invalid Bookie work map.");
  return (
    "# Bookie work map\n\n```bookie-work-map-v1\n" +
    JSON.stringify(map) +
    "\n```\n"
  );
}
export function parseWorkMapBody(body: string): WorkMap | undefined {
  if (Buffer.byteLength(body) > 48_000) return undefined;
  const match =
    /^# Bookie work map\r?\n\r?\n```bookie-work-map-v1\r?\n([\s\S]*)\r?\n```\r?\n?$/.exec(
      body,
    );
  if (!match) return undefined;
  try {
    const value: unknown = JSON.parse(match[1]!);
    return validateWorkMap(value).ok ? (value as WorkMap) : undefined;
  } catch {
    return undefined;
  }
}
export function workTaskRevision(
  map: WorkMap,
  taskId: string,
): `sha256:${string}` {
  if (!validateWorkMap(map).ok) throw Error("Invalid Bookie work map.");
  const tasks = new Map(map.tasks.map((t) => [t.concept.uid, t])),
    cache = new Map<string, `sha256:${string}`>();
  function revision(id: string): `sha256:${string}` {
    const previous = cache.get(id);
    if (previous) return previous;
    const task = tasks.get(id);
    if (!task) throw Error("Unknown Bookie task.");
    const value = hash({
      project: map.project,
      concept: task.concept,
      inputs: task.inputs,
      dependsOn: task.dependsOn.map((id) => ({
        taskId: id,
        revision: revision(id),
      })),
      requiredOutputs: task.requiredOutputs,
      resources: task.resources,
      effectScope: task.effectScope ?? "unknown",
      ...(task.effectTarget ? { effectTarget: task.effectTarget } : {}),
    });
    cache.set(id, value);
    return value;
  }
  return revision(taskId);
}
export async function readWorkMap(
  root: string | URL,
  request: { project: ConceptRevision; map: ConceptRevision },
  options: ContextOptions,
): Promise<RecallResult<LoadedWorkMap>> {
  const result = await prepareContext(
    root,
    {
      project: request.project,
      selectors: [
        { path: request.map.path, sourceHash: request.map.sourceHash },
      ],
      maxContentBytes: 48_000,
      maxTotalBytes: 48_000,
    },
    options,
  );
  if (!result.ok) return result;
  const input = result.bundle.inputs[0]!;
  if (input.type !== "Document" || input.truncated)
    return recallFailure("bounds");
  const parsed = loadConcept(Buffer.from(input.text), {
    file: input.path,
    maxBytes: 48_000,
  });
  if (!parsed.ok) return recallFailure("input");
  const map = parseWorkMapBody(parsed.concept.bodyText);
  if (!map || map.project.uid !== result.bundle.scope.project.uid)
    return recallFailure("scope");
  return {
    ok: true,
    map,
    source: { path: input.path, uid: input.uid, sourceHash: input.sourceHash },
    bundle: result.bundle,
  };
}
export async function projectWorkMap(
  root: string | URL,
  request: WorkProjectionRequest,
  options: WorkProjectionOptions,
): Promise<
  RecallResult<{
    projection: WorkProjection;
    bundles: readonly import("./recall-model.js").PreparedContextBundle[];
    assertCurrent: () => Promise<void>;
  }>
> {
  if (
    !uid(request.planId, "DOC") ||
    (request.taskIds !== undefined &&
      (!array(request.taskIds, WORK_MAP_LIMITS.selectedTasks) ||
        !request.taskIds.length ||
        !request.taskIds.every((id) => uid(id, "TSK")) ||
        !unique(request.taskIds)))
  )
    return recallFailure("input");
  const loaded = await readWorkMap(root, request, options);
  if (!loaded.ok) return loaded;
  const map = loaded.map,
    plan = map.plans.find((p) => p.document.uid === request.planId);
  if (!plan) return recallFailure("input");
  const selected = request.taskIds ?? plan.taskIds;
  const taskMap = new Map(map.tasks.map((t) => [t.concept.uid, t])),
    order: string[] = [],
    seen = new Set<string>();
  function add(id: string) {
    if (seen.has(id)) return;
    seen.add(id);
    for (const dep of taskMap.get(id)!.dependsOn) add(dep);
    order.push(id);
  }
  // A plan includes its declared prerequisites; narrowing may select one of them,
  // but cannot expand to an unrelated task from the same map.
  plan.taskIds.forEach(add);
  if (selected.some((id) => !seen.has(id))) return recallFailure("scope");
  seen.clear();
  order.length = 0;
  selected.forEach(add);
  if (order.length > WORK_MAP_LIMITS.selectedTasks)
    return recallFailure("bounds");
  const refs = new Map<string, WorkConceptReference>();
  const addRef = (ref: WorkConceptReference) => {
    const old = refs.get(ref.path);
    if (old && canonical(old) !== canonical(ref))
      throw Error("Conflicting input revisions.");
    refs.set(ref.path, ref);
  };
  const suggestions = map.suggestions.filter((s) => seen.has(s.taskId));
  try {
    addRef({ ...request.project, uid: map.project.uid });
    addRef(plan.document);
    for (const id of order) {
      const task = taskMap.get(id)!;
      addRef(task.concept);
      task.inputs.forEach(addRef);
    }
  } catch {
    return recallFailure("input");
  }
  if (refs.size > WORK_MAP_LIMITS.canonicalInputs)
    return recallFailure("bounds");
  const prepared = await prepareContext(
    root,
    {
      project: request.project,
      selectors: [...refs.values()].map(({ path, sourceHash }) => ({
        path,
        sourceHash,
      })),
      maxContentBytes: 48_000,
      maxTotalBytes: 48_000,
    },
    options,
  );
  if (!prepared.ok) return prepared;
  const inputs = new Map(
    prepared.bundle.inputs.map((input) => [input.path, input]),
  );
  for (const reference of refs.values()) {
    const input = inputs.get(reference.path);
    if (!input || input.uid !== reference.uid || input.truncated)
      return recallFailure("source-changed");
  }
  if (
    inputs.get(plan.document.path)!.type !== "Document" ||
    order.some(
      (id) => inputs.get(taskMap.get(id)!.concept.path)!.type !== "Task",
    )
  )
    return recallFailure("input");
  const scope = prepared.bundle.scope,
    initiativeId = "bookie:" + scope.vaultUid + "/" + scope.project.uid;
  const checks: (() => void | Promise<void>)[] = [],
    rows: WorkTaskProjection[] = [];
  async function resolve(
    reference: WorkOwnerReference,
    purpose: Parameters<
      NonNullable<WorkProjectionOptions["resolveReference"]>
    >[1],
  ): Promise<WorkReferenceResolution> {
    if (!options.resolveReference) return { status: "unavailable", reference };
    try {
      const value = await options.resolveReference(
        structuredClone(reference),
        purpose,
      );
      if (
        !value ||
        ![
          "current",
          "missing",
          "stale",
          "suppressed",
          "unavailable",
          "unverified",
        ].includes(value.status) ||
        canonical(value.reference) !== canonical(reference) ||
        (value.status === "current" &&
          typeof value.assertCurrent !== "function")
      )
        return { status: "unavailable", reference };
      if (value.assertCurrent) checks.push(value.assertCurrent);
      return value;
    } catch {
      return { status: "unavailable", reference };
    }
  }
  for (const id of order) {
    const task = taskMap.get(id)!,
      taskRevision = workTaskRevision(map, id),
      identity: WorkIdentity = { initiativeId, taskId: id, taskRevision };
    const resources = [];
    const targetReference = task.effectTarget
      ? effectTargetReference(task.effectTarget)
      : undefined;
    for (const reference of [
      ...task.resources,
      ...(targetReference ? [targetReference] : []),
    ]) {
      const value = await resolve(reference, {
        ...identity,
        purpose: "resource",
      });
      resources.push({ reference, status: value.status });
    }
    const outputs: WorkTaskProjection["outputs"][number][] = [];
    for (const contract of task.requiredOutputs) {
      const attached = task.outputRefs.find((o) => o.outputId === contract.id);
      if (!attached) {
        outputs.push({ id: contract.id, status: "missing" });
        continue;
      }
      const value = await resolve(attached.reference, {
        ...identity,
        purpose: "output",
        outputId: contract.id,
      });
      if (value.status !== "current") {
        outputs.push({
          id: contract.id,
          status: value.status === "unverified" ? "unverified" : value.status,
        });
        continue;
      }
      let status: "unverified" | "accepted" | "rejected" = "unverified";
      for (const reference of task.judgments) {
        const review = await resolve(reference, {
            ...identity,
            purpose: "judgment",
            outputId: contract.id,
            reviewScope: contract.reviewScope ?? "task",
          }),
          judgment = review.judgment;
        if (
          review.status === "current" &&
          judgment &&
          judgment.subjectRevision === taskRevision &&
          judgment.outputId === contract.id &&
          judgment.reviewScope === (contract.reviewScope ?? "task") &&
          canonical(judgment.outputReference) === canonical(attached.reference)
        ) {
          if (judgment.verdict === "rejected") status = "rejected";
          else if (judgment.verdict === "accepted" && status !== "rejected")
            status = "accepted";
        }
      }
      outputs.push({ id: contract.id, status });
    }
    let runtime: WorkRuntimeObservation = { status: "unavailable" };
    if (options.observeRuntime)
      try {
        const value = await options.observeRuntime(identity);
        if (
          value.status === "observed" &&
          value.initiativeId === initiativeId &&
          value.taskId === id &&
          value.taskRevision === taskRevision &&
          Number.isSafeInteger(value.ownerGeneration) &&
          value.ownerGeneration >= 0 &&
          ["unclaimed", "owned", "other-owner", "uncertain"].includes(
            value.claim,
          ) &&
          ["none", "running", "settled", "unknown"].includes(value.execution) &&
          typeof value.reconciliationRequired === "boolean" &&
          typeof value.assertCurrent === "function"
        ) {
          runtime = value;
          if (task.effectTarget) {
            const targetCurrent = resources.some(
              (row) =>
                canonical(row.reference) === canonical(targetReference) &&
                row.status === "current",
            );
            const effectObservation: WorkEffectObservation =
              targetCurrent &&
              validEffectObservation(value.effectObservation, task.effectTarget)
                ? structuredClone(value.effectObservation)
                : {
                    target: task.effectTarget,
                    outcome:
                      targetCurrent &&
                      value.execution === "none" &&
                      value.effectObservation === undefined
                        ? "pending"
                        : "unknown",
                    provenance: "not-observed",
                  };
            runtime = { ...value, effectObservation };
          }
          checks.push(value.assertCurrent);
        }
      } catch {
        /* An unavailable owner supplies no admission facts. */
      }
    const goalChanged = map.project.sourceHash !== scope.project.sourceHash;
    const depsReady = task.dependsOn.every(
      (dep) => rows.find((row) => row.taskId === dep)?.state === "completed",
    );
    const effect =
      runtime.status === "observed" ? runtime.effectObservation : undefined;
    const targetCurrent =
      !targetReference ||
      resources.some(
        (row) =>
          canonical(row.reference) === canonical(targetReference) &&
          row.status === "current",
      );
    const accepted = outputs.every((output) => output.status === "accepted"),
      hasOutput = task.outputRefs.length > 0;
    let state: WorkTaskProjection["state"];
    const reasons: string[] = [];
    if (
      runtime.status === "observed" &&
      (runtime.reconciliationRequired ||
        runtime.claim === "uncertain" ||
        runtime.execution === "unknown")
    )
      state = "reconcile";
    else if (runtime.status === "observed" && runtime.execution === "running")
      state = "running";
    else if (goalChanged) {
      state = "alignment-required";
      reasons.push("project-revision-changed");
    } else if (!depsReady) {
      state = "blocked";
      reasons.push("required-output-not-accepted");
    } else if (resources.some((row) => row.status !== "current")) {
      state = "blocked";
      reasons.push("resource-not-current");
    } else if (
      runtime.status === "unavailable" &&
      (task.effectScope ?? "unknown") !== "local" &&
      accepted
    ) {
      state = "unavailable";
      reasons.push("external-effect-state-unavailable");
    } else if (
      task.effectTarget &&
      runtime.status === "observed" &&
      effect?.outcome === "unknown" &&
      targetCurrent
    ) {
      state = "reconcile";
      reasons.push("declared-effect-outcome-unknown");
    } else if (
      accepted &&
      (!task.effectTarget || effect?.outcome === "applied") &&
      inputs.get(task.concept.path)!.state !== "cancelled"
    )
      state = "completed";
    else if (inputs.get(request.project.path)!.state !== "active") {
      state = "blocked";
      reasons.push("project-lifecycle-not-active");
    } else if (inputs.get(task.concept.path)!.state !== "ready") {
      state = "blocked";
      reasons.push("task-lifecycle-not-ready");
    } else if ((hasOutput || effect?.outcome === "applied") && !accepted) {
      state = "awaiting-acceptance";
      if (effect?.outcome === "applied")
        reasons.push("applied-effect-awaiting-output-acceptance");
    } else if (runtime.status === "unavailable") {
      state = "unavailable";
      reasons.push("runtime-owner-unavailable");
    } else if (runtime.claim !== "unclaimed") {
      state = "blocked";
      reasons.push("task-claim-not-free");
    } else state = "ready";
    const observed =
      runtime.status === "observed"
        ? {
            status: runtime.status,
            initiativeId: runtime.initiativeId,
            taskId: runtime.taskId,
            taskRevision: runtime.taskRevision,
            ownerGeneration: runtime.ownerGeneration,
            claim: runtime.claim,
            execution: runtime.execution,
            reconciliationRequired: runtime.reconciliationRequired,
            ...(runtime.effectObservation && task.effectTarget
              ? { effectObservation: runtime.effectObservation }
              : {}),
          }
        : { status: "unavailable" as const };
    rows.push({
      ...identity,
      source: task.concept,
      inputs: task.inputs,
      requiredOutputs: task.requiredOutputs,
      effectScope: task.effectScope ?? "unknown",
      ...(task.effectTarget ? { effectTarget: task.effectTarget } : {}),
      lifecycle: inputs.get(task.concept.path)!.state,
      dependsOn: task.dependsOn,
      state,
      resources,
      outputs,
      runtime: observed,
      reasons,
    });
  }
  const projection: WorkProjection = {
    schemaVersion: 1,
    initiativeId,
    map: loaded.source,
    plan: plan.document,
    project: scope.project,
    projectLifecycle: inputs.get(request.project.path)!.state,
    goalAlignment:
      map.project.sourceHash === scope.project.sourceHash
        ? "current"
        : "changed",
    tasks: rows,
    suggestions: suggestions.flatMap((s) => {
      const current = inputs.get(s.trigger.path);
      if (!current || current.uid !== s.trigger.uid) return [];
      const reconsider =
        s.disposition !== "proposed" &&
        s.handledTriggerHash !== undefined &&
        current.sourceHash !== s.handledTriggerHash;
      return s.disposition === "proposed" ||
        reconsider ||
        request.includeHandledSuggestions
        ? [
            {
              id: s.id,
              taskId: s.taskId,
              text: s.text,
              disposition: s.disposition,
              reconsider,
            },
          ]
        : [];
    }),
    executionAuthority: false,
    untrusted: true,
  };
  if (Buffer.byteLength(JSON.stringify(projection)) > PROJECTION_BYTES)
    return recallFailure("bounds");
  const bundles = [loaded.bundle, prepared.bundle];
  const assertCurrent = async () => {
    for (const check of checks) await check();
    for (const bundle of bundles) {
      const current = await revalidateContext(root, bundle, options);
      if (!current.ok) throw Error("Work map is no longer current.");
    }
    for (const check of checks) await check();
  };
  try {
    await assertCurrent();
    return { ok: true, projection, bundles, assertCurrent };
  } catch {
    return recallFailure("stale");
  }
}
