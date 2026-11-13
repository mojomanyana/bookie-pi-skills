export const OKF_VERSION = "0.2" as const;

/** Shared deterministic heuristic; not source authorization or a complete secret classifier. */
export { containsDetectedSecret } from "./vault-secret-detection.js";

export { readApprovedSourceManifest } from "./approved-source-manifest.js";
export type {
  ApprovedSourceManifestRequest,
  ApprovedSourceManifestResult,
} from "./approved-source-manifest.js";

export { resolveApprovedGitCommit } from "./approved-git-source.js";
export type {
  ApprovedGitCommitRequest,
  ApprovedGitCommitResult,
} from "./approved-git-source.js";

export {
  CHECKPOINT_SECTIONS,
  MAX_CHECKPOINT_PREVIEW_BYTES,
  createCheckpointWithPolicy,
  prepareCheckpoint,
} from "./checkpoint-preparation.js";
export type {
  CheckpointFragment,
  CheckpointPreview,
  CheckpointSection,
  PrepareCheckpointFailure,
  PrepareCheckpointFailureReason,
  PrepareCheckpointOptions,
  PrepareCheckpointRequest,
  PreparedCheckpointPublication,
  PrepareCheckpointResult,
  PrepareCheckpointSuccess,
} from "./checkpoint-preparation.js";

export {
  DEFAULT_MAX_CANONICAL_JSONL_BYTES,
  exportCanonicalJsonl,
} from "./canonical-export.js";
export type {
  CanonicalJsonlExportFailure,
  CanonicalJsonlExportFailureReason,
  CanonicalJsonlExportOptions,
  CanonicalJsonlExportRequest,
  CanonicalJsonlExportResult,
  CanonicalJsonlExportSuccess,
  CanonicalJsonlRecordV1,
  CanonicalExportSecretPolicy,
  CanonicalJsonlSink,
  CanonicalSourceManifest,
  InitialBookieConceptType,
} from "./canonical-export.js";

export {
  DEFAULT_MAX_CONCEPT_BYTES,
  DEFAULT_MAX_YAML_DEPTH,
  loadConcept,
  serializeConcept,
} from "./concept-loader.js";
export {
  DEFAULT_MAX_MANIFEST_BYTES,
  DEFAULT_MAX_TOTAL_CONCEPT_BYTES,
  DEFAULT_MAX_TOTAL_RESOURCE_BYTES,
  DEFAULT_MAX_VAULT_CONCEPTS,
  DEFAULT_MAX_VAULT_DIAGNOSTICS,
  DEFAULT_MAX_VAULT_ENTRIES,
  validateVault,
} from "./vault-validator.js";
export type {
  ValidateVaultOptions,
  ValidateVaultResult,
  VaultDiagnostic,
  VaultDiagnosticCode,
} from "./vault-validator.js";

export type {
  ConceptDiagnostic,
  ConceptDiagnosticCode,
  DiagnosticSeverity,
  LoadConceptOptions,
  LoadConceptResult,
  LoadedConcept,
  ReadonlyYamlMapping,
  ReadonlyYamlScalar,
  ReadonlyYamlValue,
  SourcePosition,
  SourceRange,
} from "./concept-loader.js";

export {
  amendConcept,
  amendConceptWithPolicy,
  computeConceptSourceHash,
  createConcept,
  createConceptWithPolicy,
} from "./concept-mutation.js";
export {
  captureEvidence,
  captureEvidenceWithPolicy,
} from "./evidence-capture.js";
export {
  DEFAULT_MAX_INSPECT_CONTENT_BYTES,
  DEFAULT_MAX_SEARCH_EXCERPT_BYTES,
  DEFAULT_MAX_SEARCH_RESULTS,
  DEFAULT_MAX_SEARCH_TEXT_BYTES,
  inspectConcept,
  MAX_FILESYSTEM_QUERY_BYTES,
  searchVault,
  recallVault,
  DEFAULT_MAX_RECALL_RESULTS,
  MAX_RECALL_RESULTS,
} from "./filesystem-query.js";
export type {
  FilesystemConceptSignals,
  FilesystemConceptSource,
  FilesystemQueryOptions,
  FilesystemSearchFilters,
  FilesystemSearchHit,
  FilesystemRecallHit,
  RecallVaultOptions,
  RecallVaultRequest,
  RecallVaultResult,
  FilesystemSensitivityClassification,
  InspectConceptFailure,
  InspectConceptOptions,
  InspectConceptResult,
  InspectConceptSelector,
  InspectConceptSuccess,
  SearchVaultOptions,
  SearchVaultRequest,
  SearchVaultResult,
} from "./filesystem-query.js";
export type {
  CaptureEvidenceFailure,
  CaptureEvidenceOptions,
  CaptureEvidenceRedactedSuccess,
  CaptureEvidenceRequest,
  CaptureEvidenceResult,
  CaptureEvidenceSuccess,
} from "./evidence-capture.js";

export type {
  AmendConceptRequest,
  ConceptMutationCoordinator,
  ConceptMutationFailure,
  ConceptMutationOptions,
  ConceptMutationResult,
  ConceptMutationSuccess,
  ConceptMutationExcludedSuccess,
  ConceptPolicyMutationResult,
  ConceptSourceHash,
  CreateConceptRequest,
  FrontmatterEdit,
  FrontmatterPathSegment,
  MutationDiagnostic,
  MutationDiagnosticCode,
} from "./concept-mutation.js";

export { inspectRecallScope } from "./recall-scope.js";
export {
  initializeRecallState,
  readRecallState,
  updateRecallControl,
  registerProducerReference,
  producerReferenceId,
  RECALL_STATE_FILE,
  RECALL_MARKER_FILE,
} from "./recall-state.js";
export {
  prepareContext,
  prepareCanonicalExport,
  revalidateContext,
} from "./prepared-context.js";
export type {
  ConceptRevision,
  RecallProject,
  RecallScope,
  ProducerReference,
  RecallTarget,
  RecallControl,
  StoredRecallControl,
  ProducerRegistration,
  RecallState,
  RecallFailureReason,
  RecallResult,
  RecallReadOptions,
  RecallMutationOptions,
  RegisterProducerOptions,
  ContextBinding,
  ContextOptions,
  PrepareContextRequest,
  PrepareCanonicalExportRequest,
  CanonicalSelectionExport,
  ContextInput,
  PreparedContextBundle,
} from "./recall-model.js";

export * from "./work-map-model.js";
export {
  describeWorkMap,
  validateWorkMap,
  renderWorkMapBody,
  parseWorkMapBody,
  workTaskRevision,
  readWorkMap,
  projectWorkMap,
  isWorkOwnerReference,
  isWorkEffectTarget,
  effectTargetReference,
} from "./work-map.js";
