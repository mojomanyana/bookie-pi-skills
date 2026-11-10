import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { ProjectNote } from "./remember.js";
import { markedOpenChoice } from "./open-choice.js";
import { mentionsDeliveryUrl } from "./delivery-url.js";
import { scoutDeliveryUrls } from "./scout-delivery.js";

interface MemoryScope {
  save(note: ProjectNote, signal?: AbortSignal): Promise<string>;
}
type Resource = ProjectNote & { deliveryUrl: string };
type Pending = { note: Resource; scope: MemoryScope };
const MAX_DELIVERIES = 16;

export function registerDeliveryHandoff(
  pi: ExtensionAPI,
  bind: (ctx: ExtensionContext) => Promise<MemoryScope>,
) {
  let run:
    | {
        sessionId: string;
        cwd: string;
        controller: AbortController;
        explicit: Map<string, Pending>;
        scout: Map<string, { scope: MemoryScope; urls: Set<string> }>;
      }
    | undefined;
  const reset = () => {
    run?.controller.abort();
    run = undefined;
  };
  pi.on("agent_start", (_event, ctx) => {
    reset();
    run = {
      sessionId: ctx.sessionManager.getSessionId(),
      cwd: ctx.cwd,
      controller: new AbortController(),
      explicit: new Map(),
      scout: new Map(),
    };
  });
  pi.on("session_shutdown", reset);
  pi.on("session_start", reset);
  pi.on("model_select", reset);
  pi.on("session_tree", reset);

  function current(ctx: ExtensionContext) {
    if (
      run &&
      run.cwd === ctx.cwd &&
      run.sessionId === ctx.sessionManager.getSessionId()
    )
      return run;
  }
  pi.on("tool_result", async (event, ctx) => {
    const active = current(ctx);
    if (!active || event.toolName !== "scout_research" || event.isError) return;
    const urls = scoutDeliveryUrls(event.details);
    if (!urls.length) return;
    try {
      const scope = await bind(ctx);
      if (current(ctx) === active && active.scout.size < MAX_DELIVERIES) {
        active.scout.set(event.toolCallId, { urls: new Set(urls), scope });
      }
    } catch {
      // A workspace without managed memory can still use Scout.
    }
  });
  pi.on("agent_end", async (event, ctx) => {
    const active = current(ctx);
    if (!active) return;
    try {
      const final = event.messages.at(-1);
      if (
        (!active.explicit.size && !active.scout.size) ||
        final?.role !== "assistant" ||
        final.stopReason !== "stop"
      )
        return;
      const blocks = final.content.filter((block) => block.type === "text");
      const start =
        event.messages.findLastIndex((message) => message.role === "user") + 1;
      // Only the tool results for the request that produced this final, including
      // any changes applied by other extensions before they became visible to Pi.
      const receipts = event.messages
        .slice(start, -1)
        .filter((message) => message.role === "toolResult")
        .filter((message) => !message.isError);
      const candidates = new Map<string, Pending>();
      for (const receipt of receipts) {
        const pending = active.explicit.get(receipt.toolCallId);
        if (receipt.toolName === "bookie_remember" && pending)
          candidates.set(pending.note.deliveryUrl, pending);
      }
      for (const receipt of receipts) {
        const seen = active.scout.get(receipt.toolCallId);
        if (receipt.toolName !== "scout_research" || !seen) continue;
        for (const url of scoutDeliveryUrls(receipt.details)) {
          if (seen.urls.has(url) && !candidates.has(url))
            candidates.set(url, {
              scope: seen.scope,
              note: {
                title: "Shared resource",
                summary: "Public research reference included in Pi’s reply.",
                deliveryUrl: url,
              },
            });
        }
      }
      // A reply-wide choice belongs to a single delivered item. Ambiguous
      // multi-resource handoffs must identify each choice in its own note.
      const delivered: Pending[] = [];
      for (const [url, pending] of candidates) {
        if (blocks.some((block) => mentionsDeliveryUrl(block.text, url))) {
          delivered.push(pending);
          if (delivered.length === MAX_DELIVERIES) break;
        }
      }
      const replyChoice =
        delivered.length === 1 &&
        blocks.reduce((length, block) => length + block.text.length + 2, 0) <=
          65536
          ? markedOpenChoice(blocks.map((block) => block.text).join("\n\n"))
          : undefined;
      for (const item of delivered) {
        if (active.controller.signal.aborted) break;
        try {
          await item.scope.save(
            replyChoice && replyChoice !== item.note.openChoice?.trim()
              ? {
                  title: item.note.title,
                  summary: item.note.summary,
                  deliveryUrl: item.note.deliveryUrl,
                  openChoice: replyChoice,
                }
              : item.note,
            active.controller.signal,
          );
        } catch {
          if (!active.controller.signal.aborted)
            ctx.ui.notify(
              "Bookie could not confirm saving the shared resource for the next session.",
              "warning",
            );
        }
      }
    } finally {
      if (run === active) reset();
    }
  });
  return {
    stage(
      callId: string,
      ctx: ExtensionContext,
      scope: MemoryScope,
      note: Resource,
    ) {
      const active = current(ctx);
      if (!active || active.explicit.size >= MAX_DELIVERIES)
        throw Error("Resource handoff unavailable.");
      active.explicit.set(callId, { scope, note });
      return "pending final reply";
    },
  };
}
