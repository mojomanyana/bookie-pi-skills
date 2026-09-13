import { Buffer } from "node:buffer";

import {
  createConceptSourceInternal,
  DEFAULT_MAX_CONCEPT_BYTES,
  DEFAULT_MAX_YAML_DEPTH,
  loadConcept,
  renderConceptSourceInternal,
} from "./concept-loader.js";
import {
  captureParent,
  publishCandidate,
  readTargetSource,
  resolveMutationTarget,
  runCoordinatedMutation,
  sameTargetIdentity,
  targetState,
  verifyParent,
} from "./concept-mutation-filesystem.js";
import type {
  ResolvedMutationTarget,
  TargetSource,
} from "./concept-mutation-filesystem.js";
import { cloneYamlInput, prepareAmendment } from "./concept-mutation-input.js";
import {
  computeConceptSourceHash,
  conceptDiagnostics,
  failure,
  hasLoneSurrogate,
  isObject,
  mutationDiagnostic,
  success,
  writeSecretDiagnostic,
  utf8ByteLength,
} from "./concept-mutation-model.js";
import type {
  AmendConceptRequest,
  ConceptMutationFailure,
  ConceptMutationOptions,
  ConceptMutationResult,
  CreateConceptRequest,
  MutationLimits,
} from "./concept-mutation-model.js";
import {
  checkUidCollision,
  displayFileForCandidate,
  loadMutationManifest,
  schemaValidatorsOrUndefined,
  stableIdentity,
  validateCandidate,
} from "./concept-mutation-validation.js";
import { throwIfAborted } from "./vault-cancellation.js";
import { containsDetectedSecret } from "./vault-secret-detection.js";
import {
  createPathTracker,
  isBeneathLiteralPath,
  matchesExcludedPath,
  verifyTrackedPaths,
} from "./vault-filesystem.js";
import type { Manifest, SchemaValidators } from "./vault-model.js";

export { computeConceptSourceHash } from "./concept-mutation-model.js";
export type {
  AmendConceptRequest,
  ConceptMutationCoordinator,
  ConceptMutationFailure,
  ConceptMutationOptions,
  ConceptMutationResult,
  ConceptMutationSuccess,
  ConceptSourceHash,
  CreateConceptRequest,
  FrontmatterEdit,
  FrontmatterPathSegment,
  MutationDiagnostic,
  MutationDiagnosticCode,
} from "./concept-mutation-model.js";

const SOURCE_HASH_PATTERN = /^sha256:[a-f0-9]{64}$/u;

function policyDetectsSecret(value: unknown): boolean {
  try {
    return containsDetectedSecret(value);
  } catch {
    return true;
  }
}

function sourceDetectsSecret(bytes: Uint8Array): boolean {
  return policyDetectsSecret(Buffer.from(bytes).toString("utf8"));
}

function policyRoot(root: string | URL): string | undefined {
  if (typeof root === "string") return root;
  try {
    return URL.prototype.toString.call(root);
  } catch {
    return undefined;
  }
}

function snapshotPolicyRequest<T>(
  request: T,
  limits: MutationLimits,
): T | undefined {
  try {
    const snapshot = cloneYamlInput(
      request,
      {
        ...limits,
        maxYamlDepth: limits.maxYamlDepth + 4,
      },
      limits.maxConceptBytes + 8_192,
    );
    return snapshot.ok && isObject(snapshot.value)
      ? (snapshot.value as T)
      : undefined;
  } catch {
    return undefined;
  }
}

function requestDeclaresSensitivity(value: unknown): boolean {
  if (!isObject(value)) return false;
  const frontmatter = isObject(value.frontmatter)
    ? value.frontmatter
    : undefined;
  const bookie = isObject(frontmatter?.bookie) ? frontmatter.bookie : undefined;
  return typeof bookie?.sensitivity === "string";
}

