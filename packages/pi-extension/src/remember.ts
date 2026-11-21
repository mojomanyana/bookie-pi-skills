import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { posix, resolve } from "node:path";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import {
  type ExtensionContext,
  defineTool,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import {
  containsDetectedSecret,
  createCheckpointWithPolicy,
  inspectConcept,
  loadConcept,
} from "pi-bookie-core";
import { prepareManagedActivity } from "./managed-activity.js";
import type { createManagedMemory } from "./managed-memory.js";
import type { createDisclosureAuthority } from "./disclosure-authority.js";
import type { createCaptureAuthority } from "./capture-authority.js";
import type { createBookieContextFilter } from "./context-filter.js";

import {
  choiceGuidance,
  markedOpenChoice,
  validOpenChoice,
  type ChoiceRecommendation,
} from "./open-choice.js";
import { isDeliveryUrl } from "./delivery-url.js";
import { registerDeliveryHandoff } from "./delivery-handoff.js";
import {
  evidenceKinds,
  isScoutCheckpointEvidence,
  registeredDelegate,
  selectCheckpointEvidence,
  validEvidenceSelection,
  type CheckpointEvidence,
  type EvidenceSelection,
} from "./checkpoint-evidence.js";
import { registerCheckpointScout } from "./scout-checkpoint-source.js";
import { REMEMBER_INPUT_ERROR } from "./output-guard.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface ProjectNote extends EvidenceSelection {
  title: string;
  summary: string;
  nextAction?: string;
  deliveryUrl?: string;
  openChoice?: string;
  choiceOptions?: string[];
  choiceRecommendation?: ChoiceRecommendation;
}

function checkNote(note: ProjectNote): boolean {
  return (
    Object.keys(note).every((key) =>
      [
        "title",
        "summary",
        "evidenceCallIds",
        "includeEvidence",
        "nextAction",
        "deliveryUrl",
        "openChoice",
        "choiceOptions",
        "choiceRecommendation",
      ].includes(key),
    ) &&
    typeof note.title === "string" &&
    note.title.trim().length > 0 &&
    note.title.length <= 120 &&
    !/[\r\n]/u.test(note.title) &&
    typeof note.summary === "string" &&
    note.summary.trim().length > 0 &&
    validEvidenceSelection(note) &&
    note.summary.length <=
      (note.includeEvidence || note.evidenceCallIds ? 4000 : 2000) &&
    !containsDetectedSecret(note.title + "\n" + note.summary) &&
    // Next actions use the same bounded, non-sensitive line shape, not choice semantics.
    (note.nextAction === undefined || validOpenChoice(note.nextAction)) &&
    (note.openChoice === undefined || validOpenChoice(note.openChoice)) &&
    ((note.choiceOptions === undefined &&
      note.choiceRecommendation === undefined) ||
      (note.openChoice !== undefined &&
        !!choiceGuidance(
          note.choiceOptions,
          note.choiceRecommendation,
          note.summary,
          note.deliveryUrl,
        ))) &&
    (note.deliveryUrl === undefined || isDeliveryUrl(note.deliveryUrl))
  );
}

