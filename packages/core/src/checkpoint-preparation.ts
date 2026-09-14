import type { BigIntStats } from "node:fs";

import {
  createConceptWithPolicyPreconditions,
  type CreatePolicyPreconditions,
} from "./concept-mutation.js";
import type {
  ConceptMutationOptions,
  ConceptMutationResult,
  CreateConceptRequest,
} from "./concept-mutation-model.js";
import type { ReadonlyYamlMapping } from "./concept-loader.js";
import { cloneYamlInput } from "./concept-mutation-input.js";
import {
  hasLoneSurrogate,
  isObject,
  utf8ByteLength,
} from "./concept-mutation-model.js";
import {
  captureParent,
  resolveMutationTarget,
} from "./concept-mutation-filesystem.js";
import {
  loadMutationManifest,
  schemaValidatorsOrUndefined,
  mutationManifestHash,
} from "./concept-mutation-validation.js";
import { throwIfAborted } from "./vault-cancellation.js";
import { createPathTracker, verifyTrackedPaths } from "./vault-filesystem.js";
import { containsDetectedSecret } from "./vault-secret-detection.js";
import {
  DEFAULT_MAX_CONCEPT_BYTES,
  DEFAULT_MAX_YAML_DEPTH,
} from "./concept-loader.js";

export const MAX_CHECKPOINT_PREVIEW_BYTES = 24_000;

export const CHECKPOINT_SECTIONS = [
  "outcome",
  "changed-artifacts",
  "decisions",
  "evidence",
  "validation",
  "unresolved-work",
  "next-action",
  "source-session",
] as const;

export type CheckpointSection = (typeof CHECKPOINT_SECTIONS)[number];

export interface CheckpointFragment {
  readonly section: CheckpointSection;
  readonly sensitivity: string;
  readonly text: string;
}

export interface PrepareCheckpointRequest {
  readonly path: string;
  readonly frontmatter: ReadonlyYamlMapping;
  readonly fragments: readonly CheckpointFragment[];
}

export interface PrepareCheckpointOptions {
  readonly signal?: AbortSignal;
}

export type PrepareCheckpointFailureReason =
  | "input"
  | "bounds"
  | "vault"
  | "manifest"
  | "sensitivity-policy"
  | "secret-policy";

export interface PrepareCheckpointFailure {
  readonly ok: false;
  readonly reason: PrepareCheckpointFailureReason;
}

export interface CheckpointPreview {
  readonly bodyText: string;
  readonly includedFragments: number;
}

declare const checkpointPublicationBrand: unique symbol;

export interface PreparedCheckpointPublication {
  readonly [checkpointPublicationBrand]: true;
}

interface PreparedCheckpointState {
  readonly root: string;
  readonly request: CreateConceptRequest;
  readonly preconditions: CreatePolicyPreconditions;
}

const preparedCheckpointStates = new WeakMap<
  PreparedCheckpointPublication,
  PreparedCheckpointState
>();

export interface PrepareCheckpointSuccess {
  readonly ok: true;
  readonly preparedInput: PrepareCheckpointRequest;
  readonly publication: PreparedCheckpointPublication;
  readonly preview: CheckpointPreview;
}

export type PrepareCheckpointResult =
  PrepareCheckpointFailure | PrepareCheckpointSuccess;

const REQUIRED_SECTIONS = CHECKPOINT_SECTIONS.slice(0, 7);
const MAX_CHECKPOINT_FRAGMENTS = 128;
const headings: Readonly<Record<CheckpointSection, string>> = {
  outcome: "Outcome",
  "changed-artifacts": "Changed artifacts",
  decisions: "Decisions",
  evidence: "Evidence",
  validation: "Validation",
  "unresolved-work": "Unresolved work",
  "next-action": "Next action",
  "source-session": "Source session",
};

function directoryIdentity(path: string, metadata: BigIntStats) {
  return {
    path,
    dev: metadata.dev.toString(),
    ino: metadata.ino.toString(),
    mode: metadata.mode.toString(),
    nlink: metadata.nlink.toString(),
  };
}

