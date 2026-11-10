import {
  dashboardOpenChoices,
  type ChoiceAccess,
  type ChoiceRow,
} from "./dashboard-open-choices.js";
import { createRequire } from "node:module";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  inspectConcept,
  inspectRecallScope,
  type RecallScope,
} from "pi-bookie-core";
import { openManagedVault } from "./managed-vault.js";
import type { VaultAuthority } from "./capture-authority.js";

export interface ManagedSelection {
  readonly vault: VaultAuthority;
  readonly scope: RecallScope;
}
type Owner = {
  version: 1;
  sessionId: string;
  cwd: string;
  isCurrent(): boolean;
};
const object = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;
function ownerMatches(value: unknown, ctx: ExtensionContext): value is Owner {
  return (
    object(value) &&
    value.version === 1 &&
    value.cwd === ctx.cwd &&
    value.sessionId === ctx.sessionManager?.getSessionId?.() &&
    typeof value.isCurrent === "function" &&
    value.isCurrent() === true
  );
}
const inactive = () => Error("Automatic Bookie project memory is unavailable.");
export function createManagedMemory(pi: ExtensionAPI) {
  let active: ExtensionContext | undefined;
  let slot: { owner: Owner; selection: Promise<ManagedSelection> } | undefined;
  let publisher:
    | { publish(payload: unknown): boolean; close(): void; sequence: number }
    | undefined;
  let displayEpoch = 0;
  let refreshRevision = 0;
  let authorize:
    ((ctx: ExtensionContext) => Promise<ChoiceAccess | undefined>) | undefined;
  function hide() {
    displayEpoch++;
    refreshRevision++;
    const old = publisher;
    publisher = undefined;
    try {
      old?.close();
    } catch {
      /* The dashboard is optional. */
    }
  }
  function reset() {
    slot = undefined;
    active = undefined;
    hide();
  }
  async function get(
    ctx: ExtensionContext,
  ): Promise<ManagedSelection | undefined> {
    if (
      !active ||
      !ctx?.hasUI ||
      !ctx.isProjectTrusted?.() ||
      active.cwd !== ctx.cwd ||
      !ctx.sessionManager?.getSessionId?.() ||
      active.sessionManager?.getSessionId?.() !==
        ctx.sessionManager.getSessionId()
    )
      return;
    if (slot && !ownerMatches(slot.owner, ctx)) {
      slot = undefined;
      hide();
    }
    if (!slot) {
      let lease: Owner | undefined;
      pi.events?.emit?.("pi-daddy:request-project-memory-owner-v1", {
        version: 1,
        cwd: ctx.cwd,
        sessionId: ctx.sessionManager.getSessionId(),
        reply(value: unknown) {
          if (ownerMatches(value, ctx)) lease = value;
        },
      });
      if (!lease) return;
      const owner = lease;
      const session = active;
      const assertOwner = async () => {
        if (
          active !== session ||
          !ctx.isProjectTrusted() ||
          !ownerMatches(owner, ctx)
        )
          throw inactive();
      };
      const initialize = async () => {
        const managed = await openManagedVault(ctx.cwd, assertOwner);
        const vault: VaultAuthority = {
          root: managed.root,
          async assertCurrent() {
            await assertOwner();
            await managed.assertCurrent();
            await assertOwner();
          },
        };
        await vault.assertCurrent();
        const project = await inspectConcept(
          vault.root,
          { path: managed.project },
          { maxContentBytes: 1 },
        );
        if (
          !project.ok ||
          project.type !== "Project" ||
          project.handling === "excluded"
        )
          throw inactive();
        const scoped = await inspectRecallScope(vault.root, project.source);
        if (
          !scoped.ok ||
          !scoped.scope.sensitivityClasses.includes("internal") ||
          scoped.scope.excludedClasses.includes("internal")
        )
          throw inactive();
        await vault.assertCurrent();
        return { vault, scope: scoped.scope };
      };
      slot = { owner, selection: initialize() };
    }
    const selected = slot;
    try {
      const result = await selected.selection;
      await result.vault.assertCurrent();
      return result;
    } catch (error) {
      if (slot === selected) {
        slot = undefined;
        hide();
      }
      throw error;
    }
  }
  function show(
    ctx: ExtensionContext,
    choices: ChoiceRow[] = [],
    limited = false,
  ) {
    const selected = slot;
    if (!selected || !ownerMatches(selected.owner, ctx)) {
      hide();
      return;
    }
    const items = [
      {
        id: "project-memory",
        kind: "work",
        state: "observed",
        label: "Current workspace memory",
        details: [
          "Ready to save and recall routine project notes.",
          ...(limited
            ? [
                "Only a bounded selection of saved open choices could be displayed.",
              ]
            : []),
        ],
      },
      ...choices,
    ];
    const publish = () => {
      if (
        publisher &&
        !publisher.publish({ sequence: ++publisher.sequence, items })
      )
        hide();
    };
    try {
      if (publisher) {
        publish();
        return;
      }
      const generation = ++displayEpoch;
      pi.events?.emit?.("pi-daddy:dashboard-source:v1", {
        version: 1,
        sessionId: selected.owner.sessionId,
        cwd: ctx.cwd,
        producer: "bookie-memory",
        producerVersion: (
          createRequire(import.meta.url)("../package.json") as {
            version: string;
          }
        ).version,
        reply(value: unknown) {
          if (
            !object(value) ||
            value.version !== 1 ||
            value.ok !== true ||
            typeof value.publish !== "function" ||
            typeof value.close !== "function"
          )
            return;
          if (
            displayEpoch !== generation ||
            slot !== selected ||
            !ownerMatches(selected.owner, ctx)
          ) {
            value.close();
            return;
          }
          publisher = {
            publish: value.publish as (payload: unknown) => boolean,
            close: value.close as () => void,
            sequence: 0,
          };
          publish();
        },
      });
    } catch {
      hide();
    }
  }
  async function refreshDashboard(ctx: ExtensionContext) {
    const revision = ++refreshRevision;
    try {
      const access = await authorize?.(ctx);
      if (revision !== refreshRevision) return false;
      if (access) {
        if (!publisher) show(ctx);
        // Standalone Pi does not need to enumerate notes for a dashboard.
        if (publisher) {
          const { rows, limited } = await dashboardOpenChoices(access);
          await access.assertCurrent();
          if (revision !== refreshRevision) return false;
          show(ctx, rows, limited);
        }
        return true;
      }
    } catch {
      // Recheck on use. Discard previous rows when current access is unknown.
    }
    if (revision === refreshRevision) hide();
    return false;
  }
  function install(warm: NonNullable<typeof authorize>) {
    authorize = warm;
    pi.on("session_start", async (_event, ctx) => {
      reset();
      active = ctx;
      if (ctx) await refreshDashboard(ctx);
    });
    pi.on("session_shutdown", reset);
    pi.on("model_select", hide);
    pi.on("before_agent_start", async (event, ctx) => {
      if (await refreshDashboard(ctx))
        return {
          systemPrompt:
            event.systemPrompt +
            "\nBookie project memory is ready in this workspace. Save project decisions at meaningful boundaries. When newly delivering a public resource, use bookie_remember with its exact deliveryUrl, a task-specific title and short summary before giving the link, even if you already saved the decision. Bookie records the link once it appears in the completed reply. If the user still has a concrete choice, include it as openChoice in the note. For a newly delivered resource you can also state it on its own line as “Open choice: …” in the final reply. For a project recap, use bookie_search for the topic and for shared resources, read matching notes, and distinguish what was decided, delivered and still open. For a recap, reuse existing receipts without writing or researching again. Keep personal and sensitive details out.",
        };
    });
    pi.events?.on?.("pi-daddy:project-memory-owner-v1", () => {
      if (slot && active && !ownerMatches(slot.owner, active)) {
        slot = undefined;
        hide();
      }
      if (active) void refreshDashboard(active);
    });
  }
  return { get, install, hide, refreshDashboard };
}
