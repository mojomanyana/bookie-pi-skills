import type { ConceptSourceHash } from "./concept-mutation-model.js";
import type { VaultDiagnostic } from "./vault-diagnostics.js";

export interface FilesystemSearchFilters {
  readonly type?: string;
  readonly project?: string;
  readonly status?: string;
  readonly state?: string;
  readonly sensitivity?: string;
  readonly tag?: string;
}

export interface SearchVaultRequest {
  readonly query: string;
  readonly filters?: FilesystemSearchFilters;
}

export type InspectConceptSelector =
  | { readonly path: string; readonly uid?: never }
  | { readonly uid: string; readonly path?: never };

export interface FilesystemQueryOptions {
  readonly maxManifestBytes?: number;
  readonly maxConceptBytes?: number;
  readonly maxYamlDepth?: number;
  readonly maxEntries?: number;
  readonly maxConcepts?: number;
  readonly maxTotalConceptBytes?: number;
  readonly maxDiagnostics?: number;
  readonly signal?: AbortSignal;
}

export interface SearchVaultOptions extends FilesystemQueryOptions {
  readonly maxResults?: number;
  readonly maxExcerptBytes?: number;
  readonly maxTotalTextBytes?: number;
}

export interface InspectConceptOptions extends FilesystemQueryOptions {
  readonly maxContentBytes?: number;
}

export interface FilesystemConceptSource {
  readonly path: string;
  readonly state: "working-tree";
  readonly commit: null;
  readonly sourceHash: ConceptSourceHash;
}

export type FilesystemSensitivityClassification =
  "missing" | "declared" | "undeclared" | "excluded";

export interface FilesystemConceptSignals {
  readonly type: string;
  readonly uid: string;
  readonly project: string | null;
  readonly status: string;
  readonly state: string | null;
  readonly sensitivity: {
    readonly value: string | null;
    readonly classification: FilesystemSensitivityClassification;
  };
  readonly verification: "present" | "absent";
  readonly staleAfter: string | null;
  readonly untrusted: true;
}

export interface FilesystemSearchHit extends FilesystemConceptSignals {
  readonly source: FilesystemConceptSource;
  readonly title: string;
  readonly titleTruncated: boolean;
  readonly matchedField: "title" | "body";
  readonly excerpt: string;
  readonly excerptTruncated: boolean;
}

export interface SearchVaultResult {
  readonly mode: "filesystem";
  readonly root: string;
  readonly results: readonly FilesystemSearchHit[];
  readonly matchedCount: number;
  readonly rejectedConcepts: number;
  readonly complete: boolean;
  readonly resultsTruncated: boolean;
  readonly outputTruncated: boolean;
  readonly diagnostics: readonly VaultDiagnostic[];
  readonly diagnosticsTruncated: boolean;
}

export interface InspectConceptSuccess extends FilesystemConceptSignals {
  readonly ok: true;
  readonly mode: "filesystem";
  readonly root: string;
  readonly source: FilesystemConceptSource;
  readonly sourceText: string;
  readonly sourceByteLength: number;
  readonly returnedByteLength: number;
  readonly sourceTruncated: boolean;
  readonly handling: "ordinary" | "excluded";
  readonly rejectedConcepts: number;
  readonly complete: true;
  readonly diagnostics: readonly VaultDiagnostic[];
  readonly diagnosticsTruncated: false;
}

export interface InspectConceptFailure {
  readonly ok: false;
  readonly mode: "filesystem";
  readonly root: string;
  readonly reason:
    | "invalid-selector"
    | "not-found"
    | "ambiguous"
    | "invalid-concept"
    | "incomplete";
  readonly rejectedConcepts: number;
  readonly complete: boolean;
  readonly diagnostics: readonly VaultDiagnostic[];
  readonly diagnosticsTruncated: boolean;
}

export type InspectConceptResult =
  InspectConceptSuccess | InspectConceptFailure;