function candidateDetectsSecret(
  bytes: Uint8Array,
  path: string,
  limits: MutationLimits,
): boolean {
  if (sourceDetectsSecret(bytes)) return true;
  const loaded = loadConcept(bytes, {
    file: "<redacted>",
    maxBytes: limits.maxConceptBytes,
    maxDepth: limits.maxYamlDepth,
  });
  return (
    loaded.ok &&
    policyDetectsSecret({
      path,
      frontmatter: loaded.concept.frontmatter,
      bodyText: loaded.concept.bodyText,
    })
  );
}

function redactPolicyFailure(
  result: ConceptMutationResult,
  excludedCandidate = false,
): ConceptMutationResult {
  if (result.ok) {
    if (!excludedCandidate) return result;
    return Object.freeze({
      ...result,
      path: "<redacted>",
      changedPaths: Object.freeze(
        result.changedPaths.length === 0 ? [] : ["<redacted>"],
      ),
    });
  }
  if (
    !excludedCandidate &&
    !result.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "WRITE-SECRET" || diagnostic.file === "<excluded>",
    )
  ) {
    return result;
  }
  const failureResult: ConceptMutationFailure = Object.freeze({
    ...result,
    changedPaths: Object.freeze(
      result.changedPaths.length === 0 ? [] : ["<redacted>"],
    ),
    diagnostics: Object.freeze(
      result.diagnostics.map((diagnostic) =>
        Object.freeze({ ...diagnostic, file: "<redacted>" }),
      ),
    ),
  });
  return failureResult;
}

function positiveLimit(
  name: string,
  value: number | undefined,
  maximum: number,
): number {
  if (value === undefined) return maximum;
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new TypeError(
      `${name} must be a positive integer no greater than ${maximum}`,
    );
  }
  return value;
}

function mutationLimits(options: ConceptMutationOptions): MutationLimits {
  if (
    options.runExclusive !== undefined &&
    typeof options.runExclusive !== "function"
  ) {
    throw new TypeError("runExclusive must be a function");
  }
  return {
    maxConceptBytes: positiveLimit(
      "maxConceptBytes",
      options.maxConceptBytes,
      DEFAULT_MAX_CONCEPT_BYTES,
    ),
    maxYamlDepth: positiveLimit(
      "maxYamlDepth",
      options.maxYamlDepth,
      DEFAULT_MAX_YAML_DEPTH,
    ),
  };
}

function createInputCandidate(
  request: CreateConceptRequest,
  target: ResolvedMutationTarget,
  manifest: Manifest,
  validators: SchemaValidators,
  limits: MutationLimits,
): ReturnType<typeof validateCandidate> {
  if (
    !isObject(request) ||
    !isObject(request.frontmatter) ||
    typeof request.bodyText !== "string" ||
    hasLoneSurrogate(request.bodyText)
  ) {
    return {
      ok: false,
      diagnostics: [mutationDiagnostic("MUTATION-INPUT", target.bundlePath)],
    };
  }
  const bodyBytes = utf8ByteLength(request.bodyText);
  if (bodyBytes + 8 > limits.maxConceptBytes) {
    return {
      ok: false,
      diagnostics: [mutationDiagnostic("MUTATION-BOUNDS", target.bundlePath)],
    };
  }
  const cloned = cloneYamlInput(
    request.frontmatter,
    limits,
    limits.maxConceptBytes - bodyBytes - 8,
  );
  if (!cloned.ok || !isObject(cloned.value)) {
    return {
      ok: false,
      diagnostics: [
        mutationDiagnostic(
          !cloned.ok && cloned.reason === "bounds"
            ? "MUTATION-BOUNDS"
            : "MUTATION-INPUT",
          target.bundlePath,
        ),
      ],
    };
  }

  let bytes: Uint8Array;
  try {
    bytes = createConceptSourceInternal(cloned.value, request.bodyText);
  } catch {
    return {
      ok: false,
      diagnostics: [mutationDiagnostic("MUTATION-INPUT", target.bundlePath)],
    };
  }
  return validateCandidate(bytes, target, manifest, validators, limits);
}