export function rememberTool(
  pi: ExtensionAPI,
  managed: ReturnType<typeof createManagedMemory>,
  capture: ReturnType<typeof createCaptureAuthority>,
  disclosure: ReturnType<typeof createDisclosureAuthority>,
  filter: ReturnType<typeof createBookieContextFilter>,
  noteLink?: (
    ctx: ExtensionContext,
  ) => ((path: string, digest: string) => Promise<void>) | undefined,
) {
  async function bind(ctx: ExtensionContext) {
    const selected = await managed.get(ctx);
    if (
      !selected ||
      !capture.selectManaged(selected) ||
      !disclosure.canManage()
    )
      throw Error();
    const ticket = await disclosure.capture(
      selected.vault.root,
      ctx,
      "canonical",
    );
    const assertCurrent = async () => {
      await ticket.assertCurrent();
      await capture.assertManaged(selected);
    };
    const linkToTask = noteLink?.(ctx);
    async function save(
      note: ProjectNote,
      signal?: AbortSignal,
      onMutation?: () => void,
      baseline?: ReturnType<typeof selectCheckpointEvidence>,
    ) {
      if (!checkNote(note)) throw Error();
      const { title, summary, deliveryUrl, nextAction } = note;
      const legacyChoice = markedOpenChoice(summary, true);
      const choice = note.openChoice?.trim() ?? legacyChoice;
      const guidance = note.choiceOptions?.length
        ? choiceGuidance(
            note.choiceOptions,
            note.choiceRecommendation,
            summary,
            deliveryUrl,
          )
        : undefined;
      const guard = async () => {
        await assertCurrent();
        signal?.throwIfAborted();
        if (
          baseline &&
          !isDeepStrictEqual(selectCheckpointEvidence(ctx, note), baseline)
        )
          throw Error("The active evidence selection changed.");
      };
      await guard();
      const attached: Array<CheckpointEvidence & { registrationId?: string }> =
        [];
      const gaps = new Set(
        baseline?.status === "selected" ? baseline.missing : [],
      );
      for (const evidence of baseline?.status === "selected"
        ? baseline.sources
        : []) {
        if (!isScoutCheckpointEvidence(evidence)) {
          const registrationId =
            evidence.executionId && evidence.role
              ? registeredDelegate(evidence, await realpath(ctx.cwd), ticket)
              : undefined;
          attached.push(
            registrationId ? { ...evidence, registrationId } : evidence,
          );
          if (evidence.kind === "research") gaps.add("research");
          continue;
        }
        const grant = await capture.referenceGrant();
        if (
          grant &&
          grant.vault.root === ticket.root &&
          grant.project.path === ticket.scope.project.path &&
          grant.project.sourceHash === ticket.scope.project.sourceHash
        ) {
          const registration = await registerCheckpointScout(
            pi,
            ctx,
            evidence,
            grant,
            guard,
            signal,
          );
          if (registration) {
            attached.push({
              ...evidence,
              registrationId: registration.registrationId,
            });
            continue;
          }
        }
        gaps.add("research");
      }
      await guard();
      const missing = [...gaps].sort();
      const evidenceText = [
        ...(deliveryUrl ? [deliveryUrl] : []),
        ...attached.map(
          (source) =>
            `${source.kind}: ${source.tool}${source.role ? " " + source.role : ""} (${source.status}); Pi session ${source.sessionId}, call ${source.callId}.` +
            (source.verification
              ? ` Inspect principal_workflow verification for task ${source.verification.task}, step ${source.verification.step}, attempt ${source.verification.attempt}. Match receipt SHA-256 ${source.verification.sha256}.`
              : "") +
            (source.registrationId
              ? ` Registered source ${source.registrationId}; use bookie_reference_read part ${source.kind === "research" ? "brief" : "final"} under current access.`
              : " Historical call locator; outcome and body access require separate evidence."),
        ),
        ...missing.map((kind) => `${kind}: no available source linked.`),
      ].join("\n");
      const hash = createHash("sha256")
        .update(
          JSON.stringify([
            ticket.scope.project.uid,
            title,
            summary,
            ...(deliveryUrl ? [deliveryUrl] : []),
            ...(choice && choice !== legacyChoice
              ? [{ openChoice: choice }]
              : []),
            ...(guidance ? [{ choiceGuidance: guidance }] : []),
            ...(nextAction ? [{ nextAction }] : []),
            ...(attached.length || missing.length
              ? [{ evidence: attached, missing }]
              : []),
          ]),
        )
        .digest("hex");
      const path = posix.join(
        posix.dirname(ticket.scope.project.path),
        "activities",
        "note-" + hash.slice(0, 32) + ".md",
      );
      const uid = "ACT-0" + hash.slice(0, 25).toUpperCase();
      const prepared = await prepareManagedActivity(
        ticket.root,
        {
          path,
          uid,
          project: ticket.scope.project.path,
          title,
          ...(choice ? { tags: ["open-choice"] } : {}),
          fields: {
            ...(guidance ? { choice_guidance: guidance } : {}),
            ...(attached.length ? { checkpoint_evidence: attached } : {}),
          },
          sections: {
            outcome: deliveryUrl
              ? "Pi shared this resource with the user. " + summary
              : summary,
            ...(evidenceText ? { evidence: evidenceText } : {}),
            ...(choice ? { "unresolved-work": choice } : {}),
            ...(nextAction ? { "next-action": nextAction } : {}),
          },
        },
        ctx.sessionManager.getSessionId(),
        signal,
      );
      if (!prepared.ok) throw Error();
      // The same title and summary retry the same record. An edited or suppressed
      // existing record must never be overwritten or confirmed as a match.
      const readExisting = async () => {
        const found = await inspectConcept(
          ticket.root,
          { path },
          {
            maxContentBytes: baseline ? 32000 : 16000,
            ...(signal ? { signal } : {}),
          },
        );
        if (!found.ok) {
          if (found.reason === "not-found") return false;
          throw Error();
        }
        if (
          !ticket.allows(found) ||
          found.uid !== uid ||
          found.handling !== "ordinary" ||
          found.type !== "Activity" ||
          found.sourceTruncated
        )
          throw Error();
        const loaded = loadConcept(Buffer.from(found.sourceText), {
          file: path,
        });
        if (!loaded.ok || loaded.concept.frontmatter.title !== title)
          throw Error();
        const bookie = loaded.concept.frontmatter.bookie;
        if (
          typeof bookie !== "object" ||
          !bookie ||
          Array.isArray(bookie) ||
          !isDeepStrictEqual(
            "checkpoint_evidence" in bookie
              ? bookie.checkpoint_evidence
              : undefined,
            attached.length ? attached : undefined,
          ) ||
          !isDeepStrictEqual(
            "choice_guidance" in bookie ? bookie.choice_guidance : undefined,
            guidance,
          )
        )
          throw Error();
        const existing = loaded.concept.bodyText.trim();
        const expected = prepared.preview.bodyText.trim();
        if (existing === expected) return true;
        // Before structured choices, this same content-addressed note already
        // stored the question in Outcome. Verify its complete previous-format
        // body before accepting a retry without mutating the immutable note.
        const oldSection = "\n# Unresolved work\n\n";
        if (
          !legacyChoice ||
          legacyChoice !== choice ||
          existing !==
            expected.replace(
              oldSection + choice + "\n\n# Next action",
              oldSection +
                "No additional information recorded.\n\n# Next action",
            )
        )
          throw Error();
        return true;
      };
      const outcome = await withFileMutationQueue(
        resolve(ticket.root, path.slice(1)),
        async () => {
          await guard();
          if (await readExisting()) return "already saved";
          onMutation?.();
          const result = await createCheckpointWithPolicy(
            prepared.publication,
            { assertAuthority: guard, ...(signal ? { signal } : {}) },
          );
          if (!result.ok) {
            if (
              !result.changedPaths.length &&
              result.diagnostics.some(
                (d) =>
                  d.code === "MUTATION-TARGET" ||
                  d.code === "MUTATION-CONFLICT",
              ) &&
              (await readExisting())
            )
              return "already saved";
            throw Error();
          }
          if (result.redacted) throw Error();
          return "saved";
        },
      );
      await guard();
      if (linkToTask) {
        try {
          const actual = await inspectConcept(
            ticket.root,
            { path },
            { maxContentBytes: 1 },
          );
          if (actual.ok && ticket.allows(actual))
            await linkToTask(path, actual.source.sourceHash);
        } catch {
          /* The canonical note receipt survives optional task linking. */
        }
      }
      await managed.refreshDashboard(ctx);
      await guard();
      return {
        status: outcome,
        readBack: { selector: "path" as const, value: path },
        ...(baseline ? { evidence: attached, missingEvidence: missing } : {}),
      };
    }
    return { assertCurrent, save };
  }

  const deliveries = registerDeliveryHandoff(pi, bind);
  return defineTool({
    name: "bookie_remember",
    label: "Remember project note",
    description:
      "Save a bounded routine project decision or outcome as untrusted project context: title at most 120 characters, summary at most 2000 characters (4000 with evidence). For a completed task use includeEvidence for the relevant decision, research and validation receipts, before condensing the work into prose. Use nextAction (at most 240 characters) for a known work step, including already-authorized research, build or review. Save each concrete unresolved user-owned decision once. Put references to already-saved decisions in the summary, not a combined openChoice. Use openChoice only for a concrete unresolved decision the user still owns; do not ask whether to proceed with work already authorized in the current conversation. Neither field grants permission. Supply choiceOptions for real alternatives and choiceRecommendation only when a saved fact or delivered reference supports it. For a newly delivered public resource, supply deliveryUrl; it is recorded once the link appears in the finished reply. Immediate saved/already-saved replies give exact bookie_read parameters in readBack; use them when read-back is requested or needed and compare the content. Pending final-reply deliveries have no confirmed locator. Correct a pre-execution schema validation error and retry the save directly; if a save could have happened but confirmation is uncertain, recall the known note before retrying. During ordinary recall, reuse the saved receipt. Exclude personal information, private sources and credentials.",
    parameters: Type.Object(
      {
        title: Type.String({ minLength: 1, maxLength: 120 }),
        summary: Type.String({
          minLength: 1,
          maxLength: 4000,
          description:
            "Write the outcome in a short paragraph. Limit 2000 characters, or 4000 when selecting evidence for this checkpoint. Keep source bodies in their owner's store.",
        }),
        includeEvidence: Type.Optional(
          Type.Array(StringEnum(evidenceKinds), {
            minItems: 1,
            maxItems: 3,
            uniqueItems: true,
            description:
              "Link unique observed research, decision or validation receipts from this user request. Ambiguity returns choices before saving. A command result does not prove the product passed.",
          }),
        ),
        evidenceCallIds: Type.Optional(
          Type.Array(Type.String({ minLength: 1, maxLength: 192 }), {
            minItems: 1,
            maxItems: 6,
            uniqueItems: true,
            description:
              "Exact observed Pi calls on this active branch to attach. When a category is ambiguous choose the applicable offered IDs. Never invent IDs or supply paths.",
          }),
        ),
        nextAction: Type.Optional(
          Type.String({
            minLength: 1,
            maxLength: 240,
            description:
              "Next known work step, including already-authorized build or review. This is remembered context, not a user choice or permission grant.",
          }),
        ),
        openChoice: Type.Optional(
          Type.String({
            minLength: 1,
            maxLength: 240,
            description:
              "A concrete unresolved decision still owned by the user. Omit for settled decisions and already-authorized work; put a known work step in nextAction.",
          }),
        ),
        choiceOptions: Type.Optional(
          Type.Array(Type.String({ minLength: 1, maxLength: 120 }), {
            maxItems: 8,
            uniqueItems: true,
            description:
              "Distinct alternatives for this open choice. Omit when none have been identified.",
          }),
        ),
        choiceRecommendation: Type.Optional(
          Type.Object(
            {
              option: Type.String({ minLength: 1, maxLength: 120 }),
              reason: Type.String({ minLength: 1, maxLength: 240 }),
              evidence: Type.String({
                minLength: 1,
                maxLength: 240,
                description:
                  "Exact supporting quote from summary, or the exact saved deliveryUrl.",
              }),
            },
            { additionalProperties: false },
          ),
        ),
        deliveryUrl: Type.Optional(
          Type.String({
            minLength: 1,
            maxLength: 2000,
            description:
              "Exact public HTTPS resource you will share in your next final reply.",
          }),
        ),
      },
      {
        additionalProperties: false,
        anyOf: [
          { required: ["evidenceCallIds"] },
          { required: ["includeEvidence"] },
          { properties: { summary: { type: "string", maxLength: 2000 } } },
        ],
      },
    ),
    async execute(callId, params, signal, _onUpdate, ctx) {
      const invalid = Error(REMEMBER_INPUT_ERROR);
      let entered = false;
      try {
        const scope = await bind(ctx);
        await scope.assertCurrent();
        signal?.throwIfAborted();
        if (!checkNote(params)) throw invalid;
        const note = {
          ...params,
          title: params.title.trim(),
          summary: params.summary.trim(),
          ...(params.nextAction === undefined
            ? {}
            : { nextAction: params.nextAction.trim() }),
        };
        const selection =
          note.evidenceCallIds || note.includeEvidence
            ? selectCheckpointEvidence(ctx, note)
            : undefined;
        if (selection?.status === "evidence-selection-needed") {
          const result = {
            content: [
              { type: "text" as const, text: JSON.stringify(selection) },
            ],
            details: selection,
          };
          filter.remember(callId, result, scope.assertCurrent);
          return result;
        }
        const receipt = note.deliveryUrl
          ? {
              status: deliveries.stage(
                callId,
                ctx,
                {
                  save: (resource, token) =>
                    scope.save(resource, token, undefined, selection),
                },
                {
                  ...note,
                  deliveryUrl: note.deliveryUrl,
                },
              ),
            }
          : await scope.save(
              note,
              signal,
              () => {
                entered = true;
              },
              selection,
            );
        const result = {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(receipt),
            },
          ],
          details: receipt,
        };
        filter.remember(callId, result, scope.assertCurrent);
        return result;
      } catch (error) {
        if (error === invalid) throw error;
        if (signal?.aborted)
          throw new DOMException("Bookie request was aborted.", "AbortError");
        // eslint-disable-next-line preserve-caught-error -- Provider and filesystem failures are private.
        throw Error(
          entered
            ? "Bookie could not confirm the save. Recall this note before retrying."
            : "Routine memory is unavailable. This workspace needs current Pi Daddy Auto and Bookie capture and disclosure authority.",
        );
      }
    },
  });
}
