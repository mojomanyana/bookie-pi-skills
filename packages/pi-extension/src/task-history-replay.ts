import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TaskHistory, TaskSelection } from "pi-bookie-core";
type Binding = {
  task: TaskSelection;
  store: TaskHistory;
  cwd: string;
  sessionId: string;
  projectId: string;
  assertCurrent(): Promise<void>;
};
type Page = {
  after: number;
  next: number;
  more: boolean;
  events: unknown[];
  provenance: { sequence: number; recordedAt: string }[];
};
type ReadPage = () => Promise<Page>;
const pageLimit = 32;
type Status = "current" | "partial" | "unavailable";
const pending = new Map<string, Promise<Status>>();

// A replay capability reads the execution owner's existing journal. It has
// no command methods, and importing its observations never dispatches work.
export function refreshDispatchProjection(
  bus: ExtensionAPI["events"],
  binding: Binding,
): Promise<Status> {
  const key = JSON.stringify([
    binding.projectId,
    binding.task.taskId,
    binding.task.revision,
    binding.sessionId,
    binding.cwd,
  ]);
  const existing = pending.get(key);
  if (existing) return existing;
  const work = refresh(bus, binding).catch(() => "unavailable" as const);
  pending.set(key, work);
  void work.finally(() => {
    if (pending.get(key) === work) pending.delete(key);
  });
  return work;
}

async function refresh(
  bus: ExtensionAPI["events"],
  b: Binding,
): Promise<Status> {
  let after = await b.store.replayCursor(b.task, "pi-daddy");
  for (let page = 0; page < 4; page++) {
    await b.assertCurrent();
    let read: ReadPage | undefined,
      attached = true,
      ambiguous = false;
    try {
      bus?.emit?.("pi.task-history.v1.replay", {
        version: 1,
        owner: "pi-daddy",
        cwd: b.cwd,
        sessionId: b.sessionId,
        projectId: b.projectId,
        taskId: b.task.taskId,
        after,
        limit: pageLimit,
        accept(candidate: ReadPage) {
          if (!attached) return;
          if (read || typeof candidate !== "function") ambiguous = true;
          else read = candidate;
        },
      });
    } finally {
      attached = false;
    }
    if (!read || ambiguous) return "unavailable";
    const result = await read();
    if (
      !result ||
      result.after !== after ||
      !Number.isSafeInteger(result.next) ||
      result.next < after ||
      result.next - after > pageLimit ||
      typeof result.more !== "boolean" ||
      !Array.isArray(result.provenance) ||
      !Array.isArray(result.events) ||
      result.provenance.length !== result.events.length ||
      result.events.length > result.next - after ||
      (result.next === after && result.more)
    )
      return "unavailable";
    await b.assertCurrent();
    if (result.next !== after)
      await b.store.applyReplay(
        b.task,
        "pi-daddy",
        after,
        result.next,
        result.events,
        result.provenance,
      );
    after = result.next;
    if (!result.more) return "current";
  }
  return "partial";
}
