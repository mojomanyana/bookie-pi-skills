/* eslint-disable preserve-caught-error -- This boundary intentionally drops private provider/filesystem causes. */
import { createHash } from "node:crypto";
import { posix, resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import {
  containsDetectedSecret,
  prepareCheckpoint,
  createCheckpointWithPolicy,
  CHECKPOINT_SECTIONS,
  inspectConcept,
  loadConcept,
} from "pi-bookie-core";
import { createCheckpointMetadata } from "./checkpoint-metadata.js";
import type { createManagedMemory } from "./managed-memory.js";
import type { createDisclosureAuthority } from "./disclosure-authority.js";
import type { createCaptureAuthority } from "./capture-authority.js";
import type { createBookieContextFilter } from "./context-filter.js";

export function rememberTool(
  managed: ReturnType<typeof createManagedMemory>,
  capture: ReturnType<typeof createCaptureAuthority>,
  disclosure: ReturnType<typeof createDisclosureAuthority>,
  filter: ReturnType<typeof createBookieContextFilter>,
) {
  return defineTool({
    name: "bookie_remember",
    label: "Remember project note",
    description:
      "Save one short routine project decision, outcome or handoff in this workspace’s private Bookie memory when requested or useful. Supply only a bounded non-sensitive title and summary (untrusted project context). Do not include personal information, raw transcripts, private sources or credentials. Identical notes reuse the saved record.",
    parameters: Type.Object(
      {
        title: Type.String({ minLength: 1, maxLength: 120 }),
        summary: Type.String({ minLength: 1, maxLength: 2000 }),
      },
      { additionalProperties: false },
    ),
    async execute(callId, params, signal, _onUpdate, ctx) {
      const invalid = Error(
        "Bookie needs a short non-sensitive project title and summary.",
      );
      let entered = false;
      try {
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
        const title =
            typeof params.title === "string" ? params.title.trim() : "",
          summary =
            typeof params.summary === "string" ? params.summary.trim() : "";
        if (
          Object.keys(params).some(
            (key) => key !== "title" && key !== "summary",
          ) ||
          !title ||
          !summary ||
          title.length > 120 ||
          summary.length > 2000 ||
          /[\r\n]/u.test(title) ||
          containsDetectedSecret(title + "\n" + summary)
        )
          throw invalid;
        const guard = async () => {
          await ticket.assertCurrent();
          await capture.assertManaged(selected);
          signal?.throwIfAborted();
        };
        const hash = createHash("sha256")
          .update(JSON.stringify([ticket.scope.project.uid, title, summary]))
          .digest("hex");
        const path = posix.join(
          posix.dirname(ticket.scope.project.path),
          "activities",
          "note-" + hash.slice(0, 32) + ".md",
        );
        const uid = "ACT-0" + hash.slice(0, 25).toUpperCase();
        const metadata = createCheckpointMetadata({
          sessionId: ctx.sessionManager.getSessionId(),
        });
        const prepared = await prepareCheckpoint(
          ticket.root,
          {
            path: path.slice(1),
            frontmatter: {
              type: "Activity",
              title,
              status: "stable",
              generated: metadata.generated,
              bookie: {
                profile: "1.0",
                uid,
                project: ticket.scope.project.path,
                occurred_at: metadata.occurred_at,
                sensitivity: "internal",
              },
            },
            fragments: CHECKPOINT_SECTIONS.filter(
              (section) => section !== "source-session",
            ).map((section) => ({
              section,
              sensitivity: "internal",
              text:
                section === "outcome"
                  ? summary
                  : "No additional information recorded.",
            })),
          },
          signal ? { signal } : {},
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
          if (
            !loaded.ok ||
            loaded.concept.frontmatter.title !== title ||
            loaded.concept.bodyText.trim() !== prepared.preview.bodyText.trim()
          )
            throw Error();
          return true;
        };
        const outcome = await withFileMutationQueue(
          resolve(ticket.root, path.slice(1)),
          async () => {
            await guard();
            if (await readExisting()) return "already saved";
            entered = true;
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
        const result = {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ status: outcome }),
            },
          ],
          details: { status: outcome },
        };
        filter.remember(callId, result, guard);
        return result;
      } catch (error) {
        if (error === invalid) throw invalid;
        if (signal?.aborted)
          throw new DOMException("Bookie request was aborted.", "AbortError");
        throw Error(
          entered
            ? "Bookie could not confirm the save. Recall this note before retrying."
            : "Routine memory is unavailable. This workspace needs current Pi Daddy Auto and Bookie capture and disclosure authority.",
        );
      }
    },
  });
}
