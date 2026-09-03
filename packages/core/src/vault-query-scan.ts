import { realpath, stat } from "node:fs/promises";
import { posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConcept } from "./concept-loader.js";
import { throwIfAborted } from "./vault-cancellation.js";
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
  isBeneathLiteralPath,
  readSafeBoundedFile,
  verifyTrackedPaths,
} from "./vault-filesystem.js";
import { getSchemaValidators, readVaultManifest } from "./vault-manifest.js";
import type { Manifest, SchemaError, ValidationLimits } from "./vault-model.js";

export interface ScannedQueryConcept {
  readonly sourcePath: string;
  readonly sourceBytes: Uint8Array;
  readonly bodyText: string;
  readonly type: string;
  readonly title: string;
  readonly uid: string;
  readonly project: string | null;
  readonly status: string;
  readonly state: string | null;
  readonly tags: readonly string[];
  readonly sensitivity: string | null;
  readonly sensitivityClassification:
    "missing" | "declared" | "undeclared" | "excluded";
  readonly verification: "present" | "absent";
  readonly staleAfter: string | null;
  readonly excluded: boolean;
}

export interface VaultQueryScanResult {
  readonly root: string;
  readonly complete: boolean;
  readonly safeToReturn: boolean;
  readonly diagnostics: readonly VaultDiagnostic[];
  readonly diagnosticsTruncated: boolean;
  readonly rejectedConcepts: number;
  readonly invalidPaths: ReadonlySet<string>;
  readonly invalidUids: ReadonlySet<string>;
}

