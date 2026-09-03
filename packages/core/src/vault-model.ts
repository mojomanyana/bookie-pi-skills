export interface ValidationLimits {
  readonly maxManifestBytes: number;
  readonly maxConceptBytes: number;
  readonly maxYamlDepth: number;
  readonly maxEntries: number;
  readonly maxConcepts: number;
  readonly maxTotalConceptBytes: number;
  readonly maxTotalResourceBytes: number;
  readonly maxDiagnostics: number;
}

export interface Manifest {
  readonly profile: "1.0";
  readonly allowed_concept_types: readonly string[];
  readonly policy: {
    readonly evidence_roots: readonly string[];
    readonly exclude: readonly string[];
    readonly sensitivity: {
      readonly classes: readonly string[];
      readonly excluded_classes: readonly string[];
    };
    readonly attachment_max_bytes: number;
  };
}

export interface ManifestState {
  readonly manifest?: Manifest;
  readonly excludedSensitivityClasses: readonly string[];
}

export interface Relation {
  readonly kind: string;
  readonly target: string;
  readonly target_uid?: string;
}

export interface BookieData {
  readonly profile: string;
  readonly uid: string;
  readonly project?: string;
  readonly state?: string;
  readonly sensitivity?: string;
  readonly relations?: readonly Relation[];
  readonly supports?: readonly string[];
  readonly sha256?: string;
}

export interface BookieCandidate {
  readonly path: string;
  readonly displayFile: string;
  readonly type?: string;
  readonly uid?: string;
  readonly profile?: string;
}

export interface BookieRecord {
  readonly path: string;
  readonly displayFile: string;
  readonly type: string;
  readonly status: string;
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly bookie: BookieData;
}

export interface BookiePolicySource {
  readonly path: string;
  readonly displayFile: string;
  readonly type: string;
  readonly status?: string;
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly bookie: {
    readonly profile?: string;
    readonly uid?: string;
    readonly project?: string;
    readonly state?: string;
    readonly sensitivity?: string;
    readonly relations?: readonly Relation[];
    readonly supports?: readonly string[];
    readonly sha256?: string;
  };
}

export interface SchemaError {
  readonly instancePath: string;
  readonly keyword: string;
}

export interface SchemaValidator {
  (value: unknown): boolean;
  readonly errors?: readonly SchemaError[] | null;
}

export interface SchemaValidators {
  readonly manifest: SchemaValidator;
  readonly byType: ReadonlyMap<string, SchemaValidator>;
  readonly conceptPathPattern: RegExp;
}

export interface VaultEntries {
  readonly regularFiles: ReadonlySet<string>;
  readonly directories: ReadonlySet<string>;
  readonly markdownFiles: readonly string[];
  readonly incomplete: boolean;
  readonly unsafeEntries: boolean;
}
