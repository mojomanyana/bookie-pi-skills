import { Buffer } from "node:buffer";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_MAX_CONCEPT_BYTES,
  DEFAULT_MAX_YAML_DEPTH,
} from "./concept-loader.js";
import {
  computeConceptSourceHash,
  hasLoneSurrogate,
} from "./concept-mutation-model.js";
import type {
  FilesystemConceptSignals,
  FilesystemConceptSource,
  FilesystemQueryOptions,
  FilesystemSearchFilters,
  FilesystemSearchHit,
  InspectConceptFailure,
  InspectConceptOptions,
  InspectConceptResult,
  InspectConceptSelector,
  InspectConceptSuccess,
  SearchVaultOptions,
  SearchVaultRequest,
  SearchVaultResult,
} from "./filesystem-query-model.js";
import { throwIfAborted } from "./vault-cancellation.js";
import { compareText, createDiagnostic } from "./vault-diagnostics.js";
import type { VaultDiagnostic } from "./vault-diagnostics.js";
import type { ValidationLimits } from "./vault-model.js";
import {
  DEFAULT_MAX_MANIFEST_BYTES,
  DEFAULT_MAX_TOTAL_CONCEPT_BYTES,
  DEFAULT_MAX_VAULT_CONCEPTS,
  DEFAULT_MAX_VAULT_DIAGNOSTICS,
  DEFAULT_MAX_VAULT_ENTRIES,
} from "./vault-validator.js";
import {
  scanVaultForQuery,
  type ScannedQueryConcept,
} from "./vault-query-scan.js";

export const MAX_FILESYSTEM_QUERY_BYTES = 4_096;
export const DEFAULT_MAX_SEARCH_RESULTS = 50;
export const DEFAULT_MAX_SEARCH_EXCERPT_BYTES = 1_024;
export const DEFAULT_MAX_SEARCH_TEXT_BYTES = 32_768;
export const DEFAULT_MAX_INSPECT_CONTENT_BYTES = DEFAULT_MAX_CONCEPT_BYTES;

const filterNames = [
  "type",
  "project",
  "status",
  "state",
  "sensitivity",
  "tag",
] as const;
const requestNames = new Set(["query", "filters"]);
const filterNameSet = new Set<string>(filterNames);
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

interface QueryLimits {
  readonly validation: ValidationLimits;
  readonly maxResults: number;
  readonly maxExcerptBytes: number;
  readonly maxTotalTextBytes: number;
}

interface PendingHit {
  readonly source: FilesystemConceptSource;
  readonly signals: FilesystemConceptSignals;
  readonly sourcePath: string;
  readonly matchedField: "title" | "body";
  readonly title: string;
  readonly titleTruncated: boolean;
  readonly excerpt: string;
  readonly excerptTruncated: boolean;
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

function validationLimits(options: FilesystemQueryOptions): ValidationLimits {
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
    // Query classifies resource paths from descriptors but never reads bytes.
    maxTotalResourceBytes: 1,
    maxDiagnostics: positiveLimit(
      "maxDiagnostics",
      options.maxDiagnostics,
      DEFAULT_MAX_VAULT_DIAGNOSTICS,
    ),
  };
}

