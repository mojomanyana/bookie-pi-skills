import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { throwIfAborted } from "./vault-cancellation.js";
import {
  DEFAULT_MAX_CONCEPT_BYTES,
  DEFAULT_MAX_YAML_DEPTH,
  loadConcept,
} from "./concept-loader.js";
import {
  createDiagnostic,
  DiagnosticCollector,
  mapConceptDiagnostic,
  sanitizeFile,
} from "./vault-diagnostics.js";
import type { VaultDiagnostic } from "./vault-diagnostics.js";
import {
  bundlePath,
  createPathTracker,
  enumerateVault,
  hashSafeBoundedFile,
  isBeneathLiteralPath,
  readSafeBoundedFile,
  verifyTrackedPaths,
} from "./vault-filesystem.js";
import type { PathTracker } from "./vault-filesystem.js";
import { validateGitBase } from "./vault-git-base.js";
import { getSchemaValidators, readVaultManifest } from "./vault-manifest.js";
import { validateMarkdownLinks } from "./vault-markdown.js";
import type {
  BookieCandidate,
  BookieData,
  BookiePolicySource,
  BookieRecord,
  Manifest,
  SchemaError,
  ValidationLimits,
  VaultEntries,
} from "./vault-model.js";
import {
  validateCandidateIdentity,
  validateCurrentTree,
} from "./vault-policy.js";

export const DEFAULT_MAX_MANIFEST_BYTES = 65_536;
export const DEFAULT_MAX_VAULT_ENTRIES = 100_000;
export const DEFAULT_MAX_VAULT_CONCEPTS = 50_000;
export const DEFAULT_MAX_TOTAL_CONCEPT_BYTES = 536_870_912;
export const DEFAULT_MAX_TOTAL_RESOURCE_BYTES = 2_147_483_648;
export const DEFAULT_MAX_VAULT_DIAGNOSTICS = 1_000;

export interface ValidateVaultOptions {
  readonly maxManifestBytes?: number;
  readonly maxConceptBytes?: number;
  readonly maxYamlDepth?: number;
  readonly maxEntries?: number;
  readonly maxConcepts?: number;
  readonly maxTotalConceptBytes?: number;
  readonly maxTotalResourceBytes?: number;
  readonly maxDiagnostics?: number;
  readonly baseRef?: string;
  readonly signal?: AbortSignal;
}

export interface ValidateVaultResult {
  readonly valid: boolean;
  readonly root: string;
  readonly diagnostics: readonly VaultDiagnostic[];
  readonly complete: boolean;
  readonly diagnosticsTruncated: boolean;
  readonly baseCommit?: string;
}

export type {
  VaultDiagnostic,
  VaultDiagnosticCode,
} from "./vault-diagnostics.js";

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

