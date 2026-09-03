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
  utf8ByteLength,
} from "./concept-mutation-model.js";
import type {
  AmendConceptRequest,
  ConceptMutationOptions,
  ConceptMutationResult,
  CreateConceptRequest,
  MutationLimits,
} from "./concept-mutation-model.js";
import {
  checkUidCollision,
  loadMutationManifest,
  schemaValidatorsOrUndefined,
  stableIdentity,
  validateCandidate,
} from "./concept-mutation-validation.js";
import { throwIfAborted } from "./vault-cancellation.js";
import {
  createPathTracker,
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
): Promise<ConceptMutationResult> {
  const parent = await captureParent(target, signal);
  if (parent === undefined) {
    return failure("create", [
      mutationDiagnostic("MUTATION-PATH", target.bundlePath),
    ]);
  }
  const initialState = await targetState(target.target);
  throwIfAborted(signal);
  if (initialState !== "absent") {
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
  const collisions = await checkUidCollision(
    target,
    candidate,
    "create",
    manifestResult.manifest,
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
    return failure("create", [
      mutationDiagnostic(
        published === "conflict" ? "MUTATION-CONFLICT" : "MUTATION-IO",
        candidate.displayFile,
      ),
    ]);
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
): Promise<ConceptMutationResult> {
  if (
    !isObject(request) ||
    typeof request.expectedSourceHash !== "string" ||
    !SOURCE_HASH_PATTERN.test(request.expectedSourceHash)
  ) {
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
  if (source.sourceHash !== request.expectedSourceHash) {
    return failure("amend", [
      mutationDiagnostic("MUTATION-CONFLICT", target.bundlePath),
    ]);
  }
  const loaded = loadConcept(source.bytes, {
    file: target.bundlePath,
    maxBytes: limits.maxConceptBytes,
    maxDepth: limits.maxYamlDepth,
  });
  if (!loaded.ok) {
    return failure(
      "amend",
      conceptDiagnostics(loaded.diagnostics, target.bundlePath),
    );
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
  if (
    matchesExcludedPath(
      target.relativePath,
      manifestResult.manifest.policy.exclude,
    )
  ) {
    return failure("amend", [
      mutationDiagnostic("MUTATION-PATH", target.bundlePath),
    ]);
  }

  const prepared = prepareAmendment(loaded.concept, request, limits);
  if (!prepared.ok) {
    return failure("amend", [
      mutationDiagnostic(prepared.code, target.bundlePath),
    ]);
  }
  const originalIdentity = stableIdentity(loaded.concept);
  if (originalIdentity === undefined) {
    return failure("amend", [
      mutationDiagnostic("MUTATION-IDENTITY", target.bundlePath),
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
        mutationDiagnostic("MUTATION-INPUT", target.bundlePath),
      ]);
    }
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

  const collisions = await checkUidCollision(
    target,
    candidateResult.candidate,
    "amend",
    manifestResult.manifest,
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
        mutationDiagnostic("MUTATION-CONFLICT", target.bundlePath),
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
    signal,
    async () => {
      const final = await finalAmendSource(target, source, limits, signal);
      return final === "match" ? "publish" : "conflict";
    },
  );
  if (published !== "published") {
    return failure("amend", [
      mutationDiagnostic(
        published === "conflict" ? "MUTATION-CONFLICT" : "MUTATION-IO",
        candidateResult.candidate.displayFile,
      ),
    ]);
  }
  return success(
    "amend",
    "amended",
    target.bundlePath,
    computeConceptSourceHash(candidateResult.candidate.bytes),
    source.sourceHash,
  );
}

export async function createConcept(
  root: string | URL,
  request: CreateConceptRequest,
  options: ConceptMutationOptions = {},
): Promise<ConceptMutationResult> {
  const limits = mutationLimits(options);
  throwIfAborted(options.signal);
  const resolved = await resolveMutationTarget(
    root,
    request?.path,
    options.signal,
  );
  if (!resolved.ok) return failure("create", [resolved.diagnostic]);
  return runCoordinatedMutation("create", resolved.target, options, () =>
    performCreate(resolved.target, request, limits, options.signal),
  );
}

export async function amendConcept(
  root: string | URL,
  request: AmendConceptRequest,
  options: ConceptMutationOptions = {},
): Promise<ConceptMutationResult> {
  const limits = mutationLimits(options);
  throwIfAborted(options.signal);
  const resolved = await resolveMutationTarget(
    root,
    request?.path,
    options.signal,
  );
  if (!resolved.ok) return failure("amend", [resolved.diagnostic]);
  return runCoordinatedMutation("amend", resolved.target, options, () =>
    performAmend(resolved.target, request, limits, options.signal),
  );
}
