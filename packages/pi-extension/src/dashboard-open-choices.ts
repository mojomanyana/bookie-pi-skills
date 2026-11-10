import { answeredChoiceIds, hasAnswerRecord } from "./choice-answer.js";
import { posix } from "node:path";
import { inspectConcept, loadConcept, searchVault } from "pi-bookie-core";
import { choiceFromActivity, safeChoiceLine } from "./open-choice.js";

export interface ChoiceAccess {
  root: string;
  scope: { project: { path: string } };
  allows(value: unknown): boolean;
  assertCurrent(): Promise<void>;
}

export type ChoiceRow = {
  id: string;
  kind: "work";
  state: "observed";
  label: string;
  details?: string[];
};

const maxFullReads = 7;

export async function dashboardOpenChoices(access: ChoiceAccess) {
  const project = access.scope.project.path;
  // Short checkpoint bodies fit in the initial query. Read longer ones by exact revision within a fixed budget.
  const filters = {
    project,
    type: "Activity",
    status: "stable",
    sensitivity: "internal",
  };
  const options = { maxResults: 50, maxTotalConceptBytes: 16 * 1024 * 1024 };
  const section = "\n# Unresolved work\n";
  const search = (query: string, tag?: string) =>
    searchVault(
      access.root,
      { query, filters: tag ? { ...filters, tag } : filters },
      options,
    );
  const scan = await search(section);
  if (!scan.complete) return { rows: [], limited: true };
  const scans = [scan];
  // An ordinary closed note has the same heading. If the general results are
  // bounded, prioritize indexed choices and the explicit marker in old receipts.
  const longNotes = scan.results.filter((hit) => hit.excerptTruncated).length;
  if (scan.resultsTruncated || longNotes > maxFullReads) {
    await access.assertCurrent();
    const indexed = await search(section, "open-choice");
    // Literal searches use the shared suffix so both "Open:" and "open:"
    // forms can qualify. The Markdown parser still validates the full marker.
    const legacyOpen = await search("pen:");
    const legacyChoice = await search("hoice:");
    if (!indexed.complete || !legacyOpen.complete || !legacyChoice.complete)
      return { rows: [], limited: true };
    scans.unshift(indexed, legacyOpen, legacyChoice);
  }
  // Skip settled rows in bulk, including decisions that displaced original notes
  // in the initial page. Independently check each displayed note's exact slot.
  const answers = await answeredChoiceIds(access);
  if (!answers.complete) return { rows: [], limited: true };
  const rows: ChoiceRow[] = [];
  let answerChecks = 0;
  const dir = posix.join(posix.dirname(project), "activities");
  let limited = scans.some((result) => result.resultsTruncated);
  const visited = new Set<string>();
  let fullReads = 0;
  let bytes = 0;
  for (const hit of scans.flatMap((result) => result.results)) {
    if (visited.has(hit.source.path)) continue;
    visited.add(hit.source.path);
    if (!access.allows(hit) || posix.dirname(hit.source.path) !== dir) continue;
    const digest = /^note-([a-f0-9]{32})\.md$/u.exec(
      posix.basename(hit.source.path),
    )?.[1];
    if (!digest || hit.uid !== "ACT-0" + digest.slice(0, 25).toUpperCase())
      continue;
    const id = "open-choice-" + digest;
    if (answers.ids.has(id)) continue;
    let body = hit.excerpt;
    if (hit.matchedField !== "body" || hit.excerptTruncated) {
      if (fullReads >= maxFullReads) {
        limited = true;
        continue;
      }
      fullReads++;
      const record = await inspectConcept(
        access.root,
        { path: hit.source.path },
        { maxContentBytes: 16_000, maxTotalConceptBytes: 16 * 1024 * 1024 },
      );
      if (
        !record.ok ||
        record.handling !== "ordinary" ||
        record.sourceTruncated ||
        record.source.sourceHash !== hit.source.sourceHash ||
        !access.allows(record)
      ) {
        limited = true;
        continue;
      }
      const parsed = loadConcept(Buffer.from(record.sourceText), {
        file: hit.source.path,
      });
      if (!parsed.ok) continue;
      body = parsed.concept.bodyText;
    }
    const label = choiceFromActivity(body);
    if (!label) continue;
    if (answerChecks >= 14 || rows.length === 7) {
      limited = true;
      continue;
    }
    answerChecks++;
    if (await hasAnswerRecord(access, id)) continue;
    const row: ChoiceRow = {
      id,
      kind: "work",
      state: "observed",
      label,
      ...(safeChoiceLine(hit.title, 120) && !hit.titleTruncated
        ? { details: [hit.title] }
        : {}),
    };
    // The v1 dashboard accepts eight rows and 4 KiB including the readiness row.
    const size = Buffer.byteLength(JSON.stringify(row)) + 1;
    if (bytes + size > 3500) {
      limited = true;
      continue;
    }
    rows.push(row);
    bytes += size;
  }
  return { rows, limited };
}