function failure(
  reason: PrepareCheckpointFailureReason,
): PrepareCheckpointFailure {
  return Object.freeze({ ok: false, reason });
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === [...expected].sort()[index])
  );
}

function validSection(value: unknown): value is CheckpointSection {
  return (
    typeof value === "string" &&
    (CHECKPOINT_SECTIONS as readonly string[]).includes(value)
  );
}

function renderBody(
  included: ReadonlyMap<CheckpointSection, readonly string[]>,
  sectionsPresent: ReadonlySet<CheckpointSection>,
): string {
  const sections = CHECKPOINT_SECTIONS.filter(
    (section) =>
      REQUIRED_SECTIONS.includes(section) || sectionsPresent.has(section),
  );
  return `${sections
    .map((section) => {
      const values = included.get(section) ?? [];
      const text =
        values.length === 0
          ? "Omitted by sensitivity policy."
          : values.join("\n\n");
      return `# ${headings[section]}\n\n${text}`;
    })
    .join("\n\n")}\n`;
}

export async function prepareCheckpoint(
  root: string | URL,
  request: PrepareCheckpointRequest,
  options: PrepareCheckpointOptions = {},
): Promise<PrepareCheckpointResult> {
  if (
    options === null ||
    typeof options !== "object" ||
    Array.isArray(options)
  ) {
    throw new TypeError("options must be an object");
  }
  const { signal } = options;
  throwIfAborted(signal);
  const limits = {
    maxConceptBytes: DEFAULT_MAX_CONCEPT_BYTES,
    maxYamlDepth: DEFAULT_MAX_YAML_DEPTH,
  };
  const cloned = cloneYamlInput(request, limits, DEFAULT_MAX_CONCEPT_BYTES);
  if (!cloned.ok)
    return failure(cloned.reason === "bounds" ? "bounds" : "input");
  if (!isObject(cloned.value)) return failure("input");
  const snapshot = cloned.value;
  if (!exactKeys(snapshot, ["fragments", "frontmatter", "path"])) {
    return failure("input");
  }
  if (containsDetectedSecret(snapshot)) return failure("secret-policy");
  if (
    typeof snapshot.path !== "string" ||
    !isObject(snapshot.frontmatter) ||
    !Array.isArray(snapshot.fragments) ||
    snapshot.fragments.length === 0
  ) {
    return failure("input");
  }
  if (snapshot.fragments.length > MAX_CHECKPOINT_FRAGMENTS) {
    return failure("bounds");
  }

  const fragments: CheckpointFragment[] = [];
  const sectionsPresent = new Set<CheckpointSection>();
  for (const value of snapshot.fragments) {
    if (
      !isObject(value) ||
      !exactKeys(value, ["section", "sensitivity", "text"]) ||
      !validSection(value.section) ||
      typeof value.sensitivity !== "string" ||
      value.sensitivity.length === 0 ||
      typeof value.text !== "string" ||
      value.text.length === 0 ||
      hasLoneSurrogate(value.text)
    ) {
      return failure("input");
    }
    sectionsPresent.add(value.section);
    fragments.push({
      section: value.section,
      sensitivity: value.sensitivity,
      text: value.text,
    });
  }
  if (REQUIRED_SECTIONS.some((section) => !sectionsPresent.has(section))) {
    return failure("input");
  }

  const resolved = await resolveMutationTarget(root, snapshot.path, signal);
  if (!resolved.ok) return failure("vault");
  const parent = await captureParent(resolved.target, signal);
  if (parent === undefined) return failure("vault");
  const validators = await schemaValidatorsOrUndefined();
  if (validators === undefined) return failure("manifest");
  const tracker = createPathTracker();
  const manifestResult = await loadMutationManifest(
    resolved.target,
    validators,
    limits,
    signal,
    tracker,
  );
  if (!manifestResult.ok) return failure("manifest");
  const { manifest } = manifestResult;
  const frontmatter = snapshot.frontmatter;
  const bookie = isObject(frontmatter.bookie) ? frontmatter.bookie : undefined;
  const activitySensitivity = bookie?.sensitivity;
  const activityValidator = validators.byType.get("Activity");
  if (
    frontmatter.type !== "Activity" ||
    activityValidator === undefined ||
    !activityValidator(frontmatter) ||
    !manifest.allowed_concept_types.includes("Activity")
  ) {
    return failure("input");
  }
  if (
    typeof activitySensitivity !== "string" ||
    !manifest.policy.sensitivity.classes.includes(activitySensitivity) ||
    manifest.policy.sensitivity.excluded_classes.includes(activitySensitivity)
  ) {
    return failure("sensitivity-policy");
  }

  const included = new Map<CheckpointSection, string[]>();
  let omittedFragments = 0;
  for (const fragment of fragments) {
    if (!manifest.policy.sensitivity.classes.includes(fragment.sensitivity)) {
      return failure("sensitivity-policy");
    }
    if (
      manifest.policy.sensitivity.excluded_classes.includes(
        fragment.sensitivity,
      )
    ) {
      omittedFragments += 1;
      continue;
    }
    const values = included.get(fragment.section) ?? [];
    values.push(fragment.text);
    included.set(fragment.section, values);
  }
  const bodyText = renderBody(included, sectionsPresent);
  if (
    utf8ByteLength(bodyText) > MAX_CHECKPOINT_PREVIEW_BYTES ||
    utf8ByteLength(bodyText) + 8 > DEFAULT_MAX_CONCEPT_BYTES
  ) {
    return failure("bounds");
  }
  throwIfAborted(signal);
  if (!(await verifyTrackedPaths(tracker, signal))) return failure("manifest");

  const publicationFrontmatter = cloneYamlInput(
    frontmatter,
    limits,
    DEFAULT_MAX_CONCEPT_BYTES,
  );
  if (!publicationFrontmatter.ok) {
    return failure(
      publicationFrontmatter.reason === "bounds" ? "bounds" : "input",
    );
  }
  if (!isObject(publicationFrontmatter.value)) return failure("input");
  const createRequest = Object.freeze({
    path: snapshot.path,
    frontmatter: publicationFrontmatter.value,
    bodyText,
  }) as CreateConceptRequest;
  const safeFragments = fragments.filter(
    (fragment) =>
      !manifest.policy.sensitivity.excluded_classes.includes(
        fragment.sensitivity,
      ),
  );
  for (const section of sectionsPresent) {
    if (!included.has(section)) {
      safeFragments.push({
        section,
        sensitivity: activitySensitivity,
        text: "Omitted by sensitivity policy.",
      });
    }
  }
  const preparedInput = Object.freeze({
    path: snapshot.path,
    frontmatter,
    fragments: Object.freeze(safeFragments),
  }) as PrepareCheckpointRequest;
  const publication = Object.freeze({}) as PreparedCheckpointPublication;
  preparedCheckpointStates.set(publication, {
    root: resolved.target.unresolvedRoot,
    request: createRequest,
    preconditions: {
      expectedRoot: directoryIdentity(
        resolved.target.root,
        resolved.target.rootMetadata,
      ),
      expectedTargetPath: resolved.target.target,
      expectedRelativePath: resolved.target.relativePath,
      expectedParent: {
        path: parent.parent,
        identities: parent.identities.map((identity) =>
          directoryIdentity(identity.path, identity.metadata),
        ),
      },
      expectedManifestHash: mutationManifestHash(manifest),
    },
  });
  return Object.freeze({
    ok: true,
    preparedInput,
    publication,
    preview: Object.freeze({
      bodyText,
      includedFragments: fragments.length - omittedFragments,
    }),
  });
}

export function createCheckpointWithPolicy(
  publication: PreparedCheckpointPublication,
  options: ConceptMutationOptions = {},
): Promise<ConceptMutationResult> {
  const state = preparedCheckpointStates.get(publication);
  if (state === undefined) {
    throw new TypeError(
      "publication must be an opaque value returned by prepareCheckpoint",
    );
  }
  return createConceptWithPolicyPreconditions(
    state.root,
    state.request,
    state.preconditions,
    options,
  );
}