async function performCreate(
  target: ResolvedMutationTarget,
  request: CreateConceptRequest,
  limits: MutationLimits,
  signal: AbortSignal | undefined,
  enforceWritePolicy: boolean,
  classifyExcluded: (excluded: boolean) => void,
): Promise<ConceptMutationResult> {
  const parent = await captureParent(target, signal);
  if (parent === undefined) {
    return failure("create", [
      mutationDiagnostic("MUTATION-PATH", target.bundlePath),
    ]);
  }
  const initialState = await targetState(target.target);
  throwIfAborted(signal);
  if (initialState !== "absent" && !enforceWritePolicy) {
    return failure("create", [
      mutationDiagnostic(
        initialState === "safe" || initialState === "unsafe"
          ? "MUTATION-TARGET"
          : "MUTATION-IO",
        target.bundlePath,
      ),
    ]);
  }

  const tracker = createPathTracker();
  const validators = await schemaValidatorsOrUndefined();
  throwIfAborted(signal);
  if (validators === undefined) {
    return failure("create", [
      mutationDiagnostic("MUTATION-IO", target.bundlePath),
    ]);
  }
  if (!validators.conceptPathPattern.test(target.bundlePath)) {
    return failure("create", [
      mutationDiagnostic("MUTATION-PATH", target.bundlePath),
    ]);
  }
  const manifestResult = await loadMutationManifest(
    target,
    validators,
    limits,
    signal,
    tracker,
  );
  if (!manifestResult.ok) return failure("create", manifestResult.diagnostics);
  if (
    matchesExcludedPath(
      target.relativePath,
      manifestResult.manifest.policy.exclude,
    ) ||
    isBeneathLiteralPath(
      target.relativePath,
      manifestResult.manifest.policy.evidence_roots,
    )
  ) {
    return failure("create", [
      mutationDiagnostic("MUTATION-PATH", target.bundlePath),
    ]);
  }

  const candidateResult = createInputCandidate(
    request,
    target,
    manifestResult.manifest,
    validators,
    limits,
  );
  if (!candidateResult.ok)
    return failure("create", candidateResult.diagnostics);
  const { candidate } = candidateResult;
  classifyExcluded(candidate.displayFile === "<excluded>");
  if (initialState !== "absent") {
    return failure("create", [
      mutationDiagnostic(
        initialState === "safe" || initialState === "unsafe"
          ? "MUTATION-TARGET"
          : "MUTATION-IO",
        candidate.displayFile,
      ),
    ]);
  }
  if (
    enforceWritePolicy &&
    candidateDetectsSecret(candidate.bytes, target.bundlePath, limits)
  ) {
    return failure("create", [writeSecretDiagnostic()]);
  }
  const collisions = await checkUidCollision(
    target,
    candidate,
    "create",
    manifestResult.manifest,
    validators,
    limits,
    signal,
    tracker,
  );
  if (collisions.length > 0) return failure("create", collisions);
  if (!(await verifyParent(target, parent, signal))) {
    return failure("create", [
      mutationDiagnostic("MUTATION-IO", candidate.displayFile),
    ]);
  }

  const published = await publishCandidate(
    target,
    parent,
    candidate.bytes,
    undefined,
    "no-replace",
    signal,
    async () => {
      const state = await targetState(target.target);
      throwIfAborted(signal);
      return state === "absent"
        ? "publish"
        : state === "safe" || state === "unsafe"
          ? "conflict"
          : "io";
    },
  );
  if (published !== "published") {
    return failure(
      "create",
      [
        mutationDiagnostic(
          published === "conflict" ? "MUTATION-CONFLICT" : "MUTATION-IO",
          candidate.displayFile,
        ),
      ],
      published === "io-after-publication" ? [target.bundlePath] : [],
    );
  }
  return success(
    "create",
    "created",
    target.bundlePath,
    computeConceptSourceHash(candidate.bytes),
  );
}