interface ScanInput {
  readonly rootPath: string | URL;
  readonly limits: ValidationLimits;
  readonly signal?: AbortSignal;
  readonly visit: (
    concept: ScannedQueryConcept,
  ) => Promise<void> | undefined | void;
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function displayFileFor(
  path: string,
  frontmatter: Readonly<Record<string, unknown>>,
  excludedClasses: readonly string[],
): string {
  const bookie = isObject(frontmatter.bookie) ? frontmatter.bookie : undefined;
  return typeof bookie?.sensitivity === "string" &&
    excludedClasses.includes(bookie.sensitivity)
    ? "<excluded>"
    : path;
}

function addSchemaDiagnostics(
  collector: DiagnosticCollector,
  file: string,
  errors: readonly SchemaError[] | null | undefined,
): void {
  if (errors === null || errors === undefined || errors.length === 0) {
    collector.add(createDiagnostic("CONCEPT-SCHEMA", file));
    return;
  }
  for (const error of errors) {
    collector.add(
      createDiagnostic("CONCEPT-SCHEMA", file, {
        instancePath: error.instancePath,
        keyword: error.keyword,
      }),
    );
  }
}

function addRedactedReferences(
  frontmatter: Readonly<Record<string, unknown>>,
  redactedPaths: Set<string>,
): void {
  const add = (value: unknown): void => {
    if (typeof value === "string" && value.startsWith("/")) {
      redactedPaths.add(sanitizeFile(posix.normalize(value)));
    }
  };
  add(frontmatter.resource);
  if (Array.isArray(frontmatter.sources)) {
    for (const source of frontmatter.sources) {
      if (isObject(source)) add(source.resource);
    }
  }
  const bookie = isObject(frontmatter.bookie) ? frontmatter.bookie : undefined;
  add(bookie?.project);
  if (Array.isArray(bookie?.supports)) {
    for (const support of bookie.supports) add(support);
  }
  if (Array.isArray(bookie?.relations)) {
    for (const relation of bookie.relations) {
      if (isObject(relation)) add(relation.target);
    }
  }
}

function isRedactedPath(
  path: string,
  redactedPaths: ReadonlySet<string>,
): boolean {
  let candidate = path;
  while (candidate.startsWith("/")) {
    if (redactedPaths.has(candidate)) return true;
    const separator = candidate.lastIndexOf("/");
    if (separator <= 0) return false;
    candidate = candidate.slice(0, separator);
  }
  return false;
}

function sensitivityClassification(
  value: string | null,
  manifest: Manifest,
): ScannedQueryConcept["sensitivityClassification"] {
  if (value === null) return "missing";
  if (manifest.policy.sensitivity.excluded_classes.includes(value)) {
    return "excluded";
  }
  return manifest.policy.sensitivity.classes.includes(value)
    ? "declared"
    : "undeclared";
}

function finishedScan(
  root: string,
  collector: DiagnosticCollector,
  rejectedConcepts: number,
  invalidPaths: ReadonlySet<string>,
  invalidUids: ReadonlySet<string>,
  safeToReturn: boolean,
  entriesIncomplete = false,
): VaultQueryScanResult {
  const diagnostics = collector.finish();
  return {
    root,
    complete: collector.complete && !entriesIncomplete && safeToReturn,
    safeToReturn,
    diagnostics,
    diagnosticsTruncated: collector.diagnosticsTruncated,
    rejectedConcepts,
    invalidPaths,
    invalidUids,
  };
}

export async function scanVaultForQuery(
  input: ScanInput,
): Promise<VaultQueryScanResult> {
  const { limits, signal, visit } = input;
  const collector = new DiagnosticCollector(limits.maxDiagnostics);
  const tracker = createPathTracker();
  const invalidPaths = new Set<string>();
  const invalidUids = new Set<string>();
  let rejectedConcepts = 0;
  throwIfAborted(signal);

  let unresolvedRoot: string;
  try {
    const suppliedRoot =
      input.rootPath instanceof URL
        ? fileURLToPath(input.rootPath)
        : input.rootPath;
    unresolvedRoot = resolve(suppliedRoot);
  } catch {
    collector.add(createDiagnostic("VAULT-ROOT", "/"));
    collector.markIncomplete();
    return finishedScan(
      "<invalid>",
      collector,
      rejectedConcepts,
      invalidPaths,
      invalidUids,
      false,
    );
  }
  let root: string;
  try {
    root = await realpath(unresolvedRoot);
    const metadata = await stat(root);
    if (!metadata.isDirectory()) throw new Error("not a directory");
  } catch {
    throwIfAborted(signal);
    collector.add(createDiagnostic("VAULT-ROOT", "/"));
    collector.markIncomplete();
    return finishedScan(
      unresolvedRoot,
      collector,
      rejectedConcepts,
      invalidPaths,
      invalidUids,
      false,
    );
  }

  throwIfAborted(signal);
  const validators = await getSchemaValidators();
  throwIfAborted(signal);
  const manifestState = await readVaultManifest(
    root,
    limits,
    validators,
    collector,
    signal,
    tracker,
  );
  const manifest = manifestState.manifest;
  if (manifest === undefined) {
    return finishedScan(
      root,
      collector,
      rejectedConcepts,
      invalidPaths,
      invalidUids,
      false,
    );
  }

  const entries = await enumerateVault(
    root,
    manifest.policy.exclude,
    limits,
    collector,
    signal,
    tracker,
  );
  if (entries.unsafeEntries) collector.markIncomplete();
  if (!entries.regularFiles.has("index.md")) {
    collector.add(
      createDiagnostic("CONCEPT-SCHEMA", "/index.md", {
        instancePath: "/okf_version",
        keyword: "required",
      }),
    );
    collector.markIncomplete();
    return finishedScan(
      root,
      collector,
      rejectedConcepts,
      invalidPaths,
      invalidUids,
      false,
      entries.incomplete,
    );
  }

  const indexRead = await readSafeBoundedFile(
    root,
    "index.md",
    limits.maxConceptBytes,
    signal,
    tracker,
  );
  if (!indexRead.ok) {
    collector.add(
      indexRead.reason === "size"
        ? mapConceptDiagnostic(
            {
              code: "CONCEPT-SIZE",
              severity: "error",
              file: "/index.md",
              message: "Concept exceeds the configured byte limit.",
              remediation:
                "Reduce the concept size below the configured limit.",
            },
            "/index.md",
          )
        : createDiagnostic("VAULT-IO", "/index.md"),
    );
    collector.markIncomplete();
    return finishedScan(
      root,
      collector,
      rejectedConcepts,
      invalidPaths,
      invalidUids,
      false,
      entries.incomplete,
    );
  }
  let totalConceptBytes = indexRead.bytes.byteLength;
  if (totalConceptBytes > limits.maxTotalConceptBytes) {
    collector.add(createDiagnostic("VAULT-BOUNDS", "/bookie.yaml"));
    collector.markIncomplete();
    return finishedScan(
      root,
      collector,
      rejectedConcepts,
      invalidPaths,
      invalidUids,
      false,
      entries.incomplete,
    );
  }
  const loadedIndex = loadConcept(indexRead.bytes, {
    file: "/index.md",
    maxBytes: limits.maxConceptBytes,
    maxDepth: limits.maxYamlDepth,
  });
  if (!loadedIndex.ok) {
    for (const diagnostic of loadedIndex.diagnostics) {
      collector.add(mapConceptDiagnostic(diagnostic, "/index.md"));
    }
    collector.markIncomplete();
    return finishedScan(
      root,
      collector,
      rejectedConcepts,
      invalidPaths,
      invalidUids,
      false,
      entries.incomplete,
    );
  }
  if (loadedIndex.concept.frontmatter.okf_version !== "0.2") {
    collector.add(
      createDiagnostic("CONCEPT-SCHEMA", "/index.md", {
        instancePath: "/okf_version",
        keyword:
          loadedIndex.concept.frontmatter.okf_version === undefined
            ? "required"
            : "const",
      }),
    );
    collector.markIncomplete();
    return finishedScan(
      root,
      collector,
      rejectedConcepts,
      invalidPaths,
      invalidUids,
      false,
      entries.incomplete,
    );
  }

  const evidenceResourceFiles = new Set<string>();
  const redactedPaths = new Set<string>();
  type UidFile = { readonly displayFile: string };
  const uidFiles = new Map<string, UidFile | UidFile[]>();
  let conceptCount = 0;
  let reachedBound = false;
  const allConceptPaths = entries.markdownFiles.filter(
    (path) =>
      path !== "index.md" &&
      !["index.md", "log.md"].includes(path.split("/").at(-1) ?? ""),
  );
  const orderedPaths = [
    ...allConceptPaths.filter(
      (path) => !isBeneathLiteralPath(path, manifest.policy.evidence_roots),
    ),
    ...allConceptPaths.filter((path) =>
      isBeneathLiteralPath(path, manifest.policy.evidence_roots),
    ),
  ];

  const reject = (
    sourcePath: string,
    frontmatter: Readonly<Record<string, unknown>> | undefined,
  ): void => {
    invalidPaths.add(sourcePath);
    const bookie =
      frontmatter !== undefined && isObject(frontmatter.bookie)
        ? frontmatter.bookie
        : undefined;
    if (
      typeof bookie?.uid === "string" &&
      /^[A-Z]{3}-[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(bookie.uid)
    ) {
      invalidUids.add(bookie.uid);
    }
    const excluded =
      (typeof bookie?.sensitivity === "string" &&
        manifest.policy.sensitivity.excluded_classes.includes(
          bookie.sensitivity,
        )) ||
      isRedactedPath(sourcePath, redactedPaths);
    if (!excluded) rejectedConcepts += 1;
  };

  for (const relativePath of orderedPaths) {
    throwIfAborted(signal);
    const insideEvidenceRoot = isBeneathLiteralPath(
      relativePath,
      manifest.policy.evidence_roots,
    );
    if (insideEvidenceRoot && evidenceResourceFiles.has(relativePath)) continue;

    conceptCount += 1;
    if (conceptCount > limits.maxConcepts) {
      collector.add(createDiagnostic("VAULT-BOUNDS", "/bookie.yaml"));
      collector.markIncomplete();
      reachedBound = true;
      break;
    }

    const sourcePath = bundlePath(relativePath);
    const read = await readSafeBoundedFile(
      root,
      relativePath,
      limits.maxConceptBytes,
      signal,
      tracker,
    );
    if (!read.ok) {
      collector.add(
        read.reason === "size"
          ? mapConceptDiagnostic(
              {
                code: "CONCEPT-SIZE",
                severity: "error",
                file: sourcePath,
                message: "Concept exceeds the configured byte limit.",
                remediation:
                  "Reduce the concept size below the configured limit.",
              },
              sourcePath,
            )
          : createDiagnostic("VAULT-IO", sourcePath),
      );
      if (read.reason === "size") reject(sourcePath, undefined);
      collector.markIncomplete();
      continue;
    }

    totalConceptBytes += read.bytes.byteLength;
    if (totalConceptBytes > limits.maxTotalConceptBytes) {
      collector.add(createDiagnostic("VAULT-BOUNDS", "/bookie.yaml"));
      collector.markIncomplete();
      reachedBound = true;
      break;
    }

    const loaded = loadConcept(read.bytes, {
      file: sourcePath,
      maxBytes: limits.maxConceptBytes,
      maxDepth: limits.maxYamlDepth,
    });
    if (!loaded.ok) {
      for (const diagnostic of loaded.diagnostics) {
        collector.add(mapConceptDiagnostic(diagnostic, sourcePath));
      }
      if (
        loaded.diagnostics.some(
          (diagnostic) =>
            diagnostic.code === "CONCEPT-SIZE" ||
            diagnostic.code === "YAML-UNSUPPORTED",
        )
      ) {
        collector.markIncomplete();
      }
      reject(sourcePath, undefined);
      continue;
    }

    const frontmatter = loaded.concept.frontmatter;
    const displayFile = displayFileFor(
      sourcePath,
      frontmatter,
      manifestState.excludedSensitivityClasses,
    );
    if (displayFile === "<excluded>") {
      redactedPaths.add(sourcePath);
      addRedactedReferences(frontmatter, redactedPaths);
    }
    const bookie = isObject(frontmatter.bookie)
      ? frontmatter.bookie
      : undefined;
    const type = frontmatter.type;
    if (bookie === undefined) {
      if (typeof type !== "string" || type.length === 0) {
        collector.add(
          createDiagnostic("CONCEPT-SCHEMA", displayFile, {
            instancePath: "/type",
            keyword: typeof type === "string" ? "minLength" : "required",
          }),
        );
        reject(sourcePath, frontmatter);
      }
      continue;
    }
    if (insideEvidenceRoot) {
      collector.add(createDiagnostic("CONCEPT-PATH", displayFile));
      reject(sourcePath, frontmatter);
      continue;
    }
    if (typeof type !== "string") {
      collector.add(
        createDiagnostic("CONCEPT-SCHEMA", displayFile, {
          instancePath: "/type",
          keyword: "required",
        }),
      );
      reject(sourcePath, frontmatter);
      continue;
    }
    const validate = validators.byType.get(type);
    if (validate === undefined) {
      collector.add(createDiagnostic("CONCEPT-SCHEMA", displayFile));
      reject(sourcePath, frontmatter);
      continue;
    }
    if (!validate(frontmatter)) {
      addSchemaDiagnostics(collector, displayFile, validate.errors);
      reject(sourcePath, frontmatter);
      continue;
    }
    if (!manifest.allowed_concept_types.includes(type)) {
      collector.add(createDiagnostic("TYPE-ALLOWED", displayFile));
      reject(sourcePath, frontmatter);
      continue;
    }
    if (
      !validators.conceptPathPattern.test(sourcePath) ||
      sourcePath
        .slice(1)
        .split("/")
        .some((segment) => segment.toLowerCase() === ".git")
    ) {
      collector.add(createDiagnostic("CONCEPT-PATH", displayFile));
      reject(sourcePath, frontmatter);
      continue;
    }

    const uid = bookie.uid as string;
    const uidEntry = { displayFile };
    const existingUid = uidFiles.get(uid);
    if (existingUid === undefined) {
      uidFiles.set(uid, uidEntry);
    } else if (Array.isArray(existingUid)) {
      existingUid.push(uidEntry);
    } else {
      uidFiles.set(uid, [existingUid, uidEntry]);
    }
    if (
      type === "Evidence" &&
      typeof frontmatter.resource === "string" &&
      frontmatter.resource.startsWith("/")
    ) {
      evidenceResourceFiles.add(frontmatter.resource.slice(1));
    }

    const sensitivity =
      typeof bookie.sensitivity === "string" ? bookie.sensitivity : null;
    const classification = sensitivityClassification(sensitivity, manifest);
    const concept: ScannedQueryConcept = {
      sourcePath,
      sourceBytes: read.bytes,
      bodyText: loaded.concept.bodyText,
      type,
      title: frontmatter.title as string,
      uid,
      project: typeof bookie.project === "string" ? bookie.project : null,
      status: frontmatter.status as string,
      state: typeof bookie.state === "string" ? bookie.state : null,
      tags: Array.isArray(frontmatter.tags)
        ? (frontmatter.tags as readonly string[])
        : [],
      sensitivity,
      sensitivityClassification: classification,
      verification: frontmatter.verified === undefined ? "absent" : "present",
      staleAfter:
        typeof frontmatter.stale_after === "string"
          ? frontmatter.stale_after
          : null,
      excluded: classification === "excluded",
    };
    await visit(concept);
  }

  for (const duplicate of uidFiles.values()) {
    if (!Array.isArray(duplicate)) continue;
    for (const entry of duplicate) {
      collector.add(createDiagnostic("UID-UNIQUE", entry.displayFile));
    }
  }

  throwIfAborted(signal);
  const safeToReturn = await verifyTrackedPaths(tracker, signal);
  if (!safeToReturn) {
    collector.add(createDiagnostic("VAULT-IO", "/"));
    collector.markIncomplete();
  }
  collector.redactFiles(redactedPaths);
  return finishedScan(
    root,
    collector,
    rejectedConcepts,
    invalidPaths,
    invalidUids,
    safeToReturn,
    entries.incomplete || reachedBound,
  );
}
