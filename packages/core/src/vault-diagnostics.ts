import type { ConceptDiagnosticCode, SourceRange } from "./concept-loader.js";

export type VaultDiagnosticCode =
  | ConceptDiagnosticCode
  | "VAULT-ROOT"
  | "VAULT-IO"
  | "VAULT-BOUNDS"
  | "MANIFEST-MISSING"
  | "MANIFEST-SIZE"
  | "MANIFEST-SYNTAX"
  | "MANIFEST-SCHEMA"
  | "CONCEPT-PATH"
  | "CONCEPT-SCHEMA"
  | "MARKDOWN-LINK"
  | "DIAGNOSTICS-TRUNCATED"
  | "GIT-BASE"
  | "TYPE-ALLOWED"
  | "UID-UNIQUE"
  | "PROJECT-TARGET"
  | "RELATION-TARGET"
  | "RELATION-INVERSE"
  | "DECISION-SUPERSESSION"
  | "ACTIVITY-IMMUTABLE"
  | "EVIDENCE-IMMUTABLE"
  | "EVIDENCE-RESOURCE"
  | "EVIDENCE-DIGEST"
  | "EVIDENCE-SUPPORT"
  | "INSPECT-INPUT"
  | "INSPECT-NOT-FOUND"
  | "INSPECT-AMBIGUOUS"
  | "EXPORT-SOURCE"
  | "EXPORT-SENSITIVITY"
  | "EXPORT-SECRET"
  | "EXPORT-OUTPUT";

export interface VaultDiagnostic {
  readonly code: VaultDiagnosticCode;
  readonly severity: "error";
  readonly file: string;
  readonly message: string;
  readonly remediation: string;
  readonly range?: SourceRange;
  readonly instancePath?: string;
  readonly keyword?: string;
}

const messages: Record<
  Exclude<VaultDiagnosticCode, ConceptDiagnosticCode>,
  string
> = {
  "VAULT-ROOT": "Vault root is missing, unreadable, or not a directory.",
  "VAULT-IO": "Vault entry could not be read safely.",
  "VAULT-BOUNDS": "Vault validation reached a configured bound.",
  "MANIFEST-MISSING": "Vault manifest is missing or not a regular file.",
  "MANIFEST-SIZE": "Vault manifest exceeds the configured byte limit.",
  "MANIFEST-SYNTAX": "Vault manifest is not a supported YAML 1.2 mapping.",
  "MANIFEST-SCHEMA": "Vault manifest does not satisfy profile 1.0.",
  "CONCEPT-PATH": "Bookie concept path is not canonical.",
  "CONCEPT-SCHEMA": "Concept does not satisfy its required schema.",
  "MARKDOWN-LINK": "Local Markdown link target is invalid or unavailable.",
  "DIAGNOSTICS-TRUNCATED": "Additional diagnostics were omitted.",
  "GIT-BASE":
    "Git base validation could not establish a safe complete comparison.",
  "TYPE-ALLOWED": "Bookie concept type is not allowed by the manifest.",
  "UID-UNIQUE": "Bookie UID is not unique within the vault.",
  "PROJECT-TARGET": "Project reference does not resolve to a valid Project.",
  "RELATION-TARGET": "Relation target or supersession edge is invalid.",
  "RELATION-INVERSE": "Required inverse relation is missing or ambiguous.",
  "DECISION-SUPERSESSION": "Decision supersession lifecycle is invalid.",
  "ACTIVITY-IMMUTABLE":
    "A Git-base Activity is not retained byte-for-byte at its path.",
  "EVIDENCE-IMMUTABLE":
    "A Git-base Evidence descriptor is not retained byte-for-byte at its path.",
  "EVIDENCE-RESOURCE": "Evidence resource is missing, unsafe, or oversized.",
  "EVIDENCE-DIGEST": "Evidence digest does not match exact resource bytes.",
  "EVIDENCE-SUPPORT": "Evidence support does not resolve to a valid concept.",
  "INSPECT-INPUT": "Inspect selector is not a canonical path or UID.",
  "INSPECT-NOT-FOUND": "No Bookie concept matches the exact selector.",
  "INSPECT-AMBIGUOUS": "More than one Bookie concept matches the exact UID.",
  "EXPORT-SOURCE":
    "Canonical export could not read one exact local Git commit.",
  "EXPORT-SENSITIVITY":
    "Canonical export eligibility is unclassified or would expose excluded data.",
  "EXPORT-SECRET": "Canonical export rejected possible credential material.",
  "EXPORT-OUTPUT": "Canonical export output could not be written completely.",
};

