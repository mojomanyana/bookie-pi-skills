import { Document } from "yaml";

import {
  parseStrictYamlMapping,
  type ReadonlyYamlMapping,
  type ReadonlyYamlValue,
} from "./strict-yaml.js";

export type {
  ReadonlyYamlMapping,
  ReadonlyYamlScalar,
  ReadonlyYamlValue,
} from "./strict-yaml.js";

export const DEFAULT_MAX_CONCEPT_BYTES = 1_048_576;
export const DEFAULT_MAX_YAML_DEPTH = 64;

export type ConceptDiagnosticCode =
  | "CONCEPT-SIZE"
  | "CONCEPT-UTF8"
  | "FRONTMATTER-OPEN"
  | "FRONTMATTER-CLOSE"
  | "YAML-SYNTAX"
  | "YAML-UNSUPPORTED"
  | "YAML-ROOT";

export type DiagnosticSeverity = "error" | "warning";

export interface SourcePosition {
  readonly byteOffset: number;
  readonly line: number;
  readonly column: number;
}

export interface SourceRange {
  readonly start: SourcePosition;
  readonly end: SourcePosition;
}

export interface ConceptDiagnostic {
  readonly code: ConceptDiagnosticCode;
  readonly severity: DiagnosticSeverity;
  readonly file: string;
  readonly message: string;
  readonly remediation: string;
  readonly range?: SourceRange;
}

declare class LoadedConceptOwnership {
  private readonly loadedConceptOwnership: never;
}

export interface LoadedConcept extends LoadedConceptOwnership {
  readonly file: string;
  readonly rawText: string;
  readonly frontmatterText: string;
  readonly frontmatter: ReadonlyYamlMapping;
  readonly bodyText: string;
}

export interface LoadConceptOptions {
  readonly file: string;
  readonly maxBytes?: number;
  readonly maxDepth?: number;
}

export type LoadConceptResult =
  | {
      readonly ok: true;
      readonly concept: LoadedConcept;
      readonly diagnostics: readonly ConceptDiagnostic[];
    }
  | {
      readonly ok: false;
      readonly diagnostics: readonly ConceptDiagnostic[];
    };

interface FrontmatterEnvelope {
  readonly contentStart: number;
  readonly contentEnd: number;
  readonly bodyStart: number;
}

interface LoadedConceptState {
  readonly document: Document;
  readonly envelope: FrontmatterEnvelope;
  readonly sourceBytes: Uint8Array;
}

export type ConceptMutationEditInternal =
  | {
      readonly op: "set";
      readonly path: readonly (string | number)[];
      readonly value: ReadonlyYamlValue;
    }
  | {
      readonly op: "remove";
      readonly path: readonly (string | number)[];
    };

const loadedConceptStates = new WeakMap<LoadedConcept, LoadedConceptState>();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

const messages: Record<ConceptDiagnosticCode, string> = {
  "CONCEPT-SIZE": "Concept exceeds the configured byte limit.",
  "CONCEPT-UTF8": "Concept is not valid UTF-8.",
  "FRONTMATTER-OPEN":
    "Concept must begin with an exact YAML frontmatter delimiter.",
  "FRONTMATTER-CLOSE":
    "Concept YAML frontmatter has no exact closing delimiter.",
  "YAML-SYNTAX": "YAML frontmatter is malformed.",
  "YAML-UNSUPPORTED":
    "YAML frontmatter uses an unsupported feature or exceeds a structural limit.",
  "YAML-ROOT": "YAML frontmatter root must be a mapping.",
};

