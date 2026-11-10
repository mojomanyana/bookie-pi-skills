import { createHash } from "node:crypto";
import { posix, resolve } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import {
  createCheckpointWithPolicy,
  inspectConcept,
  loadConcept,
  searchVault,
  type InspectConceptResult,
} from "pi-bookie-core";
import type { ChoiceAccess } from "./dashboard-open-choices.js";
import { prepareManagedActivity } from "./managed-activity.js";
import {
  activitySections,
  choiceFromActivity,
  choiceGuidance,
  safeChoiceLine,
  statedAlternatives,
  type ChoiceGuidance,
} from "./open-choice.js";

export type ChoiceDetail = ChoiceGuidance & {
  id: string;
  title: string;
  label: string;
  revision: string;
};
export class ChoiceRefused extends Error {
  constructor() {
    super("This choice or answer is unavailable. Reopen the current choice.");
  }
}

const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const digestPattern = /^open-choice-([a-f0-9]{32})$/u;
const uid = (hex: string) => "ACT-0" + hex.slice(0, 25).toUpperCase();
const limits = {
  maxContentBytes: 16000,
  maxTotalConceptBytes: 16 * 1024 * 1024,
};
const directory = (access: ChoiceAccess) =>
  posix.join(posix.dirname(access.scope.project.path), "activities");
function paths(access: ChoiceAccess, id: string) {
  const digest = digestPattern.exec(id)?.[1];
  if (!digest) throw new ChoiceRefused();
  const dir = directory(access);
  return {
    note: posix.join(dir, "note-" + digest + ".md"),
    noteUid: uid(digest),
    answer: posix.join(dir, "answer-" + digest + ".md"),
    answerUid: uid(createHash("sha256").update(id).digest("hex")),
  };
}

export function idForRecord(
  access: ChoiceAccess,
  path: string,
  kind: "note" | "answer",
) {
  if (posix.dirname(path) !== directory(access)) return;
  const match = /^(note|answer)-([a-f0-9]{32})\.md$/u.exec(
    posix.basename(path),
  );
  return match?.[1] === kind ? "open-choice-" + match[2] : undefined;
}

function ordinary(
  access: ChoiceAccess,
  record: InspectConceptResult,
  expectedUid: string,
) {
  if (
    !record.ok ||
    record.uid !== expectedUid ||
    record.handling !== "ordinary" ||
    record.sourceTruncated ||
    record.type !== "Activity" ||
    record.status !== "stable" ||
    record.project !== access.scope.project.path ||
    record.sensitivity.value !== "internal" ||
    !access.allows(record)
  )
    throw new ChoiceRefused();
  const parsed = loadConcept(Buffer.from(record.sourceText), {
    file: record.source.path,
  });
  if (!parsed.ok || !object(parsed.concept.frontmatter.bookie))
    throw new ChoiceRefused();
  return {
    body: parsed.concept.bodyText,
    meta: parsed.concept.frontmatter.bookie,
    title: parsed.concept.frontmatter.title,
    source: record.source,
  };
}

async function sourceChoice(
  access: ChoiceAccess,
  id: string,
): Promise<ChoiceDetail> {
  const target = paths(access, id);
  const found = await inspectConcept(
    access.root,
    { path: target.note },
    limits,
  );
  const { body, meta, title, source } = ordinary(access, found, target.noteUid);
  const label = choiceFromActivity(body);
  if (!label || !safeChoiceLine(title, 120)) throw new ChoiceRefused();
  const guidance = meta.choice_guidance;
  let suggestions: ChoiceGuidance = { options: statedAlternatives(label) };
  if (guidance !== undefined) {
    if (!object(guidance)) throw new ChoiceRefused();
    const sections = activitySections(body)!;
    const parsed = choiceGuidance(
      guidance.options,
      guidance.recommendation,
      sections.Outcome ?? "",
      sections.Evidence,
    );
    if (!parsed) throw new ChoiceRefused();
    suggestions = parsed;
  }
  return { id, title, label, revision: source.sourceHash, ...suggestions };
}

async function answerRecord(access: ChoiceAccess, id: string) {
  const { answer } = paths(access, id);
  const record = await inspectConcept(access.root, { path: answer }, limits);
  if (!record.ok && record.reason === "not-found") return;
  return record;
}

export async function hasAnswerRecord(access: ChoiceAccess, id: string) {
  // An unavailable or occupied answer slot must not be offered for a second decision.
  return (await answerRecord(access, id)) !== undefined;
}

export async function readChoice(access: ChoiceAccess, id: string) {
  await access.assertCurrent();
  if (!digestPattern.test(id)) return;
  if (await hasAnswerRecord(access, id)) {
    await access.assertCurrent();
    return;
  }
  const choice = await sourceChoice(access, id).catch((error: unknown) => {
    if (error instanceof ChoiceRefused) return undefined;
    throw error;
  });
  await access.assertCurrent();
  return choice;
}

function answerSections(choice: ChoiceDetail, answer: string, path: string) {
  return {
    outcome:
      "The user answered the saved project choice for " + choice.title + ".",
    decisions: "Question: " + choice.label + "\nAnswer: " + answer,
    evidence: "[Original project note](" + path + ")",
  };
}

