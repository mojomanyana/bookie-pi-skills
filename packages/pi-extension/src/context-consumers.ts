import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  containsDetectedSecret,
  prepareContext,
  prepareCanonicalExport,
  revalidateContext,
  type PreparedContextBundle,
  type PrepareContextRequest,
  type ProducerReference,
} from "pi-bookie-core";
import {
  DISCLOSURE_WITHHELD,
  type createDisclosureAuthority,
} from "./disclosure-authority.js";
import type { createBookieContextFilter } from "./context-filter.js";
import { readProducerReference, ProducerReadError } from "./producer-bridge.js";

const ENTRY = "bookie-prepared-context-v1",
  EVENT = "bookie:resolve:v1",
  MAX_RESULT = 40_000;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const textHash = (text: string) =>
  `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
const prefix = (text: string, budget: number) => {
  const bytes = Buffer.from(text);
  let end = Math.min(bytes.length, budget);
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
};
type Status =
  "unavailable" | "missing" | "stale" | "suppressed" | "denied" | "incomplete";
class ConsumerError extends Error {
  constructor(
    readonly status: Status,
    readonly causeUnknown = false,
  ) {
    super(`Bookie consumer failed: ${status}.`);
  }
}
function fail(status: Status, causeUnknown = false): never {
  throw new ConsumerError(status, causeUnknown);
}
function sourceFailure(reason: string): never {
  return fail(
    reason === "suppressed"
      ? "suppressed"
      : reason === "policy" || reason === "scope" || reason === "authority"
        ? "denied"
        : reason === "stale" ||
            reason === "source-changed" ||
            reason === "conflict"
          ? "stale"
          : "unavailable",
    ![
      "suppressed",
      "policy",
      "scope",
      "authority",
      "stale",
      "source-changed",
      "conflict",
    ].includes(reason),
  );
}
const toFailure = (error: unknown) =>
  error instanceof ConsumerError
    ? error
    : error instanceof ProducerReadError
      ? new ConsumerError(
          error.code === "not-found"
            ? "missing"
            : error.code === "source-changed"
              ? "stale"
              : error.code === "authority"
                ? "denied"
                : "unavailable",
          error.code === "unavailable",
        )
      : error instanceof Error && error.message === DISCLOSURE_WITHHELD
        ? new ConsumerError("denied")
        : new ConsumerError("unavailable", true);
type Authority = ReturnType<typeof createDisclosureAuthority>;
type Ticket = Awaited<ReturnType<Authority["capture"]>>;
type ContextReference = {
  kind: "context";
  bundleId: string;
  inputIds?: readonly string[];
};
type ProducerReferenceRequest = {
  kind: "producer";
  registrationId: string;
  part: "final" | "partial" | "manifest";
};
type Reference = ContextReference | ProducerReferenceRequest;
type BodyAuthorization = (scope: {
  record: ProducerReference;
  part: "final" | "partial";
  project: Ticket["scope"]["project"];
  destination: Ticket["binding"]["destination"];
}) => Promise<{ sensitivity: string }>;
interface Resolved {
  status: "resolved";
  excerpt: string;
  complete: boolean;
  truncated: boolean;
  references: readonly object[];
  untrusted: true;
}
interface Resolution {
  result: Resolved;
  assertCurrent: () => Promise<void>;
}
interface SavedBundle {
  schema: 1;
  bundleId: string;
  root: string;
  vaultUid: string;
  projectUid: string;
  request: PrepareContextRequest;
  controlRevision: string;
  binding: Ticket["binding"];
  inputs: readonly { path: string; uid: string; sourceHash: string }[];
}
function budget(value: unknown): number {
  if (value === undefined) return 12_000;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > 24_000
  )
    fail("incomplete");
  return value;
}
function validReference(value: unknown): value is Reference {
  if (!object(value)) return false;
  if (value.kind === "context")
    return (
      typeof value.bundleId === "string" &&
      /^sha256:[a-f0-9]{64}$/.test(value.bundleId) &&
      Object.keys(value).every((key) =>
        ["kind", "bundleId", "inputIds"].includes(key),
      ) &&
      (value.inputIds === undefined ||
        (Array.isArray(value.inputIds) &&
          value.inputIds.length > 0 &&
          value.inputIds.length <= 16 &&
          value.inputIds.every(
            (x) => typeof x === "string" && x.length <= 256,
          )))
    );
  return (
    value.kind === "producer" &&
    typeof value.registrationId === "string" &&
    /^sha256:[a-f0-9]{64}$/.test(value.registrationId) &&
    ["final", "partial", "manifest"].includes(String(value.part)) &&
    Object.keys(value).every((key) =>
      ["kind", "registrationId", "part"].includes(key),
    )
  );
}
function toolResult(value: object) {
  const text = JSON.stringify(value).replace(
    /[\u007f-\u009f\u2028\u2029]/gu,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  if (Buffer.byteLength(text) > MAX_RESULT) fail("incomplete");
  return {
    content: [{ type: "text" as const, text }],
    details: {
      mode: "bookie-consumer",
      bytes: Buffer.byteLength(text),
      untrusted: true,
    },
  };
}

export function registerContextConsumers(
  pi: ExtensionAPI,
  authority: Authority,
  filter: ReturnType<typeof createBookieContextFilter>,
) {
  const bundles = new Map<string, PreparedContextBundle>();
  let context: ExtensionContext | undefined;
  let epoch = 0;
  const reset = (_event: unknown, ctx: ExtensionContext) => {
    epoch++;
    bundles.clear();
    context = ctx;
  };
  pi.on("session_start", reset);
  pi.on("session_tree", reset);
  pi.on("session_shutdown", () => {
    epoch++;
    bundles.clear();
    context = undefined;
  });
  pi.on("model_select", () => {
    epoch++;
    bundles.clear();
  });
  pi.on("before_agent_start", (_event, ctx) => {
    context = ctx;
  });
  const aborted = (signal?: AbortSignal) => {
    if (signal?.aborted)
      throw new DOMException("Bookie request was aborted.", "AbortError");
  };
  async function ticket(
    ctx: ExtensionContext,
    dependency: "registry" | "canonical",
  ) {
    const root = await authority.selectedRoot(ctx);
    return authority.capture(root, ctx, dependency);
  }
  function saved(ctx: ExtensionContext, id: string): SavedBundle {
    const branch = ctx.sessionManager.getBranch();
    let bytes = 0;
    for (const entry of branch.slice(-256).reverse()) {
      if (entry.type !== "custom" || entry.customType !== ENTRY) continue;
      const data: unknown = entry.data;
      if (!object(data)) continue;
      const length = Buffer.byteLength(JSON.stringify(data));
      bytes += length;
      if (bytes > 262_144) fail("unavailable");
      if (data.bundleId !== id) continue;
      if (
        length > 96_000 ||
        data.schema !== 1 ||
        typeof data.root !== "string" ||
        typeof data.vaultUid !== "string" ||
        typeof data.projectUid !== "string" ||
        !object(data.request) ||
        !object(data.binding) ||
        !Array.isArray(data.inputs) ||
        data.inputs.length > 16
      )
        fail("stale");
      return data as unknown as SavedBundle;
    }
    return fail("missing");
  }
  function selectedSaved(selected: Ticket, record: SavedBundle) {
    if (
      record.root !== selected.root ||
      record.vaultUid !== selected.scope.vaultUid ||
      record.projectUid !== selected.scope.project.uid
    )
      fail("denied");
  }
  function sourceReferences(
    bundle: PreparedContextBundle,
    inputs: PreparedContextBundle["inputs"],
  ) {
    return inputs.map((input) => ({
      kind: "bookie-context-input",
      bundleId: bundle.digest,
      path: input.path,
      uid: input.uid,
      sourceHash: input.sourceHash,
      textHash: input.textHash,
      source: bundle.source,
      representation: input.representation,
      truncated: input.truncated,
    }));
  }
  async function prepare(
    ctx: ExtensionContext,
    params: {
      selectors?: readonly { path: string; sourceHash?: string }[];
      fromBundleId?: string;
      source?: { mode: string; commit?: string };
      maxBytes?: number;
    },
    signal?: AbortSignal,
  ) {
    aborted(signal);
    context = ctx;
    const selected = await ticket(ctx, "canonical"),
      selectedEpoch = epoch;
    if (
      (params.selectors === undefined) ===
      (params.fromBundleId === undefined)
    )
      fail("incomplete");
    let input: PrepareContextRequest;
    if (params.fromBundleId) {
      const previous = saved(ctx, params.fromBundleId);
      selectedSaved(selected, previous);
      input = {
        ...structuredClone(previous.request),
        project: selected.scope.project,
      };
    } else
      input = {
        project: selected.scope.project,
        selectors: params.selectors as PrepareContextRequest["selectors"],
        ...(params.source === undefined
          ? {}
          : {
              source: params.source as NonNullable<
                PrepareContextRequest["source"]
              >,
            }),
        maxContentBytes: budget(params.maxBytes),
        maxTotalBytes: budget(params.maxBytes),
      };
    const result = await prepareContext(selected.root, input, {
      binding: selected.binding,
      ...(signal ? { signal } : {}),
    });
    if (!result.ok) sourceFailure(result.reason);
    if (
      result.bundle.inputs.some(
        (row) => !selected.classes.includes(row.sensitivity),
      )
    )
      fail("denied");
    await selected.assertCurrent();
    if (epoch !== selectedEpoch) fail("denied");
    aborted(signal);
    const bundle = result.bundle,
      record: SavedBundle = {
        schema: 1,
        bundleId: bundle.digest,
        root: selected.root,
        vaultUid: selected.scope.vaultUid,
        projectUid: selected.scope.project.uid,
        request: {
          ...bundle.request,
          selectors: bundle.inputs.map((row) => ({
            path: row.path,
            sourceHash: row.sourceHash,
          })),
        },
        controlRevision: bundle.controlRevision,
        binding: bundle.binding,
        inputs: bundle.inputs.map((row) => ({
          path: row.path,
          uid: row.uid,
          sourceHash: row.sourceHash,
        })),
      };
    if (Buffer.byteLength(JSON.stringify(record)) > 96_000) fail("incomplete");
    pi.appendEntry(ENTRY, record);
    bundles.set(bundle.digest, bundle);
    while (bundles.size > 16) bundles.delete(bundles.keys().next().value!);
    return {
      value: {
        status: "prepared",
        bundleId: bundle.digest,
        source: bundle.source,
        references: sourceReferences(bundle, bundle.inputs),
        untrusted: true,
      },
      assertCurrent: async () => {
        await selected.assertCurrent();
        if (epoch !== selectedEpoch) fail("denied");
      },
    };
  }
  async function resolveContext(
    ctx: ExtensionContext,
    reference: ContextReference,
    maximum: number,
    read: boolean,
    signal?: AbortSignal,
  ): Promise<Resolution> {
    const selected = await ticket(ctx, "canonical"),
      selectedEpoch = epoch,
      record = saved(ctx, reference.bundleId);
    selectedSaved(selected, record);
    const bundle = bundles.get(reference.bundleId);
    if (!bundle) fail("stale");
    const check = async () => {
      aborted(signal);
      if (epoch !== selectedEpoch) fail("denied");
      saved(ctx, reference.bundleId);
      await selected.assertCurrent();
      const result = await revalidateContext(selected.root, bundle, {
        binding: selected.binding,
        ...(signal ? { signal } : {}),
      });
      if (!result.ok) sourceFailure(result.reason);
      if (
        result.bundle.inputs.some(
          (row) => !selected.classes.includes(row.sensitivity),
        )
      )
        fail("denied");
      await selected.assertCurrent();
      aborted(signal);
    };
    await check();
    const ids = reference.inputIds ? new Set(reference.inputIds) : undefined;
    const inputs = bundle.inputs.filter((row) => !ids || ids.has(row.uid));
    if (ids && inputs.length !== ids.size) fail("missing");
    const text = read
      ? inputs
          .map(
            (input) =>
              `[${input.uid} ${input.path} ${input.sourceHash}]\n${input.text}`,
          )
          .join("\n\n")
      : "";
    const excerpt = prefix(text, maximum),
      truncated = excerpt !== text || inputs.some((input) => input.truncated);
    return {
      result: {
        status: "resolved",
        excerpt,
        complete: !truncated,
        truncated,
        references: sourceReferences(bundle, inputs),
        untrusted: true,
      },
      assertCurrent: check,
    };
  }
  async function resolveProducer(
    ctx: ExtensionContext,
    reference: ProducerReferenceRequest,
    maximum: number,
    authorizeBody?: BodyAuthorization,
    signal?: AbortSignal,
  ): Promise<Resolution> {
    const selected = await ticket(ctx, "registry"),
      selectedEpoch = epoch,
      row = selected.controls.registrations.find(
        (row) => row.id === reference.registrationId,
      );
    if (!row) fail("missing");
    if (
      row.project.uid !== selected.scope.project.uid ||
      !selected.classes.includes(row.sensitivity)
    )
      fail("denied");
    if (
      selected.controls.controls.some(
        (c) =>
          c.project.uid === row.project.uid &&
          c.target.kind === "producer" &&
          c.target.registrationId === row.id,
      )
    )
      fail("suppressed");
    const checkAuthority = async () => {
      aborted(signal);
      if (epoch !== selectedEpoch) fail("denied");
      await selected.assertCurrent();
      if (reference.part !== "manifest") {
        let sensitivity = selected.producerBodyClass(row.record);
        if (authorizeBody) {
          try {
            const result = await authorizeBody({
              record: structuredClone(row.record),
              part: reference.part,
              project: selected.scope.project,
              destination: selected.binding.destination,
            });
            sensitivity = result.sensitivity;
          } catch {
            fail("denied");
          }
        }
        if (!sensitivity || !selected.classes.includes(sensitivity))
          fail("denied");
      }
      await selected.assertCurrent();
      aborted(signal);
    };
    await checkAuthority();
    const reply = await readProducerReference(
      pi,
      ctx,
      row.record,
      checkAuthority,
    );
    await checkAuthority();
    const manifest = reply.manifest as Record<string, unknown>;
    const operation = manifest.operation as Record<string, unknown>;
    const runtime = object(operation.runtime) ? operation.runtime : {};
    const source = {
      kind: "bookie-producer",
      representation:
        reference.part === "manifest"
          ? "bookie-producer-reference/v1"
          : "utf8-producer-text/v1",
      execution: {
        state: operation.state,
        work: ["succeeded", "failed", "unknown"].includes(String(runtime.work))
          ? runtime.work
          : "unknown",
        control: runtime.control === "failed" ? "failed" : "unknown",
      },
      approval: false,
      registrationId: row.id,
      producer: row.record.producer,
      producerInstance: row.record.producerInstance,
      owner: row.record.owner,
      operationId: row.record.operationId,
      executionId: row.record.executionId,
      part: reference.part,
      manifest: {
        sha256: row.record.reference.sha256,
        bytes: row.record.reference.byteLength,
      },
      historical:
        row.record.owner.sessionId !== ctx.sessionManager.getSessionId(),
    };
    let text: string;
    if (reference.part === "manifest")
      text = JSON.stringify({
        reference: source,
        scope: "retained producer metadata; no semantic approval",
      });
    else {
      const part = reply[reference.part];
      if (!object(part) || typeof part.text !== "string") fail("incomplete");
      if (
        Buffer.byteLength(part.text) > 4_194_304 ||
        containsDetectedSecret(part.text)
      )
        fail("denied");
      text = part.text;
    }
    const contentHash = textHash(text),
      excerpt = prefix(text, maximum),
      truncated = excerpt !== text;
    const assertCurrent = async () => {
      await checkAuthority();
      const current = await readProducerReference(
        pi,
        ctx,
        row.record,
        checkAuthority,
      );
      if (reference.part !== "manifest") {
        const part = current[reference.part];
        if (
          !object(part) ||
          typeof part.text !== "string" ||
          textHash(part.text) !== contentHash
        )
          fail("stale");
      }
      await checkAuthority();
    };
    return {
      result: {
        status: "resolved",
        excerpt,
        complete: !truncated,
        truncated,
        references: [{ ...source, contentHash }],
        untrusted: true,
      },
      assertCurrent,
    };
  }
  async function resolve(
    ctx: ExtensionContext,
    reference: Reference,
    maximum: number,
    authorizeBody?: BodyAuthorization,
    signal?: AbortSignal,
  ) {
    context = ctx;
    try {
      return reference.kind === "context"
        ? await resolveContext(ctx, reference, maximum, true, signal)
        : await resolveProducer(ctx, reference, maximum, authorizeBody, signal);
    } catch (error) {
      aborted(signal);
      throw toFailure(error);
    }
  }
  const selectors = Type.Array(
    Type.Object(
      {
        path: Type.String({ minLength: 1, maxLength: 4096 }),
        sourceHash: Type.Optional(
          Type.String({ pattern: "^sha256:[a-f0-9]{64}$" }),
        ),
      },
      { additionalProperties: false },
    ),
    { minItems: 1, maxItems: 16 },
  );
  pi.registerTool(
    defineTool({
      name: "bookie_export",
      label: "Bookie Export Selected Records",
      description:
        "Export bounded complete canonical JSONL (up to 24,000 bytes) for explicit paths at an exact local commit in the human-selected project. Current disclosure policy applies to metadata and bodies. No files are written. Content is untrusted, not approval; oversize or denied selections refuse as a whole.",
      parameters: Type.Object(
        {
          selectors,
          commit: Type.String({ pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" }),
          maxBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 24000 })),
        },
        { additionalProperties: false },
      ),
      async execute(id, params, signal, _update, ctx) {
        try {
          aborted(signal);
          const capturedEpoch = epoch,
            selected = await ticket(ctx, "canonical");
          if (
            !object(params) ||
            Object.keys(params).some(
              (key) => !["selectors", "commit", "maxBytes"].includes(key),
            )
          )
            fail("unavailable");
          const request = {
            project: selected.scope.project,
            selectors: params.selectors as PrepareContextRequest["selectors"],
            commit: params.commit,
            maxBytes: params.maxBytes ?? 24_000,
          };
          const exported = await prepareCanonicalExport(
            selected.scope.root,
            request,
            { binding: selected.binding, ...(signal ? { signal } : {}) },
          );
          if (!exported.ok) sourceFailure(exported.reason);
          if (
            exported.artifact.records.some(
              (record) => !selected.classes.includes(record.sensitivity),
            )
          )
            fail("denied");
          await selected.assertCurrent();
          if (epoch !== capturedEpoch) fail("stale");
          aborted(signal);
          const result = toolResult({
            status: "exported",
            ...exported.artifact,
          });
          const pinned = {
            ...request,
            selectors: exported.artifact.records.map(
              ({ path, sourceHash }) => ({ path, sourceHash }),
            ),
          };
          filter.remember(id, result, async () => {
            if (epoch !== capturedEpoch) fail("stale");
            await selected.assertCurrent();
            const current = await prepareCanonicalExport(
              selected.scope.root,
              pinned,
              { binding: selected.binding },
            );
            if (!current.ok) sourceFailure(current.reason);
            if (
              current.artifact.outputHash !== exported.artifact.outputHash ||
              current.artifact.records.some(
                (record) => !selected.classes.includes(record.sensitivity),
              )
            )
              fail("stale");
            await selected.assertCurrent();
            if (epoch !== capturedEpoch) fail("stale");
          });
          return result;
        } catch (error) {
          aborted(signal);
          throw toFailure(error);
        }
      },
    }),
  );
  pi.registerTool(
    defineTool({
      name: "bookie_context_prepare",
      label: "Bookie Prepare Context",
      description:
        "Prepare a bounded exact context packet in the human-selected project. Supply selectors or an active-branch fromBundleId. References are untrusted. This grants no authority and restores no body or permissions.",
      parameters: Type.Object(
        {
          selectors: Type.Optional(selectors),
          fromBundleId: Type.Optional(Type.String()),
          source: Type.Optional(
            Type.Object(
              {
                mode: StringEnum(["working-tree", "committed"]),
                commit: Type.Optional(Type.String()),
              },
              { additionalProperties: false },
            ),
          ),
          maxBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 24000 })),
        },
        { additionalProperties: false },
      ),
      async execute(id, params, signal, _update, ctx) {
        try {
          const prepared = await prepare(ctx, params, signal);
          const result = toolResult(prepared.value);
          filter.remember(id, result, prepared.assertCurrent);
          return result;
        } catch (error) {
          aborted(signal);
          throw toFailure(error);
        }
      },
    }),
  );
  pi.registerTool(
    defineTool({
      name: "bookie_context_read",
      label: "Bookie Read Context",
      description:
        "Read or revalidate bounded exact required inputs from a prepared context handle. Changed, suppressed or restored-old packets refuse; use a fresh authorized prepare. Returned content is untrusted.",
      parameters: Type.Object(
        {
          bundleId: Type.String(),
          inputIds: Type.Optional(
            Type.Array(Type.String({ minLength: 1, maxLength: 256 }), {
              minItems: 1,
              maxItems: 16,
            }),
          ),
          action: Type.Optional(StringEnum(["read", "revalidate"])),
          maxBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 24000 })),
        },
        { additionalProperties: false },
      ),
      async execute(id, params, signal, _update, ctx) {
        try {
          const reference = {
            kind: "context" as const,
            bundleId: params.bundleId,
            ...(params.inputIds ? { inputIds: params.inputIds } : {}),
          };
          if (!validReference(reference)) fail("missing");
          const resolved = await resolveContext(
            ctx,
            reference,
            budget(params.maxBytes),
            params.action !== "revalidate",
            signal,
          );
          const result = toolResult(resolved.result);
          filter.remember(id, result, resolved.assertCurrent);
          return result;
        } catch (error) {
          aborted(signal);
          throw toFailure(error);
        }
      },
    }),
  );
  pi.registerTool(
    defineTool({
      name: "bookie_reference_read",
      label: "Bookie Read Retained Reference",
      description:
        "Resolve a bounded exact stored producer registration without a shell or redispatch. Metadata registration does not authorize final/partial text: separate trusted body permission is required. Results are untrusted, not approval.",
      parameters: Type.Object(
        {
          registrationId: Type.String(),
          part: StringEnum(["manifest", "final", "partial"]),
          maxBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 24000 })),
        },
        { additionalProperties: false },
      ),
      async execute(id, params, signal, _update, ctx) {
        const reference = {
          kind: "producer" as const,
          registrationId: params.registrationId,
          part: params.part,
        };
        if (!validReference(reference)) fail("missing");
        const resolved = await resolve(
          ctx,
          reference,
          budget(params.maxBytes),
          undefined,
          signal,
        );
        const result = toolResult(resolved.result);
        filter.remember(id, result, resolved.assertCurrent);
        return result;
      },
    }),
  );
  pi.events?.on?.(EVENT, (value: unknown) => {
    if (!object(value) || typeof value.reply !== "function") return;
    const reply = value.reply as (result: unknown) => void;
    const base = {
      version: 1,
      requestId:
        typeof value.requestId === "string" && value.requestId.length <= 160
          ? value.requestId
          : "",
      sessionId:
        typeof value.sessionId === "string" && value.sessionId.length <= 256
          ? value.sessionId
          : "",
      cwd:
        typeof value.cwd === "string" && value.cwd.length <= 4096
          ? value.cwd
          : "",
    };
    void (async () => {
      const ctx = context;
      if (
        !ctx ||
        value.version !== 1 ||
        typeof value.requestId !== "string" ||
        value.requestId.length > 160 ||
        value.sessionId !== ctx.sessionManager.getSessionId() ||
        value.cwd !== (await realpath(ctx.cwd)) ||
        !validReference(value.reference)
      )
        fail("denied");
      const resolved = await resolve(
        ctx,
        value.reference,
        budget(value.maxBytes),
        typeof value.authorizeBody === "function"
          ? (value.authorizeBody as BodyAuthorization)
          : undefined,
      );
      if (Buffer.byteLength(JSON.stringify(resolved.result)) > MAX_RESULT)
        fail("incomplete");
      reply({
        ...base,
        ok: true,
        result: resolved.result,
        assertCurrent: resolved.assertCurrent,
      });
    })().catch((error) => {
      const failure = toFailure(error);
      try {
        reply({
          ...base,
          ok: false,
          status: failure.status,
          ...(failure.causeUnknown ? { causeUnknown: true } : {}),
        });
      } catch {
        /* A disconnected consumer cannot mutate data or redispatch. */
      }
    });
  });
}
