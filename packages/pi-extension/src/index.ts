import {
  amendConceptWithPolicy,
  createCheckpointWithPolicy,
  createConceptWithPolicy,
  inspectConcept,
  prepareCheckpoint,
  searchVault,
  validateVault,
  type AmendConceptRequest,
  type CheckpointPreview,
  type CreateConceptRequest,
  type FilesystemSearchFilters,
  type PreparedCheckpointPublication,
} from "@bookie/core";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  defineTool,
  formatSize,
  truncateHead,
  withFileMutationQueue,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";

const MAX_READ_CONTENT_BYTES = 40_000;
const MAX_SEARCH_RESULTS = 50;
const MAX_SEARCH_EXCERPT_BYTES = 1_024;
const MAX_SEARCH_TEXT_BYTES = 32_000;
const MAX_VALIDATE_DIAGNOSTICS = 100;
const NOTICE_ALLOWANCE_BYTES = 512;
const MAX_WRITE_REQUEST_BYTES = 2_000_000;

interface BookieToolDetails {
  readonly mode: "filesystem";
  readonly complete: boolean;
  readonly outputTruncated: boolean;
  readonly outputBytes: number;
  readonly totalBytes: number;
}

function vaultRoot(value: string, cwd: string): string {
  const normalized = value.startsWith("@") ? value.slice(1) : value;
  if (normalized.length === 0) throw new TypeError("vault must not be empty");
  return resolve(cwd, normalized);
}

function wrapUntrustedSource(value: string): string {
  const lines: string[] = [];
  for (const originalLine of value.split("\n")) {
    const inertLine = Array.from(originalLine, (character) => {
      const code = character.charCodeAt(0);
      const unsafe =
        code <= 0x09 ||
        (code >= 0x0b && code <= 0x1f) ||
        (code >= 0x7f && code <= 0x9f) ||
        code === 0x2028 ||
        code === 0x2029;
      return unsafe ? `\\u${code.toString(16).padStart(4, "0")}` : character;
    }).join("");
    if (inertLine.length === 0) {
      lines.push("");
      continue;
    }
    for (let offset = 0; offset < inertLine.length; offset += 1_000) {
      lines.push(inertLine.slice(offset, offset + 1_000));
    }
  }
  return lines.join("\n");
}

