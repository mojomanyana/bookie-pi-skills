import { ProjectMemoryUnavailable } from "./memory-readiness.js";
import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
  containsDetectedSecret,
  inspectConcept,
  inspectRecallScope,
  readRecallState,
  initializeRecallState,
  type RecallScope,
  type ProducerReference,
} from "pi-bookie-core";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type {
  ManagedSelection,
  createManagedMemory,
} from "./managed-memory.js";
import type { VaultAuthority } from "./capture-authority.js";
const producerScopeKey = (value: ProducerReference) =>
  hash([value.producer, value.producerInstance, value.owner]);
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const safe = (v: unknown): v is string =>
  typeof v === "string" &&
  v.length > 0 &&
  v.length <= 4096 &&
  !Array.from(v).some((character) => {
    const point = character.codePointAt(0)!;
    return point <= 31 || (point >= 127 && point <= 159);
  }) &&
  !containsDetectedSecret(v);
export const DISCLOSURE_WITHHELD =
  "Bookie output withheld: current model disclosure authority is absent or changed. Previous project history is unknown. Use /bookie-context to select a project manually.";
export class WrongRecallVault extends Error {
  static readonly detail =
    "Bookie lookup withheld. The supplied vault does not match the selected project memory. If the request is about that project, retry once with the vault argument omitted.";
  constructor() {
    super(WrongRecallVault.detail);
  }
}
export const MUTATION_WITHHELD =
  "Bookie local state may have changed; protected output withheld. Inspect locally before retrying.";