async function finalAmendSource(
  target: ResolvedMutationTarget,
  initial: TargetSource,
  limits: MutationLimits,
  signal: AbortSignal | undefined,
): Promise<"match" | "conflict"> {
  const tracker = createPathTracker();
  const current = await readTargetSource(target, limits, signal, tracker);
  if (!current.ok) return "conflict";
  if (!(await verifyTrackedPaths(tracker, signal))) return "conflict";
  return current.source.sourceHash === initial.sourceHash &&
    sameTargetIdentity(initial.metadata, current.source.metadata)
    ? "match"
    : "conflict";
}

async function performAmend(
  target: ResolvedMutationTarget,
  request: AmendConceptRequest,
  limits: MutationLimits,
  signal: AbortSignal | undefined,
  enforceWritePolicy: boolean,
  classifyExcluded: (excluded: boolean) => void,
): Promise<ConceptMutationResult> {
  const validRequest =
    isObject(request) &&
    typeof request.expectedSourceHash === "string" &&
    SOURCE_HASH_PATTERN.test(request.expectedSourceHash);
  if (!validRequest && !enforceWritePolicy) {
    return failure("amend", [
      mutationDiagnostic("MUTATION-INPUT", target.bundlePath),
    ]);
  }
  const parent = await captureParent(target, signal);
  if (parent === undefined) {
    return failure("amend", [
      mutationDiagnostic("MUTATION-PATH", target.bundlePath),
    ]);
  }
  const tracker = createPathTracker();
  const sourceResult = await readTargetSource(target, limits, signal, tracker);
  if (!sourceResult.ok) {
    return failure("amend", [
      sourceResult.reason === "size"
        ? mutationDiagnostic("MUTATION-BOUNDS", target.bundlePath)
        : mutationDiagnostic(
            sourceResult.reason === "missing" ||
              sourceResult.reason === "unsafe"
              ? "MUTATION-TARGET"
              : "MUTATION-IO",
            target.bundlePath,
          ),
    ]);
  }
  const source = sourceResult.source;
  if (enforceWritePolicy && sourceDetectsSecret(source.bytes)) {
    return failure("amend", [writeSecretDiagnostic()]);
  }
  const sourceConflict =
    validRequest && source.sourceHash !== request.expectedSourceHash;
  const loaded = loadConcept(source.bytes, {
    file: target.bundlePath,
    maxBytes: limits.maxConceptBytes,
    maxDepth: limits.maxYamlDepth,
  });
  if (!loaded.ok) {
    return sourceConflict
      ? failure("amend", [
          mutationDiagnostic("MUTATION-CONFLICT", target.bundlePath),
        ])
      : failure(
          "amend",
          conceptDiagnostics(loaded.diagnostics, target.bundlePath),
        );
  }
  if (
    enforceWritePolicy &&
    policyDetectsSecret({
      path: target.bundlePath,
      frontmatter: loaded.concept.frontmatter,
      bodyText: loaded.concept.bodyText,
    })
  ) {
    return failure("amend", [writeSecretDiagnostic()]);
  }
  if (sourceConflict) {
    return failure("amend", [
      mutationDiagnostic("MUTATION-CONFLICT", target.bundlePath),
    ]);
  }
  const validators = await schemaValidatorsOrUndefined();
  throwIfAborted(signal);
  if (validators === undefined) {
    return failure("amend", [
      mutationDiagnostic("MUTATION-IO", target.bundlePath),
    ]);
  }
  if (!validators.conceptPathPattern.test(target.bundlePath)) {
    return failure("amend", [
      mutationDiagnostic("MUTATION-PATH", target.bundlePath),
    ]);
  }
  const manifestResult = await loadMutationManifest(
    target,
    validators,
    limits,
    signal,
    tracker,
  );
  if (!manifestResult.ok) return failure("amend", manifestResult.diagnostics);
  const displayFile = displayFileForCandidate(
    target.bundlePath,
    loaded.concept.frontmatter,
    manifestResult.manifest,
  );
  classifyExcluded(displayFile === "<excluded>");
  if (!validRequest) {
    return failure("amend", [
      mutationDiagnostic("MUTATION-INPUT", displayFile),
    ]);
  }
  if (
    matchesExcludedPath(
      target.relativePath,
      manifestResult.manifest.policy.exclude,
    ) ||
    isBeneathLiteralPath(
      target.relativePath,
      manifestResult.manifest.policy.evidence_roots,
    )
  ) {
    return failure("amend", [mutationDiagnostic("MUTATION-PATH", displayFile)]);
  }

  const prepared = prepareAmendment(loaded.concept, request, limits);
  if (!prepared.ok) {
    return failure("amend", [mutationDiagnostic(prepared.code, displayFile)]);
  }
  const originalIdentity = stableIdentity(loaded.concept);
  if (originalIdentity === undefined) {
    return failure("amend", [
      mutationDiagnostic("MUTATION-IDENTITY", displayFile),
    ]);
  }

  let candidateBytes = source.bytes;
  if (prepared.amendment.changed) {
    try {
      candidateBytes = renderConceptSourceInternal(
        loaded.concept,
        prepared.amendment.edits,
        prepared.amendment.bodyText,
      );
    } catch {
      return failure("amend", [
        mutationDiagnostic("MUTATION-INPUT", displayFile),
      ]);
    }
  }
  if (
    enforceWritePolicy &&
    candidateDetectsSecret(candidateBytes, target.bundlePath, limits)
  ) {
    return failure("amend", [writeSecretDiagnostic()]);
  }
  const candidateResult = validateCandidate(
    candidateBytes,
    target,
    manifestResult.manifest,
    validators,
    limits,
    originalIdentity,
  );
  if (!candidateResult.ok) return failure("amend", candidateResult.diagnostics);
  classifyExcluded(candidateResult.candidate.displayFile === "<excluded>");

  const collisions = await checkUidCollision(
    target,
    candidateResult.candidate,
    "amend",
    manifestResult.manifest,
    validators,
    limits,
    signal,
    tracker,
  );
  if (collisions.length > 0) return failure("amend", collisions);
  if (!(await verifyParent(target, parent, signal))) {
    return failure("amend", [
      mutationDiagnostic("MUTATION-IO", candidateResult.candidate.displayFile),
    ]);
  }
  if (!prepared.amendment.changed) {
    const final = await finalAmendSource(target, source, limits, signal);
    if (final !== "match") {
      return failure("amend", [
        mutationDiagnostic("MUTATION-CONFLICT", displayFile),
      ]);
    }
    return success(
      "amend",
      "unchanged",
      target.bundlePath,
      source.sourceHash,
      source.sourceHash,
    );
  }

  const mode = Number(source.metadata.mode & BigInt(0o777));
  const published = await publishCandidate(
    target,
    parent,
    candidateResult.candidate.bytes,
    mode,
    "replace",
    signal,
    async () => {
      const final = await finalAmendSource(target, source, limits, signal);
      return final === "match" ? "publish" : "conflict";
    },
  );
  if (published !== "published") {
    return failure(
      "amend",
      [
        mutationDiagnostic(
          published === "conflict" ? "MUTATION-CONFLICT" : "MUTATION-IO",
          candidateResult.candidate.displayFile,
        ),
      ],
      published === "io-after-publication" ? [target.bundlePath] : [],
    );
  }
  return success(
    "amend",
    "amended",
    target.bundlePath,
    computeConceptSourceHash(candidateResult.candidate.bytes),
    source.sourceHash,
  );
}

