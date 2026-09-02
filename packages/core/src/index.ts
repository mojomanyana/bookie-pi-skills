export const OKF_VERSION = "0.2" as const;

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
  computeConceptSourceHash,
  createConcept,
} from "./concept-mutation.js";
export type {
  AmendConceptRequest,
  ConceptMutationCoordinator,
  ConceptMutationFailure,
  ConceptMutationOptions,
  ConceptMutationResult,
  ConceptMutationSuccess,
  ConceptSourceHash,
  CreateConceptRequest,
  FrontmatterEdit,
  FrontmatterPathSegment,
  MutationDiagnostic,
  MutationDiagnosticCode,
} from "./concept-mutation.js";