async function destination(ctx: ExtensionContext) {
  const model = ctx.model;
  if (
    !model ||
    !safe(model.provider) ||
    !safe(model.id) ||
    !safe(model.api) ||
    typeof ctx.modelRegistry?.getApiKeyAndHeaders !== "function"
  )
    throw Error(DISCLOSURE_WITHHELD);
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw Error(DISCLOSURE_WITHHELD);
  const endpoint = new URL(auth.baseUrl ?? model.baseUrl);
  if (
    !["https:", "http:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw Error(DISCLOSURE_WITHHELD);
  return {
    provider: model.provider,
    model: model.id,
    api: model.api,
    endpoint: hash(endpoint.href),
  };
}
export function createDisclosureAuthority(
  pi: ExtensionAPI,
  bind: (root: string, ctx: ExtensionContext) => Promise<VaultAuthority>,
  managed?: ReturnType<typeof createManagedMemory>,
) {
  let epoch = 0;
  let allowManaged = true;
  type Grant = {
    vault: VaultAuthority;
    managed?: ManagedSelection;
    scope: RecallScope;
    classes: readonly string[];
    destination: Awaited<ReturnType<typeof destination>>;
    revision: number;
    id: string;
    bodyScopes: Map<string, string>;
  };
  let grant: Grant | undefined;
  const invalidate = () => {
    epoch++;
    grant = undefined;
  };
  const reset = () => {
    allowManaged = true;
    invalidate();
  };
  async function selectedFor(ctx: ExtensionContext) {
    if (!allowManaged && !grant) throw new ProjectMemoryUnavailable("disabled");
    if (!allowManaged || !managed) return grant;
    const revision = epoch;
    const project = await managed.get(ctx).catch(() => {
      throw new ProjectMemoryUnavailable("storage");
    });
    if (!project) {
      if (!ctx.hasUI) throw new ProjectMemoryUnavailable("interactive");
      if (ctx.isProjectTrusted?.() === false)
        throw new ProjectMemoryUnavailable("trust");
      throw new ProjectMemoryUnavailable("owner");
    }
    if (grant?.managed === project) return grant;
    const target = await destination(ctx).catch(() => {
      throw new ProjectMemoryUnavailable("destination");
    });
    await project.vault.assertCurrent();
    if (epoch !== revision || !allowManaged) throw Error(DISCLOSURE_WITHHELD);
    if (grant?.managed === project) return grant;
    grant = {
      vault: project.vault,
      managed: project,
      scope: project.scope,
      classes: ["internal", "public"].filter(
        (x) =>
          project.scope.sensitivityClasses.includes(x) &&
          !project.scope.excludedClasses.includes(x),
      ),
      destination: target,
      revision,
      id: randomUUID(),
      bodyScopes: new Map(),
    };
    return grant;
  }
  async function check(selected: Grant, ctx: ExtensionContext) {
    if (grant !== selected || epoch !== selected.revision)
      throw Error(DISCLOSURE_WITHHELD);
    await selected.vault.assertCurrent();
    const current = await inspectRecallScope(
      selected.vault.root,
      selected.scope.project,
    );
    if (!current.ok || hash(current.scope) !== hash(selected.scope))
      throw Error(DISCLOSURE_WITHHELD);
    const target = await destination(ctx).catch(() => {
      throw new ProjectMemoryUnavailable("destination");
    });
    if (grant !== selected || epoch !== selected.revision)
      throw Error(DISCLOSURE_WITHHELD);
    if (hash(target) !== hash(selected.destination))
      throw new ProjectMemoryUnavailable("destination");
    if (selected.managed) {
      await selected.vault.assertCurrent();
      if (grant !== selected || epoch !== selected.revision)
        throw Error(DISCLOSURE_WITHHELD);
    }
  }
  pi.registerCommand("bookie-context", {
    description:
      "Authorize selected Bookie project/classes for the current model destination; separate from saving permission.",
    async handler(args, ctx) {
      if (!ctx.hasUI)
        throw Error("Bookie context settings require trusted interactive UI.");
      if (args.trim() === "off") {
        allowManaged = false;
        managed?.hide();
        invalidate();
        ctx.ui.notify("Bookie model disclosure disabled.", "info");
        return;
      }
      if (args.trim() === "producer") {
        const selected = grant;
        if (!selected) throw Error(DISCLOSURE_WITHHELD);
        await check(selected, ctx);
        const state = await readRecallState(selected.vault.root);
        if (!state.ok) throw Error(DISCLOSURE_WITHHELD);
        const rows = state.state.registrations.filter(
          (row) =>
            row.project.uid === selected.scope.project.uid &&
            selected.classes.includes(row.sensitivity) &&
            !state.state.controls.some(
              (c) =>
                c.project.uid === row.project.uid &&
                c.target.kind === "producer" &&
                c.target.registrationId === row.id,
            ),
        );
        const sources = [
          ...new Map(
            rows.map((row) => [producerScopeKey(row.record), row.record]),
          ).entries(),
        ];
        if (!sources.length)
          throw Error("No permitted producer references are registered.");
        const choices = sources.map(
          ([key, value], i) =>
            `${i + 1}. ${value.producer} ${key.slice(0, 12)} ${value.owner.cwd.slice(-80)}`,
        );
        const choice = await ctx.ui.select(
          "Allow retained text from this registered producer owner",
          choices,
        );
        if (!choice) return;
        const index = choices.indexOf(choice);
        if (index < 0) throw Error(DISCLOSURE_WITHHELD);
        const source = sources[index]!;
        const bodyClass = await ctx.ui.select(
          "Declared sensitivity of retained producer text",
          [...selected.classes],
        );
        if (!bodyClass || !selected.classes.includes(bodyClass)) return;
        if (
          !(await ctx.ui.confirm(
            "Allow retained producer bodies for this session?",
            JSON.stringify({
              project: selected.scope.project.path,
              producer: source[1].producer,
              producerInstance: source[1].producerInstance,
              owner: source[1].owner,
              sensitivity: bodyClass,
              destination: selected.destination,
            }) +
              "\nThis separately permits final/partial text from this owner and source. Reference metadata did not grant it. Classification is your declaration, not automatic content detection; no body is imported.",
          ))
        )
          return;
        await check(selected, ctx);
        const now = await readRecallState(selected.vault.root);
        if (!now.ok || now.revision !== state.revision)
          throw Error(DISCLOSURE_WITHHELD);
        selected.bodyScopes.set(source[0], bodyClass);
        ctx.ui.notify(
          "Retained producer text enabled for this exact project, source owner, declared class and destination.",
          "info",
        );
        return;
      }
      if (args.trim())
        throw Error(
          "Use /bookie-context, /bookie-context producer, or /bookie-context off.",
        );
      const revision = epoch,
        root = await ctx.ui.input("Bookie vault directory", ctx.cwd);
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
        throw Error("Select an included Bookie Project.");
      const inspected = await inspectRecallScope(vault.root, {
        path: project.source.path,
        sourceHash: project.source.sourceHash,
      });
      if (!inspected.ok) throw Error("Bookie project scope is unavailable.");
      const scope = inspected.scope,
        available = scope.sensitivityClasses.filter(
          (x) => !scope.excludedClasses.includes(x),
        ),
        classes: string[] = [];
      while (classes.length < available.length) {
        const choice = await ctx.ui.select("Allow disclosure class", [
          ...(classes.length ? ["Done"] : []),
          ...available.filter((x) => !classes.includes(x)),
        ]);
        if (!choice) return;
        if (choice === "Done") break;
        if (!available.includes(choice))
          throw Error("Invalid disclosure selection.");
        classes.push(choice);
      }
      if (!classes.length) return;
      const target = await destination(ctx);
      if (
        !(await ctx.ui.confirm(
          "Allow Bookie data to this model for this session?",
          JSON.stringify({
            provider: target.provider,
            model: target.model,
            project: scope.project.path,
            classes,
          }) +
            "\nAuthorize this effective destination only. Initialize local recall controls if absent; no content upload now. Save permission remains separate. Prior conversation history is outside this output boundary.",
        ))
      )
        return;
      if (epoch !== revision) throw Error(DISCLOSURE_WITHHELD);
      await vault.assertCurrent();
      const initializationAuthority = async () => {
        if (epoch !== revision) throw Error(DISCLOSURE_WITHHELD);
        await vault.assertCurrent();
        const now = await inspectRecallScope(vault.root, scope.project);
        if (
          !now.ok ||
          hash(now.scope) !== hash(scope) ||
          hash(await destination(ctx)) !== hash(target) ||
          epoch !== revision
        )
          throw Error(DISCLOSURE_WITHHELD);
      };
      const initialized = await initializeRecallState(vault.root, {
        assertAuthority: initializationAuthority,
      });
      if (!initialized.ok)
        throw Error(
          "Bookie recall controls unavailable; restore trusted state before continuing.",
        );
      const selected: Grant = {
        vault,
        scope,
        classes,
        destination: target,
        revision,
        id: randomUUID(),
        bodyScopes: new Map(),
      };
      allowManaged = false;
      managed?.hide();
      grant = selected;
      try {
        await check(selected, ctx);
      } catch {
        if (grant === selected) invalidate();
        throw Error(DISCLOSURE_WITHHELD);
      }
      ctx.ui.notify(
        "Bookie disclosure enabled for the selected project, classes and current model destination.",
        "info",
      );
    },
  });
  pi.on("model_select", invalidate);
  return {
    reset,
    canManage: () => allowManaged,
    async selectedRoot(ctx: ExtensionContext) {
      const selected = await selectedFor(ctx);
      if (!selected) throw Error(DISCLOSURE_WITHHELD);
      await check(selected, ctx);
      return selected.vault.root;
    },
    async capture(
      root: string,
      ctx: ExtensionContext,
      dependency: "registry" | "canonical" = "registry",
      explicitRecall = false,
    ) {
      if (dependency !== "registry" && dependency !== "canonical")
        throw Error(DISCLOSURE_WITHHELD);
      const selected = await selectedFor(ctx);
      if (!selected) throw Error(DISCLOSURE_WITHHELD);
      const resolved = await realpath(root).catch(() => undefined);
      if (resolved !== selected.vault.root) {
        if (!explicitRecall) throw Error(DISCLOSURE_WITHHELD);
        // Give scope guidance only while the current project is still authorized.
        // Missing paths and other unselected vaults return the same fixed text.
        await check(selected, ctx);
        throw new WrongRecallVault();
      }
      await check(selected, ctx);
      const controls = await readRecallState(root);
      const identity = (state: Awaited<ReturnType<typeof readRecallState>>) => {
        if (!state.ok) throw Error(DISCLOSURE_WITHHELD);
        const revision =
          dependency === "canonical" ? state.controlsRevision : state.revision;
        // Mixed package versions must refuse, not compare absent fields as equal.
        if (
          typeof revision !== "string" ||
          !/^sha256:[a-f0-9]{64}$/u.test(revision)
        )
          throw Error(DISCLOSURE_WITHHELD);
        return revision;
      };
      if (!controls.ok || grant !== selected || epoch !== selected.revision)
        throw Error(DISCLOSURE_WITHHELD);
      const revision = identity(controls);
      const allows = (value: unknown) => {
        if (
          !object(value) ||
          !object(value.sensitivity) ||
          value.sensitivity.classification !== "declared" ||
          typeof value.sensitivity.value !== "string" ||
          !selected.classes.includes(value.sensitivity.value)
        )
          return false;
        if (
          value.project !== selected.scope.project.path &&
          !(
            object(value.source) &&
            value.source.path === selected.scope.project.path
          )
        )
          return false;
        return !controls.state.controls.some(
          (c) =>
            c.project.uid === selected.scope.project.uid &&
            c.target.kind === "concept" &&
            c.target.uid === value.uid,
        );
      };
      return {
        root: selected.vault.root,
        managedWorkspace: selected.managed !== undefined,
        scope: selected.scope,
        classes: [...selected.classes],
        controls: controls.state,
        controlRevision: revision,
        binding: {
          policyRevision: selected.id,
          destination: {
            provider: selected.destination.provider,
            model: selected.destination.model,
            endpoint: hash({
              api: selected.destination.api,
              endpoint: selected.destination.endpoint,
            }),
          },
        },
        producerBodyClass(record: ProducerReference) {
          return selected.bodyScopes.get(producerScopeKey(record));
        },
        allows,
        async assertCurrent() {
          await check(selected, ctx);
          const now = await readRecallState(root);
          if (
            identity(now) !== revision ||
            grant !== selected ||
            epoch !== selected.revision
          )
            throw Error(DISCLOSURE_WITHHELD);
        },
      };
    },
  };
}
