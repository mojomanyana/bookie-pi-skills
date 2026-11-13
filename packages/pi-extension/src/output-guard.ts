/* eslint-disable preserve-caught-error -- This disclosure boundary intentionally drops private provider/filesystem causes. */
import {
  answeredChoiceIds,
  historyChoice,
  projectChoiceHistory,
} from "./choice-answer.js";
import type {
  MutationDiagnostic,
  PrepareCheckpointFailureReason,
} from "pi-bookie-core";
import type { createBookieContextFilter } from "./context-filter.js";
import { managedRecall, RECALL_INPUT_ERROR } from "./managed-recall.js";
import { resolve } from "node:path";
import {
  ProjectMemoryUnavailable,
  isProjectMemoryUnavailableMessage,
} from "./memory-readiness.js";
import type {
  AgentToolResult,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import {
  DISCLOSURE_WITHHELD,
  MUTATION_WITHHELD,
  WrongRecallVault,
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
      const recall =
        tool.name === "bookie_read" || tool.name === "bookie_search";
      let entered = false;
      let ticket: Awaited<ReturnType<typeof authority.capture>> | undefined;
      try {
        const suppliedVault =
          object(values) && typeof values.vault === "string"
            ? values.vault
            : undefined;
        if (suppliedVault === "@" || suppliedVault === "")
          throw Error(DISCLOSURE_WITHHELD);
        const root =
          suppliedVault === undefined
            ? await authority.selectedRoot(ctx)
            : resolve(ctx.cwd, suppliedVault.replace(/^@/, ""));
        const input =
          object(values) && values.vault === undefined
            ? { ...params, vault: root }
            : params;
        const canonical = recall || tool.name === "bookie_validate";
        ticket = await authority.capture(
          root,
          ctx,
          canonical ? "canonical" : "registry",
          suppliedVault !== undefined && recall,
        );
        entered = true;
        const managedSearch =
          tool.name === "bookie_search" &&
          ticket.managedWorkspace &&
          object(values) &&
          values.mode !== "exact";
        const raw = managedSearch
          ? await managedRecall(ticket, values, signal)
          : payloads.get(
              await tool.execute(callId, input, signal, undefined, ctx),
            );
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
          const ref = historyChoice(ticket, raw);
          if (ref) {
            const resolution = await projectChoiceHistory(ticket, ref);
            if (resolution) filtered.choiceResolution = resolution;
          }
        } else if (tool.name === "bookie_search") {
          const results: unknown[] = [];
          let checked = 0,
            limited = false;
          const visible: Record<string, unknown>[] = (
            Array.isArray(raw.results) ? raw.results : []
          ).filter(ticket.allows);
          const candidates = visible.map((hit) => ({
            hit,
            ref: historyChoice(ticket!, hit),
          }));
          // A large general search often mostly finds ordinary notes. Check the
          // receipt index once, then spend exact reads only on linked choices.
          const index =
            candidates.filter((x) => x.ref).length > 8
              ? await answeredChoiceIds(ticket)
              : undefined;
          for (const { hit, ref } of candidates) {
            if (
              !ref ||
              (ref.kind === "note" &&
                index?.complete &&
                !index.truncated &&
                !index.ids.has(ref.id))
            ) {
              results.push(hit);
              continue;
            }
            if (++checked > 8) {
              limited = true;
              if (ref.kind === "note")
                results.push({
                  ...hit,
                  choiceResolution: { status: "unknown" },
                });
              continue;
            }
            try {
              const resolution = await projectChoiceHistory(ticket, ref);
              results.push(
                resolution ? { ...hit, choiceResolution: resolution } : hit,
              );
            } catch {
              limited = true;
            }
          }
          filtered = {
            mode: "filesystem",
            complete:
              raw.complete === true && !raw.resultsTruncated && !limited,
            results,
            scope: "selected project and allowed classes",
            resultsTruncated: raw.resultsTruncated === true || limited,
            outputTruncated: raw.outputTruncated === true,
            ...(managedSearch
              ? {
                  queryMode: raw.queryMode,
                  matching: raw.matching,
                  ordering: raw.ordering,
                  limit: raw.limit,
                  matchedCount: raw.matchedCount,
                  scanComplete: raw.complete === true,
                }
              : {
                  queryMode: "exact",
                  matching: "literal-case-sensitive-substring",
                  ordering: "path-asc",
                }),
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
        if (recall && !entered) {
          if (error instanceof WrongRecallVault)
            throw Error(WrongRecallVault.detail);
          if (
            error instanceof ProjectMemoryUnavailable &&
            isProjectMemoryUnavailableMessage(error.message)
          )
            throw Error(error.message);
        }
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
  checkpointInput:
    "Bookie checkpoint failed: input. No checkpoint was written. Check complete Activity metadata and all seven fragment sections. generated.by must be human:<id>, process:<id>, or <producer>/<version>; bookie.uid must be ACT- followed by a 26-character ULID. Use the packaged checkpoint metadata helper for host-owned identity and UTC time.",
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
  if (reason === "input") return AUTHORING_FEEDBACK.checkpointInput;
  if (reason === "vault") return AUTHORING_FEEDBACK.checkpointVault;
  if (reason === "sensitivity-policy") return AUTHORING_FEEDBACK.sensitivity;
  return `Bookie checkpoint failed: ${reason}.`;
}

const SAFE_ERRORS = new Set([
  RECALL_INPUT_ERROR,
  "Bookie exact search needs a query. Recent mode is available only for managed project memory.",
  ...Object.values(AUTHORING_FEEDBACK),
  "Bookie needs a short non-sensitive project title and summary.",
  "Bookie needs a short non-sensitive project title and summary, and a safe public URL if supplied.",
  "Bookie could not confirm the save. Recall this note before retrying.",
  "Routine memory is unavailable. This workspace needs current Pi Daddy Auto and Bookie capture and disclosure authority.",
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

/** Fixed public failures contain no vault data, authority or successful read body. */
export function isStaticBookieErrorMessage(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (isProjectMemoryUnavailableMessage(value) ||
      value === WrongRecallVault.detail ||
      SAFE_ERRORS.has(value) ||
      value === DISCLOSURE_WITHHELD ||
      value === MUTATION_WITHHELD ||
      value === "Bookie request was aborted.")
  );
}
