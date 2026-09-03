import type { ReadonlyYamlMapping } from "./concept-loader.js";
import type { ConceptSourceHash } from "./concept-mutation-model.js";
import type { VaultDiagnostic } from "./vault-diagnostics.js";

export type InitialBookieConceptType =
  | "Project"
  | "Task"
  | "Document"
  | "Research"
  | "Decision"
  | "Activity"
  | "Evidence"
  | "Person";

export interface CanonicalJsonlRecordV1 {
  readonly schema_version: "1.0";
  readonly source_commit: string;
  readonly source_hash: ConceptSourceHash;
  readonly profile: "1.0";
  readonly uid: string;
  readonly path: string;
  readonly type: InitialBookieConceptType;
  readonly title: string;
  readonly frontmatter: ReadonlyYamlMapping;
  readonly body_markdown: string;
}

export type CanonicalJsonlSink = (
  completeLine: Uint8Array,
) => void | Promise<void>;

export interface CanonicalJsonlExportRequest {
  readonly sourceRef: string;
  readonly write: CanonicalJsonlSink;
}

export type CanonicalExportSecretPolicy = "reject-detected" | "allow-unchecked";

export interface CanonicalJsonlExportOptions {
  readonly secretPolicy?: CanonicalExportSecretPolicy;
  readonly maxManifestBytes?: number;
  readonly maxConceptBytes?: number;
  readonly maxYamlDepth?: number;
  readonly maxEntries?: number;
  readonly maxConcepts?: number;
  readonly maxTotalConceptBytes?: number;
  readonly maxTotalResourceBytes?: number;
  readonly maxDiagnostics?: number;
  readonly maxOutputBytes?: number;
  readonly signal?: AbortSignal;
}

export interface CanonicalJsonlExportSuccess {
  readonly ok: true;
  readonly format: "bookie-canonical-jsonl";
  readonly schemaVersion: "1.0";
  readonly root: string;
  readonly sourceCommit: string;
  readonly secretPolicy: CanonicalExportSecretPolicy;
  readonly recordCount: number;
  readonly byteLength: number;
  readonly outputHash: ConceptSourceHash;
  readonly complete: true;
  readonly diagnostics: readonly [];
  readonly diagnosticsTruncated: false;
}

export type CanonicalJsonlExportFailureReason =
  | "invalid-source"
  | "invalid-vault"
  | "sensitivity-policy"
  | "secret-policy"
  | "incomplete"
  | "output-error";

export interface CanonicalJsonlExportFailure {
  readonly ok: false;
  readonly format: "bookie-canonical-jsonl";
  readonly schemaVersion: "1.0";
  readonly root: string;
  readonly sourceCommit?: string;
  readonly secretPolicy: CanonicalExportSecretPolicy;
  readonly reason: CanonicalJsonlExportFailureReason;
  readonly complete: boolean;
  readonly diagnostics: readonly VaultDiagnostic[];
  readonly diagnosticsTruncated: boolean;
  readonly possiblyWrittenRecords: number;
  readonly possiblyWrittenBytes: number;
}

export type CanonicalJsonlExportResult =
  CanonicalJsonlExportSuccess | CanonicalJsonlExportFailure;