async function createConceptInternal(
  root: string | URL,
  request: CreateConceptRequest,
  options: ConceptMutationOptions,
  enforceWritePolicy: boolean,
): Promise<ConceptMutationResult> {
  const limits = mutationLimits(options);
  throwIfAborted(options.signal);
  const rootValue = policyRoot(root);
  const effectiveRequest = enforceWritePolicy
    ? snapshotPolicyRequest(request, limits)
    : request;
  if (
    enforceWritePolicy &&
    (rootValue === undefined ||
      effectiveRequest === undefined ||
      policyDetectsSecret({ root: rootValue, request: effectiveRequest }))
  ) {
    return failure("create", [writeSecretDiagnostic()]);
  }
  const preparedRequest = effectiveRequest ?? request;
  const resolved = await resolveMutationTarget(
    root,
    preparedRequest?.path,
    options.signal,
  );
  if (!resolved.ok) {
    const result = failure("create", [resolved.diagnostic]);
    return enforceWritePolicy
      ? redactPolicyFailure(result, requestDeclaresSensitivity(preparedRequest))
      : result;
  }
  let candidateClassified = false;
  let excludedCandidate = false;
  const result = await runCoordinatedMutation(
    "create",
    resolved.target,
    options,
    () =>
      performCreate(
        resolved.target,
        preparedRequest,
        limits,
        options.signal,
        enforceWritePolicy,
        (excluded) => {
          candidateClassified = true;
          excludedCandidate = excluded;
        },
      ),
  );
  return enforceWritePolicy
    ? redactPolicyFailure(
        result,
        excludedCandidate ||
          (!candidateClassified && requestDeclaresSensitivity(preparedRequest)),
      )
    : result;
}

