import { existsSync, realpathSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { containsDetectedSecret } from "pi-bookie-core";
import type { createManagedMemory } from "./managed-memory.js";
import type { createCaptureAuthority } from "./capture-authority.js";
import type { createDisclosureAuthority } from "./disclosure-authority.js";

interface StreamModelRegistry {
  find?(provider: string, id: string): unknown;
  streamSimple?(
    model: unknown,
    context: {
      messages: Array<{
        role: string;
        content: Array<{ type: string; text: string }>;
        timestamp: number;
      }>;
    },
    options?: { signal?: AbortSignal; reasoning?: string },
  ): {
    result(): Promise<{ content?: Array<{ type?: string; text?: string }> }>;
  };
}

function selectFastModel(
  registry: StreamModelRegistry | undefined,
  fallback: unknown,
): unknown {
  const spec = process.env.PI_ECO_MODEL_FAST?.trim();
  if (spec && typeof registry?.find === "function") {
    const sep = spec.includes("/") ? "/" : ":";
    const idx = spec.indexOf(sep);
    if (idx > 0) {
      const found = registry.find(
        spec.slice(0, idx).trim(),
        spec.slice(idx + 1).trim(),
      );
      if (found) return found;
    }
  }
  return fallback;
}

function collectBranchDigest(ctx: ExtensionContext): string {
  const branch = ctx.sessionManager?.getBranch?.() ?? [];
  const lines: string[] = [];
  for (const entry of branch.slice(-24)) {
    const row = entry as {
      type?: string;
      message?: {
        role?: string;
        content?: unknown;
      };
    };
    if (row.type !== "message" || !row.message) continue;
    const role = row.message.role;
    if (role !== "user" && role !== "assistant") continue;
    const blocks = Array.isArray(row.message.content)
      ? row.message.content
      : [];
    const text = blocks
      .filter(
        (b): b is { type: string; text: string } =>
          typeof b === "object" &&
          b !== null &&
          (b as { type?: unknown }).type === "text" &&
          typeof (b as { text?: unknown }).text === "string",
      )
      .map((b) => b.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 500);
    if (text) lines.push(`${role.toUpperCase()}: ${text}`);
  }
  return lines.join("\n").slice(-6000);
}

function slugTitle(raw: string): string {
  return (
    raw
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "checkpoint"
  );
}

export async function distillSessionCheckpoint(
  ctx: ExtensionContext,
  vaultRoot: string,
  signal?: AbortSignal,
): Promise<{ saved: boolean; path?: string; reason?: string }> {
  const digest = collectBranchDigest(ctx);
  if (digest.length < 40)
    return { saved: false, reason: "insufficient-history" };
  if (containsDetectedSecret(digest)) {
    return { saved: false, reason: "secret-detected-in-history" };
  }
  const registry = (ctx as unknown as { modelRegistry?: StreamModelRegistry })
    .modelRegistry;
  const fallback = (ctx as unknown as { model?: unknown }).model;
  const model = selectFastModel(registry, fallback);
  if (!model || typeof registry?.streamSimple !== "function") {
    return { saved: false, reason: "model-unavailable" };
  }
  const prompt = [
    "Distill this recent coding session into ONE concise project memory checkpoint.",
    'Return JSON only: {"title": "short title <=80 chars", "summary": "2-4 concise sentences covering key decisions, root causes, files changed, and open next steps"}.',
    "Never include secrets, tokens, or credentials.",
    "",
    digest,
  ].join("\n");
  const stream = registry.streamSimple(
    model,
    {
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: prompt }],
          timestamp: Date.now(),
        },
      ],
    },
    { ...(signal ? { signal } : {}), reasoning: "off" },
  );
  const message = await stream.result();
  const raw = (message?.content ?? [])
    .filter((c) => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text!)
    .join("\n")
    .trim();
  const match = /\{[\s\S]*\}/.exec(raw);
  if (!match) return { saved: false, reason: "unparseable-distillation" };
  let parsed: { title?: unknown; summary?: unknown };
  try {
    parsed = JSON.parse(match[0]) as { title?: unknown; summary?: unknown };
  } catch {
    return { saved: false, reason: "invalid-json" };
  }
  const title =
    typeof parsed.title === "string"
      ? parsed.title
          .replace(/[\r\n]+/g, " ")
          .trim()
          .slice(0, 100)
      : "";
  const summary =
    typeof parsed.summary === "string"
      ? parsed.summary.trim().slice(0, 1800)
      : "";
  if (!title || !summary) return { saved: false, reason: "empty-fields" };
  const body = [
    "---",
    `title: ${JSON.stringify(title)}`,
    "type: activity",
    "sensitivity: internal",
    `createdAt: ${JSON.stringify(new Date().toISOString())}`,
    "source: bookie-auto-distill",
    "---",
    "",
    `# ${title}`,
    "",
    summary,
    "",
  ].join("\n");
  if (containsDetectedSecret(body)) {
    return { saved: false, reason: "secret-detected-in-output" };
  }
  const canonical = realpathSync(vaultRoot);
  const notesDir = join(canonical, "notes");
  await mkdir(notesDir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = join(notesDir, `auto-${stamp}-${slugTitle(title)}.md`);
  await writeFile(target, body, { encoding: "utf8", mode: 0o600 });
  return { saved: true, path: target };
}

/**
 * Automatic cheap-model checkpoint distillation on `session_before_compact` + manual `/bookie-distill`.
 * Uses PI_ECO_MODEL_FAST (or current model at reasoning=off) with fail-closed secret detection.
 * Opt out with PI_BOOKIE_AUTO_DISTILL=0.
 */
export function registerAutoDistill(
  pi: ExtensionAPI,
  managed: ReturnType<typeof createManagedMemory>,
  authority: ReturnType<typeof createCaptureAuthority>,
  disclosure: ReturnType<typeof createDisclosureAuthority>,
): void {
  pi.on("session_before_compact", async (event, ctx) => {
    if (process.env.PI_BOOKIE_AUTO_DISTILL === "0") return;
    if (!authority.canManage() || !disclosure.canManage()) return;
    try {
      const selected = await managed.get(ctx).catch(() => undefined);
      const root = selected?.vault?.root;
      if (!root || !existsSync(root)) return;
      const res = await distillSessionCheckpoint(ctx, root, event.signal);
      if (res.saved && ctx.hasUI) {
        ctx.ui.notify(
          "Bookie auto-distilled checkpoint before compaction.",
          "info",
        );
      }
    } catch {
      /* Auto-distill never blocks compaction. */
    }
  });

  pi.registerCommand("bookie-distill", {
    description:
      "Distill a concise, secret-scanned project memory checkpoint using PI_ECO_MODEL_FAST",
    async handler(_args, ctx) {
      if (!authority.canManage() || !disclosure.canManage()) {
        ctx.ui.notify(
          "Bookie auto-distill requires an active managed project memory session.",
          "warning",
        );
        return;
      }
      const selected = await managed.get(ctx).catch(() => undefined);
      const root = selected?.vault?.root;
      if (!root || !existsSync(root)) {
        ctx.ui.notify(
          "No managed Bookie vault exists for this folder yet.",
          "warning",
        );
        return;
      }
      const res = await distillSessionCheckpoint(ctx, root);
      if (res.saved) {
        ctx.ui.notify(`Bookie checkpoint distilled: ${res.path}`, "info");
      } else {
        ctx.ui.notify(
          `Bookie checkpoint skipped (${res.reason ?? "unavailable"}).`,
          "warning",
        );
      }
    },
  });
}
