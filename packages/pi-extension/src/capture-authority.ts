import {
  inspectConcept,
  inspectRecallScope,
  initializeRecallState,
  containsDetectedSecret,
  type PrepareCheckpointRequest,
} from "pi-bookie-core";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { lstat, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { ManagedSelection } from "./managed-memory.js";

export interface VaultAuthority {
  readonly root: string;
  assertCurrent(): Promise<void>;
}

export interface ReferenceCaptureGrant {
  readonly vault: VaultAuthority;
  readonly project: { path: string; sourceHash: `sha256:${string}` };
  readonly sensitivity: string;
  assertCurrent(): Promise<void>;
}
export function createCaptureAuthority(pi: ExtensionAPI, onManual = () => {}) {
  let allowManaged = true;
  let managedSelection: ManagedSelection | undefined;
  let epoch = 0;
  let captureEpoch = 0;
  let grant:
    | {
        vault: VaultAuthority;
        project: string;
        projectHash: `sha256:${string}`;
        summaries: boolean;
        sensitivity?: string;
      }
    | undefined;
  let sync: ((ctx: ExtensionContext) => Promise<void>) | undefined;
  function reset() {
    allowManaged = true;
    managedSelection = undefined;
    epoch++;
    captureEpoch++;
    grant = undefined;
  }

  async function bind(
    root: string,
    ctx: ExtensionContext,
  ): Promise<VaultAuthority> {
    if (!ctx.isProjectTrusted())
      throw new Error("Bookie write requires a trusted project.");
    const capturedEpoch = epoch;
    const canonical = await realpath(root);
    if (containsDetectedSecret(canonical))
      throw new Error("Bookie vault authority is invalid.");
    const identity = await lstat(canonical, { bigint: true });
    if (!identity.isDirectory() || identity.isSymbolicLink())
      throw new Error("Bookie vault authority is invalid.");
    return {
      root: canonical,
      async assertCurrent() {
        if (epoch !== capturedEpoch || !ctx.isProjectTrusted())
          throw new Error("Bookie authority expired or was revoked.");
        if ((await realpath(root)) !== canonical)
          throw new Error("Bookie vault authority changed.");
        const current = await lstat(canonical, { bigint: true });
        if (
          !current.isDirectory() ||
          current.isSymbolicLink() ||
          current.dev !== identity.dev ||
          current.ino !== identity.ino
        )
          throw new Error("Bookie vault authority changed.");
      },
    };
  }

  async function standingCheckpoint(
    vault: VaultAuthority,
    input: PrepareCheckpointRequest,
  ): Promise<(() => Promise<void>) | undefined> {
    const selected = grant;
    const value = input.frontmatter.bookie;
    if (value === null || typeof value !== "object" || Array.isArray(value))
      return undefined;
    const bookie = value as Readonly<Record<string, unknown>>;
    if (
      selected === undefined ||
      !selected.summaries ||
      selected.vault.root !== vault.root ||
      bookie === null ||
      typeof bookie !== "object" ||
      Array.isArray(bookie) ||
      bookie.project !== selected.project ||
      !(["public", "internal"] as readonly unknown[]).includes(
        bookie.sensitivity,
      ) ||
      input.fragments.some(
        (fragment) => !["public", "internal"].includes(fragment.sensitivity),
      )
    )
      return undefined;
    const guard = async () => {
      if (grant !== selected)
        throw new Error("Bookie capture permission was revoked.");
      await selected.vault.assertCurrent();
      await vault.assertCurrent();
      const project = await inspectConcept(
        vault.root,
        { path: selected.project },
        { maxContentBytes: 1 },
      );
      if (
        !project.ok ||
        project.type !== "Project" ||
        project.handling === "excluded" ||
        project.source.sourceHash !== selected.projectHash
      )
        throw new Error(
          "Bookie capture project revision changed; select it again.",
        );
    };
    await guard();
    return guard;
  }

  pi.registerCommand("bookie-capture", {
    description:
      "Select or revoke session-only routine task/evidence checkpoint capture for one Bookie project.",
    async handler(args, ctx) {
      if (!ctx.hasUI)
        throw new Error(
          "Bookie capture settings require trusted interactive UI.",
        );
      if (args.trim() === "off") {
        captureEpoch++;
        allowManaged = false;
        managedSelection = undefined;
        onManual();
        grant = undefined;
        ctx.ui.notify("Bookie routine capture disabled.", "info");
        return;
      }
      if (args.trim() === "sync") {
        if (!sync) throw Error("Producer bridge unavailable.");
        await sync(ctx);
        return;
      }
      if (args.trim() !== "")
        throw new Error(
          "Use /bookie-capture, /bookie-capture sync, or /bookie-capture off.",
        );
      const revision = captureEpoch;
      const root = await ctx.ui.input("Bookie vault directory", ctx.cwd);
      if (!root) return;
      const projectPath = await ctx.ui.input(
        "Bookie Project path",
        "/projects/example/project.md",
      );
      if (!projectPath) return;
      const vault = await bind(resolve(ctx.cwd, root), ctx);
      const project = await inspectConcept(
        vault.root,
        { path: projectPath },
        { maxContentBytes: 1 },
      );
      if (
        !project.ok ||
        project.type !== "Project" ||
        project.handling === "excluded"
      )
        throw new Error("Select an existing, included Bookie Project.");
      const mode = await ctx.ui.select("Bookie capture content", [
        "Structured summaries",
        "Producer reference metadata",
        "Both",
      ]);
      if (!mode) return;
      const summaries = mode !== "Producer reference metadata";
      let sensitivity: string | undefined;
      if (mode !== "Structured summaries") {
        const scope = await inspectRecallScope(vault.root, {
          path: project.source.path,
          sourceHash: project.source.sourceHash,
        });
        if (!scope.ok) throw Error("Bookie capture scope is unavailable.");
        sensitivity = await ctx.ui.select(
          "Reference metadata sensitivity",
          scope.scope.sensitivityClasses.filter(
            (x) => !scope.scope.excludedClasses.includes(x),
          ),
        );
        if (!sensitivity) return;
      }
      const approved = await ctx.ui.confirm(
        "Allow routine Bookie capture for this session?",
        JSON.stringify({
          vault: vault.root,
          project: project.source.path,
          projectHash: project.source.sourceHash,
          summaries,
          ...(sensitivity ? { referenceMetadataSensitivity: sensitivity } : {}),
        }) +
          "\nSelected summaries use public/internal classes. Producer metadata saves technical identifiers and local paths (which may include user/project names) with the selected class, never final text/transcripts. Initialize local recall controls if absent. No model disclosure or training consent. Other changes still ask. /bookie-capture off revokes.",
      );
      if (!approved) return;
      if (captureEpoch !== revision)
        throw new Error("Bookie capture settings changed during confirmation.");
      await vault.assertCurrent();
      if (sensitivity) {
        const initialized = await initializeRecallState(vault.root, {
          assertAuthority: async () => {
            if (captureEpoch !== revision)
              throw Error("Bookie capture permission changed.");
            await vault.assertCurrent();
            const current = await inspectRecallScope(vault.root, {
              path: project.source.path,
              sourceHash: project.source.sourceHash,
            });
            if (
              !current.ok ||
              !current.scope.sensitivityClasses.includes(sensitivity!) ||
              current.scope.excludedClasses.includes(sensitivity!) ||
              captureEpoch !== revision
            )
              throw Error("Bookie capture scope changed.");
          },
        });
        if (!initialized.ok)
          throw Error(
            "Bookie recall controls unavailable; restore trusted state before continuing.",
          );
      }
      if (captureEpoch !== revision)
        throw Error("Bookie capture permission changed.");
      allowManaged = false;
      managedSelection = undefined;
      onManual();
      grant = {
        vault,
        project: project.source.path,
        projectHash: project.source.sourceHash,
        summaries,
        ...(sensitivity ? { sensitivity } : {}),
      };
      ctx.ui.notify(
        "Bookie routine capture enabled for the selected project in this session.",
        "info",
      );
    },
  });
  return {
    bind,
    canManage: () => allowManaged,
    selectManaged(selected: ManagedSelection) {
      if (!allowManaged) return false;
      if (managedSelection !== selected) {
        managedSelection = selected;
        grant = {
          vault: selected.vault,
          project: selected.scope.project.path,
          projectHash: selected.scope.project.sourceHash,
          summaries: true,
          sensitivity: "internal",
        };
      }
      return true;
    },
    async assertManaged(selected: ManagedSelection) {
      if (!allowManaged || managedSelection !== selected)
        throw Error("Bookie capture permission was revoked.");
      await selected.vault.assertCurrent();
      if (!allowManaged || managedSelection !== selected)
        throw Error("Bookie capture permission was revoked.");
    },
    standingCheckpoint,
    reset,
    hasStanding: () => grant?.summaries === true,
    setReferenceSync: (handler: (ctx: ExtensionContext) => Promise<void>) => {
      sync = handler;
    },
    async referenceGrant(): Promise<ReferenceCaptureGrant | undefined> {
      const selected = grant;
      if (!selected?.sensitivity) return;
      const guard = async () => {
        if (grant !== selected)
          throw Error("Bookie reference capture revoked.");
        await selected.vault.assertCurrent();
        const scope = await inspectRecallScope(selected.vault.root, {
          path: selected.project,
          sourceHash: selected.projectHash,
        });
        if (
          !scope.ok ||
          !scope.scope.sensitivityClasses.includes(selected.sensitivity!) ||
          scope.scope.excludedClasses.includes(selected.sensitivity!)
        )
          throw Error("Bookie reference scope changed.");
        if (grant !== selected)
          throw Error("Bookie reference capture revoked.");
      };
      await guard();
      return {
        vault: selected.vault,
        project: { path: selected.project, sourceHash: selected.projectHash },
        sensitivity: selected.sensitivity,
        assertCurrent: guard,
      };
    },
  };
}