export async function createConcept(
  root: string | URL,
  request: CreateConceptRequest,
  options: ConceptMutationOptions = {},
): Promise<ConceptMutationResult> {
  return createConceptInternal(root, request, options, false);
}

export async function createConceptWithPolicy(
  root: string | URL,
  request: CreateConceptRequest,
  options: ConceptMutationOptions = {},
): Promise<ConceptMutationResult> {
  return createConceptInternal(root, request, options, true);
}

async function amendConceptInternal(
  root: string | URL,
  request: AmendConceptRequest,
  options: ConceptMutationOptions,
  enforceWritePolicy: boolean,
): Promise<ConceptMutationResult> {
  const limits = mutationLimits(options);
  throwIfAborted(options.signal);
  const rootValue = policyRoot(root);
  const effectiveRequest = enforceWritePolicy
    ? snapshotPolicyRequest(request, limits)
    : request;
  if (
    enforceWritePolicy &&
    (rootValue === undefined ||
      effectiveRequest === undefined ||
      policyDetectsSecret({ root: rootValue, request: effectiveRequest }))
  ) {
    return failure("amend", [writeSecretDiagnostic()]);
  }
  const preparedRequest = effectiveRequest ?? request;
  const resolved = await resolveMutationTarget(
    root,
    preparedRequest?.path,
    options.signal,
  );
  if (!resolved.ok) {
    const result = failure("amend", [resolved.diagnostic]);
    return enforceWritePolicy ? redactPolicyFailure(result) : result;
  }
  let candidateClassified = false;
  let excludedCandidate = false;
  const result = await runCoordinatedMutation(
    "amend",
    resolved.target,
    options,
    () =>
      performAmend(
        resolved.target,
        preparedRequest,
        limits,
        options.signal,
        enforceWritePolicy,
        (excluded) => {
          candidateClassified = true;
          excludedCandidate = excluded;
        },
      ),
  );
  return enforceWritePolicy
    ? redactPolicyFailure(result, excludedCandidate || !candidateClassified)
    : result;
}

export async function amendConcept(
  root: string | URL,
  request: AmendConceptRequest,
  options: ConceptMutationOptions = {},
): Promise<ConceptMutationResult> {
  return amendConceptInternal(root, request, options, false);
}

export async function amendConceptWithPolicy(
  root: string | URL,
  request: AmendConceptRequest,
  options: ConceptMutationOptions = {},
): Promise<ConceptMutationResult> {
  return amendConceptInternal(root, request, options, true);
}