export async function choiceResolution(access: ChoiceAccess, id: string) {
  const existing = await answerRecord(access, id);
  if (!existing) return;
  const target = paths(access, id);
  const choice = await sourceChoice(access, id);
  const { body, meta, source, title } = ordinary(
    access,
    existing,
    target.answerUid,
  );
  const link = meta.choice_answer;
  if (
    !object(link) ||
    link.source !== target.note ||
    link.revision !== choice.revision ||
    title !== choice.title
  )
    throw new ChoiceRefused();
  const sections = activitySections(body);
  const decisions = sections?.Decisions;
  const prefix = "Question: " + choice.label + "\nAnswer: ";
  if (!decisions?.startsWith(prefix)) throw new ChoiceRefused();
  const answer = decisions.slice(prefix.length);
  if (!safeChoiceLine(answer)) throw new ChoiceRefused();
  const expected = answerSections(choice, answer, target.note);
  if (
    sections?.Outcome !== expected.outcome ||
    sections.Evidence !== expected.evidence ||
    sections["Source session"] !== undefined ||
    ["Changed artifacts", "Validation", "Unresolved work", "Next action"].some(
      (name) => sections[name] !== "No additional information recorded.",
    )
  )
    throw new ChoiceRefused();
  return {
    status: "answered" as const,
    answer,
    source,
    questionRevision: choice.revision,
  };
}

export async function answerChoice(
  access: ChoiceAccess,
  input: { id: string; revision: string; answer: string },
  sessionId: string,
): Promise<"saved" | "already saved"> {
  if (
    !object(input) ||
    typeof input.id !== "string" ||
    !safeChoiceLine(input.answer) ||
    typeof input.revision !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(input.revision)
  )
    throw new ChoiceRefused();
  const { id, revision, answer } = input;
  const target = paths(access, id);
  return withFileMutationQueue(
    resolve(access.root, target.answer.slice(1)),
    async () => {
      const verified = async () => {
        await access.assertCurrent();
        if (
          !access.allows({
            uid: target.answerUid,
            project: access.scope.project.path,
            sensitivity: { classification: "declared", value: "internal" },
          })
        )
          throw new ChoiceRefused();
        const source = await sourceChoice(access, id);
        if (source.revision !== revision) throw new ChoiceRefused();
        await access.assertCurrent();
        return source;
      };
      const choice = await verified();
      const alreadySaved = async () => {
        const saved = await choiceResolution(access, id);
        await access.assertCurrent();
        if (saved && saved.answer !== answer) throw new ChoiceRefused();
        return !!saved;
      };
      if (await alreadySaved()) return "already saved";
      const prepared = await prepareManagedActivity(
        access.root,
        {
          path: target.answer,
          uid: target.answerUid,
          project: access.scope.project.path,
          title: choice.title,
          tags: ["choice-answer"],
          fields: { choice_answer: { source: target.note, revision } },
          sections: answerSections(choice, answer, target.note),
        },
        sessionId,
      );
      if (!prepared.ok) throw new ChoiceRefused();
      const result = await createCheckpointWithPolicy(prepared.publication, {
        assertAuthority: async () => {
          await verified();
        },
      });
      if (!result.ok) {
        if (
          !result.changedPaths.length &&
          result.diagnostics.some(
            (d) =>
              d.code === "MUTATION-TARGET" || d.code === "MUTATION-CONFLICT",
          ) &&
          (await alreadySaved())
        )
          return "already saved";
        throw Error("Bookie could not confirm saving the decision.");
      }
      // Once the canonical file exists, losing access or seeing new bytes can
      // only mean the acknowledgment is uncertain.
      if (result.redacted || !(await alreadySaved().catch(() => false)))
        throw Error("Bookie could not confirm saving the decision.");
      return "saved";
    },
  );
}

/** Search metadata identifies potential receipts. Exact reads below decide what may be disclosed. */
export async function answeredChoiceIds(access: ChoiceAccess) {
  const scan = await searchVault(
    access.root,
    {
      query: "The user answered the saved project choice for ",
      filters: {
        project: access.scope.project.path,
        type: "Activity",
        status: "stable",
        sensitivity: "internal",
        tag: "choice-answer",
      },
    },
    { maxResults: 50, maxTotalConceptBytes: limits.maxTotalConceptBytes },
  );
  return {
    ids: new Set(
      scan.results.map((hit) => idForRecord(access, hit.source.path, "answer")),
    ),
    complete: scan.complete,
    truncated: scan.resultsTruncated,
  };
}

export function historyChoice(
  access: ChoiceAccess & { managedWorkspace?: boolean },
  hit: Record<string, unknown>,
) {
  if (
    !object(hit.source) ||
    typeof hit.source.path !== "string" ||
    typeof hit.source.sourceHash !== "string"
  )
    return;
  for (const kind of ["note", "answer"] as const) {
    const id = idForRecord(access, hit.source.path, kind);
    if (
      id &&
      ((kind === "answer" && access.managedWorkspace) ||
        hit.uid ===
          paths(access, id)[kind === "note" ? "noteUid" : "answerUid"])
    )
      return { id, kind, revision: hit.source.sourceHash };
  }
}

export async function projectChoiceHistory(
  access: ChoiceAccess,
  ref: NonNullable<ReturnType<typeof historyChoice>>,
) {
  const saved = await choiceResolution(access, ref.id);
  if (ref.kind === "answer") {
    if (!saved || saved.source.sourceHash !== ref.revision)
      throw new ChoiceRefused();
  } else if (saved) {
    if (saved.questionRevision !== ref.revision) throw new ChoiceRefused();
    return saved;
  }
}
