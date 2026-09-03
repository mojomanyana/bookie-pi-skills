import { loadConcept } from "./concept-loader.js";
import type { LoadedConcept, ReadonlyYamlMapping } from "./concept-loader.js";
import type { ResolvedMutationTarget } from "./concept-mutation-filesystem.js";
import {
  conceptDiagnostics,
  isObject,
  mutationDiagnostic,
  reusedDiagnostic,
} from "./concept-mutation-model.js";
import type {
  MutationDiagnostic,
  MutationLimits,
  MutationOperation,
} from "./concept-mutation-model.js";
import { getSchemaValidators, readVaultManifest } from "./vault-manifest.js";
import {
  bundlePath,
  enumerateVault,
  isBeneathLiteralPath,
  readSafeBoundedFile,
  verifyTrackedPaths,
} from "./vault-filesystem.js";
import type { PathTracker } from "./vault-filesystem.js";
import type {
  Manifest,
  SchemaError,
  SchemaValidators,
  ValidationLimits,
} from "./vault-model.js";
import {
  DEFAULT_MAX_MANIFEST_BYTES,
  DEFAULT_MAX_TOTAL_CONCEPT_BYTES,
  DEFAULT_MAX_TOTAL_RESOURCE_BYTES,
  DEFAULT_MAX_VAULT_CONCEPTS,
  DEFAULT_MAX_VAULT_DIAGNOSTICS,
  DEFAULT_MAX_VAULT_ENTRIES,
} from "./vault-validator.js";
import { DiagnosticCollector } from "./vault-diagnostics.js";
import { throwIfAborted } from "./vault-cancellation.js";

export interface Candidate {
  readonly bytes: Uint8Array;
  readonly uid: string;
  readonly displayFile: string;
}

export interface StableIdentity {
  readonly type: string;
  readonly profile: string;
  readonly uid: string;
}

function displayFileForCandidate(
  bundlePathValue: string,
  frontmatter: ReadonlyYamlMapping,
  manifest: Manifest,
): string {
  const bookie = isObject(frontmatter.bookie) ? frontmatter.bookie : undefined;
  return typeof bookie?.sensitivity === "string" &&
    manifest.policy.sensitivity.excluded_classes.includes(bookie.sensitivity)
    ? "<excluded>"
    : bundlePathValue;
}

function schemaDiagnostics(
  file: string,
  errors: readonly SchemaError[] | null | undefined,
): readonly MutationDiagnostic[] {
  if (errors === undefined || errors === null || errors.length === 0) {
    return [reusedDiagnostic("CONCEPT-SCHEMA", file)];
  }
  const diagnostics = errors
    .slice(0, DEFAULT_MAX_VAULT_DIAGNOSTICS - 1)
    .map((error) =>
      reusedDiagnostic("CONCEPT-SCHEMA", file, {
        instancePath: error.instancePath,
        keyword: error.keyword,
      }),
    );
  if (errors.length >= DEFAULT_MAX_VAULT_DIAGNOSTICS) {
    diagnostics.push(mutationDiagnostic("MUTATION-BOUNDS", file));
  }
  return diagnostics;
}

