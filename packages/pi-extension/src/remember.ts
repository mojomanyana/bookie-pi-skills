import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { posix, resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
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
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface ProjectNote {
  title: string;
  summary: string;
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
    note.summary.length <= 2000 &&
    !containsDetectedSecret(note.title + "\n" + note.summary) &&
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
    async function save(
      note: ProjectNote,
      signal?: AbortSignal,
      onMutation?: () => void,
    ) {
      if (!checkNote(note)) throw Error();
      const { title, summary, deliveryUrl } = note;
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
      };
      await guard();
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
          ...(guidance ? { fields: { choice_guidance: guidance } } : {}),
          sections: {
            outcome: deliveryUrl
              ? "Pi shared this resource with the user. " + summary
              : summary,
            ...(deliveryUrl ? { evidence: deliveryUrl } : {}),
            ...(choice ? { "unresolved-work": choice } : {}),
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
          { maxContentBytes: 16000, ...(signal ? { signal } : {}) },
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
      await managed.refreshDashboard(ctx);
      await guard();
      return outcome;
    }
    return { assertCurrent, save };
  }

  const deliveries = registerDeliveryHandoff(pi, bind);
  return defineTool({
    name: "bookie_remember",
    label: "Remember project note",
    description:
      "Save a bounded routine project decision or outcome as untrusted project context. For a newly delivered public resource, supply deliveryUrl, a title naming the task, and a short summary. The link is recorded once it appears in the finished reply. When a concrete choice remains with the user, supply it as openChoice. Supply choiceOptions when there are concrete alternatives, and choiceRecommendation only if a saved fact or delivered reference supports the reason. During recall, reuse the saved receipt. Exclude personal information, private sources and credentials.",
    parameters: Type.Object(
      {
        title: Type.String({ minLength: 1, maxLength: 120 }),
        summary: Type.String({ minLength: 1, maxLength: 2000 }),
        openChoice: Type.Optional(
          Type.String({
            minLength: 1,
            maxLength: 240,
            description:
              "The specific open choice still left to the user, in a short, non-sensitive line. Omit for settled decisions.",
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
      { additionalProperties: false },
    ),
    async execute(callId, params, signal, _onUpdate, ctx) {
      const invalid = Error(
        "Bookie needs a short non-sensitive project title and summary, a short open choice if supplied, distinct options with a supported recommendation if supplied, and a safe public URL if supplied.",
      );
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
        };
        const outcome = note.deliveryUrl
          ? deliveries.stage(callId, ctx, scope, {
              ...note,
              deliveryUrl: note.deliveryUrl,
            })
          : await scope.save(note, signal, () => {
              entered = true;
            });
        const result = {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ status: outcome }),
            },
          ],
          details: { status: outcome },
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
