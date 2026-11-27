import { createHash } from "node:crypto";
import { posix, resolve } from "node:path";
import { Type } from "typebox";
import {
  defineTool,
  withFileMutationQueue,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  containsDetectedSecret,
  createCheckpointWithPolicy,
  inspectConcept,
  searchVault,
} from "pi-bookie-core";
import { prepareManagedActivity } from "./managed-activity.js";
import type { createManagedMemory } from "./managed-memory.js";
import {
  DISCLOSURE_WITHHELD,
  type createDisclosureAuthority,
} from "./disclosure-authority.js";
import type { createCaptureAuthority } from "./capture-authority.js";

export interface MemoryProposal {
  readonly title: string;
  readonly summary: string;
  readonly kind: "finding" | "decision";
  readonly verified: boolean;
  readonly specialist?: string;
  readonly source?: "specialist" | "coordinator";
  readonly coordinatorAccepted?: boolean;
  readonly evidence?: string;
}

export interface ReconcileResult {
  readonly status: "novel" | "duplicate" | "conflict";
  readonly existingPath?: string;
  readonly existingUid?: string;
  readonly existingTitle?: string;
  readonly existingExcerpt?: string;
}

const normalize = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .replace(/[^a-z0-9 ._/-]/gu, "");

export function reconcileProposalAgainstMatches(
  proposal: Pick<MemoryProposal, "title" | "summary">,
  matches: ReadonlyArray<{
    readonly path: string;
    readonly uid?: string;
    readonly title: string;
    readonly excerpt?: string;
  }>,
): ReconcileResult {
  const wantedTitle = normalize(proposal.title);
  const wantedSummary = normalize(proposal.summary);
  for (const match of matches) {
    const existingTitle = normalize(match.title);
    const existingExcerpt = normalize(match.excerpt ?? "");
    if (existingTitle !== wantedTitle) continue;
    if (
      existingExcerpt.length > 0 &&
      (existingExcerpt === wantedSummary ||
        existingExcerpt.includes(wantedSummary) ||
        wantedSummary.includes(existingExcerpt))
    ) {
      return {
        status: "duplicate",
        existingPath: match.path,
        ...(match.uid !== undefined ? { existingUid: match.uid } : {}),
        existingTitle: match.title,
        ...(match.excerpt !== undefined
          ? { existingExcerpt: match.excerpt }
          : {}),
      };
    }
    return {
      status: "conflict",
      existingPath: match.path,
      ...(match.uid !== undefined ? { existingUid: match.uid } : {}),
      existingTitle: match.title,
      ...(match.excerpt !== undefined
        ? { existingExcerpt: match.excerpt }
        : {}),
    };
  }
  return { status: "novel" };
}

function validProposal(input: MemoryProposal): boolean {
  if (
    typeof input.title !== "string" ||
    input.title.trim().length === 0 ||
    input.title.length > 120 ||
    /[\r\n]/u.test(input.title)
  )
    return false;
  if (
    typeof input.summary !== "string" ||
    input.summary.trim().length === 0 ||
    input.summary.length > 2000
  )
    return false;
  if (input.kind !== "finding" && input.kind !== "decision") return false;
  if (typeof input.verified !== "boolean") return false;
  if (
    input.specialist !== undefined &&
    (typeof input.specialist !== "string" ||
      input.specialist.trim().length === 0 ||
      input.specialist.length > 80 ||
      /[\r\n]/u.test(input.specialist))
  )
    return false;
  if (
    input.source !== undefined &&
    input.source !== "specialist" &&
    input.source !== "coordinator"
  )
    return false;
  if (
    input.coordinatorAccepted !== undefined &&
    typeof input.coordinatorAccepted !== "boolean"
  )
    return false;
  if (
    input.evidence !== undefined &&
    (typeof input.evidence !== "string" || input.evidence.length > 1000)
  )
    return false;
  const combined = [input.title, input.summary, input.evidence ?? ""].join(
    "\n",
  );
  return !containsDetectedSecret(combined);
}

