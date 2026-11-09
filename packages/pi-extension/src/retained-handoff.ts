import { createHash } from "node:crypto";
import {
  withFileMutationQueue,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  amendConceptWithPolicy,
  isWorkOwnerReference,
  renderWorkMapBody,
  workTaskRevision,
  type WorkIdentity,
  type WorkMap,
  type WorkOwnerReference,
  type WorkProjection,
} from "pi-bookie-core";
import { wrapUntrustedSource } from "./untrusted-text.js";

export type RetainedHandoff = {
  reference: WorkOwnerReference;
  assertCurrent: () => Promise<void>;
  readText: () => Promise<string>;
};
type LinkScope = {
  root: string;
  snapshot: () => { map: WorkMap; source: WorkProjection["map"] };
  assertSelection: () => Promise<void>;
};
const sha = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const id = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/u.test(value);
export function isRetainedReference(
  value: unknown,
): value is WorkOwnerReference & {
  owner: "pi-daddy";
  reference: {
    kind: "retained-handoff";
    operationId: string;
    executionId: string;
    manifestSha256: string;
    finalSha256: string;
  };
} {
  if (!isWorkOwnerReference(value) || value.owner !== "pi-daddy") return false;
  const r = value.reference;
  return (
    Object.keys(r).length === 5 &&
    r.kind === "retained-handoff" &&
    id(r.operationId) &&
    id(r.executionId) &&
    sha(r.manifestSha256) &&
    sha(r.finalSha256)
  );
}
export function handoffSlot(task: WorkMap["tasks"][number]) {
  return (
    task.requiredOutputs.find((item) => item.id === "handoff") ??
    (task.requiredOutputs.length === 1 ? task.requiredOutputs[0] : undefined)
  );
}
export async function linkRetainedHandoff(
  scope: LinkScope,
  identity: WorkIdentity,
  retained: RetainedHandoff,
) {
  if (!isRetainedReference(retained.reference))
    throw Error("Invalid retained handoff reference.");
  const check = async () => {
    await retained.assertCurrent();
    await scope.assertSelection();
  };
  await scope.assertSelection();
  const { map, source } = scope.snapshot();
  const task = map.tasks.find(
    (candidate) => candidate.concept.uid === identity.taskId,
  );
  if (
    !task ||
    workTaskRevision(map, task.concept.uid) !== identity.taskRevision
  )
    throw Error("Bookie task revision changed before linking the handoff.");
  const output = handoffSlot(task);
  if (
    !output ||
    task.outputRefs.some((attached) => attached.outputId === output.id)
  )
    return;
  const reference = structuredClone(retained.reference);
  const amended = {
    ...map,
    tasks: map.tasks.map((row) =>
      row === task
        ? {
            ...row,
            outputRefs: [...row.outputRefs, { outputId: output.id, reference }],
          }
        : row,
    ),
  };
  const result = await amendConceptWithPolicy(
    scope.root,
    {
      path: source.path.slice(1),
      expectedSourceHash: source.sourceHash,
      edits: [],
      bodyText: renderWorkMapBody(amended),
    },
    { assertAuthority: check, runExclusive: withFileMutationQueue },
  );
  if (!result.ok) {
    if (result.changedPaths.length)
      throw Error(
        "Bookie handoff write outcome is uncertain. Inspect the selected work map.",
      );
    if (result.conflict) {
      await scope.assertSelection();
      const observed = scope
        .snapshot()
        .map.tasks.find((row) => row.concept.uid === identity.taskId)
        ?.outputRefs.find((item) => item.outputId === output.id)?.reference;
      if (
        isRetainedReference(observed) &&
        observed.reference.operationId === reference.reference.operationId &&
        observed.reference.executionId === reference.reference.executionId &&
        observed.reference.finalSha256 === reference.reference.finalSha256 &&
        observed.reference.manifestSha256 === reference.reference.manifestSha256
      )
        return;
      throw Error(
        "The work map changed before the handoff was linked. Refresh the selected work map.",
      );
    }
    throw Error("Bookie could not attach the retained handoff.");
  }
  if (result.redacted) throw Error("Bookie handoff output withheld.");
  await scope.assertSelection();
}
export async function showHandoff(
  ctx: ExtensionContext,
  retained: RetainedHandoff,
  check: () => Promise<void>,
  title: string,
) {
  await check();
  const text = await retained.readText();
  if (
    typeof text !== "string" ||
    createHash("sha256").update(text).digest("hex") !==
      retained.reference.reference.finalSha256
  )
    throw Error("Handoff bytes have changed.");
  const safe = wrapUntrustedSource(text);
  const lines = safe
    .split("\n")
    .flatMap((line) => line.match(/[\s\S]{1,68}/gu) ?? [""]);
  const count = Math.max(1, Math.ceil(lines.length / 8));
  for (let page = 0; page < count;) {
    await check();
    const choices = [
      "Close",
      ...(page + 1 < count ? ["Next page"] : []),
      ...(page > 0 ? ["Previous page"] : []),
    ];
    const result = await ctx.ui.select(
      `Review ${title} (${page + 1}/${count})\n\n${lines.slice(8 * page, 8 * page + 8).join("\n")}`,
      choices,
    );
    if (result === "Next page" && page + 1 < count) page++;
    else if (result === "Previous page" && page > 0) page--;
    else return;
  }
}
