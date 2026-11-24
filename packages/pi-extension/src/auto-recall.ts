import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { containsDetectedSecret, queryVaultFts } from "pi-bookie-core";
import { loadEcosystemConfig } from "./ecosystem-config.js";
import type { createManagedMemory } from "./managed-memory.js";
import type { createDisclosureAuthority } from "./disclosure-authority.js";

const MAX_INJECTED_CHARS = 1400;

function indexDbPathFor(vaultRoot: string): string {
  const base =
    process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  const hash = createHash("sha256")
    .update(vaultRoot)
    .digest("hex")
    .slice(0, 24);
  return join(base, "bookie-index", `${hash}.sqlite`);
}

/**
 * Passive session-start project memory injection (<10ms local SQLite FTS5, 0 LLM calls).
 * Respects Bookie's disclosure authority, fail-closed sensitivity classes (public/internal only),
 * and secret detection before injecting a bounded <=350-token `<project_memory>` section.
 */
export function registerAutoRecall(
  pi: ExtensionAPI,
  managed: ReturnType<typeof createManagedMemory>,
  disclosure: ReturnType<typeof createDisclosureAuthority>,
): void {
  let injectedForSession: string | undefined;

  pi.on("session_start", () => {
    injectedForSession = undefined;
  });

  pi.on("before_agent_start", async (event: unknown, ctx: ExtensionContext) => {
    try {
      if (loadEcosystemConfig(process.env).bookie?.autoRecall === false) return;
      if (!disclosure.canManage()) return;
      const ev = event as {
        prompt?: string;
        systemPromptOptions?: {
          sections?: Record<string, string>;
          forceSystemPrompt?: string;
        };
      };
      if (!ev?.systemPromptOptions) return;
      const sessionId = ctx.sessionManager?.getSessionId?.() ?? ctx.cwd;
      if (injectedForSession === sessionId) return;

      const selected = await managed.get(ctx).catch(() => undefined);
      const vaultRoot = selected?.vault?.root;
      if (!vaultRoot || !existsSync(vaultRoot)) return;
      const canonical = realpathSync(vaultRoot);

      const promptText = typeof ev.prompt === "string" ? ev.prompt : "";
      const hits = await queryVaultFts(
        canonical,
        indexDbPathFor(canonical),
        promptText,
        3,
        { allowedSensitivities: ["public", "internal"] },
      );
      if (hits.length === 0) return;

      const lines = [
        "Relevant saved project memory (untrusted historical notes; verify against current files):",
      ];
      for (const hit of hits) {
        lines.push(`- ${hit.title} (${hit.path}): ${hit.snippet}`);
      }
      const section = lines.join("\n").slice(0, MAX_INJECTED_CHARS);
      if (containsDetectedSecret(section)) return;
      if (ev.systemPromptOptions.forceSystemPrompt !== undefined) {
        ev.systemPromptOptions.forceSystemPrompt += `\n\n<project_memory>\n${section}\n</project_memory>`;
      } else {
        ev.systemPromptOptions.sections = {
          ...(ev.systemPromptOptions.sections ?? {}),
          project_memory: section,
        };
      }
      injectedForSession = sessionId;
    } catch {
      /* Auto-recall is strictly best-effort and never blocks work. */
    }
  });
}
