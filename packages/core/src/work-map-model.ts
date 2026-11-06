import type { ConceptSourceHash } from "./concept-mutation-model.js";
import type {
  ContextOptions,
  ConceptRevision,
  PreparedContextBundle,
  RecallProject,
} from "./recall-model.js";

export interface WorkConceptReference extends ConceptRevision {
  readonly uid: string;
}
export interface WorkOwnerReference {
  readonly owner: string;
  readonly reference: Readonly<Record<string, unknown>>;
}
export interface WorkEffectTarget {
  readonly owner: string;
  readonly kind: string;
  /** Opaque owner-issued structured reference; copy unchanged. */
  readonly reference: string;
}
export interface WorkEffectObservation {
  readonly target: WorkEffectTarget;
  readonly outcome: "pending" | "applied" | "not-applied" | "unknown";
  readonly provenance: "not-observed" | "operator-attested" | "owner-verified";
  readonly receipt?: { readonly reference: string; readonly sha256: string };
  readonly attempt?: {
    readonly owner: { readonly sessionId: string; readonly cwd: string };
    readonly operationId: string;
    readonly executionId: string;
  };
}
export interface WorkTask {
  readonly concept: WorkConceptReference;
  readonly dependsOn: readonly string[];
  readonly inputs: readonly WorkConceptReference[];
  readonly requiredOutputs: readonly {
    readonly id: string;
    readonly description: string;
    readonly reviewScope?: "task" | "integrated";
  }[];
  readonly resources: readonly WorkOwnerReference[];
  readonly effectScope?: "local" | "external" | "unknown";
  readonly effectTarget?: WorkEffectTarget;
  readonly outputRefs: readonly {
    readonly outputId: string;
    readonly reference: WorkOwnerReference;
  }[];
  readonly judgments: readonly WorkOwnerReference[];
}
export interface WorkSuggestion {
  readonly id: string;
  readonly taskId: string;
  readonly text: string;
  readonly trigger: WorkConceptReference;
  readonly disposition:
    | "proposed"
    | "accepted"
    | "dismissed"
    | "deferred"
    | "superseded"
    | "resolved";
  readonly handledTriggerHash?: ConceptSourceHash;
}
export interface WorkMap {
  readonly schemaVersion: 1;
  readonly project: {
    readonly uid: string;
    readonly sourceHash: ConceptSourceHash;
  };
  readonly plans: readonly {
    readonly document: WorkConceptReference;
    readonly taskIds: readonly string[];
  }[];
  readonly tasks: readonly WorkTask[];
  readonly suggestions: readonly WorkSuggestion[];
}
export interface WorkIdentity {
  readonly initiativeId: string;
  readonly taskId: string;
  readonly taskRevision: ConceptSourceHash;
}
export type WorkReferenceStatus =
  "current" | "missing" | "stale" | "suppressed" | "unavailable" | "unverified";
export interface WorkReferenceResolution {
  readonly status: WorkReferenceStatus;
  readonly reference: WorkOwnerReference;
  readonly judgment?: {
    readonly subjectRevision: ConceptSourceHash;
    readonly outputId: string;
    readonly outputReference: WorkOwnerReference;
    readonly verdict: "accepted" | "rejected" | "unverified";
    readonly reviewScope: "task" | "integrated";
  };
  readonly assertCurrent?: () => void | Promise<void>;
}
export type WorkRuntimeObservation =
  | { readonly status: "unavailable" }
  | (WorkIdentity & {
      readonly status: "observed";
      readonly ownerGeneration: number;
      readonly claim: "unclaimed" | "owned" | "other-owner" | "uncertain";
      readonly execution: "none" | "running" | "settled" | "unknown";
      readonly reconciliationRequired: boolean;
      readonly effectObservation?: WorkEffectObservation;
      readonly assertCurrent: () => void | Promise<void>;
    });
export interface WorkProjectionOptions extends ContextOptions {
  readonly resolveReference?: (
    reference: WorkOwnerReference,
    purpose: WorkIdentity & {
      readonly purpose: "resource" | "output" | "judgment";
      readonly outputId?: string;
      readonly reviewScope?: "task" | "integrated";
    },
  ) => Promise<WorkReferenceResolution>;
  readonly observeRuntime?: (
    identity: WorkIdentity,
  ) => Promise<WorkRuntimeObservation>;
}
export interface WorkProjectionRequest {
  readonly project: ConceptRevision;
  readonly map: ConceptRevision;
  readonly planId: string;
  readonly taskIds?: readonly string[];
  readonly includeHandledSuggestions?: boolean;
}
export interface WorkTaskProjection extends WorkIdentity {
  readonly source: WorkConceptReference;
  readonly inputs: readonly WorkConceptReference[];
  readonly requiredOutputs: WorkTask["requiredOutputs"];
  readonly effectScope: "local" | "external" | "unknown";
  readonly effectTarget?: WorkEffectTarget;
  readonly lifecycle: string | null;
  readonly dependsOn: readonly string[];
  readonly state:
    | "completed"
    | "alignment-required"
    | "reconcile"
    | "running"
    | "blocked"
    | "awaiting-acceptance"
    | "ready"
    | "unavailable";
  readonly resources: readonly {
    readonly reference: WorkOwnerReference;
    readonly status: WorkReferenceStatus;
  }[];
  readonly outputs: readonly {
    readonly id: string;
    readonly status:
      | "missing"
      | "unverified"
      | "accepted"
      | "rejected"
      | "stale"
      | "suppressed"
      | "unavailable";
  }[];
  readonly runtime:
    | { readonly status: "unavailable" }
    | Omit<
        Extract<WorkRuntimeObservation, { status: "observed" }>,
        "assertCurrent"
      >;
  readonly reasons: readonly string[];
}
export interface WorkProjection {
  readonly schemaVersion: 1;
  readonly initiativeId: string;
  readonly map: WorkConceptReference;
  readonly plan: WorkConceptReference;
  readonly project: RecallProject;
  readonly goalAlignment: "current" | "changed";
  readonly projectLifecycle: string | null;
  readonly tasks: readonly WorkTaskProjection[];
  readonly suggestions: readonly {
    readonly id: string;
    readonly taskId: string;
    readonly text: string;
    readonly disposition: WorkSuggestion["disposition"];
    readonly reconsider: boolean;
  }[];
  readonly executionAuthority: false;
  readonly untrusted: true;
}
export interface LoadedWorkMap {
  readonly map: WorkMap;
  readonly source: WorkConceptReference;
  readonly bundle: PreparedContextBundle;
}
