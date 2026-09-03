import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConcept } from "./concept-loader.js";
import type { ConceptSourceHash } from "./concept-mutation-model.js";
import type {
  CanonicalExportSecretPolicy,
  InitialBookieConceptType,
} from "./canonical-export-model.js";
import { throwIfAborted } from "./vault-cancellation.js";
import {
  createDiagnostic,
  DiagnosticCollector,
  mapConceptDiagnostic,
  sanitizeFile,
} from "./vault-diagnostics.js";
import type { VaultDiagnostic } from "./vault-diagnostics.js";
import { isBeneathLiteralPath } from "./vault-filesystem.js";
import {
  expandLocalGitCommitTree,
  GitBatchReader,
  GitBoundsFailure,
  GitFailure,
  readLocalGitCommitRoot,
} from "./vault-git-base.js";
import type { GitEntry, LocalGitCommitRoot } from "./vault-git-base.js";
import { getSchemaValidators } from "./vault-manifest.js";
import { analyzeBoundedMarkdown } from "./vault-markdown.js";
import type {
  BookieCandidate,
  BookieData,
  BookiePolicySource,
  BookieRecord,
  Manifest,
  SchemaError,
  SchemaValidators,
  ValidationLimits,
  VaultEntries,
} from "./vault-model.js";
import {
  validateCandidateIdentity,
  validateCurrentTree,
} from "./vault-policy.js";
import { parseStrictYamlMapping } from "./strict-yaml.js";
import { containsDetectedSecret } from "./vault-secret-detection.js";

const ordinaryModes = new Set(["100644", "100755"]);
const utf8Decoder = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true,
});

export interface ExportSnapshotRecord {
  readonly path: string;
  readonly type: InitialBookieConceptType;
  readonly title: string;
  readonly uid: string;
  readonly sourceHash: ConceptSourceHash;
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly bodyText: string;
  readonly sensitivity: string | null;
  readonly excluded: boolean;
  readonly localTargets: ReadonlySet<string>;
}