const remediations: Record<
  Exclude<VaultDiagnosticCode, ConceptDiagnosticCode>,
  string
> = {
  "VAULT-ROOT": "Pass an explicit readable Bookie vault directory.",
  "VAULT-IO":
    "Replace symlinks or special entries with readable regular files and directories.",
  "VAULT-BOUNDS":
    "Reduce the vault size or use an accepted lower-scope validation operation.",
  "MANIFEST-MISSING": "Add a regular bookie.yaml file at the vault root.",
  "MANIFEST-SIZE": "Reduce bookie.yaml below the configured limit.",
  "MANIFEST-SYNTAX":
    "Save bookie.yaml as bounded strict YAML 1.2 without aliases or custom tags.",
  "MANIFEST-SCHEMA":
    "Correct the manifest field identified by instancePath and keyword.",
  "CONCEPT-PATH":
    "Move the concept to a canonical bundle-relative Markdown path.",
  "CONCEPT-SCHEMA":
    "Correct the concept field identified by instancePath and keyword.",
  "MARKDOWN-LINK":
    "Use an existing local target inside the vault or an explicit external URL.",
  "DIAGNOSTICS-TRUNCATED":
    "Raise the diagnostic limit within the supported bound or fix reported errors first.",
  "GIT-BASE":
    "Use a local canonical commit ref in the containing Git worktree and stage every validated file.",
  "TYPE-ALLOWED":
    "List the Bookie type in allowed_concept_types or remove the Bookie profile mapping.",
  "UID-UNIQUE":
    "Assign a new correctly prefixed ULID to one conflicting concept.",
  "PROJECT-TARGET":
    "Point bookie.project to a schema-valid Project in this vault.",
  "RELATION-TARGET":
    "Correct the target, cached UID, duplicate, or supersession combination.",
  "RELATION-INVERSE":
    "Add exactly one matching inverse relation with the correct cached UID.",
  "DECISION-SUPERSESSION":
    "Correct reciprocal links, lifecycle, project, cycle, or replacement cardinality.",
  "ACTIVITY-IMMUTABLE":
    "Restore the base Activity at its original path or add a new linked correction.",
  "EVIDENCE-IMMUTABLE":
    "Restore the base Evidence descriptor at its original path or add a new linked correction.",
  "EVIDENCE-RESOURCE":
    "Use a singly linked bounded regular file beneath a configured evidence root without symlinks.",
  "EVIDENCE-DIGEST":
    "Recompute lowercase SHA-256 over the exact stored resource bytes.",
  "EVIDENCE-SUPPORT":
    "Point every support path to a schema-valid Bookie concept.",
  "INSPECT-INPUT":
    "Use exactly one canonical bundle-absolute concept path or Bookie UID.",
  "INSPECT-NOT-FOUND":
    "Use the exact path or UID of a schema-valid Bookie concept in this vault.",
  "INSPECT-AMBIGUOUS":
    "Resolve duplicate UIDs before inspecting a concept by UID.",
  "EXPORT-SOURCE":
    "Use a canonical local ref or full object ID in the containing Git worktree.",
  "EXPORT-SENSITIVITY":
    "Assign every included record a declared class and remove excluded identity references.",
  "EXPORT-SECRET":
    "Remove or redact credential material, or explicitly select the audited unchecked export policy.",
  "EXPORT-OUTPUT":
    "Discard any output prefix, repair the caller-owned sink, and retry the same commit.",
};

