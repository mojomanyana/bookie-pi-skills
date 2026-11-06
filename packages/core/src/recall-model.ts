import type { ConceptSourceHash } from "./concept-mutation-model.js";

export interface ConceptRevision {
  readonly path: string;
  readonly sourceHash: ConceptSourceHash;
}
export interface RecallProject extends ConceptRevision {
  readonly uid: string;
}
export interface RecallScope {
  readonly root: string;
  readonly vaultUid: string;
  readonly project: RecallProject;
  readonly manifestRevision: ConceptSourceHash;
  readonly sensitivityClasses: readonly string[];
  readonly excludedClasses: readonly string[];
}
export interface ProducerReference {
  readonly producer: string;
  readonly producerInstance: string;
  readonly owner: { readonly sessionId: string; readonly cwd: string };
  readonly operationId: string;
  readonly executionId: string;
  readonly kind: string;
  readonly reference: {
    readonly locator: string;
    readonly sha256: string;
    readonly byteLength: number;
  };
}
export type RecallTarget =
  | { readonly kind: "concept"; readonly uid: string }
  | { readonly kind: "producer"; readonly registrationId: string };
export interface RecallControl {
  readonly target: RecallTarget;
  readonly disposition: "suppressed" | "superseded";
  readonly replacement?: RecallProject;
}
export interface StoredRecallControl extends RecallControl {
  readonly project: RecallProject;
}
export interface ProducerRegistration {
  readonly id: string;
  readonly project: RecallProject;
  readonly record: ProducerReference;
  readonly sensitivity: string;
}
export interface RecallState {
  readonly schemaVersion: 1;
  readonly vaultUid: string;
  readonly sequence: number;
  readonly previousRevision: ConceptSourceHash | null;
  readonly controls: readonly StoredRecallControl[];
  readonly registrations: readonly ProducerRegistration[];
}
export type RecallFailureReason =
  | "input"
  | "bounds"
  | "vault"
  | "scope"
  | "not-configured"
  | "invalid-state"
  | "conflict"
  | "suppressed"
  | "source-changed"
  | "authority"
  | "io"
  | "unavailable"
  | "stale"
  | "policy";
export type RecallResult<T> =
  | ({ readonly ok: true } & T)
  | { readonly ok: false; readonly reason: RecallFailureReason };
export interface RecallReadOptions {
  readonly signal?: AbortSignal;
}
export interface RecallMutationOptions extends RecallReadOptions {
  readonly assertAuthority: () => Promise<void>;
}
export interface RegisterProducerOptions extends RecallMutationOptions {
  readonly resolveReference: (
    record: ProducerReference,
  ) => Promise<{ readonly sha256: string; readonly byteLength: number }>;
}
export interface ContextBinding {
  readonly policyRevision: string;
  readonly destination: {
    readonly provider: string;
    readonly model: string;
    readonly endpoint: string;
  };
}
export interface ContextOptions extends RecallReadOptions {
  readonly binding: ContextBinding;
}
export interface PrepareContextRequest {
  readonly project: ConceptRevision;
  readonly selectors: readonly {
    readonly path: string;
    readonly sourceHash?: ConceptSourceHash;
  }[];
  readonly source?:
    | { readonly mode: "working-tree" }
    | { readonly mode: "committed"; readonly commit: string };
  readonly maxContentBytes?: number;
  readonly maxTotalBytes?: number;
}
export interface PrepareCanonicalExportRequest {
  readonly project: ConceptRevision;
  readonly selectors: PrepareContextRequest["selectors"];
  readonly commit: string;
  readonly maxBytes?: number;
}
export interface CanonicalSelectionExport {
  readonly format: "bookie-canonical-jsonl/v1";
  readonly scope: "selected-records";
  readonly sourceCommit: string;
  readonly records: readonly {
    readonly path: string;
    readonly uid: string;
    readonly sourceHash: ConceptSourceHash;
    readonly sensitivity: string;
  }[];
  readonly recordCount: number;
  readonly byteLength: number;
  readonly outputHash: ConceptSourceHash;
  readonly jsonl: string;
  readonly complete: true;
  readonly untrusted: true;
}
export interface ContextInput {
  readonly path: string;
  readonly uid: string;
  readonly sourceHash: ConceptSourceHash;
  readonly sensitivity: string;
  readonly type: string;
  readonly status: string;
  readonly state: string | null;
  readonly representation: "utf8-source/v1" | "canonical-jsonl-body/v1";
  readonly text: string;
  readonly textHash: ConceptSourceHash;
  readonly fullByteLength: number;
  readonly truncated: boolean;
}
export interface PreparedContextBundle {
  readonly schemaVersion: 1;
  readonly digest: ConceptSourceHash;
  readonly representation: "bookie-context-excerpts/v1";
  readonly scope: RecallScope;
  readonly controlRevision: ConceptSourceHash;
  readonly binding: ContextBinding;
  readonly source:
    | { readonly mode: "working-tree"; readonly commit: null }
    | { readonly mode: "committed"; readonly commit: string };
  readonly request: PrepareContextRequest;
  readonly inputs: readonly ContextInput[];
  readonly untrusted: true;
}