export interface ExportSnapshotResult {
  readonly root: string;
  readonly sourceCommit?: string;
  readonly records: readonly ExportSnapshotRecord[];
  readonly valid: boolean;
  readonly complete: boolean;
  readonly sensitivityFailure: boolean;
  readonly diagnostics: readonly VaultDiagnostic[];
  readonly diagnosticsTruncated: boolean;
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rootLabel(root: unknown): string {
  try {
    if (typeof root !== "string" && !(root instanceof URL)) return "<invalid>";
    return resolve(root instanceof URL ? fileURLToPath(root) : root);
  } catch {
    return "<invalid>";
  }
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

function excludedSensitivityClasses(
  value: Readonly<Record<string, unknown>>,
): readonly string[] {
  const policy = isObject(value.policy) ? value.policy : undefined;
  const sensitivity =
    policy !== undefined && isObject(policy.sensitivity)
      ? policy.sensitivity
      : undefined;
  return Array.isArray(sensitivity?.excluded_classes)
    ? sensitivity.excluded_classes.filter(
        (item): item is string => typeof item === "string",
      )
    : [];
}

function parseManifest(
  bytes: Uint8Array,
  limits: ValidationLimits,
  validators: SchemaValidators,
  collector: DiagnosticCollector,
): {
  readonly manifest?: Manifest;
  readonly excludedClasses: readonly string[];
} {
  let source: string;
  try {
    source = utf8Decoder.decode(bytes);
  } catch {
    collector.add(createDiagnostic("MANIFEST-SYNTAX", "/bookie.yaml"));
    collector.markIncomplete();
    return { excludedClasses: [] };
  }
  const parsed = parseStrictYamlMapping(source, limits.maxYamlDepth);
  if (!parsed.ok) {
    collector.add(createDiagnostic("MANIFEST-SYNTAX", "/bookie.yaml"));
    collector.markIncomplete();
    return { excludedClasses: [] };
  }
  const excludedClasses = excludedSensitivityClasses(parsed.value);
  if (!validators.manifest(parsed.value)) {
    addSchemaDiagnostics(
      collector,
      "MANIFEST-SCHEMA",
      "/bookie.yaml",
      validators.manifest.errors,
    );
    collector.markIncomplete();
    return { excludedClasses };
  }
  return {
    manifest: parsed.value as unknown as Manifest,
    excludedClasses,
  };
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

function addRedactedReferences(
  path: string,
  frontmatter: Readonly<Record<string, unknown>>,
  redactedPaths: Set<string>,
): void {
  const add = (value: unknown): void => {
    if (typeof value === "string" && value.startsWith("/")) {
      redactedPaths.add(sanitizeFile(posix.normalize(value)));
    }
  };
  redactedPaths.add(path);
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

function containsGitMetadataSegment(path: string): boolean {
  return path.split("/").some((segment) => segment.toLowerCase() === ".git");
}

function treeIsOrdinary(entries: readonly GitEntry[]): boolean {
  return entries.every(
    (entry) =>
      !containsGitMetadataSegment(entry.path) &&
      ((entry.type === "tree" && entry.mode === "040000") ||
        (entry.type === "blob" && ordinaryModes.has(entry.mode))),
  );
}

function localLinkTarget(
  destination: string,
  sourcePath: string,
): string | undefined | null {
  if (
    destination === "" ||
    destination.startsWith("#") ||
    destination.startsWith("?") ||
    destination.startsWith("//") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(destination)
  ) {
    return undefined;
  }
  const encodedPath = destination.split(/[?#]/u, 1)[0] ?? "";
  if (encodedPath === "") return undefined;
  if (/%(?:2f|5c)/iu.test(encodedPath)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(encodedPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return null;

  const virtualRoot = "/__bookie_vault__";
  const source = `${virtualRoot}${sourcePath}`;
  const target = decoded.startsWith("/")
    ? posix.resolve(virtualRoot, `.${decoded}`)
    : posix.resolve(posix.dirname(source), decoded);
  if (target !== virtualRoot && !target.startsWith(`${virtualRoot}/`)) {
    return null;
  }
  return target.slice(virtualRoot.length + 1).replace(/\/$/u, "");
}

async function validateSnapshotMarkdownLinks(
  body: string,
  sourcePath: string,
  displayFile: string,
  entries: VaultEntries,
  collector: DiagnosticCollector,
  signal: AbortSignal | undefined,
  localTargets: Set<string>,
  redactedPaths: Set<string>,
): Promise<void> {
  const analysis = await analyzeBoundedMarkdown(body, signal);
  if (analysis === undefined) {
    collector.add(createDiagnostic("MARKDOWN-LINK", displayFile));
    collector.markIncomplete();
    return;
  }
  for (const destination of analysis.destinations) {
    const target = localLinkTarget(destination, sourcePath);
    if (target === undefined) continue;
    if (typeof target === "string") {
      const bundleTarget = `/${target}`;
      localTargets.add(bundleTarget);
      if (displayFile === "<excluded>") redactedPaths.add(bundleTarget);
    }
    if (
      target === null ||
      (!entries.regularFiles.has(target) && !entries.directories.has(target))
    ) {
      collector.add(createDiagnostic("MARKDOWN-LINK", displayFile));
    }
  }
}

function sourceHash(bytes: Uint8Array): ConceptSourceHash {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function asBookieData(
  frontmatter: Readonly<Record<string, unknown>>,
): BookieData {
  return frontmatter.bookie as unknown as BookieData;
}

async function validateEvidenceResources(
  sources: readonly BookiePolicySource[],
  manifest: Manifest,
  files: ReadonlyMap<string, GitEntry>,
  limits: ValidationLimits,
  batch: GitBatchReader,
  collector: DiagnosticCollector,
  signal: AbortSignal | undefined,
): Promise<void> {
  const cache = new Map<
    string,
    { readonly ok: true; readonly digest: string } | { readonly ok: false }
  >();
  let totalResourceBytes = 0;
  for (const evidence of sources.filter(
    (source) => source.type === "Evidence",
  )) {
    throwIfAborted(signal);
    const resource = evidence.frontmatter.resource;
    if (typeof resource !== "string" || !resource.startsWith("/")) continue;
    const relativePath = resource.slice(1);
    const entry = files.get(relativePath);
    if (
      entry?.size === undefined ||
      !ordinaryModes.has(entry.mode) ||
      !isBeneathLiteralPath(relativePath, manifest.policy.evidence_roots) ||
      entry.size > manifest.policy.attachment_max_bytes
    ) {
      collector.add(
        createDiagnostic("EVIDENCE-RESOURCE", evidence.displayFile),
      );
      continue;
    }

    let cached = cache.get(relativePath);
    if (cached === undefined) {
      const remaining = limits.maxTotalResourceBytes - totalResourceBytes;
      if (entry.size > remaining) {
        collector.add(createDiagnostic("VAULT-BOUNDS", "/bookie.yaml"));
        collector.markIncomplete();
        cached = { ok: false };
      } else {
        const digest = await batch.hash(
          entry.oid,
          entry.size,
          Math.min(manifest.policy.attachment_max_bytes, remaining),
        );
        totalResourceBytes += entry.size;
        cached = { ok: true, digest };
      }
      cache.set(relativePath, cached);
    }

    if (!cached.ok) {
      collector.add(
        createDiagnostic("EVIDENCE-RESOURCE", evidence.displayFile),
      );
    } else if (
      typeof evidence.bookie.sha256 === "string" &&
      evidence.bookie.sha256 !== cached.digest
    ) {
      collector.add(createDiagnostic("EVIDENCE-DIGEST", evidence.displayFile));
    }
  }
}

interface IdentityMatcherNode {
  readonly next: Map<string, number>;
  failure: number;
  terminal: boolean;
}

class IdentityMatcher {
  readonly #nodes: IdentityMatcherNode[] = [
    { next: new Map(), failure: 0, terminal: false },
  ];

  constructor(identities: ReadonlySet<string>) {
    for (const identity of identities) {
      let state = 0;
      for (const character of identity) {
        const existing = this.#nodes[state]?.next.get(character);
        if (existing !== undefined) {
          state = existing;
          continue;
        }
        const next = this.#nodes.length;
        this.#nodes.push({ next: new Map(), failure: 0, terminal: false });
        this.#nodes[state]?.next.set(character, next);
        state = next;
      }
      const node = this.#nodes[state];
      if (node !== undefined) node.terminal = true;
    }

    const queue: number[] = [];
    for (const child of this.#nodes[0]?.next.values() ?? []) queue.push(child);
    for (let index = 0; index < queue.length; index += 1) {
      const state = queue[index];
      const node = state === undefined ? undefined : this.#nodes[state];
      if (node === undefined) continue;
      for (const [character, child] of node.next) {
        queue.push(child);
        let fallback = node.failure;
        while (fallback !== 0 && !this.#nodes[fallback]?.next.has(character)) {
          fallback = this.#nodes[fallback]?.failure ?? 0;
        }
        const failure = this.#nodes[fallback]?.next.get(character);
        const childNode = this.#nodes[child];
        if (childNode !== undefined) {
          childNode.failure = failure === child ? 0 : (failure ?? 0);
          childNode.terminal ||=
            this.#nodes[childNode.failure]?.terminal === true;
        }
      }
    }
  }

  matches(value: string): boolean {
    let state = 0;
    for (const character of value) {
      while (state !== 0 && !this.#nodes[state]?.next.has(character)) {
        state = this.#nodes[state]?.failure ?? 0;
      }
      state = this.#nodes[state]?.next.get(character) ?? 0;
      if (this.#nodes[state]?.terminal === true) return true;
    }
    return false;
  }
}

function valueContainsIdentity(
  value: unknown,
  matcher: IdentityMatcher,
): boolean {
  if (typeof value === "string") return matcher.matches(value);
  if (Array.isArray(value)) {
    return value.some((item) => valueContainsIdentity(item, matcher));
  }
  if (!isObject(value)) return false;
  return Object.entries(value).some(
    ([key, child]) =>
      matcher.matches(key) || valueContainsIdentity(child, matcher),
  );
}

function failedResult(
  root: string,
  collector: DiagnosticCollector,
  sourceCommit?: string,
): ExportSnapshotResult {
  const diagnostics = collector.finish();
  return {
    root,
    ...(sourceCommit === undefined ? {} : { sourceCommit }),
    records: Object.freeze([]),
    valid: false,
    complete: false,
    sensitivityFailure: false,
    diagnostics,
    diagnosticsTruncated: collector.diagnosticsTruncated,
  };
}

export async function scanGitCommitForExport(
  rootInput: string | URL,
  sourceRef: string,
  secretPolicy: CanonicalExportSecretPolicy,
  limits: ValidationLimits,
  signal: AbortSignal | undefined,
): Promise<ExportSnapshotResult> {
  const collector = new DiagnosticCollector(limits.maxDiagnostics);
  throwIfAborted(signal);
  let unresolvedRoot: string;
  try {
    unresolvedRoot = resolve(
      rootInput instanceof URL ? fileURLToPath(rootInput) : rootInput,
    );
  } catch {
    collector.add(createDiagnostic("VAULT-ROOT", "/"));
    collector.markIncomplete();
    return failedResult("<invalid>", collector);
  }
  let root: string;
  try {
    root = await realpath(unresolvedRoot);
    if (!(await stat(root)).isDirectory()) throw new Error("not a directory");
  } catch {
    throwIfAborted(signal);
    collector.add(createDiagnostic("VAULT-ROOT", "/"));
    collector.markIncomplete();
    return failedResult(rootLabel(rootInput), collector);
  }

  throwIfAborted(signal);
  let sourceCommit: string | undefined;
  let source: LocalGitCommitRoot;
  try {
    source = await readLocalGitCommitRoot(
      root,
      sourceRef,
      limits.maxEntries,
      signal,
    );
    sourceCommit = source.commit;
  } catch (error) {
    throwIfAborted(signal);
    if (!(error instanceof GitFailure)) throw error;
    collector.add(
      createDiagnostic(
        error instanceof GitBoundsFailure ? "VAULT-BOUNDS" : "EXPORT-SOURCE",
        "/bookie.yaml",
      ),
    );
    collector.markIncomplete();
    return failedResult(root, collector, sourceCommit);
  }

  const rawFiles = new Map(
    source.entries
      .filter((entry) => entry.type === "blob")
      .map((entry) => [entry.path, entry]),
  );
  const manifestEntry = rawFiles.get("bookie.yaml");
  if (manifestEntry?.size === undefined) {
    collector.add(createDiagnostic("MANIFEST-MISSING", "/bookie.yaml"));
    collector.markIncomplete();
    return failedResult(root, collector, sourceCommit);
  }
  if (
    !ordinaryModes.has(manifestEntry.mode) ||
    manifestEntry.size > limits.maxManifestBytes
  ) {
    collector.add(
      createDiagnostic(
        manifestEntry.size > limits.maxManifestBytes
          ? "MANIFEST-SIZE"
          : "EXPORT-SOURCE",
        "/bookie.yaml",
      ),
    );
    collector.markIncomplete();
    return failedResult(root, collector, sourceCommit);
  }

  const batch = new GitBatchReader(root, signal);
  try {
    const validators = await getSchemaValidators();
    const manifestBytes = await batch.bytes(
      manifestEntry.oid,
      manifestEntry.size,
      limits.maxManifestBytes,
    );
    const manifestState = parseManifest(
      manifestBytes,
      limits,
      validators,
      collector,
    );
    const manifest = manifestState.manifest;
    if (manifest === undefined) {
      await batch.finish();
      return failedResult(root, collector, sourceCommit);
    }

    const active = await expandLocalGitCommitTree(
      root,
      source,
      limits.maxEntries,
      manifest.policy.exclude,
      signal,
    );
    if (!treeIsOrdinary(active)) {
      collector.add(createDiagnostic("EXPORT-SOURCE", "/bookie.yaml"));
      collector.markIncomplete();
      await batch.finish();
      return failedResult(root, collector, sourceCommit);
    }
    const files = new Map(
      active
        .filter((entry) => entry.type === "blob")
        .map((entry) => [entry.path, entry]),
    );
    const directories = new Set([
      "",
      ...active
        .filter((entry) => entry.type === "tree")
        .map((entry) => entry.path),
    ]);
    const markdownEntries = [...files.values()]
      .filter((entry) => entry.path.endsWith(".md"))
      .sort((left, right) =>
        left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
      );
    const entries: VaultEntries = {
      regularFiles: new Set(files.keys()),
      directories,
      markdownFiles: markdownEntries.map((entry) => entry.path),
      incomplete: false,
      unsafeEntries: false,
    };

    const indexEntry = files.get("index.md");
    if (indexEntry?.size === undefined) {
      collector.add(
        createDiagnostic("CONCEPT-SCHEMA", "/index.md", {
          instancePath: "/okf_version",
          keyword: "required",
        }),
      );
      await batch.finish();
      const diagnostics = collector.finish();
      return {
        root,
        sourceCommit,
        records: Object.freeze([]),
        valid: false,
        complete: collector.complete,
        sensitivityFailure: false,
        diagnostics,
        diagnosticsTruncated: collector.diagnosticsTruncated,
      };
    }
    if (indexEntry.size > limits.maxConceptBytes) {
      collector.add(
        mapConceptDiagnostic(
          {
            code: "CONCEPT-SIZE",
            severity: "error",
            file: "/index.md",
            message: "Concept exceeds the configured byte limit.",
            remediation: "Reduce the concept size below the configured limit.",
          },
          "/index.md",
        ),
      );
      collector.markIncomplete();
      await batch.finish();
      return failedResult(root, collector, sourceCommit);
    }
    const indexBytes = await batch.bytes(
      indexEntry.oid,
      indexEntry.size,
      limits.maxConceptBytes,
    );
    let totalConceptBytes = indexBytes.byteLength;
    if (totalConceptBytes > limits.maxTotalConceptBytes) {
      collector.add(createDiagnostic("VAULT-BOUNDS", "/bookie.yaml"));
      collector.markIncomplete();
      await batch.finish();
      return failedResult(root, collector, sourceCommit);
    }
    const loadedIndex = loadConcept(indexBytes, {
      file: "/index.md",
      maxBytes: limits.maxConceptBytes,
      maxDepth: limits.maxYamlDepth,
    });
    if (!loadedIndex.ok) {
      for (const diagnostic of loadedIndex.diagnostics) {
        collector.add(mapConceptDiagnostic(diagnostic, "/index.md"));
      }
      if (
        loadedIndex.diagnostics.some(
          (diagnostic) => diagnostic.code === "YAML-UNSUPPORTED",
        )
      ) {
        collector.markIncomplete();
      }
    } else {
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
      }
      await validateSnapshotMarkdownLinks(
        loadedIndex.concept.bodyText,
        "/index.md",
        "/index.md",
        entries,
        collector,
        signal,
        new Set(),
        new Set(),
      );
    }

    const candidates: BookieCandidate[] = [];
    const records: BookieRecord[] = [];
    const policySources: BookiePolicySource[] = [];
    const exportRecords: ExportSnapshotRecord[] = [];
    const evidenceResourceFiles = new Set<string>();
    const redactedPaths = new Set<string>();
    const orderedMarkdown = [
      ...markdownEntries.filter(
        (entry) =>
          entry.path !== "index.md" &&
          !isBeneathLiteralPath(entry.path, manifest.policy.evidence_roots),
      ),
      ...markdownEntries.filter(
        (entry) =>
          entry.path !== "index.md" &&
          isBeneathLiteralPath(entry.path, manifest.policy.evidence_roots),
      ),
    ];
    let conceptCount = 0;
    let reachedBound = false;

    for (const entry of orderedMarkdown) {
      throwIfAborted(signal);
      const insideEvidenceRoot = isBeneathLiteralPath(
        entry.path,
        manifest.policy.evidence_roots,
      );
      if (insideEvidenceRoot && evidenceResourceFiles.has(entry.path)) continue;
      if (entry.size === undefined || entry.size > limits.maxConceptBytes) {
        collector.add(
          mapConceptDiagnostic(
            {
              code: "CONCEPT-SIZE",
              severity: "error",
              file: `/${entry.path}`,
              message: "Concept exceeds the configured byte limit.",
              remediation:
                "Reduce the concept size below the configured limit.",
            },
            `/${entry.path}`,
          ),
        );
        collector.markIncomplete();
        continue;
      }
      totalConceptBytes += entry.size;
      if (totalConceptBytes > limits.maxTotalConceptBytes) {
        collector.add(createDiagnostic("VAULT-BOUNDS", "/bookie.yaml"));
        collector.markIncomplete();
        reachedBound = true;
        break;
      }

      const sourcePath = `/${entry.path}`;
      const bytes = await batch.bytes(
        entry.oid,
        entry.size,
        limits.maxConceptBytes,
      );
      const name = entry.path.split("/").at(-1);
      if (name === "index.md" || name === "log.md") {
        let body: string;
        try {
          body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          collector.add(
            mapConceptDiagnostic(
              {
                code: "CONCEPT-UTF8",
                severity: "error",
                file: sourcePath,
                message: "Concept is not valid UTF-8.",
                remediation: "Save the complete Markdown file as valid UTF-8.",
              },
              sourcePath,
            ),
          );
          continue;
        }
        await validateSnapshotMarkdownLinks(
          body,
          sourcePath,
          sourcePath,
          entries,
          collector,
          signal,
          new Set(),
          redactedPaths,
        );
        continue;
      }

      conceptCount += 1;
      if (conceptCount > limits.maxConcepts) {
        collector.add(createDiagnostic("VAULT-BOUNDS", "/bookie.yaml"));
        collector.markIncomplete();
        reachedBound = true;
        break;
      }
      const loaded = loadConcept(bytes, {
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
        continue;
      }

      const frontmatter = loaded.concept.frontmatter;
      const displayFile = displayFileFor(
        sourcePath,
        frontmatter,
        manifestState.excludedClasses,
      );
      if (displayFile === "<excluded>") {
        addRedactedReferences(sourcePath, frontmatter, redactedPaths);
      }
      const localTargets = new Set<string>();
      await validateSnapshotMarkdownLinks(
        loaded.concept.bodyText,
        sourcePath,
        displayFile,
        entries,
        collector,
        signal,
        localTargets,
        redactedPaths,
      );

      const type = frontmatter.type;
      const bookieValue = isObject(frontmatter.bookie)
        ? frontmatter.bookie
        : undefined;
      if (bookieValue === undefined) {
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
        path: sourcePath,
        displayFile,
        ...(typeof type === "string" ? { type } : {}),
        ...(typeof bookieValue.uid === "string"
          ? { uid: bookieValue.uid }
          : {}),
        ...(typeof bookieValue.profile === "string"
          ? { profile: bookieValue.profile }
          : {}),
      });
      if (insideEvidenceRoot) {
        collector.add(createDiagnostic("CONCEPT-PATH", displayFile));
      }
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
        sourcePath,
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
        frontmatter.resource.startsWith("/") &&
        !insideEvidenceRoot
      ) {
        evidenceResourceFiles.add(frontmatter.resource.slice(1));
      }
      const bookie = asBookieData(frontmatter);
      const record: BookieRecord = {
        path: sourcePath,
        displayFile,
        type,
        status: frontmatter.status as string,
        frontmatter,
        bookie,
      };
      records.push(record);
      policySources.push(record);
      const sensitivity =
        typeof bookie.sensitivity === "string" ? bookie.sensitivity : null;
      exportRecords.push({
        path: sourcePath,
        type: type as InitialBookieConceptType,
        title: frontmatter.title as string,
        uid: bookie.uid,
        sourceHash: sourceHash(bytes),
        frontmatter,
        bodyText: loaded.concept.bodyText,
        sensitivity,
        excluded:
          sensitivity !== null &&
          manifest.policy.sensitivity.excluded_classes.includes(sensitivity),
        localTargets,
      });
    }

    validateCandidateIdentity(candidates, manifest, validators, collector);
    await validateCurrentTree(records, collector, signal, policySources);
    await validateEvidenceResources(
      policySources,
      manifest,
      files,
      limits,
      batch,
      collector,
      signal,
    );
    throwIfAborted(signal);

    const excludedIdentities = new Set<string>();
    const excludedPaths = new Set<string>();
    for (const record of exportRecords.filter((record) => record.excluded)) {
      excludedIdentities.add(record.uid);
      excludedIdentities.add(record.path);
      excludedPaths.add(record.path);
      const resource = record.frontmatter.resource;
      if (typeof resource === "string" && resource.startsWith("/")) {
        excludedIdentities.add(resource);
        excludedPaths.add(resource);
      }
    }
    const includedRecords = exportRecords.filter((record) => !record.excluded);
    let sensitivityFailure = includedRecords.some(
      (record) =>
        record.sensitivity === null ||
        !manifest.policy.sensitivity.classes.includes(record.sensitivity),
    );
    if (
      !sensitivityFailure &&
      excludedIdentities.size > 0 &&
      includedRecords.length > 0
    ) {
      const matcher = new IdentityMatcher(excludedIdentities);
      sensitivityFailure = includedRecords.some(
        (record) =>
          matcher.matches(record.path) ||
          valueContainsIdentity(record.frontmatter, matcher) ||
          matcher.matches(record.bodyText) ||
          (record.localTargets.size > 0 &&
            [...record.localTargets].some((target) =>
              excludedPaths.has(target),
            )),
      );
    }
    if (sensitivityFailure) {
      collector.add(createDiagnostic("EXPORT-SENSITIVITY", "<unclassified>"));
    } else if (
      secretPolicy === "reject-detected" &&
      includedRecords.some((record) =>
        containsDetectedSecret({
          schema_version: "1.0",
          source_commit: sourceCommit,
          source_hash: record.sourceHash,
          profile: "1.0",
          uid: record.uid,
          path: record.path,
          type: record.type,
          title: record.title,
          frontmatter: record.frontmatter,
          body_markdown: record.bodyText,
        }),
      )
    ) {
      collector.add(createDiagnostic("EXPORT-SECRET", "<redacted>"));
    }

    collector.redactFiles(redactedPaths);
    await batch.finish();
    throwIfAborted(signal);
    const diagnostics = collector.finish();
    const complete = collector.complete && !reachedBound;
    return {
      root,
      sourceCommit,
      records: Object.freeze(exportRecords),
      valid: complete && diagnostics.length === 0,
      complete,
      sensitivityFailure,
      diagnostics,
      diagnosticsTruncated: collector.diagnosticsTruncated,
    };
  } catch (error) {
    await batch.abort();
    throwIfAborted(signal);
    if (!(error instanceof GitFailure)) throw error;
    collector.add(
      createDiagnostic(
        error instanceof GitBoundsFailure ? "VAULT-BOUNDS" : "EXPORT-SOURCE",
        "/bookie.yaml",
      ),
    );
    collector.markIncomplete();
    return failedResult(root, collector, sourceCommit);
  }
}
