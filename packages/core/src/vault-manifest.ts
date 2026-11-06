import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { Ajv2020 } from "ajv/dist/2020.js";
import type { SchemaValidateFunction } from "ajv/dist/types/index.js";
import * as formatsModule from "ajv-formats";

import { throwIfAborted } from "./vault-cancellation.js";
import { createDiagnostic, DiagnosticCollector } from "./vault-diagnostics.js";
import { readSafeBoundedFile } from "./vault-filesystem.js";
import type { PathTracker } from "./vault-filesystem.js";
import type {
  Manifest,
  ManifestState,
  SchemaValidator,
  SchemaValidators,
  ValidationLimits,
} from "./vault-model.js";
import { parseStrictYamlMapping } from "./strict-yaml.js";

const profileTypes = [
  "Project",
  "Task",
  "Document",
  "Research",
  "Decision",
  "Activity",
  "Evidence",
  "Person",
] as const;
const schemaRoot = fileURLToPath(new URL("./schemas/", import.meta.url));
let validatorsPromise: Promise<SchemaValidators> | undefined;

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// These validators receive bounded JSON-compatible values from the strict YAML
// loader or mutation clone. Ajv's default comparator invokes valueOf/toString;
// those names are ordinary data here, and mutation mappings have no prototype.
const uniqueJsonItems: SchemaValidateFunction = (
  enabled: boolean,
  items: readonly unknown[],
): boolean => {
  uniqueJsonItems.errors = [];
  if (!enabled || items.length < 2) return true;
  const duplicate = (i: number, j: number): false => {
    uniqueJsonItems.errors = [
      {
        keyword: "uniqueItems",
        params: { i, j },
        message: `must NOT have duplicate items (items ## ${j} and ${i} are identical)`,
      },
    ];
    return false;
  };
  // Preserve linear comparison for primitive arrays and JSON's 0 === -0.
  if (items.every((item) => item === null || typeof item !== "object")) {
    const indices = new Map<unknown, number>();
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const j = indices.get(items[i]);
      if (j !== undefined) return duplicate(i, j);
      indices.set(items[i], i);
    }
    return true;
  }
  // Normalize prototypes and signed zero in a validation-only view. The already
  // checked input contains no accessors/functions, so no caller method can run.
  // Keep the original prepared/publication data and all own keys unchanged.
  const values = JSON.parse(JSON.stringify(items)) as unknown[];
  for (let i = values.length - 1; i >= 0; i -= 1) {
    for (let j = i - 1; j >= 0; j -= 1) {
      if (isDeepStrictEqual(values[i], values[j])) return duplicate(i, j);
    }
  }
  return true;
};

async function loadSchemaValidators(): Promise<SchemaValidators> {
  const readJson = async (path: string): Promise<Record<string, unknown>> =>
    JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.removeKeyword("uniqueItems");
  ajv.addKeyword({
    keyword: "uniqueItems",
    type: "array",
    schemaType: "boolean",
    $data: true,
    errors: true,
    validate: uniqueJsonItems,
  });
  const addFormats = formatsModule.default as unknown as (
    instance: Ajv2020,
  ) => unknown;
  addFormats(ajv);

  const common = await readJson(
    resolve(schemaRoot, "bookie-common.schema.json"),
  );
  const manifestSchema = await readJson(
    resolve(schemaRoot, "profile/1.0/bookie-config.schema.json"),
  );
  ajv.addSchema(common);

  const byType = new Map<string, SchemaValidator>();
  for (const type of profileTypes) {
    byType.set(
      type,
      ajv.compile(
        await readJson(
          resolve(schemaRoot, `types/${type.toLowerCase()}.schema.json`),
        ),
      ),
    );
  }

  const definitions = common.$defs as
    Record<string, Record<string, unknown>> | undefined;
  const conceptPath = definitions?.conceptPath?.pattern;
  if (typeof conceptPath !== "string") {
    throw new Error("Canonical conceptPath schema is unavailable");
  }

  return {
    manifest: ajv.compile(manifestSchema),
    byType,
    conceptPathPattern: new RegExp(conceptPath, "u"),
  };
}

export function getSchemaValidators(): Promise<SchemaValidators> {
  validatorsPromise ??= loadSchemaValidators();
  return validatorsPromise;
}

function excludedSensitivityClasses(
  manifest: Readonly<Record<string, unknown>>,
): readonly string[] {
  const policy = isObject(manifest.policy) ? manifest.policy : undefined;
  const sensitivity =
    policy !== undefined && isObject(policy.sensitivity)
      ? policy.sensitivity
      : undefined;
  const excluded = sensitivity?.excluded_classes;
  return Array.isArray(excluded)
    ? [
        ...new Set(
          excluded.filter(
            (value): value is string => typeof value === "string",
          ),
        ),
      ].sort()
    : [];
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === code
  );
}

export async function readVaultManifest(
  root: string,
  limits: ValidationLimits,
  validators: SchemaValidators,
  collector: DiagnosticCollector,
  signal: AbortSignal | undefined,
  tracker: PathTracker,
): Promise<ManifestState> {
  throwIfAborted(signal);
  const path = resolve(root, "bookie.yaml");
  try {
    const metadata = await lstat(path);
    throwIfAborted(signal);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      collector.add(createDiagnostic("MANIFEST-MISSING", "/bookie.yaml"));
      collector.markIncomplete();
      return { excludedSensitivityClasses: [] };
    }
  } catch (error) {
    throwIfAborted(signal);
    collector.add(
      createDiagnostic(
        hasErrorCode(error, "ENOENT") ? "MANIFEST-MISSING" : "VAULT-IO",
        "/bookie.yaml",
      ),
    );
    collector.markIncomplete();
    return { excludedSensitivityClasses: [] };
  }

  const read = await readSafeBoundedFile(
    root,
    "bookie.yaml",
    limits.maxManifestBytes,
    signal,
    tracker,
  );
  throwIfAborted(signal);
  if (!read.ok) {
    collector.add(
      createDiagnostic(
        read.reason === "size" ? "MANIFEST-SIZE" : "VAULT-IO",
        "/bookie.yaml",
      ),
    );
    collector.markIncomplete();
    return { excludedSensitivityClasses: [] };
  }

  let manifestText: string;
  try {
    manifestText = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(read.bytes);
  } catch {
    collector.add(createDiagnostic("MANIFEST-SYNTAX", "/bookie.yaml"));
    collector.markIncomplete();
    return { excludedSensitivityClasses: [] };
  }
  const parsed = parseStrictYamlMapping(manifestText, limits.maxYamlDepth);
  throwIfAborted(signal);
  if (!parsed.ok) {
    collector.add(createDiagnostic("MANIFEST-SYNTAX", "/bookie.yaml"));
    collector.markIncomplete();
    return { excludedSensitivityClasses: [] };
  }

  const decoded = parsed.value;
  const redaction = excludedSensitivityClasses(decoded);
  if (!validators.manifest(decoded)) {
    throwIfAborted(signal);
    const errors = validators.manifest.errors;
    if (errors === null || errors === undefined || errors.length === 0) {
      collector.add(createDiagnostic("MANIFEST-SCHEMA", "/bookie.yaml"));
    } else {
      for (const error of errors) {
        collector.add(
          createDiagnostic("MANIFEST-SCHEMA", "/bookie.yaml", {
            instancePath: error.instancePath,
            keyword: error.keyword,
          }),
        );
      }
    }
    collector.markIncomplete();
    return { excludedSensitivityClasses: redaction };
  }
  throwIfAborted(signal);
  return {
    manifest: decoded as unknown as Manifest,
    excludedSensitivityClasses: redaction,
  };
}