function queryLimits(options: SearchVaultOptions): QueryLimits {
  return {
    validation: validationLimits(options),
    maxResults: positiveLimit(
      "maxResults",
      options.maxResults,
      DEFAULT_MAX_SEARCH_RESULTS,
    ),
    maxExcerptBytes: positiveLimit(
      "maxExcerptBytes",
      options.maxExcerptBytes,
      DEFAULT_MAX_SEARCH_EXCERPT_BYTES,
    ),
    maxTotalTextBytes: positiveLimit(
      "maxTotalTextBytes",
      options.maxTotalTextBytes,
      DEFAULT_MAX_SEARCH_TEXT_BYTES,
    ),
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateScalar(name: string, value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    hasLoneSurrogate(value) ||
    Buffer.byteLength(value, "utf8") > MAX_FILESYSTEM_QUERY_BYTES
  ) {
    throw new TypeError(
      `${name} must be a non-empty Unicode string of at most ${MAX_FILESYSTEM_QUERY_BYTES} UTF-8 bytes`,
    );
  }
}

function validateSearchRequest(
  request: SearchVaultRequest,
): FilesystemSearchFilters {
  if (!isRecord(request)) throw new TypeError("request must be an object");
  if (Object.keys(request).some((name) => !requestNames.has(name))) {
    throw new TypeError("request contains an unsupported field");
  }
  validateScalar("query", request.query);
  if (request.filters === undefined) return {};
  if (!isRecord(request.filters)) {
    throw new TypeError("filters must be an object");
  }
  if (Object.keys(request.filters).some((name) => !filterNameSet.has(name))) {
    throw new TypeError("filters contain an unsupported field");
  }
  for (const name of filterNames) {
    const value = request.filters[name];
    if (value !== undefined) validateScalar(`filters.${name}`, value);
  }
  return request.filters;
}

function validateRoot(root: unknown): asserts root is string | URL {
  if (typeof root !== "string" && !(root instanceof URL)) {
    throw new TypeError("root must be a filesystem path or file URL");
  }
}

function truncateUtf8Prefix(
  value: string,
  maximumBytes: number,
): {
  readonly value: string;
  readonly byteLength: number;
  readonly truncated: boolean;
} {
  const bytes = encoder.encode(value);
  if (bytes.byteLength <= maximumBytes) {
    return { value, byteLength: bytes.byteLength, truncated: false };
  }
  let end = maximumBytes;
  while (
    end > 0 &&
    end < bytes.byteLength &&
    ((bytes[end] ?? 0) & 0xc0) === 0x80
  ) {
    end -= 1;
  }
  const truncated = decoder.decode(bytes.subarray(0, end));
  return { value: truncated, byteLength: end, truncated: true };
}

function excerptAt(
  value: string,
  matchIndex: number,
  query: string,
  maximumBytes: number,
): { readonly value: string; readonly truncated: boolean } {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) {
    return { value, truncated: false };
  }
  let windowStart = Math.max(0, matchIndex - maximumBytes);
  if (
    windowStart > 0 &&
    value.charCodeAt(windowStart) >= 0xdc00 &&
    value.charCodeAt(windowStart) <= 0xdfff
  ) {
    windowStart += 1;
  }
  let windowEnd = Math.min(
    value.length,
    matchIndex + query.length + maximumBytes,
  );
  if (
    windowEnd < value.length &&
    value.charCodeAt(windowEnd - 1) >= 0xd800 &&
    value.charCodeAt(windowEnd - 1) <= 0xdbff
  ) {
    windowEnd -= 1;
  }
  const window = value.slice(windowStart, windowEnd);
  const points = Array.from(window);
  const matchPoint = Array.from(value.slice(windowStart, matchIndex)).length;
  const queryPoints = Array.from(query);
  let start = matchPoint;
  let end = Math.min(points.length, matchPoint + queryPoints.length);
  let selected = points.slice(start, end).join("");
  if (Buffer.byteLength(selected, "utf8") > maximumBytes) {
    return {
      value: truncateUtf8Prefix(selected, maximumBytes).value,
      truncated: true,
    };
  }
  while (start > 0 || end < points.length) {
    let changed = false;
    if (start > 0) {
      const candidate = points.slice(start - 1, end).join("");
      if (Buffer.byteLength(candidate, "utf8") <= maximumBytes) {
        start -= 1;
        selected = candidate;
        changed = true;
      }
    }
    if (end < points.length) {
      const candidate = points.slice(start, end + 1).join("");
      if (Buffer.byteLength(candidate, "utf8") <= maximumBytes) {
        end += 1;
        selected = candidate;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return { value: selected, truncated: true };
}

function matchesFilters(
  concept: ScannedQueryConcept,
  filters: FilesystemSearchFilters,
): boolean {
  return (
    (filters.type === undefined || concept.type === filters.type) &&
    (filters.project === undefined || concept.project === filters.project) &&
    (filters.status === undefined || concept.status === filters.status) &&
    (filters.state === undefined || concept.state === filters.state) &&
    (filters.sensitivity === undefined ||
      concept.sensitivity === filters.sensitivity) &&
    (filters.tag === undefined || concept.tags.includes(filters.tag))
  );
}

function sourceFor(concept: ScannedQueryConcept): FilesystemConceptSource {
  return Object.freeze({
    path: concept.sourcePath,
    state: "working-tree",
    commit: null,
    sourceHash: computeConceptSourceHash(concept.sourceBytes),
  });
}

function signalsFor(concept: ScannedQueryConcept): FilesystemConceptSignals {
  return {
    type: concept.type,
    uid: concept.uid,
    project: concept.project,
    status: concept.status,
    state: concept.state,
    sensitivity: Object.freeze({
      value: concept.sensitivity,
      classification: concept.sensitivityClassification,
    }),
    verification: concept.verification,
    staleAfter: concept.staleAfter,
    untrusted: true,
  };
}

function rootLabel(root: string | URL): string {
  try {
    return resolve(root instanceof URL ? fileURLToPath(root) : root);
  } catch {
    return "<invalid>";
  }
}

function selectorValue(
  selector: InspectConceptSelector,
):
  | { readonly kind: "path"; readonly value: string }
  | { readonly kind: "uid"; readonly value: string }
  | undefined {
  if (!isRecord(selector)) return undefined;
  const keys = Object.keys(selector);
  if (keys.length !== 1) return undefined;
  if (keys[0] === "uid" && typeof selector.uid === "string") {
    return /^[A-Z]{3}-[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(selector.uid)
      ? { kind: "uid", value: selector.uid }
      : undefined;
  }
  if (keys[0] !== "path" || typeof selector.path !== "string") {
    return undefined;
  }
  const path = selector.path;
  if (
    path.length === 0 ||
    !path.startsWith("/") ||
    path.startsWith("//") ||
    !path.endsWith(".md") ||
    path.includes("\\") ||
    path.includes(":") ||
    path.includes("%") ||
    path.includes("?") ||
    path.includes("#") ||
    hasLoneSurrogate(path) ||
    Buffer.byteLength(path, "utf8") > 4_097
  ) {
    return undefined;
  }
  const segments = path.slice(1).split("/");
  const name = segments.at(-1);
  if (
    name === ".md" ||
    name === "index.md" ||
    name === "log.md" ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        segment.toLowerCase() === ".git" ||
        Buffer.byteLength(segment, "utf8") > 255 ||
        [...segment].some((character) => {
          const codePoint = character.codePointAt(0) ?? 0;
          return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
        }),
    )
  ) {
    return undefined;
  }
  return { kind: "path", value: path };
}

function withDiagnostic(
  diagnostics: readonly VaultDiagnostic[],
  diagnostic: VaultDiagnostic,
): readonly VaultDiagnostic[] {
  return Object.freeze(
    [...diagnostics, diagnostic].sort(
      (left, right) =>
        compareText(left.file, right.file) ||
        compareText(left.code, right.code),
    ),
  );
}

function inspectFailure(
  root: string,
  reason: InspectConceptFailure["reason"],
  complete: boolean,
  rejectedConcepts: number,
  diagnostics: readonly VaultDiagnostic[],
  diagnosticsTruncated: boolean,
): InspectConceptFailure {
  return {
    ok: false,
    mode: "filesystem",
    root,
    reason,
    rejectedConcepts,
    complete,
    diagnostics,
    diagnosticsTruncated,
  };
}

export async function searchVault(
  root: string | URL,
  request: SearchVaultRequest,
  options: SearchVaultOptions = {},
): Promise<SearchVaultResult> {
  validateRoot(root);
  const limits = queryLimits(options);
  const filters = validateSearchRequest(request);
  throwIfAborted(options.signal);
  const pending: PendingHit[] = [];
  let matchedCount = 0;

  const scan = await scanVaultForQuery({
    rootPath: root,
    limits: limits.validation,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    visit(concept) {
      if (concept.excluded || !matchesFilters(concept, filters)) return;
      const titleIndex = concept.title.indexOf(request.query);
      const bodyIndex = concept.bodyText.indexOf(request.query);
      if (titleIndex === -1 && bodyIndex === -1) return;
      matchedCount += 1;
      const last = pending.at(-1);
      if (
        pending.length === limits.maxResults &&
        last !== undefined &&
        compareText(concept.sourcePath, last.sourcePath) >= 0
      ) {
        return;
      }
      const matchedField = titleIndex === -1 ? "body" : "title";
      const matchedValue =
        matchedField === "title" ? concept.title : concept.bodyText;
      const matchIndex = matchedField === "title" ? titleIndex : bodyIndex;
      const title = truncateUtf8Prefix(concept.title, limits.maxExcerptBytes);
      const excerpt = excerptAt(
        matchedValue,
        matchIndex,
        request.query,
        limits.maxExcerptBytes,
      );
      pending.push({
        source: sourceFor(concept),
        signals: signalsFor(concept),
        sourcePath: concept.sourcePath,
        matchedField,
        title: title.value,
        titleTruncated: title.truncated,
        excerpt: excerpt.value,
        excerptTruncated: excerpt.truncated,
      });
      pending.sort((left, right) =>
        compareText(left.sourcePath, right.sourcePath),
      );
      if (pending.length > limits.maxResults) pending.pop();
    },
  });

  if (!scan.safeToReturn) {
    return {
      mode: "filesystem",
      root: scan.root,
      results: Object.freeze([]),
      matchedCount: 0,
      rejectedConcepts: scan.rejectedConcepts,
      complete: false,
      resultsTruncated: false,
      outputTruncated: false,
      diagnostics: scan.diagnostics,
      diagnosticsTruncated: scan.diagnosticsTruncated,
    };
  }

  let remainingTextBytes = limits.maxTotalTextBytes;
  let outputTruncated = false;
  const results: FilesystemSearchHit[] = [];
  for (const candidate of pending) {
    const title = truncateUtf8Prefix(candidate.title, remainingTextBytes);
    remainingTextBytes -= title.byteLength;
    const excerpt = truncateUtf8Prefix(candidate.excerpt, remainingTextBytes);
    remainingTextBytes -= excerpt.byteLength;
    const titleTruncated = candidate.titleTruncated || title.truncated;
    const excerptTruncated = candidate.excerptTruncated || excerpt.truncated;
    outputTruncated ||= titleTruncated || excerptTruncated;
    results.push(
      Object.freeze({
        source: candidate.source,
        ...candidate.signals,
        title: title.value,
        titleTruncated,
        matchedField: candidate.matchedField,
        excerpt: excerpt.value,
        excerptTruncated,
      }),
    );
  }

  return {
    mode: "filesystem",
    root: scan.root,
    results: Object.freeze(results),
    matchedCount,
    rejectedConcepts: scan.rejectedConcepts,
    complete: scan.complete,
    resultsTruncated: matchedCount > results.length,
    outputTruncated,
    diagnostics: scan.diagnostics,
    diagnosticsTruncated: scan.diagnosticsTruncated,
  };
}

export async function inspectConcept(
  root: string | URL,
  selector: InspectConceptSelector,
  options: InspectConceptOptions = {},
): Promise<InspectConceptResult> {
  validateRoot(root);
  const limits = validationLimits(options);
  const maxContentBytes = positiveLimit(
    "maxContentBytes",
    options.maxContentBytes,
    DEFAULT_MAX_INSPECT_CONTENT_BYTES,
  );
  throwIfAborted(options.signal);
  const selected = selectorValue(selector);
  if (selected === undefined) {
    return inspectFailure(
      rootLabel(root),
      "invalid-selector",
      false,
      0,
      Object.freeze([createDiagnostic("INSPECT-INPUT", "<invalid>")]),
      false,
    );
  }

  const matches: ScannedQueryConcept[] = [];
  const scan = await scanVaultForQuery({
    rootPath: root,
    limits,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    visit(concept) {
      if (
        (selected.kind === "path" && concept.sourcePath === selected.value) ||
        (selected.kind === "uid" && concept.uid === selected.value)
      ) {
        if (matches.length < 2) matches.push(concept);
      }
    },
  });
  if (!scan.complete || !scan.safeToReturn) {
    return inspectFailure(
      scan.root,
      "incomplete",
      false,
      scan.rejectedConcepts,
      scan.diagnostics,
      scan.diagnosticsTruncated,
    );
  }

  const invalid =
    selected.kind === "path"
      ? scan.invalidPaths.has(selected.value)
      : scan.invalidUids.has(selected.value);
  if (matches.length > 1) {
    return inspectFailure(
      scan.root,
      "ambiguous",
      true,
      scan.rejectedConcepts,
      withDiagnostic(
        scan.diagnostics,
        createDiagnostic("INSPECT-AMBIGUOUS", "/"),
      ),
      false,
    );
  }
  const concept = matches[0];
  if (concept === undefined) {
    const reason = invalid ? "invalid-concept" : "not-found";
    return inspectFailure(
      scan.root,
      reason,
      true,
      scan.rejectedConcepts,
      invalid
        ? scan.diagnostics
        : withDiagnostic(
            scan.diagnostics,
            createDiagnostic(
              "INSPECT-NOT-FOUND",
              selected.kind === "path" ? selected.value : "/",
            ),
          ),
      false,
    );
  }

  const sourcePrefix = truncateUtf8Prefix(
    decoder.decode(concept.sourceBytes),
    maxContentBytes,
  );
  const success: InspectConceptSuccess = {
    ok: true,
    mode: "filesystem",
    root: scan.root,
    source: sourceFor(concept),
    ...signalsFor(concept),
    sourceText: sourcePrefix.value,
    sourceByteLength: concept.sourceBytes.byteLength,
    returnedByteLength: sourcePrefix.byteLength,
    sourceTruncated: sourcePrefix.truncated,
    handling: concept.excluded ? "excluded" : "ordinary",
    rejectedConcepts: scan.rejectedConcepts,
    complete: true,
    diagnostics: scan.diagnostics,
    diagnosticsTruncated: false,
  };
  return success;
}

export type {
  FilesystemConceptSignals,
  FilesystemConceptSource,
  FilesystemQueryOptions,
  FilesystemSearchFilters,
  FilesystemSearchHit,
  FilesystemSensitivityClassification,
  InspectConceptFailure,
  InspectConceptOptions,
  InspectConceptResult,
  InspectConceptSelector,
  InspectConceptSuccess,
  SearchVaultOptions,
  SearchVaultRequest,
  SearchVaultResult,
} from "./filesystem-query-model.js";
