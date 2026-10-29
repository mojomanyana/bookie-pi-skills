import { createHash } from "node:crypto";
import { types } from "node:util";
import type {
  ConceptProjection,
  ChunkProjection,
  LexicalProjection,
} from "./projection.js";

const digest = /^sha256:[a-f0-9]{64}$/u;
const commit = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const empty = `sha256:${createHash("sha256").digest("hex")}`;

function streamHash(
  rows: readonly (ConceptProjection | ChunkProjection)[],
  sourceCommit: string,
  chunks: boolean,
): string | undefined {
  const hash = createHash("sha256");
  for (const [ordinal, row] of rows.entries()) {
    if (
      row === null ||
      typeof row !== "object" ||
      types.isProxy(row) ||
      row.sourceCommit !== sourceCommit ||
      (chunks && (row as ChunkProjection).ordinal !== ordinal)
    )
      return undefined;
    const json = JSON.stringify(row);
    if (typeof json !== "string") return undefined;
    hash.update(json, "utf8");
    hash.update("\n", "utf8");
  }
  return `sha256:${hash.digest("hex")}`;
}

/**
 * Internal isolated-builder integrity check after complete projection. This does
 * not approve a Git source, authorize a recipe, attest runtime provenance or
 * verify Redis content. When supplied, canonical must be measured independently
 * over the actual validated export sink bytes, never reconstructed projections.
 * A false result is failure, never a valid empty corpus.
 */
export function verifyPreparedProjection(
  value: LexicalProjection,
  canonical?: Readonly<{ hash: string; bytes: number; records: number }>,
): boolean {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      types.isProxy(value) ||
      typeof value.sourceCommit !== "string" ||
      !commit.test(value.sourceCommit) ||
      !Array.isArray(value.concepts) ||
      types.isProxy(value.concepts) ||
      !Array.isArray(value.chunks) ||
      types.isProxy(value.chunks) ||
      value.concepts.length > 50_000 ||
      value.chunks.length > 250_000 ||
      value.canonicalOutput === null ||
      typeof value.canonicalOutput !== "object" ||
      types.isProxy(value.canonicalOutput) ||
      typeof value.canonicalOutput.hash !== "string" ||
      !digest.test(value.canonicalOutput.hash) ||
      !Number.isSafeInteger(value.canonicalOutput.bytes) ||
      value.canonicalOutput.bytes < 0 ||
      value.canonicalOutput.bytes > 536_870_912 ||
      value.canonicalOutput.records !== value.concepts.length ||
      typeof value.conceptStreamHash !== "string" ||
      !digest.test(value.conceptStreamHash) ||
      typeof value.chunkStreamHash !== "string" ||
      !digest.test(value.chunkStreamHash) ||
      (value.concepts.length === 0
        ? value.canonicalOutput.bytes !== 0 ||
          value.canonicalOutput.hash !== empty ||
          value.chunks.length !== 0
        : value.canonicalOutput.bytes === 0 ||
          value.canonicalOutput.hash === empty)
    )
      return false;
    return (
      (canonical === undefined ||
        (value.canonicalOutput.hash === canonical.hash &&
          value.canonicalOutput.bytes === canonical.bytes &&
          value.canonicalOutput.records === canonical.records)) &&
      streamHash(value.concepts, value.sourceCommit, false) ===
        value.conceptStreamHash &&
      streamHash(value.chunks, value.sourceCommit, true) ===
        value.chunkStreamHash
    );
  } catch {
    // Private IPC failure returns a static mismatch without leaking record data.
    return false;
  }
}
