import { createHash } from "node:crypto";

import {
  DEFAULT_MAX_CONCEPT_BYTES,
  DEFAULT_MAX_YAML_DEPTH,
} from "./concept-loader.js";
import type { ReadonlyYamlValue } from "./concept-loader.js";
import type {
  CanonicalJsonlExportFailure,
  CanonicalJsonlExportFailureReason,
  CanonicalJsonlExportOptions,
  CanonicalJsonlExportRequest,
  CanonicalJsonlExportResult,
  CanonicalJsonlExportSuccess,
  CanonicalJsonlRecordV1,
  CanonicalJsonlSink,
  CanonicalExportSecretPolicy,
} from "./canonical-export-model.js";
import { throwIfAborted } from "./vault-cancellation.js";
import { compareText, createDiagnostic } from "./vault-diagnostics.js";
import type { ValidationLimits } from "./vault-model.js";
import { scanGitCommitForExport } from "./vault-export-scan.js";
import type { ExportSnapshotRecord } from "./vault-export-scan.js";
import {
  DEFAULT_MAX_MANIFEST_BYTES,
  DEFAULT_MAX_TOTAL_CONCEPT_BYTES,
  DEFAULT_MAX_TOTAL_RESOURCE_BYTES,
  DEFAULT_MAX_VAULT_CONCEPTS,
  DEFAULT_MAX_VAULT_DIAGNOSTICS,
  DEFAULT_MAX_VAULT_ENTRIES,
} from "./vault-validator.js";

export const DEFAULT_MAX_CANONICAL_JSONL_BYTES = 536_870_912;

const encoder = new TextEncoder();
const requestFields = new Set(["sourceRef", "write"]);
const optionFields = new Set([
  "secretPolicy",
  "maxManifestBytes",
  "maxConceptBytes",
  "maxYamlDepth",
  "maxEntries",
  "maxConcepts",
  "maxTotalConceptBytes",
  "maxTotalResourceBytes",
  "maxDiagnostics",
  "maxOutputBytes",
  "signal",
]);

interface ExportLimits {
  readonly validation: ValidationLimits;
  readonly maxOutputBytes: number;
}

interface ValidatedInvocation {
  readonly sourceRef: string;
  readonly write: CanonicalJsonlSink;
  readonly signal: AbortSignal | undefined;
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

function exportLimits(options: CanonicalJsonlExportOptions): ExportLimits {
  return {
    validation: {
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
    },
    maxOutputBytes: positiveLimit(
      "maxOutputBytes",
      options.maxOutputBytes,
      DEFAULT_MAX_CANONICAL_JSONL_BYTES,
    ),
  };
}

function validateRequest(
  root: unknown,
  request: CanonicalJsonlExportRequest,
  options: CanonicalJsonlExportOptions,
): ValidatedInvocation {
  if (typeof root !== "string" && !(root instanceof URL)) {
    throw new TypeError("root must be a filesystem path or file URL");
  }
  if (!isObject(request)) throw new TypeError("request must be an object");
  if (Object.keys(request).some((field) => !requestFields.has(field))) {
    throw new TypeError("request contains an unsupported field");
  }
  const sourceRef = request.sourceRef;
  const write = request.write;
  if (typeof sourceRef !== "string") {
    throw new TypeError("sourceRef must be a string");
  }
  if (typeof write !== "function") {
    throw new TypeError("write must be a function");
  }
  if (!isObject(options)) throw new TypeError("options must be an object");
  if (Object.keys(options).some((field) => !optionFields.has(field))) {
    throw new TypeError("options contains an unsupported field");
  }
  const signal = options.signal as unknown;
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new TypeError("signal must be an AbortSignal");
  }
  return { sourceRef, write, signal };
}