const remediations: Record<ConceptDiagnosticCode, string> = {
  "CONCEPT-SIZE": "Reduce the concept size below the configured limit.",
  "CONCEPT-UTF8": "Save the complete Markdown concept as valid UTF-8.",
  "FRONTMATTER-OPEN": "Place an unindented --- line at byte zero.",
  "FRONTMATTER-CLOSE": "Add an unindented --- line after the YAML mapping.",
  "YAML-SYNTAX":
    "Correct the YAML 1.2 syntax, duplicate key, or non-string key.",
  "YAML-UNSUPPORTED":
    "Use YAML 1.2 core values without aliases, custom tags, unsafe integers, or excessive nesting.",
  "YAML-ROOT": "Replace the frontmatter value with a string-keyed mapping.",
};

function diagnostic(
  code: ConceptDiagnosticCode,
  file: string,
  range?: SourceRange,
): ConceptDiagnostic {
  return {
    code,
    severity: "error",
    file,
    message: messages[code],
    remediation: remediations[code],
    ...(range === undefined ? {} : { range }),
  };
}

function fail(
  code: ConceptDiagnosticCode,
  file: string,
  range?: SourceRange,
): LoadConceptResult {
  return { ok: false, diagnostics: [diagnostic(code, file, range)] };
}

function validateLimit(
  name: string,
  value: number | undefined,
  maximum: number,
): number {
  if (value === undefined) return maximum;
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new TypeError(
      `${name} must be a positive integer no greater than ${maximum}`,
    );
  }
  return value;
}

function hasOpeningDelimiter(bytes: Uint8Array): boolean {
  return (
    (bytes[0] === 0x2d &&
      bytes[1] === 0x2d &&
      bytes[2] === 0x2d &&
      bytes[3] === 0x0a) ||
    (bytes[0] === 0x2d &&
      bytes[1] === 0x2d &&
      bytes[2] === 0x2d &&
      bytes[3] === 0x0d &&
      bytes[4] === 0x0a)
  );
}

function findEnvelope(source: string): FrontmatterEnvelope | undefined {
  const contentStart = source.startsWith("---\r\n") ? 5 : 4;
  let lineStart = contentStart;

  while (lineStart <= source.length) {
    const newline = source.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? source.length : newline;
    const contentEnd =
      lineEnd > lineStart && source.charCodeAt(lineEnd - 1) === 0x0d
        ? lineEnd - 1
        : lineEnd;

    if (source.slice(lineStart, contentEnd) === "---") {
      return {
        contentStart,
        contentEnd: lineStart,
        bodyStart: newline === -1 ? source.length : newline + 1,
      };
    }

    if (newline === -1) return undefined;
    lineStart = newline + 1;
  }

  return undefined;
}

function positionAt(source: string, offset: number): SourcePosition {
  const boundedOffset = Math.max(0, Math.min(offset, source.length));
  const prefix = source.slice(0, boundedOffset);
  const lastNewline = prefix.lastIndexOf("\n");
  const line = prefix.split("\n").length;
  const linePrefix = prefix.slice(lastNewline + 1);

  return {
    byteOffset: encoder.encode(prefix).byteLength,
    line,
    column: [...linePrefix].length + 1,
  };
}

function sourceRange(
  source: string,
  yamlStart: number,
  relativeStart: number,
  relativeEnd: number,
  relativeLimit = source.length - yamlStart,
): SourceRange {
  const boundedStart = Math.max(0, Math.min(relativeStart, relativeLimit));
  const boundedEnd = Math.max(
    boundedStart,
    Math.min(relativeEnd, relativeLimit),
  );
  return {
    start: positionAt(source, yamlStart + boundedStart),
    end: positionAt(source, yamlStart + boundedEnd),
  };
}