function validationLimits(options: ValidateVaultOptions): ValidationLimits {
  return {
    maxManifestBytes: positiveLimit(
      "maxManifestBytes",
      options.maxManifestBytes,
      DEFAULT_MAX_MANIFEST_BYTES,
    ),
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
    maxEntries: positiveLimit(
      "maxEntries",
      options.maxEntries,
      DEFAULT_MAX_VAULT_ENTRIES,
    ),
    maxConcepts: positiveLimit(
      "maxConcepts",
      options.maxConcepts,
      DEFAULT_MAX_VAULT_CONCEPTS,
    ),
    maxTotalConceptBytes: positiveLimit(
      "maxTotalConceptBytes",
      options.maxTotalConceptBytes,
      DEFAULT_MAX_TOTAL_CONCEPT_BYTES,
    ),
    maxTotalResourceBytes: positiveLimit(
      "maxTotalResourceBytes",
      options.maxTotalResourceBytes,
      DEFAULT_MAX_TOTAL_RESOURCE_BYTES,
    ),
    maxDiagnostics: positiveLimit(
      "maxDiagnostics",
      options.maxDiagnostics,
      DEFAULT_MAX_VAULT_DIAGNOSTICS,
    ),
  };
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function trustedPolicySource(
  path: string,
  displayFile: string,
  type: string,
  frontmatter: Readonly<Record<string, unknown>>,
  bookie: Readonly<Record<string, unknown>>,
): BookiePolicySource {
  const status =
    typeof frontmatter.status === "string" ? frontmatter.status : undefined;
  const profile =
    typeof bookie.profile === "string" ? bookie.profile : undefined;
  const uid = typeof bookie.uid === "string" ? bookie.uid : undefined;
  const project =
    typeof bookie.project === "string" ? bookie.project : undefined;
  const state = typeof bookie.state === "string" ? bookie.state : undefined;
  const sensitivity =
    typeof bookie.sensitivity === "string" ? bookie.sensitivity : undefined;
  const sha256 = typeof bookie.sha256 === "string" ? bookie.sha256 : undefined;
  let relations: BookieData["relations"];
  if (Array.isArray(bookie.relations)) {
    const trusted = [];
    let malformed = false;
    for (const relation of bookie.relations) {
      if (
        !isObject(relation) ||
        typeof relation.kind !== "string" ||
        typeof relation.target !== "string" ||
        (relation.target_uid !== undefined &&
          typeof relation.target_uid !== "string")
      ) {
        malformed = true;
        break;
      }
      trusted.push({
        kind: relation.kind,
        target: relation.target,
        ...(relation.target_uid === undefined
          ? {}
          : { target_uid: relation.target_uid }),
      });
    }
    if (!malformed) relations = trusted;
  }
  const supports =
    Array.isArray(bookie.supports) &&
    bookie.supports.every((support) => typeof support === "string")
      ? bookie.supports
      : undefined;
  return {
    path,
    displayFile,
    type,
    ...(status === undefined ? {} : { status }),
    frontmatter,
    bookie: {
      ...(profile === undefined ? {} : { profile }),
      ...(uid === undefined ? {} : { uid }),
      ...(project === undefined ? {} : { project }),
      ...(state === undefined ? {} : { state }),
      ...(sensitivity === undefined ? {} : { sensitivity }),
      ...(relations === undefined ? {} : { relations }),
      ...(supports === undefined ? {} : { supports }),
      ...(sha256 === undefined ? {} : { sha256 }),
    },
  };
}

function addSchemaDiagnostics(
  collector: DiagnosticCollector,
  code: "MANIFEST-SCHEMA" | "CONCEPT-SCHEMA",
  file: string,
  errors: readonly SchemaError[] | null | undefined,
): void {
  if (errors === null || errors === undefined || errors.length === 0) {
    collector.add(createDiagnostic(code, file));
    return;
  }
  for (const error of errors) {
    collector.add(
      createDiagnostic(code, file, {
        instancePath: error.instancePath,
        keyword: error.keyword,
      }),
    );
  }
}

function isReservedMarkdown(relativePath: string): boolean {
  const name = relativePath.split("/").at(-1);
  return name === "index.md" || name === "log.md";
}

function displayFileFor(
  path: string,
  frontmatter: Readonly<Record<string, unknown>>,
  excludedClasses: readonly string[],
): string {
  const bookie = isObject(frontmatter.bookie) ? frontmatter.bookie : undefined;
  const sensitivity = bookie?.sensitivity;
  return typeof sensitivity === "string" &&
    excludedClasses.includes(sensitivity)
    ? "<excluded>"
    : path;
}

async function validateEvidenceResources(
  records: readonly BookiePolicySource[],
  manifest: Manifest | undefined,
  root: string,
  entries: VaultEntries,
  limits: ValidationLimits,
  collector: DiagnosticCollector,
  signal: AbortSignal | undefined,
  tracker: PathTracker,
): Promise<void> {
  if (manifest === undefined) return;
  const cache = new Map<
    string,
    { readonly ok: true; readonly digest: string } | { readonly ok: false }
  >();
  let totalResourceBytes = 0;

  for (const evidence of records.filter(
    (record) => record.type === "Evidence",
  )) {
    throwIfAborted(signal);
    const resource = evidence.frontmatter.resource;
    if (typeof resource !== "string" || !resource.startsWith("/")) continue;
    const relativeResource = resource.slice(1);
    const beneathConfiguredRoot = isBeneathLiteralPath(
      relativeResource,
      manifest.policy.evidence_roots,
    );
    if (!beneathConfiguredRoot || !entries.regularFiles.has(relativeResource)) {
      collector.add(
        createDiagnostic("EVIDENCE-RESOURCE", evidence.displayFile),
      );
      continue;
    }

    let cached = cache.get(relativeResource);
    if (cached === undefined) {
      const remaining = limits.maxTotalResourceBytes - totalResourceBytes;
      if (remaining <= 0) {
        collector.add(createDiagnostic("VAULT-BOUNDS", "/bookie.yaml"));
        collector.markIncomplete();
        cached = { ok: false };
      } else {
        const maximum = Math.min(
          manifest.policy.attachment_max_bytes,
          remaining,
        );
        const hashed = await hashSafeBoundedFile(
          root,
          relativeResource,
          maximum,
          signal,
          tracker,
        );
        if (!hashed.ok) {
          totalResourceBytes += hashed.bytesRead;
          if (
            hashed.reason === "size" &&
            ((hashed.size ?? 0) <= manifest.policy.attachment_max_bytes ||
              hashed.bytesRead > remaining)
          ) {
            collector.add(createDiagnostic("VAULT-BOUNDS", "/bookie.yaml"));
            collector.markIncomplete();
          } else if (hashed.reason === "io" || hashed.reason === "unsafe") {
            collector.markIncomplete();
          }
          cached = { ok: false };
        } else {
          totalResourceBytes += hashed.size;
          cached = { ok: true, digest: hashed.digest };
        }
      }
      cache.set(relativeResource, cached);
    }

    if (!cached.ok) {
      collector.add(
        createDiagnostic("EVIDENCE-RESOURCE", evidence.displayFile),
      );
    } else if (
      typeof evidence.bookie.sha256 === "string" &&
      cached.digest !== evidence.bookie.sha256
    ) {
      collector.add(createDiagnostic("EVIDENCE-DIGEST", evidence.displayFile));
    }
  }
}

export async function validateVault(
  rootPath: string | URL,
  options: ValidateVaultOptions = {},
): Promise<ValidateVaultResult> {
  if (options.baseRef !== undefined && typeof options.baseRef !== "string") {
    throw new TypeError("baseRef must be a string");
  }
  const limits = validationLimits(options);
  const collector = new DiagnosticCollector(limits.maxDiagnostics);
  const tracker = createPathTracker();
  throwIfAborted(options.signal);
  const suppliedRoot =
    rootPath instanceof URL ? fileURLToPath(rootPath) : rootPath;
  const unresolvedRoot = resolve(suppliedRoot);
  let root: string;
  try {
    root = await realpath(unresolvedRoot);
    const metadata = await stat(root);
    if (!metadata.isDirectory()) throw new Error("not a directory");
  } catch {
    throwIfAborted(options.signal);
    collector.add(createDiagnostic("VAULT-ROOT", "/"));
    collector.markIncomplete();
    const diagnostics = collector.finish();
    return {
      valid: false,
      root: unresolvedRoot,
      diagnostics,
      complete: collector.complete,
      diagnosticsTruncated: collector.diagnosticsTruncated,
    };
  }

  throwIfAborted(options.signal);
  const validators = await getSchemaValidators();
  throwIfAborted(options.signal);
  const manifestState = await readVaultManifest(
    root,
    limits,
    validators,
    collector,
    options.signal,
    tracker,
  );
  throwIfAborted(options.signal);
  const manifest = manifestState.manifest;
  const entries = await enumerateVault(
    root,
    manifest?.policy.exclude ?? [],
    limits,
    collector,
    options.signal,
    tracker,
  );

  if (!entries.regularFiles.has("index.md")) {
    collector.add(
      createDiagnostic("CONCEPT-SCHEMA", "/index.md", {
        instancePath: "/okf_version",
        keyword: "required",
      }),
    );
  }

  const candidates: BookieCandidate[] = [];
  const records: BookieRecord[] = [];
  const policySources: BookiePolicySource[] = [];
  const currentSourceDigests = new Map<string, string>();
  const redactedEntryPaths = new Set<string>();
  const evidenceResourceFiles = new Set<string>();
  let conceptCount = 0;
  let totalConceptBytes = 0;
  const markdownFiles =
    manifest === undefined
      ? entries.markdownFiles
      : [
          ...entries.markdownFiles.filter(
            (path) =>
              !isBeneathLiteralPath(path, manifest.policy.evidence_roots),
          ),
          ...entries.markdownFiles.filter((path) =>
            isBeneathLiteralPath(path, manifest.policy.evidence_roots),
          ),
        ];

  for (const relativePath of markdownFiles) {
    throwIfAborted(options.signal);
    const insideEvidenceRoot =
      manifest !== undefined &&
      isBeneathLiteralPath(relativePath, manifest.policy.evidence_roots);
    if (insideEvidenceRoot && evidenceResourceFiles.has(relativePath)) {
      continue;
    }
    const hostPath = resolve(root, relativePath);
    const file = bundlePath(relativePath);
    const read = await readSafeBoundedFile(
      root,
      relativePath,
      limits.maxConceptBytes,
      options.signal,
      tracker,
    );
    if (!read.ok) {
      collector.add(
        read.reason === "size"
          ? mapConceptDiagnostic(
              {
                code: "CONCEPT-SIZE",
                severity: "error",
                file,
                message: "Concept exceeds the configured byte limit.",
                remediation:
                  "Reduce the concept size below the configured limit.",
              },
              file,
            )
          : createDiagnostic("VAULT-IO", file),
      );
      collector.markIncomplete();
      continue;
    }

    totalConceptBytes += read.bytes.byteLength;
    if (totalConceptBytes > limits.maxTotalConceptBytes) {
      collector.add(createDiagnostic("VAULT-BOUNDS", "/bookie.yaml"));
      collector.markIncomplete();
      break;
    }

    if (relativePath === "index.md") {
      const loadedIndex = loadConcept(read.bytes, {
        file,
        maxBytes: limits.maxConceptBytes,
        maxDepth: limits.maxYamlDepth,
      });
      if (!loadedIndex.ok) {
        for (const diagnostic of loadedIndex.diagnostics) {
          collector.add(mapConceptDiagnostic(diagnostic, file));
        }
        if (
          loadedIndex.diagnostics.some(
            (diagnostic) => diagnostic.code === "YAML-UNSUPPORTED",
          )
        ) {
          collector.markIncomplete();
        }
        continue;
      }
      if (loadedIndex.concept.frontmatter.okf_version !== "0.2") {
        collector.add(
          createDiagnostic("CONCEPT-SCHEMA", file, {
            instancePath: "/okf_version",
            keyword:
              loadedIndex.concept.frontmatter.okf_version === undefined
                ? "required"
                : "const",
          }),
        );
      }
      await validateMarkdownLinks(
        loadedIndex.concept.bodyText,
        hostPath,
        file,
        root,
        entries,
        collector,
        options.signal,
      );
      continue;
    }

    if (isReservedMarkdown(relativePath)) {
      let body: string;
      try {
        body = new TextDecoder("utf-8", { fatal: true }).decode(read.bytes);
      } catch {
        collector.add({
          code: "CONCEPT-UTF8",
          severity: "error",
          file: sanitizeFile(file),
          message: "Concept is not valid UTF-8.",
          remediation: "Save the complete Markdown file as valid UTF-8.",
        });
        continue;
      }
      await validateMarkdownLinks(
        body,
        hostPath,
        file,
        root,
        entries,
        collector,
        options.signal,
      );
      continue;
    }

    conceptCount += 1;
    if (conceptCount > limits.maxConcepts) {
      collector.add(createDiagnostic("VAULT-BOUNDS", "/bookie.yaml"));
      collector.markIncomplete();
      break;
    }

    const loaded = loadConcept(read.bytes, {
      file,
      maxBytes: limits.maxConceptBytes,
      maxDepth: limits.maxYamlDepth,
    });
    if (!loaded.ok) {
      for (const diagnostic of loaded.diagnostics) {
        collector.add(mapConceptDiagnostic(diagnostic, file));
      }
      if (
        loaded.diagnostics.some(
          (diagnostic) => diagnostic.code === "YAML-UNSUPPORTED",
        )
      ) {
        collector.markIncomplete();
      }
      continue;
    }

    const { frontmatter } = loaded.concept;
    currentSourceDigests.set(
      file,
      createHash("sha256").update(read.bytes).digest("hex"),
    );
    const displayFile = displayFileFor(
      file,
      frontmatter,
      manifestState.excludedSensitivityClasses,
    );
    if (insideEvidenceRoot) {
      collector.add(createDiagnostic("CONCEPT-PATH", displayFile));
    }
    if (displayFile === "<excluded>") {
      const addSensitivePath = (value: unknown): void => {
        if (typeof value === "string" && value.startsWith("/")) {
          redactedEntryPaths.add(sanitizeFile(posix.normalize(value)));
        }
      };
      redactedEntryPaths.add(sanitizeFile(file));
      addSensitivePath(frontmatter.resource);
      if (Array.isArray(frontmatter.sources)) {
        for (const source of frontmatter.sources) {
          if (isObject(source)) addSensitivePath(source.resource);
        }
      }
      const rawBookie = isObject(frontmatter.bookie)
        ? frontmatter.bookie
        : undefined;
      addSensitivePath(rawBookie?.project);
      if (Array.isArray(rawBookie?.supports)) {
        for (const support of rawBookie.supports) addSensitivePath(support);
      }
      if (Array.isArray(rawBookie?.relations)) {
        for (const relation of rawBookie.relations) {
          if (isObject(relation)) addSensitivePath(relation.target);
        }
      }
    }
    await validateMarkdownLinks(
      loaded.concept.bodyText,
      hostPath,
      displayFile,
      root,
      entries,
      collector,
      options.signal,
      displayFile === "<excluded>"
        ? (target) => redactedEntryPaths.add(sanitizeFile(target))
        : undefined,
    );

    const type = frontmatter.type;
    const bookieValue = frontmatter.bookie;
    if (!isObject(bookieValue)) {
      if (typeof type !== "string" || type.length === 0) {
        collector.add(
          createDiagnostic("CONCEPT-SCHEMA", displayFile, {
            instancePath: "/type",
            keyword: typeof type === "string" ? "minLength" : "required",
          }),
        );
      }
      continue;
    }

    candidates.push({
      path: file,
      displayFile,
      ...(typeof type === "string" ? { type } : {}),
      ...(typeof bookieValue.uid === "string" ? { uid: bookieValue.uid } : {}),
      ...(typeof bookieValue.profile === "string"
        ? { profile: bookieValue.profile }
        : {}),
    });

    if (typeof type !== "string") {
      collector.add(
        createDiagnostic("CONCEPT-SCHEMA", displayFile, {
          instancePath: "/type",
          keyword: "required",
        }),
      );
      continue;
    }
    const validate = validators.byType.get(type);
    if (validate === undefined) {
      collector.add(createDiagnostic("CONCEPT-SCHEMA", displayFile));
      continue;
    }
    const policySource = trustedPolicySource(
      file,
      displayFile,
      type,
      frontmatter,
      bookieValue,
    );
    if (!validate(frontmatter)) {
      addSchemaDiagnostics(
        collector,
        "CONCEPT-SCHEMA",
        displayFile,
        validate.errors,
      );
      policySources.push(policySource);
      continue;
    }
    if (
      type === "Evidence" &&
      typeof frontmatter.resource === "string" &&
      frontmatter.resource.startsWith("/")
    ) {
      evidenceResourceFiles.add(frontmatter.resource.slice(1));
    }

    const record = {
      path: file,
      displayFile,
      type,
      status: frontmatter.status as string,
      frontmatter,
      bookie: frontmatter.bookie as unknown as BookieData,
    };
    records.push(record);
    policySources.push(record);
  }

  validateCandidateIdentity(candidates, manifest, validators, collector);
  await validateCurrentTree(records, collector, options.signal, policySources);
  await validateEvidenceResources(
    policySources,
    manifest,
    root,
    entries,
    limits,
    collector,
    options.signal,
    tracker,
  );
  const gitBase =
    options.baseRef === undefined
      ? {}
      : await validateGitBase({
          root,
          baseRef: options.baseRef,
          ...(manifest === undefined ? {} : { currentManifest: manifest }),
          currentExcludedSensitivityClasses:
            manifestState.excludedSensitivityClasses,
          currentRecords: records,
          currentSourceDigests,
          entries,
          limits,
          validators,
          collector,
          redactedEntryPaths,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          tracker,
        });
  throwIfAborted(options.signal);
  if (!(await verifyTrackedPaths(tracker, options.signal))) {
    collector.add(createDiagnostic("VAULT-IO", "/"));
    collector.markIncomplete();
  }
  throwIfAborted(options.signal);
  collector.redactFiles(redactedEntryPaths);

  const diagnostics = collector.finish();
  const complete = collector.complete && !entries.incomplete;
  return {
    valid: complete && diagnostics.length === 0,
    root,
    diagnostics,
    complete,
    diagnosticsTruncated: collector.diagnosticsTruncated,
    ...(gitBase.baseCommit === undefined
      ? {}
      : { baseCommit: gitBase.baseCommit }),
  };
}
