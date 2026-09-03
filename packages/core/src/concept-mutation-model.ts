import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import type {
  ConceptDiagnostic,
  ConceptDiagnosticCode,
  ReadonlyYamlMapping,
  ReadonlyYamlValue,
  SourceRange,
} from "./concept-loader.js";
import { createDiagnostic, sanitizeFile } from "./vault-diagnostics.js";

export type ConceptSourceHash = `sha256:${string}`;
export type FrontmatterPathSegment = string | number;
export type FrontmatterEdit =
  | {
      readonly op: "set";
      readonly path: readonly [
        FrontmatterPathSegment,
        ...FrontmatterPathSegment[],
      ];
      readonly value: ReadonlyYamlValue;
    }
  | {
      readonly op: "remove";
      readonly path: readonly [
        FrontmatterPathSegment,
        ...FrontmatterPathSegment[],
      ];
    };

export interface CreateConceptRequest {
  readonly path: string;
  readonly frontmatter: ReadonlyYamlMapping;
  readonly bodyText: string;
}

export interface AmendConceptRequest {
  readonly path: string;
  readonly expectedSourceHash: ConceptSourceHash;
  readonly edits: readonly FrontmatterEdit[];
  readonly bodyText?: string;
}

export type ConceptMutationCoordinator = <T>(
  absoluteTargetPath: string,
  mutation: () => Promise<T>,
) => Promise<T>;

export interface ConceptMutationOptions {
  readonly maxConceptBytes?: number;
  readonly maxYamlDepth?: number;
  readonly signal?: AbortSignal;
  readonly runExclusive?: ConceptMutationCoordinator;
}

export type MutationDiagnosticCode =
  | ConceptDiagnosticCode
  | "CONCEPT-SCHEMA"
  | "MANIFEST-MISSING"
  | "MANIFEST-SIZE"
  | "MANIFEST-SYNTAX"
  | "MANIFEST-SCHEMA"
  | "TYPE-ALLOWED"
  | "UID-UNIQUE"
  | "VAULT-ROOT"
  | "MUTATION-INPUT"
  | "MUTATION-PATH"
  | "MUTATION-TARGET"
  | "MUTATION-IDENTITY"
  | "MUTATION-CONFLICT"
  | "MUTATION-BOUNDS"
  | "MUTATION-IO";

export interface MutationDiagnostic {
  readonly code: MutationDiagnosticCode;
  readonly severity: "error";
  readonly file: string;
  readonly message: string;
  readonly remediation: string;
  readonly range?: SourceRange;
  readonly instancePath?: string;
  readonly keyword?: string;
}

export interface ConceptMutationSuccess {
  readonly ok: true;
  readonly operation: "create" | "amend";
  readonly outcome: "created" | "amended" | "unchanged";
  readonly path: string;
  readonly changedPaths: readonly string[];
  readonly sourceHash: ConceptSourceHash;
  readonly previousSourceHash?: ConceptSourceHash;
  readonly diagnostics: readonly [];
}

export interface ConceptMutationFailure {
  readonly ok: false;
  readonly operation: "create" | "amend";
  readonly conflict: boolean;
  readonly changedPaths: readonly string[];
  readonly diagnostics: readonly MutationDiagnostic[];
}

export type ConceptMutationResult =
  ConceptMutationSuccess | ConceptMutationFailure;

export type MutationOperation = "create" | "amend";

export interface MutationLimits {
  readonly maxConceptBytes: number;
  readonly maxYamlDepth: number;
}

const emptyDiagnostics = Object.freeze([]) as readonly [];

const mutationMessages: Record<
  Extract<MutationDiagnosticCode, `MUTATION-${string}`>,
  { readonly message: string; readonly remediation: string }
> = {
  "MUTATION-INPUT": {
    message: "Concept mutation request is invalid.",
    remediation:
      "Use bounded YAML values, valid non-overlapping edits, and an exact source-hash token.",
  },
  "MUTATION-PATH": {
    message: "Concept mutation path is non-canonical or unsafe.",
    remediation:
      "Use a vault-relative POSIX Markdown path beneath existing non-symlink directories.",
  },
  "MUTATION-TARGET": {
    message: "Concept mutation target is not in the required state.",
    remediation:
      "Create only absent targets and amend only singly linked regular concept files.",
  },
  "MUTATION-IDENTITY": {
    message: "Concept mutation would change stable identity.",
    remediation:
      "Keep type, bookie.profile, and bookie.uid unchanged; create a new concept when identity changes.",
  },
  "MUTATION-CONFLICT": {
    message: "Concept source changed after it was read.",
    remediation: "Reread the concept, recompute the edits, and retry once.",
  },
  "MUTATION-BOUNDS": {
    message: "Concept mutation reached a configured safety bound.",
    remediation:
      "Reduce the candidate or vault size before retrying the mutation.",
  },
  "MUTATION-IO": {
    message: "Concept mutation could not complete filesystem I/O safely.",
    remediation:
      "Restore safe readable directories and retry after checking for leftover temporary files.",
  },
};

export function mutationDiagnostic(
  code: Extract<MutationDiagnosticCode, `MUTATION-${string}`>,
  file: string,
): MutationDiagnostic {
  const description = mutationMessages[code];
  return Object.freeze({
    code,
    severity: "error" as const,
    file: sanitizeFile(file),
    message: description.message,
    remediation: description.remediation,
  });
}

export function reusedDiagnostic(
  code: Exclude<
    MutationDiagnosticCode,
    ConceptDiagnosticCode | `MUTATION-${string}`
  >,
  file: string,
  details?: {
    readonly instancePath?: string;
    readonly keyword?: string;
  },
): MutationDiagnostic {
  return Object.freeze(
    createDiagnostic(code, file, details) as MutationDiagnostic,
  );
}

export function conceptDiagnostics(
  diagnostics: readonly ConceptDiagnostic[],
  file: string,
): readonly MutationDiagnostic[] {
  return diagnostics.map((diagnostic) =>
    Object.freeze({
      ...diagnostic,
      severity: "error" as const,
      file: sanitizeFile(file),
    }),
  );
}

export function failure(
  operation: MutationOperation,
  diagnostics: readonly MutationDiagnostic[],
  changedPaths: readonly string[] = [],
): ConceptMutationFailure {
  const frozen = Object.freeze([...diagnostics]);
  return Object.freeze({
    ok: false,
    operation,
    conflict: frozen.some(
      (diagnostic) => diagnostic.code === "MUTATION-CONFLICT",
    ),
    changedPaths: Object.freeze([...changedPaths]),
    diagnostics: frozen,
  });
}

export function success(
  operation: MutationOperation,
  outcome: "created" | "amended" | "unchanged",
  path: string,
  sourceHash: ConceptSourceHash,
  previousSourceHash?: ConceptSourceHash,
): ConceptMutationSuccess {
  const changedPaths = Object.freeze(
    outcome === "unchanged" ? [] : [path],
  ) as readonly string[];
  return Object.freeze({
    ok: true,
    operation,
    outcome,
    path,
    changedPaths,
    sourceHash,
    ...(previousSourceHash === undefined ? {} : { previousSourceHash }),
    diagnostics: emptyDiagnostics,
  });
}

export function isObject(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function hasErrorCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === code
  );
}

export function isAbortError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "name" in error &&
    error.name === "AbortError"
  );
}

export function computeConceptSourceHash(bytes: Uint8Array): ConceptSourceHash {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError("bytes must be a Uint8Array");
  }
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}
