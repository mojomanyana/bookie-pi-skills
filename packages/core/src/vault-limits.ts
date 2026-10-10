import { positiveLimit } from "./bounded-limit.js";
import {
  DEFAULT_MAX_CONCEPT_BYTES,
  DEFAULT_MAX_YAML_DEPTH,
} from "./concept-loader.js";
import type { ValidationLimits } from "./vault-model.js";

export const DEFAULT_MAX_MANIFEST_BYTES = 65_536;
export const DEFAULT_MAX_VAULT_ENTRIES = 100_000;
export const DEFAULT_MAX_VAULT_CONCEPTS = 50_000;
export const DEFAULT_MAX_TOTAL_CONCEPT_BYTES = 536_870_912;
export const DEFAULT_MAX_TOTAL_RESOURCE_BYTES = 2_147_483_648;
export const DEFAULT_MAX_VAULT_DIAGNOSTICS = 1_000;

export function validationLimits(
  options: Partial<ValidationLimits>,
): ValidationLimits {
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
  };
}
