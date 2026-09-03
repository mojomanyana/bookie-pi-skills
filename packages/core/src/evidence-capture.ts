import type {
  ReadonlyYamlMapping,
  ReadonlyYamlValue,
} from "./concept-loader.js";
import { createConceptSourceInternal } from "./concept-loader.js";
import {
  captureParent,
  cleanupTemporary,
  publishStagedCandidate,
  resolveMutationTarget,
  resolveRelatedMutationFileTarget,
  runCoordinatedOperation,
  stageTemporary,
  syncMutationDirectory,
  targetState,
  verifyParent,
} from "./concept-mutation-filesystem.js";
import type {
  ResolvedMutationTarget,
  StagedTemporary,
} from "./concept-mutation-filesystem.js";
import { cloneYamlInput } from "./concept-mutation-input.js";
import {
  computeConceptSourceHash,
  hasLoneSurrogate,
  isAbortError,
  isObject,
  mutationDiagnostic,
  reusedDiagnostic,
  utf8ByteLength,
} from "./concept-mutation-model.js";
import type {
  ConceptMutationOptions,
  ConceptSourceHash,
  MutationDiagnostic,
  MutationLimits,
} from "./concept-mutation-model.js";
import {
  checkUidCollision,
  loadMutationManifest,
  schemaValidatorsOrUndefined,
  validateCandidate,
} from "./concept-mutation-validation.js";
import {
  capturePublishedEvidenceResource,
  stageEvidenceResource,
  verifyEvidenceSource,
  verifyPublishedEvidenceResource,
} from "./evidence-capture-filesystem.js";
import type { StagedEvidenceResource } from "./evidence-capture-filesystem.js";
import { throwIfAborted } from "./vault-cancellation.js";
import {
  DEFAULT_MAX_CONCEPT_BYTES,
  DEFAULT_MAX_YAML_DEPTH,
} from "./concept-loader.js";
import {
  createPathTracker,
  isBeneathLiteralPath,
  matchesExcludedPath,
} from "./vault-filesystem.js";

export interface CaptureEvidenceRequest {
  readonly source: string | URL;
  readonly path: string;
  readonly resourcePath: string;
  readonly frontmatter: ReadonlyYamlMapping;
  readonly bodyText: string;
}

export interface CaptureEvidenceOptions extends ConceptMutationOptions {
  readonly maxResourceBytes?: number;
}

export interface CaptureEvidenceSuccess {
  readonly ok: true;
  readonly operation: "capture-evidence";
  readonly outcome: "captured";
  readonly path: string;
  readonly resourcePath: string;
  readonly changedPaths: readonly [string, string];
  readonly sourceHash: ConceptSourceHash;
  readonly sha256: string;
  readonly byteLength: number;
  readonly diagnostics: readonly [];
}

export interface CaptureEvidenceFailure {
  readonly ok: false;
  readonly operation: "capture-evidence";
  readonly conflict: boolean;
  readonly changedPaths: readonly string[];
  readonly diagnostics: readonly MutationDiagnostic[];
}

export type CaptureEvidenceResult =
  CaptureEvidenceSuccess | CaptureEvidenceFailure;

interface CaptureLimits extends MutationLimits {
  readonly maxResourceBytes: number;
}

const emptyDiagnostics = Object.freeze([]) as readonly [];

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

function captureLimits(options: CaptureEvidenceOptions): CaptureLimits {
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
    maxResourceBytes: positiveLimit(
      "maxResourceBytes",
      options.maxResourceBytes,
      Number.MAX_SAFE_INTEGER,
    ),
  };
}

function captureFailure(
  diagnostics: readonly MutationDiagnostic[],
  changedPaths: readonly string[] = [],
): CaptureEvidenceFailure {
  const frozenDiagnostics = Object.freeze([...diagnostics]);
  return Object.freeze({
    ok: false,
    operation: "capture-evidence",
    conflict: frozenDiagnostics.some(
      (diagnostic) => diagnostic.code === "MUTATION-CONFLICT",
    ),
    changedPaths: Object.freeze([...changedPaths]),
    diagnostics: frozenDiagnostics,
  });
}