export function loadConcept(
  input: Uint8Array,
  options: LoadConceptOptions,
): LoadConceptResult {
  const maxBytes = validateLimit(
    "maxBytes",
    options.maxBytes,
    DEFAULT_MAX_CONCEPT_BYTES,
  );
  const maxDepth = validateLimit(
    "maxDepth",
    options.maxDepth,
    DEFAULT_MAX_YAML_DEPTH,
  );

  if (input.byteLength > maxBytes) {
    return fail("CONCEPT-SIZE", options.file);
  }

  const sourceBytes = Uint8Array.from(input);
  let source: string;
  try {
    source = decoder.decode(sourceBytes);
  } catch {
    return fail("CONCEPT-UTF8", options.file);
  }

  if (!hasOpeningDelimiter(sourceBytes)) {
    return fail(
      "FRONTMATTER-OPEN",
      options.file,
      sourceRange(source, 0, 0, Math.min(source.length, 3)),
    );
  }

  const envelope = findEnvelope(source);
  if (envelope === undefined) {
    const end = positionAt(source, source.length);
    return fail("FRONTMATTER-CLOSE", options.file, { start: end, end });
  }

  const frontmatterText = source.slice(
    envelope.contentStart,
    envelope.contentEnd,
  );
  const parsed = parseStrictYamlMapping(frontmatterText, maxDepth);
  if (!parsed.ok) {
    const code =
      parsed.code === "root"
        ? "YAML-ROOT"
        : parsed.code === "syntax"
          ? "YAML-SYNTAX"
          : "YAML-UNSUPPORTED";
    const range =
      parsed.range === undefined
        ? undefined
        : sourceRange(
            source,
            envelope.contentStart,
            parsed.range[0],
            parsed.range[1],
            frontmatterText.length,
          );
    return fail(code, options.file, range);
  }

  const frontmatter = parsed.value;

  const concept = Object.freeze({
    file: options.file,
    rawText: source,
    frontmatterText,
    frontmatter,
    bodyText: source.slice(envelope.bodyStart),
  }) as LoadedConcept;
  loadedConceptStates.set(concept, {
    document: parsed.document as Document,
    envelope,
    sourceBytes,
  });

  return { ok: true, concept, diagnostics: [] };
}

export function serializeConcept(concept: LoadedConcept): Uint8Array {
  const state = loadedConceptStates.get(concept);
  if (state === undefined) {
    throw new TypeError(
      "serializeConcept requires a concept returned by loadConcept",
    );
  }
  return Uint8Array.from(state.sourceBytes);
}

function withLineEnding(source: string, lineEnding: "\n" | "\r\n"): string {
  return lineEnding === "\n" ? source : source.replaceAll("\n", "\r\n");
}

export function createConceptSourceInternal(
  frontmatter: ReadonlyYamlMapping,
  bodyText: string,
): Uint8Array {
  const document = new Document(frontmatter, {
    schema: "core",
    version: "1.2",
  });
  const yaml = document.toString();
  return encoder.encode(`---\n${yaml}---\n${bodyText}`);
}

export function renderConceptSourceInternal(
  concept: LoadedConcept,
  edits: readonly ConceptMutationEditInternal[],
  bodyText: string | undefined,
): Uint8Array {
  const state = loadedConceptStates.get(concept);
  if (state === undefined) {
    throw new TypeError(
      "renderConceptSourceInternal requires a concept returned by loadConcept",
    );
  }

  const document = state.document.clone();
  for (const edit of edits) {
    if (edit.op === "set") document.setIn(edit.path, edit.value);
    else document.deleteIn(edit.path);
  }

  const lineEnding = concept.rawText.startsWith("---\r\n") ? "\r\n" : "\n";
  const renderedFrontmatter = withLineEnding(document.toString(), lineEnding);
  const prefix = concept.rawText.slice(0, state.envelope.contentStart);
  let suffix: string;
  if (bodyText === undefined) {
    suffix = concept.rawText.slice(state.envelope.contentEnd);
  } else {
    let closingDelimiter = concept.rawText.slice(
      state.envelope.contentEnd,
      state.envelope.bodyStart,
    );
    if (bodyText.length > 0 && !closingDelimiter.endsWith("\n")) {
      closingDelimiter += lineEnding;
    }
    suffix = `${closingDelimiter}${bodyText}`;
  }
  return encoder.encode(`${prefix}${renderedFrontmatter}${suffix}`);
}