export function proposeMemoryTool(
  pi: ExtensionAPI,
  managed: ReturnType<typeof createManagedMemory>,
  capture: ReturnType<typeof createCaptureAuthority>,
  disclosure: ReturnType<typeof createDisclosureAuthority>,
) {
  return defineTool({
    name: "bookie_propose_memory",
    label: "Bookie propose memory",
    description:
      "Propose a bounded untrusted finding or explicit user decision for Bookie project memory, " +
      "or accept a reconciled proposal from the coordinator for durable storage. " +
      "Specialist proposals are reconciled only and never auto-written until the coordinator " +
      "accepts and verifies them. With Daddy Auto on at write time, coordinator-verified " +
      "findings and explicit user decisions save automatically; with Daddy Auto off (even " +
      "when Bookie memory is enabled), operator confirmation is required.",
    parameters: Type.Object(
      {
        title: Type.String({
          minLength: 1,
          maxLength: 120,
          description: "Short note title (max 120 chars, single line).",
        }),
        summary: Type.String({
          minLength: 1,
          maxLength: 2000,
          description: "Concise verified finding or explicit user decision.",
        }),
        kind: Type.Enum(["finding", "decision"], {
          description: "Whether this is a verified finding or user decision.",
        }),
        verified: Type.Boolean({
          description:
            "True only when backed by observed evidence or an explicit user statement.",
        }),
        specialist: Type.Optional(
          Type.String({
            minLength: 1,
            maxLength: 80,
            description: "Specialist role proposing this note, if delegated.",
          }),
        ),
        source: Type.Optional(
          Type.Enum(["specialist", "coordinator"], {
            description:
              "Origin of the call. Child-proxied calls are pinned to specialist and cannot self-accept.",
          }),
        ),
        coordinatorAccepted: Type.Optional(
          Type.Boolean({
            description:
              "Set true only by the coordinator after reviewing and accepting a specialist proposal for durable storage.",
          }),
        ),
        evidence: Type.Optional(
          Type.String({
            maxLength: 1000,
            description:
              "Exact file, command, or brief reference supporting it.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(_id, params: MemoryProposal, signal, _onUpdate, ctx) {
      // Fail closed on absent model disclosure authority BEFORE validating, reading, or mutating.
      const selected = await managed.get(ctx);
      if (
        !selected ||
        !capture.selectManaged(selected) ||
        !disclosure.canManage()
      ) {
        throw Error(DISCLOSURE_WITHHELD);
      }
      const ticket = await disclosure.capture(
        selected.vault.root,
        ctx,
        "canonical",
      );
      const guard = async () => {
        await ticket.assertCurrent();
        await capture.assertManaged(selected);
        signal?.throwIfAborted();
      };
      await guard();

      if (!validProposal(params)) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "Invalid memory proposal (empty, oversized, multiline title, or secret detected).",
            },
          ],
          details: { status: "rejected" },
        };
      }

      // Reconcile against existing canonical project notes for duplicates/conflicts.
      const found = await searchVault(
        selected.vault.root,
        {
          query: params.title,
          filters: { project: ticket.scope.project.path },
        },
        {
          maxResults: 12,
          ...(signal ? { signal } : {}),
        },
      );
      await guard();
      const candidates: Array<{
        path: string;
        uid?: string;
        title: string;
        excerpt?: string;
      }> = [];
      if (found.complete) {
        for (const item of found.results) {
          const concept = await inspectConcept(
            selected.vault.root,
            { path: item.source.path },
            { maxContentBytes: 8000, ...(signal ? { signal } : {}) },
          );
          if (!concept.ok || !ticket.allows(concept)) continue;
          candidates.push({
            path: concept.source.path,
            ...(concept.uid !== undefined ? { uid: concept.uid } : {}),
            title: item.title,
            excerpt: concept.sourceText,
          });
        }
      }
      await guard();
      const reconciled = reconcileProposalAgainstMatches(params, candidates);
      if (reconciled.status === "duplicate") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "duplicate",
                path: reconciled.existingPath,
                uid: reconciled.existingUid,
                message: "Matching project memory already exists; skipped.",
              }),
            },
          ],
          details: reconciled,
        };
      }
      if (reconciled.status === "conflict") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "conflict",
                needsDecision: true,
                existingPath: reconciled.existingPath,
                existingTitle: reconciled.existingTitle,
                proposed: params,
                message:
                  "Conflicting note with the same title exists; coordinator or operator must reconcile.",
              }),
            },
          ],
          details: { ...reconciled, needsDecision: true },
        };
      }

      // Separate specialist proposals from coordinator acceptance for durable storage.
      // A specialist's `verified: true` flag is uncorroborated on its own and never triggers
      // durable storage until the coordinator explicitly accepts and verifies it.
      const isSpecialistProposal =
        params.source === "specialist" ||
        (params.specialist !== undefined &&
          params.coordinatorAccepted !== true);
      if (isSpecialistProposal) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "proposed",
                accepted: false,
                needsCoordinatorAcceptance: true,
                uncorroboratedSpecialistFlag: params.verified === true,
                proposal: {
                  title: params.title,
                  summary: params.summary,
                  kind: params.kind,
                  verified: params.verified,
                  ...(params.specialist
                    ? { specialist: params.specialist }
                    : {}),
                  ...(params.evidence ? { evidence: params.evidence } : {}),
                },
                message:
                  "Specialist proposal reconciled and returned for coordinator review; durable storage requires coordinator acceptance.",
              }),
            },
          ],
          details: {
            status: "proposed",
            accepted: false,
            needsCoordinatorAcceptance: true,
            uncorroboratedSpecialistFlag: params.verified === true,
          },
        };
      }

      // Use actual live Daddy Auto authority at write time (independent of Bookie memory being on).
      const daddyAutoEnabled = managed.isAutoEnabled(ctx);
      let approvedToWrite = daddyAutoEnabled && params.verified === true;
      let requiredAutoCheckAtWrite = approvedToWrite;
      if (!approvedToWrite) {
        const ui = ctx as ExtensionContext & {
          hasUI?: boolean;
          ui?: {
            confirm?: (title: string, body: string) => Promise<boolean>;
          };
        };
        if (ui.hasUI && typeof ui.ui?.confirm === "function") {
          const who = params.specialist ? ` (${params.specialist})` : "";
          approvedToWrite = await ui.ui.confirm(
            `Save Bookie memory proposal${who}?`,
            `${params.kind.toUpperCase()}: ${params.title}\n\n${params.summary}`,
          );
          if (!approvedToWrite) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    status: "declined",
                    needsDecision: false,
                    daddyAutoEnabled,
                    message: "Operator declined saving the proposed note.",
                  }),
                },
              ],
              details: { status: "declined", daddyAutoEnabled },
            };
          }
          requiredAutoCheckAtWrite = false;
        } else {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  status: "needs-approval",
                  needsDecision: true,
                  daddyAutoEnabled,
                  proposal: params,
                  message:
                    "Daddy Auto is off or finding is unverified; operator confirmation is required before writing durable memory.",
                }),
              },
            ],
            details: {
              status: "needs-approval",
              needsDecision: true,
              daddyAutoEnabled,
            },
          };
        }
      }

      const writeGuard = async () => {
        await guard();
        if (requiredAutoCheckAtWrite && !managed.isAutoEnabled(ctx)) {
          throw Error(
            "Daddy Auto authority was disabled before write; confirmation is required.",
          );
        }
      };
      await writeGuard();
      const digest = createHash("sha256")
        .update(
          JSON.stringify([
            "proposal",
            params.kind,
            params.title,
            params.summary,
            params.specialist ?? "",
          ]),
        )
        .digest("hex");
      const path = posix.join(
        posix.dirname(ticket.scope.project.path),
        "activities",
        "note-" + digest.slice(0, 32) + ".md",
      );
      const uid = "ACT-0" + digest.slice(0, 25).toUpperCase();
      const prepared = await prepareManagedActivity(
        ticket.root,
        {
          path,
          uid,
          project: ticket.scope.project.path,
          title: params.title,
          tags: [
            params.kind,
            ...(params.specialist ? [`specialist:${params.specialist}`] : []),
          ],
          sections: {
            outcome: params.summary,
            ...(params.evidence ? { evidence: params.evidence } : {}),
          },
        },
        ctx.sessionManager.getSessionId(),
        signal,
      );
      if (!prepared.ok) throw Error("Could not prepare Bookie memory note.");

      const savedStatus = await withFileMutationQueue(
        resolve(ticket.root, path.slice(1)),
        async () => {
          await writeGuard();
          const result = await createCheckpointWithPolicy(
            prepared.publication,
            { assertAuthority: writeGuard, ...(signal ? { signal } : {}) },
          );
          if (!result.ok) {
            if (
              !result.changedPaths.length &&
              result.diagnostics.some(
                (d) =>
                  d.code === "MUTATION-TARGET" ||
                  d.code === "MUTATION-CONFLICT",
              )
            )
              return "duplicate";
            throw Error("Bookie memory save refused.");
          }
          return "saved";
        },
      );
      try {
        pi.events?.emit?.("pi-daddy:ecosystem-activity:v1", {
          producer: "bookie",
          kind: "memory-proposal",
          status: savedStatus,
          specialist: params.specialist,
          detail: `Bookie · ${savedStatus === "saved" ? "saved" : "reused"} ${params.specialist ?? "coordinator"} ${params.kind}: ${params.title}`,
        });
      } catch {
        /* Optional activity stream cannot fail memory writes. */
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: savedStatus,
              path,
              uid,
              kind: params.kind,
              ...(params.specialist ? { specialist: params.specialist } : {}),
            }),
          },
        ],
        details: { status: savedStatus, path, uid },
      };
    },
  });
}
