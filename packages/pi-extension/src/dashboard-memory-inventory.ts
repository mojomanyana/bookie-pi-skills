import { recallVault } from "pi-bookie-core";
import type { ChoiceAccess } from "./dashboard-open-choices.js";

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
): Promise<MemoryInventory> {
  checkDashboardAbort(signal);
  await access.assertCurrent();
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
      include: access.allows,
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
    const outcome =
      hit.excerpt.replace(/^# Outcome\s*\n/u, "").split(/\n# /u)[0] ?? "";
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
  return inventory;
}
