import {
  computeConceptSourceHash,
  isObject,
} from "./concept-mutation-model.js";
import { scanVaultForQuery } from "./vault-query-scan.js";
import { validationLimits } from "./vault-limits.js";
import { exportCanonicalJsonl } from "./canonical-export.js";
import type { CanonicalJsonlRecordV1 } from "./canonical-export-model.js";
import { containsDetectedSecret } from "./vault-secret-detection.js";
import {
  matchesExcludedPath,
  createPathTracker,
  readSafeBoundedFile,
  verifyTrackedPaths,
} from "./vault-filesystem.js";
import { throwIfAborted } from "./vault-cancellation.js";
import {
  RECALL_SCAN_LIMITS,
  inspectRecallScope,
  readRecallManifest,
  recallFailure,
  safeText,
  validHash,
  validRevision,
} from "./recall-scope.js";
import { isRecallSuppressed, readRecallState } from "./recall-state.js";
import type {
  ContextBinding,
  ContextInput,
  ContextOptions,
  PrepareContextRequest,
  PreparedContextBundle,
  RecallResult,
  RecallScope,
  RecallState,
} from "./recall-model.js";

const MAX_CONTEXT_BUNDLE_BYTES = 262_144;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (isObject(value))
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ":" + canonical(value[key]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
function validBinding(binding: unknown): binding is ContextBinding {
  return (
    isObject(binding) &&
    Object.keys(binding).length === 2 &&
    safeText(binding.policyRevision, 512) &&
    isObject(binding.destination) &&
    Object.keys(binding.destination).length === 3 &&
    safeText(binding.destination.provider, 128) &&
    safeText(binding.destination.model, 512) &&
    safeText(binding.destination.endpoint, 2048)
  );
}
function sourcePrefix(value: string, maximum: number): string {
  const bytes = Buffer.from(value);
  if (bytes.length <= maximum) return value;
  let end = maximum;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}
interface Metadata {
  readonly path: string;
  readonly uid: string;
  readonly type: string;
  readonly project: string | null;
  readonly status: string;
  readonly state: string | null;
  readonly sensitivity: string | null;
  readonly sourceHash: `sha256:${string}`;
  readonly relations: readonly {
    kind: string;
    target: string;
    target_uid?: string;
  }[];
}
function relations(
  frontmatter: Readonly<Record<string, unknown>>,
): Metadata["relations"] {
  const bookie = frontmatter.bookie;
  if (!isObject(bookie) || !Array.isArray(bookie.relations)) return [];
  return bookie.relations.filter(
    (row): row is { kind: string; target: string; target_uid?: string } =>
      isObject(row) &&
      typeof row.kind === "string" &&
      typeof row.target === "string",
  );
}
function isCurrentCorrection(source: Metadata, target: Metadata): boolean {
  if (source.uid === target.uid || source.project !== target.project)
    return false;
  if (source.type === "Decision" && target.type === "Decision")
    return (
      source.status === "stable" &&
      source.state === "accepted" &&
      target.status === "deprecated" &&
      target.state === "superseded" &&
      target.relations.some(
        (edge) => edge.kind === "superseded_by" && edge.target === source.path,
      )
    );
  return (
    (source.type === "Activity" || source.type === "Evidence") &&
    source.type === target.type
  );
}
function validRequest(request: unknown): request is PrepareContextRequest {
  if (
    !isObject(request) ||
    !validRevision(request.project) ||
    !Array.isArray(request.selectors) ||
    request.selectors.length < 1 ||
    request.selectors.length > 16 ||
    Object.keys(request).some(
      (key) =>
        ![
          "project",
          "selectors",
          "source",
          "maxContentBytes",
          "maxTotalBytes",
        ].includes(key),
    )
  )
    return false;
  const paths = new Set<string>();
  for (const selector of request.selectors) {
    if (
      !isObject(selector) ||
      Object.keys(selector).some(
        (key) => !["path", "sourceHash"].includes(key),
      ) ||
      !safeText(selector.path) ||
      !selector.path.startsWith("/") ||
      paths.has(selector.path) ||
      (selector.sourceHash !== undefined && !validHash(selector.sourceHash))
    )
      return false;
    paths.add(selector.path);
  }
  if (request.source !== undefined) {
    if (!isObject(request.source)) return false;
    if (request.source.mode === "working-tree") {
      if (Object.keys(request.source).length !== 1) return false;
    } else if (
      request.source.mode !== "committed" ||
      Object.keys(request.source).length !== 2 ||
      typeof request.source.commit !== "string" ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(request.source.commit)
    )
      return false;
  }
  for (const field of ["maxContentBytes", "maxTotalBytes"]) {
    const value = request[field];
    if (
      value !== undefined &&
      (typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value < 1 ||
        value > 48_000)
    )
      return false;
  }
  return true;
}
function scoped(
  scope: RecallScope,
  path: string,
  uid: string,
  project: string | null,
): boolean {
  return (
    project === scope.project.path ||
    (path === scope.project.path && uid === scope.project.uid)
  );
}
function classified(
  scope: RecallScope,
  sensitivity: string | null,
): sensitivity is string {
  return (
    sensitivity !== null &&
    scope.sensitivityClasses.includes(sensitivity) &&
    !scope.excludedClasses.includes(sensitivity)
  );
}
function makeInput(
  path: string,
  uid: string,
  sourceHash: `sha256:${string}`,
  sensitivity: string,
  type: string,
  status: string,
  state: string | null,
  text: string,
  maxBytes: number,
  representation: ContextInput["representation"],
): ContextInput {
  const prefix = sourcePrefix(text, maxBytes);
  return {
    path,
    uid,
    sourceHash,
    sensitivity,
    type,
    status,
    state,
    representation,
    text: prefix,
    textHash: computeConceptSourceHash(Buffer.from(prefix)),
    fullByteLength: Buffer.byteLength(text),
    truncated: prefix !== text,
  };
}
function controlBlocks(
  state: RecallState,
  scope: RecallScope,
  uid: string,
): boolean {
  return isRecallSuppressed(state, scope.project.uid, { kind: "concept", uid });
}
export async function prepareContext(
  root: string | URL,
  request: PrepareContextRequest,
  options: ContextOptions,
): Promise<RecallResult<{ bundle: PreparedContextBundle }>> {
  if (!validRequest(request) || !validBinding(options?.binding))
    return recallFailure("input");
  const captured = structuredClone(request),
    binding = structuredClone(options.binding);
  const { signal } = options;
  throwIfAborted(signal);
  const inspected = await inspectRecallScope(root, captured.project, options);
  if (!inspected.ok) return inspected;
  const { scope } = inspected;
  const state = await readRecallState(scope.root, options);
  if (!state.ok) return state;
  if (controlBlocks(state.state, scope, scope.project.uid))
    return recallFailure("suppressed");
  const manifest = await readRecallManifest(scope.root, options);
  if (!manifest.ok || manifest.manifestRevision !== scope.manifestRevision)
    return recallFailure("stale");
  const maxContent = captured.maxContentBytes ?? 12_000,
    maxTotal = captured.maxTotalBytes ?? 24_000;
  const selection = new Map(
    captured.selectors.map((selector) => [selector.path, selector]),
  );
  const currentMetadata = new Map<string, Metadata>();
  const currentIdentities = new Map<string, Metadata>();
  const inputs = new Map<string, ContextInput>();
  const blockedIdentities = new Set<string>();
  const privateIdentities = new Set<string>();
  let issue:
    "scope" | "policy" | "suppressed" | "source-changed" | "bounds" | undefined;
  const working = captured.source?.mode !== "committed";
  try {
    const scan = await scanVaultForQuery({
      rootPath: scope.root,
      limits: validationLimits(RECALL_SCAN_LIMITS),
      ...(signal === undefined ? {} : { signal }),
      visit(concept) {
        const suppressed = controlBlocks(state.state, scope, concept.uid);
        if (concept.excluded || suppressed) {
          blockedIdentities.add(concept.uid);
          blockedIdentities.add(concept.sourcePath);
        }
        if (
          concept.excluded ||
          state.state.controls.some(
            (row) =>
              row.project.uid === scope.project.uid &&
              row.disposition === "suppressed" &&
              row.target.kind === "concept" &&
              row.target.uid === concept.uid,
          )
        ) {
          privateIdentities.add(concept.uid);
          privateIdentities.add(concept.sourcePath);
        }
        const inScope = scoped(
          scope,
          concept.sourcePath,
          concept.uid,
          concept.project,
        );
        const metadata: Metadata = {
          path: concept.sourcePath,
          uid: concept.uid,
          type: concept.type,
          project: concept.project,
          status: concept.status,
          state: concept.state,
          sensitivity: concept.sensitivity,
          sourceHash: computeConceptSourceHash(concept.sourceBytes),
          relations: relations(concept.frontmatter),
        };
        currentIdentities.set(concept.uid, metadata);
        if (inScope) currentMetadata.set(concept.sourcePath, metadata);
        if (!working || !selection.has(concept.sourcePath)) return;
        if (!inScope) {
          issue = "scope";
          return;
        }
        if (suppressed) {
          issue = "suppressed";
          return;
        }
        if (!classified(scope, concept.sensitivity)) {
          issue = "policy";
          return;
        }
        const sourceHash = computeConceptSourceHash(concept.sourceBytes);
        const expected = selection.get(concept.sourcePath)?.sourceHash;
        if (expected !== undefined && expected !== sourceHash) {
          issue = "source-changed";
          return;
        }
        const text = new TextDecoder("utf-8", { fatal: true }).decode(
          concept.sourceBytes,
        );
        if (containsDetectedSecret(text)) {
          issue = "policy";
          return;
        }
        inputs.set(
          concept.sourcePath,
          makeInput(
            concept.sourcePath,
            concept.uid,
            sourceHash,
            concept.sensitivity,
            concept.type,
            concept.status,
            concept.state,
            text,
            maxContent,
            "utf8-source/v1",
          ),
        );
      },
    });
    if (!scan.complete || scan.rejectedConcepts > 0)
      return recallFailure("unavailable");
    const corrected = new Set<string>();
    for (const candidate of currentMetadata.values())
      if (candidate.state === "superseded") {
        corrected.add(candidate.uid);
        blockedIdentities.add(candidate.uid);
        blockedIdentities.add(candidate.path);
      }
    for (const candidate of currentMetadata.values())
      for (const relation of candidate.relations) {
        if (relation.kind !== "supersedes") continue;
        const target = currentMetadata.get(relation.target);
        if (target && isCurrentCorrection(candidate, target)) {
          corrected.add(target.uid);
          blockedIdentities.add(target.uid);
          blockedIdentities.add(target.path);
        }
      }
    if (!working && captured.source?.mode === "committed") {
      const exported = await exportCanonicalJsonl(
        scope.root,
        {
          sourceRef: captured.source.commit,
          write(bytes) {
            const record = JSON.parse(
              Buffer.from(bytes).toString("utf8"),
            ) as CanonicalJsonlRecordV1;
            if (!selection.has(record.path)) return;
            const bookie = record.frontmatter.bookie;
            if (!isObject(bookie)) {
              issue = "policy";
              return;
            }
            const project =
              typeof bookie.project === "string" ? bookie.project : null;
            const sensitivity =
              typeof bookie.sensitivity === "string"
                ? bookie.sensitivity
                : null;
            if (!scoped(scope, record.path, record.uid, project)) {
              issue = "scope";
              return;
            }
            if (
              matchesExcludedPath(
                record.path.slice(1),
                manifest.manifest.policy.exclude,
              ) ||
              !classified(scope, sensitivity)
            ) {
              issue = "policy";
              return;
            }
            if (controlBlocks(state.state, scope, record.uid)) {
              issue = "suppressed";
              return;
            }
            const expected = selection.get(record.path)?.sourceHash;
            if (expected !== undefined && expected !== record.source_hash) {
              issue = "source-changed";
              return;
            }
            inputs.set(
              record.path,
              makeInput(
                record.path,
                record.uid,
                record.source_hash,
                sensitivity,
                record.type,
                String(record.frontmatter.status),
                typeof bookie.state === "string" ? bookie.state : null,
                record.body_markdown,
                maxContent,
                "canonical-jsonl-body/v1",
              ),
            );
          },
        },
        { ...RECALL_SCAN_LIMITS, ...(signal === undefined ? {} : { signal }) },
      );
      if (
        !exported.ok ||
        exported.sourceCommit !== captured.source.commit ||
        exported.sourceManifest.vaultUid !== scope.vaultUid
      )
        return recallFailure("unavailable");
    }
    if (issue) return recallFailure(issue);
    if (inputs.size !== selection.size) return recallFailure("unavailable");
    const ordered = captured.selectors.map((selector) =>
      inputs.get(selector.path)!,
    );
    for (const input of ordered) {
      if (blockedIdentities.has(input.uid) || blockedIdentities.has(input.path))
        return recallFailure("policy");
      const currentIdentity = currentIdentities.get(input.uid);
      if (
        !currentIdentity ||
        !scoped(
          scope,
          currentIdentity.path,
          currentIdentity.uid,
          currentIdentity.project,
        ) ||
        !classified(scope, currentIdentity.sensitivity) ||
        currentIdentity.sensitivity !== input.sensitivity
      )
        return recallFailure("policy");
      if (
        corrected.has(input.uid) ||
        controlBlocks(state.state, scope, input.uid)
      )
        return recallFailure("suppressed");
      for (const identity of privateIdentities)
        if (input.text.includes(identity)) return recallFailure("policy");
    }
    if (
      ordered.reduce((size, input) => size + Buffer.byteLength(input.text), 0) >
      maxTotal
    )
      return recallFailure("bounds");
    const tracker = createPathTracker();
    for (const input of ordered) {
      const metadata = currentIdentities.get(input.uid)!;
      const latest = await readSafeBoundedFile(
        scope.root,
        metadata.path.slice(1),
        validationLimits(RECALL_SCAN_LIMITS).maxConceptBytes,
        signal,
        tracker,
      );
      if (
        !latest.ok ||
        computeConceptSourceHash(latest.bytes) !== metadata.sourceHash
      )
        return recallFailure("stale");
    }
    if (!(await verifyTrackedPaths(tracker, signal)))
      return recallFailure("stale");
    const current = await readRecallState(scope.root, options);
    const finalScope = await inspectRecallScope(
      scope.root,
      captured.project,
      options,
    );
    if (
      !current.ok ||
      current.revision !== state.revision ||
      !finalScope.ok ||
      canonical(finalScope.scope) !== canonical(scope)
    )
      return recallFailure("stale");
    throwIfAborted(signal);
    const body: Omit<PreparedContextBundle, "digest"> = {
      schemaVersion: 1,
      representation: "bookie-context-excerpts/v1",
      scope,
      controlRevision: state.controlsRevision,
      binding,
      source:
        captured.source?.mode === "committed"
          ? { mode: "committed", commit: captured.source.commit }
          : { mode: "working-tree", commit: null },
      request: captured,
      inputs: ordered,
      untrusted: true,
    };
    const bundle: PreparedContextBundle = {
      ...body,
      digest: computeConceptSourceHash(Buffer.from(canonical(body))),
    };
    if (Buffer.byteLength(JSON.stringify(bundle)) > MAX_CONTEXT_BUNDLE_BYTES)
      return recallFailure("bounds");
    return { ok: true, bundle };
  } catch {
    throwIfAborted(signal);
    return recallFailure("unavailable");
  }
}
export async function revalidateContext(
  root: string | URL,
  bundle: PreparedContextBundle,
  options: ContextOptions,
): Promise<RecallResult<{ bundle: PreparedContextBundle }>> {
  try {
    if (
      !isObject(bundle) ||
      !validRequest(bundle.request) ||
      !Array.isArray(bundle.inputs) ||
      bundle.inputs.length > 16 ||
      bundle.inputs.some(
        (input) =>
          !isObject(input) ||
          typeof input.text !== "string" ||
          Buffer.byteLength(input.text) > 48_000,
      ) ||
      Buffer.byteLength(JSON.stringify(bundle)) > MAX_CONTEXT_BUNDLE_BYTES ||
      bundle.schemaVersion !== 1 ||
      !validHash(bundle.digest) ||
      !validBinding(options?.binding) ||
      canonical(bundle.binding) !== canonical(options.binding)
    )
      return recallFailure("stale");
    const { digest, ...body } = bundle;
    if (computeConceptSourceHash(Buffer.from(canonical(body))) !== digest)
      return recallFailure("stale");
    const current = await prepareContext(root, bundle.request, options);
    if (!current.ok) return current;
    return current.bundle.digest === bundle.digest
      ? current
      : recallFailure("stale");
  } catch {
    throwIfAborted(options?.signal);
    return recallFailure("stale");
  }
}