export function validateCandidate(
  bytes: Uint8Array,
  target: ResolvedMutationTarget,
  manifest: Manifest,
  validators: SchemaValidators,
  limits: MutationLimits,
  expectedIdentity?: StableIdentity,
):
  | { readonly ok: true; readonly candidate: Candidate }
  | {
      readonly ok: false;
      readonly diagnostics: readonly MutationDiagnostic[];
    } {
  const loaded = loadConcept(bytes, {
    file: target.bundlePath,
    maxBytes: limits.maxConceptBytes,
    maxDepth: limits.maxYamlDepth,
  });
  if (!loaded.ok) {
    return {
      ok: false,
      diagnostics: conceptDiagnostics(loaded.diagnostics, target.bundlePath),
    };
  }

  const frontmatter = loaded.concept.frontmatter;
  const displayFile = displayFileForCandidate(
    target.bundlePath,
    frontmatter,
    manifest,
  );
  const type = frontmatter.type;
  const bookie = isObject(frontmatter.bookie) ? frontmatter.bookie : undefined;
  const uid = bookie?.uid;
  const profile = bookie?.profile;
  if (
    expectedIdentity !== undefined &&
    (type !== expectedIdentity.type ||
      profile !== expectedIdentity.profile ||
      uid !== expectedIdentity.uid)
  ) {
    return {
      ok: false,
      diagnostics: [mutationDiagnostic("MUTATION-IDENTITY", displayFile)],
    };
  }
  if (
    typeof type !== "string" ||
    typeof uid !== "string" ||
    typeof profile !== "string"
  ) {
    return {
      ok: false,
      diagnostics: [reusedDiagnostic("CONCEPT-SCHEMA", displayFile)],
    };
  }

  const validator = validators.byType.get(type);
  if (validator === undefined || !validator(frontmatter)) {
    return {
      ok: false,
      diagnostics:
        validator === undefined
          ? [reusedDiagnostic("CONCEPT-SCHEMA", displayFile)]
          : schemaDiagnostics(displayFile, validator.errors),
    };
  }
  if (!manifest.allowed_concept_types.includes(type)) {
    return {
      ok: false,
      diagnostics: [reusedDiagnostic("TYPE-ALLOWED", displayFile)],
    };
  }

  return {
    ok: true,
    candidate: { bytes, uid, displayFile },
  };
}

function scanLimits(limits: MutationLimits): ValidationLimits {
  return {
    maxManifestBytes: DEFAULT_MAX_MANIFEST_BYTES,
    maxConceptBytes: limits.maxConceptBytes,
    maxYamlDepth: limits.maxYamlDepth,
    maxEntries: DEFAULT_MAX_VAULT_ENTRIES,
    maxConcepts: DEFAULT_MAX_VAULT_CONCEPTS,
    maxTotalConceptBytes: DEFAULT_MAX_TOTAL_CONCEPT_BYTES,
    maxTotalResourceBytes: DEFAULT_MAX_TOTAL_RESOURCE_BYTES,
    maxDiagnostics: DEFAULT_MAX_VAULT_DIAGNOSTICS,
  };
}

export async function loadMutationManifest(
  target: ResolvedMutationTarget,
  validators: SchemaValidators,
  limits: MutationLimits,
  signal: AbortSignal | undefined,
  tracker: PathTracker,
): Promise<
  | { readonly ok: true; readonly manifest: Manifest }
  | { readonly ok: false; readonly diagnostics: readonly MutationDiagnostic[] }
> {
  const collector = new DiagnosticCollector(DEFAULT_MAX_VAULT_DIAGNOSTICS);
  const state = await readVaultManifest(
    target.root,
    scanLimits(limits),
    validators,
    collector,
    signal,
    tracker,
  );
  if (state.manifest !== undefined) {
    return { ok: true, manifest: state.manifest };
  }

  const diagnostics = collector.finish().map((diagnostic) => {
    switch (diagnostic.code) {
      case "MANIFEST-MISSING":
      case "MANIFEST-SIZE":
      case "MANIFEST-SYNTAX":
      case "MANIFEST-SCHEMA":
        return Object.freeze(diagnostic) as MutationDiagnostic;
      case "VAULT-BOUNDS":
      case "DIAGNOSTICS-TRUNCATED":
        return mutationDiagnostic("MUTATION-BOUNDS", "/bookie.yaml");
      default:
        return mutationDiagnostic("MUTATION-IO", "/bookie.yaml");
    }
  });
  return {
    ok: false,
    diagnostics:
      diagnostics.length > 0
        ? diagnostics
        : [mutationDiagnostic("MUTATION-IO", "/bookie.yaml")],
  };
}

function isReservedMarkdown(relativePath: string): boolean {
  const name = relativePath.split("/").at(-1);
  return name === "index.md" || name === "log.md";
}