export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareDiagnostics(
  left: VaultDiagnostic,
  right: VaultDiagnostic,
): number {
  return (
    compareText(left.file, right.file) ||
    compareText(left.code, right.code) ||
    compareText(left.instancePath ?? "", right.instancePath ?? "") ||
    (left.range?.start.byteOffset ?? -1) - (right.range?.start.byteOffset ?? -1)
  );
}

export function sanitizeFile(file: string): string {
  return [...file]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)
        ? "�"
        : character;
    })
    .join("");
}

export function createDiagnostic(
  code: Exclude<VaultDiagnosticCode, ConceptDiagnosticCode>,
  file: string,
  details?: {
    readonly instancePath?: string;
    readonly keyword?: string;
  },
): VaultDiagnostic {
  return {
    code,
    severity: "error",
    file: sanitizeFile(file),
    message: messages[code],
    remediation: remediations[code],
    ...(details?.instancePath === undefined
      ? {}
      : { instancePath: details.instancePath }),
    ...(details?.keyword === undefined ? {} : { keyword: details.keyword }),
  };
}

export function mapConceptDiagnostic(
  diagnostic: {
    readonly code: ConceptDiagnosticCode;
    readonly severity: "error" | "warning";
    readonly file: string;
    readonly message: string;
    readonly remediation: string;
    readonly range?: SourceRange;
  },
  file: string,
): VaultDiagnostic {
  return {
    ...diagnostic,
    severity: "error",
    file: sanitizeFile(file),
  };
}

export class DiagnosticCollector {
  readonly #diagnostics: VaultDiagnostic[] = [];
  readonly #maximum: number;
  readonly #decisionKeys = new Set<string>();
  #diagnosticsTruncated = false;
  #incomplete = false;

  constructor(maximum: number) {
    this.#maximum = maximum;
  }

  get diagnosticsTruncated(): boolean {
    return this.#diagnosticsTruncated;
  }

  get complete(): boolean {
    return !this.#incomplete && !this.#diagnosticsTruncated;
  }

  markIncomplete(): void {
    this.#incomplete = true;
  }

  redactFiles(files: ReadonlySet<string>): void {
    const sensitivePaths = [...files].filter(
      (file) => file.startsWith("/") && file !== "/",
    );
    for (let index = 0; index < this.#diagnostics.length; index += 1) {
      const diagnostic = this.#diagnostics[index];
      if (
        diagnostic !== undefined &&
        sensitivePaths.some(
          (sensitive) =>
            diagnostic.file === sensitive ||
            diagnostic.file.startsWith(`${sensitive}/`) ||
            sensitive.startsWith(`${diagnostic.file}/`),
        )
      ) {
        this.#diagnostics[index] = { ...diagnostic, file: "<excluded>" };
      }
    }
  }

  add(diagnostic: VaultDiagnostic): void {
    if (diagnostic.code === "DECISION-SUPERSESSION") {
      const key = `${diagnostic.file}\0${diagnostic.instancePath ?? ""}`;
      if (this.#decisionKeys.has(key)) return;
      this.#decisionKeys.add(key);
    }
    const capacity = Math.max(0, this.#maximum - 1);
    if (this.#diagnostics.length < capacity) {
      this.#diagnostics.push(diagnostic);
    } else {
      this.#diagnosticsTruncated = true;
    }
  }

  finish(): readonly VaultDiagnostic[] {
    const diagnostics = [...this.#diagnostics].sort(compareDiagnostics);
    if (this.#diagnosticsTruncated) {
      diagnostics.push(
        createDiagnostic("DIAGNOSTICS-TRUNCATED", "/bookie.yaml"),
      );
    }
    return Object.freeze(diagnostics);
  }
}
