import { createHash } from "node:crypto";
import { parentPort } from "node:worker_threads";

import type {
  CanonicalJsonlExportSuccess,
  CanonicalJsonlRecordV1,
} from "@bookie/core";
import { fromMarkdown } from "mdast-util-from-markdown";
import type { Nodes, Root } from "mdast";

import type {
  ChunkProjection,
  ConceptProjection,
  PrepareProjectionResult,
  ProjectionConfig,
} from "./projection.js";
import { PROJECTION_VERSIONS as versions } from "./build-input-versions.js";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function streamHash(
  records: readonly (ConceptProjection | ChunkProjection)[],
): string {
  const digest = createHash("sha256");
  for (const record of records)
    digest.update(`${JSON.stringify(record)}\n`, "utf8");
  return `sha256:${digest.digest("hex")}`;
}

function object(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function headingText(node: Nodes): string {
  if (node.type === "text" || node.type === "inlineCode") return node.value;
  if (node.type === "image" || node.type === "imageReference")
    return node.alt ?? "";
  return "children" in node ? node.children.map(headingText).join("") : "";
}

function links(root: Root): readonly string[] {
  const definitions = new Map<string, string>();
  const destinations: string[] = [];
  const walk = (node: Nodes, visit: (node: Nodes) => void): void => {
    visit(node);
    if ("children" in node)
      for (const child of node.children) walk(child, visit);
  };
  walk(root, (node) => {
    if (node.type === "definition" && !definitions.has(node.identifier)) {
      definitions.set(node.identifier, node.url);
    }
  });
  walk(root, (node) => {
    if (node.type === "link" || node.type === "image")
      destinations.push(node.url);
    else if (node.type === "linkReference" || node.type === "imageReference") {
      const destination = definitions.get(node.identifier);
      if (destination !== undefined) destinations.push(destination);
    }
  });
  return [...new Set(destinations)];
}

function* sections(
  body: string,
  root: Root,
): Generator<{
  heading: string | null;
  headingPath: readonly string[];
  text: string;
}> {
  const stack: { depth: number; title: string }[] = [];
  let heading: string | null = null;
  let headingPath: readonly string[] = [];
  let start = 0;
  for (const node of root.children) {
    if (node.type !== "heading") continue;
    const offset = node.position?.start.offset;
    if (offset === undefined) throw new Error("Missing Markdown offset.");
    yield { heading, headingPath, text: body.slice(start, offset) };
    while (stack.length > 0 && (stack.at(-1)?.depth ?? 0) >= node.depth)
      stack.pop();
    heading = headingText(node);
    stack.push({ depth: node.depth, title: heading });
    headingPath = stack.map(({ title }) => title);
    // Keep headings searchable, including a section containing only a heading.
    start = offset;
  }
  yield { heading, headingPath, text: body.slice(start) };
}

function* splitUtf8(text: string, maximum: number): Generator<string> {
  let current = "";
  let bytes = 0;
  for (const scalar of text.trim()) {
    const size = Buffer.byteLength(scalar, "utf8");
    if (bytes + size > maximum) {
      yield current;
      current = "";
      bytes = 0;
    }
    current += scalar;
    bytes += size;
  }
  if (current !== "") yield current;
}

function metadata(
  record: CanonicalJsonlRecordV1,
  root: Root,
): ConceptProjection {
  const fm = record.frontmatter;
  const bookie = fm.bookie;
  // Core already validated the complete record; fail closed if that boundary drifts.
  if (
    !object(bookie) ||
    typeof bookie.sensitivity !== "string" ||
    typeof fm.status !== "string"
  ) {
    throw new Error("Invalid validated record.");
  }
  const verified = Array.isArray(fm.verified)
    ? fm.verified
    : object(fm.verified)
      ? [fm.verified]
      : [];
  const verifiedBy = verified.map((event) => {
    if (!object(event) || typeof event.by !== "string")
      throw new Error("Invalid verification metadata.");
    return event.by;
  });
  const relations = Array.isArray(bookie.relations)
    ? bookie.relations.map((relation) => {
        if (
          !object(relation) ||
          typeof relation.kind !== "string" ||
          typeof relation.target !== "string"
        ) {
          throw new Error("Invalid relation metadata.");
        }
        return {
          kind: relation.kind,
          target: relation.target,
          targetUid:
            typeof relation.target_uid === "string"
              ? relation.target_uid
              : null,
        };
      })
    : [];
  return {
    uid: record.uid,
    path: record.path,
    type: record.type,
    title: record.title,
    project: typeof bookie.project === "string" ? bookie.project : null,
    lifecycle: fm.status,
    workflow: typeof bookie.state === "string" ? bookie.state : null,
    sensitivity: bookie.sensitivity,
    tags: Array.isArray(fm.tags)
      ? fm.tags.map((tag) => {
          if (typeof tag !== "string") throw new Error("Invalid tag metadata.");
          return tag;
        })
      : [],
    links: links(root),
    trust:
      verifiedBy.length > 0
        ? "verified"
        : Array.isArray(fm.sources) && fm.sources.length > 0
          ? "declared"
          : "unverified",
    verifiedBy: [...new Set(verifiedBy)],
    staleAfter: typeof fm.stale_after === "string" ? fm.stale_after : null,
    relations,
    sourceCommit: record.source_commit,
    sourceHash: record.source_hash,
    projectionSchemaVersion: versions.projectionSchemaVersion,
    contentTrust: "untrusted",
  };
}

interface ProjectionInput {
  readonly records: readonly CanonicalJsonlRecordV1[];
  readonly source: CanonicalJsonlExportSuccess;
  readonly config: ProjectionConfig;
}

function project({
  records,
  source,
  config,
}: ProjectionInput): PrepareProjectionResult {
  const concepts: ConceptProjection[] = [];
  const chunks: ChunkProjection[] = [];
  // Core's canonical export already uses locale-independent UID ordering.
  for (const record of records) {
    const root = fromMarkdown(record.body_markdown);
    const concept = metadata(record, root);
    concepts.push(concept);
    for (const section of sections(record.body_markdown, root)) {
      for (const text of splitUtf8(section.text, config.maxChunkBytes)) {
        if (chunks.length === config.maxChunks)
          return { ok: false, reason: "incomplete" };
        chunks.push({
          ...concept,
          ordinal: chunks.length,
          heading: section.heading,
          headingPath: section.headingPath,
          text,
          chunkerVersion: versions.chunkerVersion,
          embeddingGeneration: null,
        });
      }
    }
  }
  const policyHash = `sha256:${hash(JSON.stringify({ approvedSensitivityClasses: config.approvedSensitivityClasses, secretPolicy: "reject-detected" }))}`;
  const identity = {
    vaultUid: source.sourceManifest.vaultUid,
    sourceCommit: source.sourceCommit,
    profile: source.sourceManifest.profile,
    manifestHash: source.sourceManifest.hash,
    policyHash,
    versions,
    maxChunkBytes: config.maxChunkBytes,
    canonicalOutputHash: source.outputHash,
    embeddingGeneration: null,
  };
  return {
    ok: true,
    projection: {
      buildId: `bld_${hash(JSON.stringify(identity))}`,
      sourceCommit: source.sourceCommit,
      profile: source.sourceManifest.profile,
      manifestHash: source.sourceManifest.hash,
      policyHash,
      versions,
      canonicalOutput: {
        hash: source.outputHash,
        bytes: source.byteLength,
        records: source.recordCount,
      },
      conceptStreamHash: streamHash(concepts),
      chunkStreamHash: streamHash(chunks),
      concepts,
      chunks,
    },
  };
}

const port = parentPort;
if (port === null) throw new Error("Projection worker requires a parent port.");
port.once("message", (input: ProjectionInput) => {
  try {
    port.postMessage(project(input));
  } catch {
    // Never forward canonical text or raw parser errors out of the worker.
    port.postMessage({ ok: false, reason: "projection-error" });
  } finally {
    port.close();
  }
});