export async function checkUidCollision(
  target: ResolvedMutationTarget,
  candidate: Candidate,
  operation: MutationOperation,
  manifest: Manifest,
  validators: SchemaValidators,
  limits: MutationLimits,
  signal: AbortSignal | undefined,
  tracker: PathTracker,
): Promise<readonly MutationDiagnostic[]> {
  const collector = new DiagnosticCollector(DEFAULT_MAX_VAULT_DIAGNOSTICS);
  const entries = await enumerateVault(
    target.root,
    manifest.policy.exclude,
    scanLimits(limits),
    collector,
    signal,
    tracker,
  );
  const enumerationDiagnostics = collector.finish();
  if (entries.incomplete || enumerationDiagnostics.length > 0) {
    return [
      mutationDiagnostic(
        enumerationDiagnostics.some(
          (diagnostic) => diagnostic.code === "VAULT-BOUNDS",
        )
          ? "MUTATION-BOUNDS"
          : "MUTATION-IO",
        candidate.displayFile,
      ),
    ];
  }

  let conceptCount = 0;
  let totalBytes = 0;
  const evidenceResourceFiles = new Set<string>();
  const markdownFiles = [
    ...entries.markdownFiles.filter(
      (path) => !isBeneathLiteralPath(path, manifest.policy.evidence_roots),
    ),
    ...entries.markdownFiles.filter((path) =>
      isBeneathLiteralPath(path, manifest.policy.evidence_roots),
    ),
  ];
  for (const relativePath of markdownFiles) {
    throwIfAborted(signal);
    const insideEvidenceRoot = isBeneathLiteralPath(
      relativePath,
      manifest.policy.evidence_roots,
    );
    if (
      isReservedMarkdown(relativePath) ||
      (insideEvidenceRoot && evidenceResourceFiles.has(relativePath))
    ) {
      continue;
    }
    conceptCount += 1;
    if (conceptCount > DEFAULT_MAX_VAULT_CONCEPTS) {
      return [mutationDiagnostic("MUTATION-BOUNDS", candidate.displayFile)];
    }
    const read = await readSafeBoundedFile(
      target.root,
      relativePath,
      limits.maxConceptBytes,
      signal,
      tracker,
    );
    if (!read.ok) {
      return [
        mutationDiagnostic(
          read.reason === "size" ? "MUTATION-BOUNDS" : "MUTATION-IO",
          candidate.displayFile,
        ),
      ];
    }
    totalBytes += read.bytes.byteLength;
    if (totalBytes > DEFAULT_MAX_TOTAL_CONCEPT_BYTES) {
      return [mutationDiagnostic("MUTATION-BOUNDS", candidate.displayFile)];
    }
    const loaded = loadConcept(read.bytes, {
      file: bundlePath(relativePath),
      maxBytes: limits.maxConceptBytes,
      maxDepth: limits.maxYamlDepth,
    });
    if (!loaded.ok) {
      return [mutationDiagnostic("MUTATION-IO", candidate.displayFile)];
    }
    const loadedType = loaded.concept.frontmatter.type;
    const loadedValidator =
      typeof loadedType === "string"
        ? validators.byType.get(loadedType)
        : undefined;
    if (
      loadedType === "Evidence" &&
      loadedValidator?.(loaded.concept.frontmatter) === true &&
      typeof loaded.concept.frontmatter.resource === "string" &&
      loaded.concept.frontmatter.resource.startsWith("/")
    ) {
      evidenceResourceFiles.add(loaded.concept.frontmatter.resource.slice(1));
    }
    if (insideEvidenceRoot) {
      return [mutationDiagnostic("MUTATION-IO", candidate.displayFile)];
    }
    const bookie = isObject(loaded.concept.frontmatter.bookie)
      ? loaded.concept.frontmatter.bookie
      : undefined;
    if (
      bookie?.uid === candidate.uid &&
      !(operation === "amend" && relativePath === target.relativePath)
    ) {
      return [reusedDiagnostic("UID-UNIQUE", candidate.displayFile)];
    }
  }

  if (!(await verifyTrackedPaths(tracker, signal))) {
    return [mutationDiagnostic("MUTATION-IO", candidate.displayFile)];
  }
  return [];
}

export function stableIdentity(
  concept: LoadedConcept,
): StableIdentity | undefined {
  const type = concept.frontmatter.type;
  const bookie = isObject(concept.frontmatter.bookie)
    ? concept.frontmatter.bookie
    : undefined;
  return typeof type === "string" &&
    typeof bookie?.profile === "string" &&
    typeof bookie.uid === "string"
    ? { type, profile: bookie.profile, uid: bookie.uid }
    : undefined;
}

export async function schemaValidatorsOrUndefined(): Promise<
  SchemaValidators | undefined
> {
  try {
    return await getSchemaValidators();
  } catch {
    return undefined;
  }
}