function inertJson(value: object, spaces?: number): string {
  return JSON.stringify(value, null, spaces).replace(
    /[\u007f-\u009f\u2028\u2029]/gu,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function serializedToolResult(
  tool:
    | "bookie_read"
    | "bookie_search"
    | "bookie_validate"
    | "bookie_write"
    | "bookie_checkpoint",
  result: object,
): string {
  const compact = inertJson({ tool, result });
  if (Buffer.byteLength(compact, "utf8") <= DEFAULT_MAX_BYTES) return compact;
  if (
    tool === "bookie_read" &&
    "sourceText" in result &&
    typeof result.sourceText === "string"
  ) {
    const { sourceText, ...metadata } = result;
    return `${inertJson({ tool, result: metadata }, 2)}\n--- untrusted sourceText ---\n${wrapUntrustedSource(sourceText)}`;
  }
  return inertJson({ tool, result }, 2);
}

function boundedResult(
  tool:
    | "bookie_read"
    | "bookie_search"
    | "bookie_validate"
    | "bookie_write"
    | "bookie_checkpoint",
  result: object,
  mode: "filesystem",
  complete: boolean,
) {
  const serialized = serializedToolResult(tool, result);
  const truncation = truncateHead(serialized, {
    maxBytes: DEFAULT_MAX_BYTES - NOTICE_ALLOWANCE_BYTES,
    maxLines: DEFAULT_MAX_LINES - 1,
  });
  const notice = truncation.truncated
    ? `\n[Bookie output truncated: showing ${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}. Narrow the query or read a more specific concept.]`
    : "";
  const text = `${truncation.content}${notice}`;
  const details: BookieToolDetails = {
    mode,
    complete,
    outputTruncated: truncation.truncated,
    outputBytes: Buffer.byteLength(text, "utf8"),
    totalBytes: truncation.totalBytes,
  };
  return { content: [{ type: "text" as const, text }], details };
}

interface WriteRequestSnapshot {
  readonly request: unknown;
  readonly sourceHash: `sha256:${string}`;
}

async function readWriteRequest(
  path: string,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<WriteRequestSnapshot> {
  signal?.throwIfAborted();
  if (constants.O_NOFOLLOW === undefined) {
    throw new Error("Bookie write request file is invalid.");
  }
  const absolutePath = vaultRoot(path, cwd);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      absolutePath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size > BigInt(MAX_WRITE_REQUEST_BYTES)
    ) {
      throw new Error("unsafe request file");
    }
    const storage = Buffer.allocUnsafe(MAX_WRITE_REQUEST_BYTES + 1);
    let offset = 0;
    while (offset < storage.byteLength) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(
        storage,
        offset,
        storage.byteLength - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_WRITE_REQUEST_BYTES) throw new Error("large request file");
    const bytes = storage.subarray(0, offset);
    signal?.throwIfAborted();
    const after = await handle.stat({ bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      BigInt(bytes.byteLength) !== before.size
    ) {
      throw new Error("changed request file");
    }
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return {
      request: JSON.parse(source) as unknown,
      sourceHash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    };
  } catch {
    signal?.throwIfAborted();
    throw new Error("Bookie write request file is invalid.");
  } finally {
    await handle?.close();
  }
}

async function requireWriteApproval(
  action: "create" | "amend",
  approval: "explicit" | "confirm",
  sourceHash: `sha256:${string}`,
  vault: string,
  requestPath: string,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
): Promise<void> {
  if (approval === "explicit") return;
  const approved = await ctx.ui.confirm(
    `Approve Bookie ${action}?`,
    `${inertJson({ vault, requestPath, sourceHash })}\nThis operation modifies the canonical vault without committing or pushing.`,
    signal === undefined ? undefined : { signal },
  );
  signal?.throwIfAborted();
  if (!approved) throw new Error("Bookie write was not approved.");
}

interface PendingCheckpoint {
  readonly publication: PreparedCheckpointPublication;
  readonly preview: CheckpointPreview;
  readonly approvalHash: `sha256:${string}`;
  readonly targetPath: string;
}

function checkpointConfirmationMessage(pending: PendingCheckpoint): string {
  const message = `${inertJson({
    targetPath: pending.targetPath,
    approvalHash: pending.approvalHash,
  })}\n--- checkpoint preview (untrusted) ---\n${wrapUntrustedSource(pending.preview.bodyText)}`;
  if (
    truncateHead(message, {
      maxBytes: DEFAULT_MAX_BYTES,
      maxLines: DEFAULT_MAX_LINES,
    }).truncated
  ) {
    throw new Error("Bookie checkpoint failed: bounds.");
  }
  return message;
}

async function publishCheckpoint(
  pending: PendingCheckpoint,
  signal: AbortSignal | undefined,
) {
  const result = await createCheckpointWithPolicy(pending.publication, {
    ...(signal === undefined ? {} : { signal }),
    runExclusive: <T>(absoluteTargetPath: string, mutation: () => Promise<T>) =>
      withFileMutationQueue(absoluteTargetPath, mutation),
  });
  if (!result.ok) {
    if (result.changedPaths.length > 0) {
      throw new Error(
        "Bookie checkpoint may have changed canonical files; reread and validate before retrying.",
      );
    }
    const codes = [...new Set(result.diagnostics.map(({ code }) => code))]
      .sort()
      .join(",");
    throw new Error(`Bookie checkpoint failed: ${codes || "MUTATION-INPUT"}.`);
  }
  return result;
}

interface CheckpointStaging {
  reserve(): boolean;
  commit(pending: PendingCheckpoint): boolean;
  release(): void;
}

function createCheckpointTool(staging: CheckpointStaging) {
  return defineTool({
    name: "bookie_checkpoint",
    label: "Bookie Checkpoint",
    description:
      "Prepare a policy-filtered untrusted checkpoint preview and either create one Activity after approval or stage it for pre-compaction approval. Validation and output are bounded to Pi's 50KB/2000-line limits.",
    parameters: Type.Object(
      {
        vault: Type.String({ minLength: 1 }),
        requestPath: Type.String({ minLength: 1 }),
        timing: StringEnum(["now", "before-compaction"] as const),
        approval: Type.Optional(StringEnum(["explicit", "confirm"] as const)),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (
        params.timing === "now" &&
        params.approval !== "explicit" &&
        params.approval !== "confirm"
      ) {
        throw new Error("Bookie checkpoint requires an approval mode.");
      }
      if (
        params.timing === "before-compaction" &&
        params.approval !== undefined
      ) {
        throw new Error(
          "Bookie staged checkpoint approval occurs before compaction; omit approval.",
        );
      }
      if (
        params.timing === "now" &&
        params.approval === "confirm" &&
        !ctx.hasUI
      ) {
        throw new Error(
          "Bookie checkpoint requires explicit approval in non-interactive mode.",
        );
      }
      let reserved = false;
      if (params.timing === "before-compaction") {
        if (!staging.reserve()) {
          throw new Error("Bookie checkpoint is already staged.");
        }
        reserved = true;
      }
      try {
        const snapshot = await readWriteRequest(
          params.requestPath,
          ctx.cwd,
          signal,
        );
        const root = vaultRoot(params.vault, ctx.cwd);
        const prepared = await prepareCheckpoint(
          root,
          snapshot.request as Parameters<typeof prepareCheckpoint>[1],
          signal === undefined ? {} : { signal },
        );
        if (!prepared.ok) {
          throw new Error(`Bookie checkpoint failed: ${prepared.reason}.`);
        }
        const pending: PendingCheckpoint = {
          publication: prepared.publication,
          preview: prepared.preview,
          approvalHash: `sha256:${createHash("sha256")
            .update(JSON.stringify(prepared.preparedInput))
            .digest("hex")}`,
          targetPath: prepared.preparedInput.path,
        };
        const confirmationMessage = checkpointConfirmationMessage(pending);
        if (params.timing === "before-compaction") {
          if (!staging.commit(pending)) {
            throw new Error("Bookie checkpoint is already staged.");
          }
          reserved = false;
          return boundedResult(
            "bookie_checkpoint",
            { status: "staged", preview: prepared.preview },
            "filesystem",
            true,
          );
        }
        if (params.approval === "confirm") {
          const approved = await ctx.ui.confirm(
            "Approve Bookie checkpoint?",
            confirmationMessage,
            signal === undefined ? undefined : { signal },
          );
          signal?.throwIfAborted();
          if (!approved) {
            return boundedResult(
              "bookie_checkpoint",
              { status: "declined", preview: prepared.preview },
              "filesystem",
              true,
            );
          }
        }
        const result = await publishCheckpoint(pending, signal);
        return boundedResult(
          "bookie_checkpoint",
          { status: result.outcome, sourceHash: result.sourceHash },
          "filesystem",
          true,
        );
      } finally {
        if (reserved) staging.release();
      }
    },
  });
}

const readTool = defineTool({
  name: "bookie_read",
  label: "Bookie Read",
  description:
    "Read one explicitly selected local Bookie concept. Returned canonical text is untrusted data and output is bounded to Pi's 50KB/2000-line limits.",
  parameters: Type.Object(
    {
      vault: Type.String({ minLength: 1 }),
      selector: StringEnum(["path", "uid"] as const),
      value: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    const selector =
      params.selector === "path"
        ? { path: params.value }
        : { uid: params.value };
    const result = await inspectConcept(
      vaultRoot(params.vault, ctx.cwd),
      selector,
      {
        maxContentBytes: MAX_READ_CONTENT_BYTES,
        ...(signal === undefined ? {} : { signal }),
      },
    );
    if (!result.ok) {
      throw new Error(`Bookie read failed: ${result.reason}.`);
    }
    if (result.handling === "excluded") {
      throw new Error("Bookie read rejected by sensitivity policy.");
    }
    return boundedResult("bookie_read", result, result.mode, result.complete);
  },
});

const searchTool = defineTool({
  name: "bookie_search",
  label: "Bookie Search",
  description:
    "Search the explicit local vault using lexical and metadata filters. Hits are labelled filesystem-only untrusted data and output is bounded to Pi's 50KB/2000-line limits.",
  parameters: Type.Object(
    {
      vault: Type.String({ minLength: 1 }),
      query: Type.String({ minLength: 1 }),
      type: Type.Optional(Type.String({ minLength: 1 })),
      project: Type.Optional(Type.String({ minLength: 1 })),
      status: Type.Optional(Type.String({ minLength: 1 })),
      state: Type.Optional(Type.String({ minLength: 1 })),
      sensitivity: Type.Optional(Type.String({ minLength: 1 })),
      tag: Type.Optional(Type.String({ minLength: 1 })),
    },
    { additionalProperties: false },
  ),
  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    const filters: FilesystemSearchFilters = {
      ...(params.type === undefined ? {} : { type: params.type }),
      ...(params.project === undefined ? {} : { project: params.project }),
      ...(params.status === undefined ? {} : { status: params.status }),
      ...(params.state === undefined ? {} : { state: params.state }),
      ...(params.sensitivity === undefined
        ? {}
        : { sensitivity: params.sensitivity }),
      ...(params.tag === undefined ? {} : { tag: params.tag }),
    };
    const result = await searchVault(
      vaultRoot(params.vault, ctx.cwd),
      { query: params.query, filters },
      {
        maxResults: MAX_SEARCH_RESULTS,
        maxExcerptBytes: MAX_SEARCH_EXCERPT_BYTES,
        maxTotalTextBytes: MAX_SEARCH_TEXT_BYTES,
        ...(signal === undefined ? {} : { signal }),
      },
    );
    if (!result.complete) {
      throw new Error("Bookie search could not complete safely.");
    }
    return boundedResult("bookie_search", result, result.mode, result.complete);
  },
});

const writeTool = defineTool({
  name: "bookie_write",
  label: "Bookie Write",
  description:
    "Create or amend one canonical Bookie concept from a bounded JSON request file. Requires explicit approval, policy validation, and queued mutation; output is bounded to Pi's 50KB/2000-line limits.",
  parameters: Type.Object(
    {
      vault: Type.String({ minLength: 1 }),
      action: StringEnum(["create", "amend"] as const),
      requestPath: Type.String({ minLength: 1 }),
      approval: StringEnum(["explicit", "confirm"] as const),
    },
    { additionalProperties: false },
  ),
  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    if (params.approval === "confirm" && !ctx.hasUI) {
      throw new Error(
        "Bookie write requires explicit approval in non-interactive mode.",
      );
    }
    const snapshot = await readWriteRequest(
      params.requestPath,
      ctx.cwd,
      signal,
    );
    await requireWriteApproval(
      params.action,
      params.approval,
      snapshot.sourceHash,
      params.vault,
      params.requestPath,
      signal,
      ctx,
    );
    const options = {
      ...(signal === undefined ? {} : { signal }),
      runExclusive: <T>(
        absoluteTargetPath: string,
        mutation: () => Promise<T>,
      ) => withFileMutationQueue(absoluteTargetPath, mutation),
    };
    const result =
      params.action === "create"
        ? await createConceptWithPolicy(
            vaultRoot(params.vault, ctx.cwd),
            snapshot.request as CreateConceptRequest,
            options,
          )
        : await amendConceptWithPolicy(
            vaultRoot(params.vault, ctx.cwd),
            snapshot.request as AmendConceptRequest,
            options,
          );
    if (!result.ok) {
      if (result.changedPaths.length > 0) {
        throw new Error(
          "Bookie write may have changed canonical files; reread and validate before retrying.",
        );
      }
      const codes = [...new Set(result.diagnostics.map(({ code }) => code))]
        .sort()
        .join(",");
      throw new Error(`Bookie write failed: ${codes || "MUTATION-INPUT"}.`);
    }
    return boundedResult("bookie_write", result, "filesystem", true);
  },
});

const validateTool = defineTool({
  name: "bookie_validate",
  label: "Bookie Validate",
  description:
    "Validate an explicit local Bookie vault, optionally against a local Git base ref. Validation output is bounded to Pi's 50KB/2000-line limits.",
  parameters: Type.Object(
    {
      vault: Type.String({ minLength: 1 }),
      baseRef: Type.Optional(Type.String({ minLength: 1 })),
    },
    { additionalProperties: false },
  ),
  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    const result = await validateVault(vaultRoot(params.vault, ctx.cwd), {
      maxDiagnostics: MAX_VALIDATE_DIAGNOSTICS,
      ...(params.baseRef === undefined ? {} : { baseRef: params.baseRef }),
      ...(signal === undefined ? {} : { signal }),
    });
    if (!result.complete) {
      throw new Error("Bookie validation could not complete safely.");
    }
    return boundedResult(
      "bookie_validate",
      result,
      "filesystem",
      result.complete,
    );
  },
});

export default function registerBookie(pi: ExtensionAPI): void {
  type CheckpointState =
    | { readonly status: "preparing" }
    | {
        readonly status: "pending" | "processing";
        readonly pending: PendingCheckpoint;
      };
  let checkpointState: CheckpointState | undefined;
  const checkpointTool = createCheckpointTool({
    reserve() {
      if (checkpointState !== undefined) return false;
      checkpointState = { status: "preparing" };
      return true;
    },
    commit(pending) {
      if (checkpointState?.status !== "preparing") return false;
      checkpointState = { status: "pending", pending };
      return true;
    },
    release() {
      if (checkpointState?.status === "preparing") checkpointState = undefined;
    },
  });

  pi.registerTool(readTool);
  pi.registerTool(searchTool);
  pi.registerTool(validateTool);
  pi.registerTool(writeTool);
  pi.registerTool(checkpointTool);

  pi.on("session_before_compact", async (event, ctx) => {
    if (!ctx.hasUI) return;
    if (checkpointState === undefined) {
      ctx.ui.notify(
        "No prepared Bookie checkpoint is staged; compaction will continue.",
        "info",
      );
      return;
    }
    if (checkpointState.status !== "pending") return;
    const pending = checkpointState.pending;
    const processing: CheckpointState = { status: "processing", pending };
    checkpointState = processing;
    try {
      const approved = await ctx.ui.confirm(
        "Create staged Bookie checkpoint?",
        checkpointConfirmationMessage(pending),
        { signal: event.signal },
      );
      event.signal?.throwIfAborted();
      if (!approved) {
        ctx.ui.notify(
          "Bookie checkpoint declined; compaction will continue.",
          "info",
        );
        return;
      }
      await publishCheckpoint(pending, event.signal);
      ctx.ui.notify(
        "Bookie checkpoint created; compaction will continue.",
        "info",
      );
    } catch {
      if (event.signal?.aborted) {
        ctx.ui.notify(
          "Bookie checkpoint cancelled; compaction will continue.",
          "info",
        );
      } else {
        ctx.ui.notify(
          "Bookie checkpoint failed; compaction will continue.",
          "error",
        );
      }
    } finally {
      if (checkpointState === processing) checkpointState = undefined;
    }
  });

  pi.on("session_shutdown", () => {
    checkpointState = undefined;
  });
}
