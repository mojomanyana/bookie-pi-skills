import { historyChoice, projectChoiceHistory } from "./choice-answer.js";
import { recallVault } from "pi-bookie-core";
import type { ChoiceAccess } from "./dashboard-open-choices.js";

type VerifiedAnswer = NonNullable<
  Awaited<ReturnType<typeof projectChoiceHistory>>
>;
// Derived display values only. Fresh canonical metadata and current access are
// always required before reuse; this object carries no permission or scan count.
export function createMemoryAnswerCache() {
  return { scope: "", answers: new Map<string, VerifiedAnswer>() };
}
export type MemoryAnswerCache = ReturnType<typeof createMemoryAnswerCache>;

// Optional dashboard v1 metadata. Kept local so standalone Pi needs no host dependency.
export interface MemoryInventory {
  scope: string;
  state: "available" | "empty" | "unavailable" | "unknown";
  summary: string;
  count?: number;
  limited: boolean;
  entries: { id: string; title: string; summary: string; reference?: string }[];
}
export function checkDashboardAbort(signal?: AbortSignal) {
  if (signal?.aborted)
    throw new DOMException("Bookie dashboard read was aborted.", "AbortError");
}
function line(value: string, limit: number) {
  const clean = value
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  let result = "";
  for (const char of clean) {
    if (result.length + char.length > limit) break;
    result += char;
  }
  return result;
}
export function unavailableInventory(
  state: "unknown" | "unavailable",
): MemoryInventory {
  return {
    scope: "Current workspace",
    state,
    summary:
      state === "unavailable"
        ? "Current project memory access is unavailable."
        : "Saved notes could not be fully checked.",
    limited: true,
    entries: [],
  };
}
export async function dashboardMemoryInventory(
  access: ChoiceAccess,
  signal?: AbortSignal,
  cache?: MemoryAnswerCache,
): Promise<MemoryInventory> {
  try {
    return await readMemoryInventory(access, signal, cache);
  } catch (error) {
    if (cache) {
      cache.scope = "";
      cache.answers.clear();
    }
    throw error;
  }
}
async function readMemoryInventory(
  access: ChoiceAccess,
  signal?: AbortSignal,
  cache?: MemoryAnswerCache,
): Promise<MemoryInventory> {
  checkDashboardAbort(signal);
  await access.assertCurrent();
  const scope = JSON.stringify([access.root, access.scope.project.path]);
  if (cache && cache.scope !== scope) {
    cache.scope = scope;
    cache.answers.clear();
  }
  // Capture a bounded previous generation. Concurrent refreshes cannot expand
  // this invocation's wanted records while its scan is in flight.
  const previous = new Map(cache?.answers);
  const fresh = new Set<string>();
  const next = new Map<string, VerifiedAnswer>();
  const scan = await recallVault(
    access.root,
    {
      mode: "recent",
      filters: {
        project: access.scope.project.path,
        type: "Activity",
        status: "stable",
      },
    },
    {
      maxResults: 12,
      maxExcerptBytes: 1024,
      maxTotalTextBytes: 16 * 1024,
      maxTotalConceptBytes: 16 * 1024 * 1024,
      include: (record) => {
        if (!access.allows(record)) return false;
        // Core calls this for each visible matching concept before top-K, so an
        // older question outside the twelve displayed notes is still checked.
        const ref = historyChoice(access, { ...record });
        if (ref && previous.has(ref.id))
          fresh.add(JSON.stringify([ref.id, ref.kind, ref.revision]));
        return true;
      },
      ...(signal ? { signal } : {}),
    },
  );
  await access.assertCurrent();
  checkDashboardAbort(signal);
  const inventory: MemoryInventory = {
    scope: "Current workspace",
    state: scan.results.length
      ? "available"
      : scan.complete
        ? "empty"
        : "unknown",
    summary: scan.complete
      ? scan.matchedCount === 0
        ? "No saved project notes."
        : `${scan.matchedCount} saved ${scan.matchedCount === 1 ? "note" : "notes"}. Recent notes shown.`
      : "Only a partial view of saved project notes is available.",
    ...(scan.complete ? { count: scan.matchedCount } : {}),
    limited: !scan.complete || scan.resultsTruncated || scan.outputTruncated,
    entries: [],
  };
  for (const hit of scan.results) {
    checkDashboardAbort(signal);
    let outcome =
      hit.excerpt.replace(/^# Outcome\s*\n/u, "").split(/\n# /u)[0] ?? "";
    const ref = historyChoice(access, { ...hit });
    if (ref?.kind === "answer") {
      try {
        const cached = previous.get(ref.id);
        const resolution =
          scan.complete &&
          cached &&
          cached.source.sourceHash === ref.revision &&
          fresh.has(
            JSON.stringify([ref.id, "answer", cached.source.sourceHash]),
          ) &&
          fresh.has(JSON.stringify([ref.id, "note", cached.questionRevision]))
            ? cached
            : await projectChoiceHistory(access, ref, signal);
        if (!resolution) throw Error("Saved answer unavailable");
        next.set(ref.id, resolution);
        outcome = "Answered: " + resolution.answer;
      } catch {
        checkDashboardAbort(signal);
        inventory.limited = true;
        outcome = "Saved answer unavailable in this preview.";
      }
      await access.assertCurrent();
      checkDashboardAbort(signal);
    }
    const title = line(hit.title, 160) || "Saved project note";
    const summary =
      line(outcome, 240) || "No summary available in this bounded preview.";
    const entry = {
      id: hit.uid,
      title,
      summary,
      ...(hit.source.path.length <= 512 ? { reference: hit.source.path } : {}),
    };
    if (
      title !== hit.title ||
      line(outcome, Number.MAX_SAFE_INTEGER) !== summary ||
      hit.excerptTruncated
    )
      inventory.limited = true;
    inventory.entries.push(entry);
    if (Buffer.byteLength(JSON.stringify(inventory), "utf8") > 8192) {
      inventory.entries.pop();
      inventory.limited = true;
      break;
    }
  }
  await access.assertCurrent();
  checkDashboardAbort(signal);
  if (cache?.scope === scope) cache.answers = next;
  return inventory;
}