function exportSecretPolicy(
  options: CanonicalJsonlExportOptions,
): CanonicalExportSecretPolicy {
  const descriptor = Object.getOwnPropertyDescriptor(options, "secretPolicy");
  if (descriptor === undefined) return "reject-detected";
  if (!("value" in descriptor)) {
    throw new TypeError("secretPolicy must be an own data property");
  }
  const value = descriptor.value as unknown;
  if (value !== "reject-detected" && value !== "allow-unchecked") {
    throw new TypeError(
      'secretPolicy must be "reject-detected" or "allow-unchecked"',
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("unsupported JSON number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (!isObject(value)) throw new TypeError("unsupported JSON value");
  return `{${Object.keys(value)
    .sort(compareText)
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJson(value[key] as ReadonlyYamlValue)}`,
    )
    .join(",")}}`;
}

function canonicalRecord(
  sourceCommit: string,
  source: ExportSnapshotRecord,
): CanonicalJsonlRecordV1 {
  return {
    schema_version: "1.0",
    source_commit: sourceCommit,
    source_hash: source.sourceHash,
    profile: "1.0",
    uid: source.uid,
    path: source.path,
    type: source.type,
    title: source.title,
    frontmatter: source.frontmatter,
    body_markdown: source.bodyText,
  } as CanonicalJsonlRecordV1;
}

function lineFor(sourceCommit: string, source: ExportSnapshotRecord): string {
  return `${canonicalJson(canonicalRecord(sourceCommit, source))}\n`;
}

async function awaitSink(
  result: void | Promise<void>,
  signal: AbortSignal | undefined,
): Promise<void> {
  const completion = Promise.resolve(result);
  if (signal === undefined) {
    await completion;
    return;
  }
  if (signal.aborted) {
    void completion.catch(() => undefined);
    throwIfAborted(signal);
  }
  await new Promise<void>((resolveCompletion, rejectCompletion) => {
    let settled = false;
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      if (error === undefined) resolveCompletion();
      else rejectCompletion(error);
    };
    const onAbort = (): void => {
      try {
        throwIfAborted(signal);
      } catch (error) {
        finish(error);
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    completion.then(
      () => finish(),
      (error: unknown) => finish(error),
    );
    if (signal.aborted) onAbort();
  });
}

function failure(
  input: Omit<CanonicalJsonlExportFailure, "ok" | "format" | "schemaVersion">,
): CanonicalJsonlExportFailure {
  return {
    ok: false,
    format: "bookie-canonical-jsonl",
    schemaVersion: "1.0",
    ...input,
  };
}

function scanFailureReason(
  complete: boolean,
  sourceCommit: string | undefined,
  sensitivityFailure: boolean,
  diagnosticCodes: readonly string[],
): CanonicalJsonlExportFailureReason {
  if (diagnosticCodes.includes("VAULT-BOUNDS")) return "incomplete";
  if (
    sourceCommit === undefined ||
    diagnosticCodes.includes("VAULT-ROOT") ||
    diagnosticCodes.includes("EXPORT-SOURCE")
  ) {
    return "invalid-source";
  }
  if (
    complete &&
    sensitivityFailure &&
    diagnosticCodes.every(
      (code) =>
        code === "EXPORT-SENSITIVITY" || code === "DIAGNOSTICS-TRUNCATED",
    )
  ) {
    return "sensitivity-policy";
  }
  if (
    complete &&
    diagnosticCodes.includes("EXPORT-SECRET") &&
    diagnosticCodes.every(
      (code) => code === "EXPORT-SECRET" || code === "DIAGNOSTICS-TRUNCATED",
    )
  ) {
    return "secret-policy";
  }
  return complete ? "invalid-vault" : "incomplete";
}

export async function exportCanonicalJsonl(
  root: string | URL,
  request: CanonicalJsonlExportRequest,
  options: CanonicalJsonlExportOptions = {},
): Promise<CanonicalJsonlExportResult> {
  const { signal, sourceRef, write } = validateRequest(root, request, options);
  const secretPolicy = exportSecretPolicy(options);
  const limits = exportLimits(options);
  throwIfAborted(signal);
  const snapshot = await scanGitCommitForExport(
    root,
    sourceRef,
    secretPolicy,
    limits.validation,
    signal,
  );
  throwIfAborted(signal);

  if (!snapshot.valid || snapshot.sourceCommit === undefined) {
    return failure({
      root: snapshot.root,
      secretPolicy,
      ...(snapshot.sourceCommit === undefined
        ? {}
        : { sourceCommit: snapshot.sourceCommit }),
      reason: scanFailureReason(
        snapshot.complete,
        snapshot.sourceCommit,
        snapshot.sensitivityFailure,
        snapshot.diagnostics.map((diagnostic) => diagnostic.code),
      ),
      complete: snapshot.complete,
      diagnostics: snapshot.diagnostics,
      diagnosticsTruncated: snapshot.diagnosticsTruncated,
      possiblyWrittenRecords: 0,
      possiblyWrittenBytes: 0,
    });
  }

  const records = snapshot.records
    .filter((record) => !record.excluded)
    .sort((left, right) => compareText(left.uid, right.uid));
  let byteLength = 0;
  const outputHash = createHash("sha256");
  for (const record of records) {
    throwIfAborted(signal);
    const line = encoder.encode(lineFor(snapshot.sourceCommit, record));
    if (line.byteLength > limits.maxOutputBytes - byteLength) {
      return failure({
        root: snapshot.root,
        sourceCommit: snapshot.sourceCommit,
        secretPolicy,
        reason: "incomplete",
        complete: false,
        diagnostics: Object.freeze([
          createDiagnostic("VAULT-BOUNDS", "/bookie.yaml"),
        ]),
        diagnosticsTruncated: false,
        possiblyWrittenRecords: 0,
        possiblyWrittenBytes: 0,
      });
    }
    byteLength += line.byteLength;
    outputHash.update(line);
  }

  let writtenRecords = 0;
  let writtenBytes = 0;
  for (const record of records) {
    throwIfAborted(signal);
    const line = encoder.encode(lineFor(snapshot.sourceCommit, record));
    const possiblyWrittenRecords = writtenRecords + 1;
    const possiblyWrittenBytes = writtenBytes + line.byteLength;
    try {
      await awaitSink(write(line), signal);
    } catch {
      throwIfAborted(signal);
      return failure({
        root: snapshot.root,
        sourceCommit: snapshot.sourceCommit,
        secretPolicy,
        reason: "output-error",
        complete: false,
        diagnostics: Object.freeze([
          createDiagnostic("EXPORT-OUTPUT", "/bookie.yaml"),
        ]),
        diagnosticsTruncated: false,
        possiblyWrittenRecords,
        possiblyWrittenBytes,
      });
    }
    writtenRecords = possiblyWrittenRecords;
    writtenBytes = possiblyWrittenBytes;
    throwIfAborted(signal);
  }

  const success: CanonicalJsonlExportSuccess = {
    ok: true,
    format: "bookie-canonical-jsonl",
    schemaVersion: "1.0",
    root: snapshot.root,
    sourceCommit: snapshot.sourceCommit,
    secretPolicy,
    recordCount: records.length,
    byteLength,
    outputHash: `sha256:${outputHash.digest("hex")}`,
    complete: true,
    diagnostics: Object.freeze([]),
    diagnosticsTruncated: false,
  };
  return success;
}

export type {
  CanonicalJsonlExportFailure,
  CanonicalJsonlExportFailureReason,
  CanonicalJsonlExportOptions,
  CanonicalJsonlExportRequest,
  CanonicalJsonlExportResult,
  CanonicalJsonlExportSuccess,
  CanonicalJsonlRecordV1,
  CanonicalJsonlSink,
  CanonicalExportSecretPolicy,
  InitialBookieConceptType,
} from "./canonical-export-model.js";
