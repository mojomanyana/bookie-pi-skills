/* eslint-disable preserve-caught-error -- This disclosure boundary intentionally drops private provider/filesystem causes. */
import type {
  MutationDiagnostic,
  PrepareCheckpointFailureReason,
} from "pi-bookie-core";
import type { createBookieContextFilter } from "./context-filter.js";
import { resolve } from "node:path";
import type {
  AgentToolResult,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import {
  DISCLOSURE_WITHHELD,
  MUTATION_WITHHELD,
  type createDisclosureAuthority,
} from "./disclosure-authority.js";
const payloads = new WeakMap<object, object>();
export function retainToolPayload<T extends object>(
  result: T,
  payload: object,
): T {
  payloads.set(result, payload);
  return result;
}
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
type BookieToolName =
  | "bookie_read"
  | "bookie_search"
  | "bookie_validate"
  | "bookie_write"
  | "bookie_checkpoint";
export function guardBookieTool<P extends TSchema, D, S>(
  tool: ToolDefinition<P, D, S>,
  authority: ReturnType<typeof createDisclosureAuthority>,
  format: (
    name: BookieToolName,
    result: object,
    mode: "filesystem",
    complete: boolean,
  ) => AgentToolResult<D>,
  contextFilter?: ReturnType<typeof createBookieContextFilter>,
): ToolDefinition<P, D, S> {
  return {
    ...tool,
    async execute(callId, params, signal, _onUpdate, ctx) {
      const values: unknown = params;
      const mutation =
        tool.name === "bookie_write" || tool.name === "bookie_checkpoint";
      let entered = false;
      let ticket: Awaited<ReturnType<typeof authority.capture>> | undefined;
      try {
        const root = resolve(
          ctx.cwd,
          object(values) && typeof values.vault === "string"
            ? values.vault.replace(/^@/, "")
            : "",
        );
        const canonical =
          tool.name === "bookie_read" ||
          tool.name === "bookie_search" ||
          tool.name === "bookie_validate";
        ticket = await authority.capture(
          root,
          ctx,
          canonical ? "canonical" : "registry",
        );
        entered = true;
        const result = await tool.execute(
          callId,
          params,
          signal,
          undefined,
          ctx,
        );
        const raw = payloads.get(result);
        if (!object(raw)) throw Error(DISCLOSURE_WITHHELD);
        let filtered: Record<string, unknown>;
        if (tool.name === "bookie_read") {
          if (!ticket.allows(raw)) throw Error(DISCLOSURE_WITHHELD);
          filtered = Object.fromEntries(
            Object.entries(raw).filter(
              ([key]) =>
                ![
                  "diagnostics",
                  "rejectedConcepts",
                  "diagnosticsTruncated",
                ].includes(key),
            ),
          );
        } else if (tool.name === "bookie_search") {
          filtered = {
            mode: "filesystem",
            complete: raw.complete === true && !raw.resultsTruncated,
            results: (Array.isArray(raw.results) ? raw.results : []).filter(
              ticket.allows,
            ),
            scope: "selected project and allowed classes",
            resultsTruncated: raw.resultsTruncated === true,
          };
        } else if (tool.name === "bookie_validate") {
          filtered = {
            status:
              "Local validation completed; detailed vault diagnostics are available only locally.",
            complete: true,
          };
        } else if (mutation) {
          filtered = {
            ...(typeof raw.ok === "boolean" ? { ok: raw.ok } : {}),
            ...(typeof raw.operation === "string"
              ? { operation: raw.operation }
              : {}),
            ...(typeof raw.outcome === "string"
              ? { outcome: raw.outcome }
              : {}),
            status:
              typeof raw.status === "string"
                ? raw.status
                : typeof raw.outcome === "string"
                  ? raw.outcome
                  : "completed",
            detailsWithheld: true,
          };
        } else throw Error(DISCLOSURE_WITHHELD);
        await ticket.assertCurrent();
        const formatted = format(
          tool.name as BookieToolName,
          filtered,
          "filesystem",
          filtered.complete !== false,
        );
        contextFilter?.remember(callId, formatted, ticket.assertCurrent);
        return formatted;
      } catch (error) {
        // Neither arbitrary underlying errors nor result.details can escape this boundary.
        if (ticket) {
          try {
            await ticket.assertCurrent();
          } catch {
            throw Error(
              mutation && entered ? MUTATION_WITHHELD : DISCLOSURE_WITHHELD,
            );
          }
          if (error instanceof Error) {
            if (error.name === "AbortError")
              throw new DOMException(
                "Bookie request was aborted.",
                "AbortError",
              );
            if (
              SAFE_ERRORS.has(error.message) ||
              /^Bookie (write|checkpoint) failed: [A-Z0-9,-]{1,256}\.$/.test(
                error.message,
              )
            )
              throw Error(error.message);
          }
        }
        throw Error(
          mutation && entered ? MUTATION_WITHHELD : DISCLOSURE_WITHHELD,
        );
      }
    },
  };
}

// Only fixed public contract guidance may cross the disclosure boundary.
// Diagnostic files, values, arbitrary pointers and validator messages stay private.
const AUTHORING_FEEDBACK = {
  path: "Bookie write failed: MUTATION-PATH. Check request.path: use a vault-relative Markdown path without a leading slash, dot segments or backslashes, outside reserved/excluded locations.",
  checkpointVault:
    "Bookie checkpoint failed: vault. Check request.path: use a vault-relative Markdown path without a leading slash or dot segments, with an existing safe parent in the selected vault.",
  sensitivity:
    "Bookie checkpoint failed: sensitivity-policy. Check frontmatter.bookie.sensitivity and fragments[].sensitivity against the vault's declared classes; the Activity class must not be excluded. Preserve the content's true classification.",
  state:
    "Bookie write failed: CONCEPT-SCHEMA. Check frontmatter.bookie.state against the concept type's allowed states. Task states: proposed, ready, in_progress, blocked, done, cancelled.",
} as const;

export function writeFailureMessage(
  diagnostics: readonly MutationDiagnostic[],
): string {
  const codes = [...new Set(diagnostics.map(({ code }) => code))].sort();
  if (codes.length === 1 && codes[0] === "MUTATION-PATH")
    return AUTHORING_FEEDBACK.path;
  if (
    codes.length === 1 &&
    codes[0] === "CONCEPT-SCHEMA" &&
    diagnostics.some(
      ({ instancePath, keyword }) =>
        instancePath === "/bookie/state" && keyword === "enum",
    )
  )
    return AUTHORING_FEEDBACK.state;
  return `Bookie write failed: ${codes.join(",") || "MUTATION-INPUT"}.`;
}

export function checkpointPreparationFailureMessage(
  reason: PrepareCheckpointFailureReason,
): string {
  if (reason === "vault") return AUTHORING_FEEDBACK.checkpointVault;
  if (reason === "sensitivity-policy") return AUTHORING_FEEDBACK.sensitivity;
  return `Bookie checkpoint failed: ${reason}.`;
}

const SAFE_ERRORS = new Set([
  ...Object.values(AUTHORING_FEEDBACK),
  "Bookie read failed: not-found.",
  "Bookie read failed: invalid-selector.",
  "Bookie read failed: incomplete.",
  "Bookie checkpoint failed: secret-policy.",
  "Bookie approval must come from trusted host authority, not tool arguments.",
  "Bookie authority expired or was revoked.",
  "Bookie capture permission was revoked.",
  "Bookie capture project revision changed; select it again.",
  "Bookie checkpoint failed: bounds.",
  "Bookie checkpoint is already staged.",
  "Bookie checkpoint may have changed canonical files; reread and validate before retrying.",
  "Bookie checkpoint requires trusted approval in non-interactive mode.",
  "Bookie read rejected by sensitivity policy.",
  "Bookie search could not complete safely.",
  "Bookie validation could not complete safely.",
  "Bookie write may have changed canonical files; reread and validate before retrying.",
  "Bookie write request file is invalid.",
  "Bookie write requires trusted approval in non-interactive mode.",
  "Bookie write was not approved.",
  "changed request file",
  "large request file",
  "unsafe request file",
]);