function captureSuccess(
  descriptor: ResolvedMutationTarget,
  resource: ResolvedMutationTarget,
  descriptorBytes: Uint8Array,
  sha256: string,
  byteLength: number,
): CaptureEvidenceSuccess {
  return Object.freeze({
    ok: true,
    operation: "capture-evidence",
    outcome: "captured",
    path: descriptor.bundlePath,
    resourcePath: resource.bundlePath,
    changedPaths: Object.freeze([
      resource.bundlePath,
      descriptor.bundlePath,
    ]) as readonly [string, string],
    sourceHash: computeConceptSourceHash(descriptorBytes),
    sha256,
    byteLength,
    diagnostics: emptyDiagnostics,
  });
}

function inputFrontmatter(
  request: CaptureEvidenceRequest,
  descriptor: ResolvedMutationTarget,
  limits: CaptureLimits,
):
  | {
      readonly ok: true;
      readonly frontmatter: Record<string, ReadonlyYamlValue>;
    }
  | {
      readonly ok: false;
      readonly diagnostics: readonly MutationDiagnostic[];
    } {
  if (
    !isObject(request) ||
    !isObject(request.frontmatter) ||
    typeof request.bodyText !== "string" ||
    hasLoneSurrogate(request.bodyText)
  ) {
    return {
      ok: false,
      diagnostics: [
        mutationDiagnostic("MUTATION-INPUT", descriptor.bundlePath),
      ],
    };
  }
  const bodyBytes = utf8ByteLength(request.bodyText);
  if (bodyBytes + 8 > limits.maxConceptBytes) {
    return {
      ok: false,
      diagnostics: [
        mutationDiagnostic("MUTATION-BOUNDS", descriptor.bundlePath),
      ],
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
          descriptor.bundlePath,
        ),
      ],
    };
  }
  const bookie = isObject(cloned.value.bookie)
    ? cloned.value.bookie
    : undefined;
  if (
    Object.hasOwn(cloned.value, "resource") ||
    bookie === undefined ||
    Object.hasOwn(bookie, "sha256")
  ) {
    return {
      ok: false,
      diagnostics: [
        mutationDiagnostic("MUTATION-INPUT", descriptor.bundlePath),
      ],
    };
  }
  return {
    ok: true,
    frontmatter: cloned.value as Record<string, ReadonlyYamlValue>,
  };
}

function addCapturedFields(
  frontmatter: Record<string, ReadonlyYamlValue>,
  resourcePath: string,
  sha256: string,
): boolean {
  const bookie = frontmatter.bookie;
  if (!isObject(bookie)) return false;
  Object.defineProperty(frontmatter, "resource", {
    value: resourcePath,
    enumerable: true,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(bookie, "sha256", {
    value: sha256,
    enumerable: true,
    writable: true,
    configurable: true,
  });
  return true;
}

async function cleanupStagedResource(
  staged: StagedEvidenceResource | undefined,
  resource: ResolvedMutationTarget,
  parent: Awaited<ReturnType<typeof captureParent>>,
): Promise<boolean> {
  if (staged === undefined) return true;
  if (parent === undefined) return false;
  return cleanupTemporary(staged.temporary, resource, parent);
}

async function performCapture(
  descriptor: ResolvedMutationTarget,
  resource: ResolvedMutationTarget,
  request: CaptureEvidenceRequest,
  limits: CaptureLimits,
  signal: AbortSignal | undefined,
): Promise<CaptureEvidenceResult> {
  const descriptorParent = await captureParent(descriptor, signal);
  const resourceParent = await captureParent(resource, signal);
  if (descriptorParent === undefined || resourceParent === undefined) {
    return captureFailure([
      mutationDiagnostic("MUTATION-PATH", descriptor.bundlePath),
    ]);
  }
  const [descriptorState, resourceState] = await Promise.all([
    targetState(descriptor.target),
    targetState(resource.target),
  ]);
  throwIfAborted(signal);
  if (descriptorState !== "absent" || resourceState !== "absent") {
    return captureFailure([
      mutationDiagnostic(
        descriptorState === "io" || resourceState === "io"
          ? "MUTATION-IO"
          : "MUTATION-TARGET",
        descriptorState !== "absent"
          ? descriptor.bundlePath
          : resource.bundlePath,
      ),
    ]);
  }

  const preparedInput = inputFrontmatter(request, descriptor, limits);
  if (!preparedInput.ok) return captureFailure(preparedInput.diagnostics);
  const tracker = createPathTracker();
  const validators = await schemaValidatorsOrUndefined();
  throwIfAborted(signal);
  if (validators === undefined) {
    return captureFailure([
      mutationDiagnostic("MUTATION-IO", descriptor.bundlePath),
    ]);
  }
  if (!validators.conceptPathPattern.test(descriptor.bundlePath)) {
    return captureFailure([
      mutationDiagnostic("MUTATION-PATH", descriptor.bundlePath),
    ]);
  }
  const manifestResult = await loadMutationManifest(
    descriptor,
    validators,
    limits,
    signal,
    tracker,
  );
  if (!manifestResult.ok) return captureFailure(manifestResult.diagnostics);
  const manifest = manifestResult.manifest;
  if (
    matchesExcludedPath(descriptor.relativePath, manifest.policy.exclude) ||
    matchesExcludedPath(resource.relativePath, manifest.policy.exclude) ||
    isBeneathLiteralPath(
      descriptor.relativePath,
      manifest.policy.evidence_roots,
    ) ||
    !isBeneathLiteralPath(resource.relativePath, manifest.policy.evidence_roots)
  ) {
    return captureFailure([
      mutationDiagnostic("MUTATION-PATH", resource.bundlePath),
    ]);
  }

  const stagedResult = await stageEvidenceResource(
    request.source,
    resource,
    resourceParent,
    Math.min(limits.maxResourceBytes, manifest.policy.attachment_max_bytes),
    signal,
  );
  if (!stagedResult.ok) {
    const code =
      stagedResult.reason === "target"
        ? "MUTATION-TARGET"
        : stagedResult.reason === "bounds"
          ? "MUTATION-BOUNDS"
          : stagedResult.reason === "conflict"
            ? "MUTATION-CONFLICT"
            : "MUTATION-IO";
    return captureFailure([mutationDiagnostic(code, resource.bundlePath)]);
  }
  const stagedResource = stagedResult.staged;
  let stagedDescriptor: StagedTemporary | undefined;
  const cleanupBeforePublication = async (): Promise<boolean> => {
    const [resourceClean, descriptorClean] = await Promise.all([
      cleanupStagedResource(stagedResource, resource, resourceParent),
      cleanupTemporary(stagedDescriptor, descriptor, descriptorParent),
    ]);
    return resourceClean && descriptorClean;
  };
  const failBeforePublication = async (
    diagnostics: readonly MutationDiagnostic[],
  ): Promise<CaptureEvidenceResult> =>
    captureFailure(
      (await cleanupBeforePublication())
        ? diagnostics
        : [mutationDiagnostic("MUTATION-IO", descriptor.bundlePath)],
    );

  let descriptorBytes: Uint8Array;
  try {
    if (
      preparedInput.frontmatter.type !== "Evidence" ||
      !addCapturedFields(
        preparedInput.frontmatter,
        resource.bundlePath,
        stagedResource.sha256,
      )
    ) {
      return failBeforePublication([
        reusedDiagnostic("CONCEPT-SCHEMA", descriptor.bundlePath),
      ]);
    }

    try {
      descriptorBytes = createConceptSourceInternal(
        preparedInput.frontmatter,
        request.bodyText,
      );
    } catch {
      return failBeforePublication([
        mutationDiagnostic("MUTATION-INPUT", descriptor.bundlePath),
      ]);
    }
    const candidate = validateCandidate(
      descriptorBytes,
      descriptor,
      manifest,
      validators,
      limits,
    );
    if (!candidate.ok) return failBeforePublication(candidate.diagnostics);
    const collisions = await checkUidCollision(
      descriptor,
      candidate.candidate,
      "create",
      manifest,
      validators,
      limits,
      signal,
      tracker,
    );
    if (collisions.length > 0) return failBeforePublication(collisions);

    stagedDescriptor = await stageTemporary(
      descriptor,
      descriptorParent,
      descriptorBytes,
      undefined,
      signal,
    );

    if (!(await verifyEvidenceSource(stagedResource.source, signal))) {
      return failBeforePublication([
        mutationDiagnostic("MUTATION-CONFLICT", resource.bundlePath),
      ]);
    }
    if (
      !(await verifyParent(resource, resourceParent, signal)) ||
      !(await verifyParent(descriptor, descriptorParent, signal))
    ) {
      return failBeforePublication([
        mutationDiagnostic("MUTATION-IO", resource.bundlePath),
      ]);
    }

    const resourcePublished = await publishStagedCandidate(
      resource,
      resourceParent,
      stagedResource.temporary,
      stagedResource.byteLength,
      "no-replace",
      signal,
      async () => {
        if (!(await verifyEvidenceSource(stagedResource.source, signal))) {
          return "conflict";
        }
        if (
          (await targetState(resource.target)) !== "absent" ||
          (await targetState(descriptor.target)) !== "absent"
        ) {
          return "conflict";
        }
        return (await verifyParent(descriptor, descriptorParent, signal))
          ? "publish"
          : "io";
      },
    );
    if (resourcePublished !== "published") {
      const cleaned = await cleanupTemporary(
        stagedDescriptor,
        descriptor,
        descriptorParent,
      );
      return captureFailure(
        [
          mutationDiagnostic(
            resourcePublished === "conflict" && cleaned
              ? "MUTATION-CONFLICT"
              : "MUTATION-IO",
            resource.bundlePath,
          ),
        ],
        resourcePublished === "io-after-publication"
          ? [resource.bundlePath]
          : [],
      );
    }
  } catch (error) {
    const cleaned = await cleanupBeforePublication();
    if (isAbortError(error) && cleaned) throw error;
    return captureFailure([
      mutationDiagnostic("MUTATION-IO", descriptor.bundlePath),
    ]);
  }

  const publishedResource = await capturePublishedEvidenceResource(
    resource,
    stagedResource,
  );
  if (
    publishedResource === undefined ||
    !(await syncMutationDirectory(resource, resourceParent))
  ) {
    await cleanupTemporary(stagedDescriptor, descriptor, descriptorParent);
    return captureFailure(
      [mutationDiagnostic("MUTATION-IO", resource.bundlePath)],
      [resource.bundlePath],
    );
  }

  const descriptorPublished = await publishStagedCandidate(
    descriptor,
    descriptorParent,
    stagedDescriptor,
    descriptorBytes.byteLength,
    "no-replace",
    undefined,
    async () => {
      if ((await targetState(descriptor.target)) !== "absent") {
        return "conflict";
      }
      return (await verifyPublishedEvidenceResource(
        resource,
        publishedResource,
      )) && (await verifyParent(resource, resourceParent, undefined))
        ? "publish"
        : "io";
    },
  );
  if (descriptorPublished !== "published") {
    return captureFailure(
      [
        mutationDiagnostic(
          descriptorPublished === "conflict"
            ? "MUTATION-CONFLICT"
            : "MUTATION-IO",
          descriptor.bundlePath,
        ),
      ],
      descriptorPublished === "io-after-publication"
        ? [resource.bundlePath, descriptor.bundlePath]
        : [resource.bundlePath],
    );
  }
  if (!(await syncMutationDirectory(descriptor, descriptorParent))) {
    return captureFailure(
      [mutationDiagnostic("MUTATION-IO", descriptor.bundlePath)],
      [resource.bundlePath, descriptor.bundlePath],
    );
  }

  return captureSuccess(
    descriptor,
    resource,
    descriptorBytes,
    stagedResource.sha256,
    stagedResource.byteLength,
  );
}

async function runCoordinatedCapture(
  descriptor: ResolvedMutationTarget,
  resource: ResolvedMutationTarget,
  request: CaptureEvidenceRequest,
  limits: CaptureLimits,
  options: CaptureEvidenceOptions,
): Promise<CaptureEvidenceResult> {
  return runCoordinatedOperation(
    descriptor.target,
    descriptor.root,
    options.signal,
    options.runExclusive,
    () => performCapture(descriptor, resource, request, limits, options.signal),
    () =>
      captureFailure([
        mutationDiagnostic("MUTATION-IO", descriptor.bundlePath),
      ]),
    "the evidence capture",
  );
}

export async function captureEvidence(
  root: string | URL,
  request: CaptureEvidenceRequest,
  options: CaptureEvidenceOptions = {},
): Promise<CaptureEvidenceResult> {
  const limits = captureLimits(options);
  throwIfAborted(options.signal);
  const descriptor = await resolveMutationTarget(
    root,
    request?.path,
    options.signal,
  );
  if (!descriptor.ok) {
    return captureFailure([descriptor.diagnostic]);
  }
  const resource = resolveRelatedMutationFileTarget(
    descriptor.target,
    request?.resourcePath,
  );
  if (resource === undefined || resource.target === descriptor.target.target) {
    return captureFailure([mutationDiagnostic("MUTATION-PATH", "<invalid>")]);
  }
  return runCoordinatedCapture(
    descriptor.target,
    resource,
    request,
    limits,
    options,
  );
}
