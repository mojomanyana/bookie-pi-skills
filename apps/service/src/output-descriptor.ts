import { createHash } from "node:crypto";
import { types } from "node:util";

/** Private, disconnected v2 candidate-manifest output evidence (format 1). */
export interface OutputDescriptorInputs {
  readonly recipeHash: string;
  readonly canonical: Readonly<{
    hash: string;
    bytes: number;
    records: number;
  }>;
  readonly concepts: Readonly<{ count: number; hash: string }>;
  readonly chunks: Readonly<{ count: number; hash: string }>;
}
export interface EncodedOutputDescriptor {
  readonly serialized: string;
  readonly hash: `sha256:${string}`;
}
const empty = `sha256:${createHash("sha256").update("").digest("hex")}`;
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
function invalid(): never {
  throw new TypeError("Output descriptor is invalid.");
}
function fields(value: unknown, keys: readonly string[]): readonly unknown[] {
  if (
    value === null ||
    typeof value !== "object" ||
    types.isProxy(value) ||
    Array.isArray(value)
  )
    invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== keys.length) invalid();
  return keys.map((key) => {
    const field = descriptors[key];
    if (
      !Object.hasOwn(descriptors, key) ||
      field === undefined ||
      !Object.hasOwn(field, "value")
    )
      invalid();
    return field.value as unknown;
  });
}
function hash(value: unknown): value is string {
  return typeof value === "string" && digestPattern.test(value);
}
function count(value: unknown, maximum: number): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    !Object.is(value, -0) &&
    value <= maximum
  );
}
/** Encodes only evidence supplied by a completely validated builder; does not attest it. */
export function encodeOutputDescriptor(
  input: OutputDescriptorInputs,
): EncodedOutputDescriptor {
  try {
    const [recipeHash, canonical, concepts, chunks] = fields(input, [
      "recipeHash",
      "canonical",
      "concepts",
      "chunks",
    ]);
    const [canonicalHash, bytes, records] = fields(canonical, [
      "hash",
      "bytes",
      "records",
    ]);
    const [conceptCount, conceptHash] = fields(concepts, ["count", "hash"]);
    const [chunkCount, chunkHash] = fields(chunks, ["count", "hash"]);
    if (
      !hash(recipeHash) ||
      !hash(canonicalHash) ||
      !hash(conceptHash) ||
      !hash(chunkHash) ||
      !count(bytes, 536870912) ||
      !count(records, 50000) ||
      !count(conceptCount, 50000) ||
      !count(chunkCount, 250000) ||
      records !== conceptCount ||
      (records === 0 &&
        (bytes !== 0 || canonicalHash !== empty || chunkCount !== 0)) ||
      (records > 0 && (bytes === 0 || canonicalHash === empty)) ||
      (conceptCount === 0 ? conceptHash !== empty : conceptHash === empty) ||
      (chunkCount === 0 ? chunkHash !== empty : chunkHash === empty)
    )
      invalid();
    const serialized = JSON.stringify([
      "bookie-build-output",
      1,
      recipeHash,
      canonicalHash,
      bytes,
      records,
      conceptCount,
      conceptHash,
      chunkCount,
      chunkHash,
    ]);
    return Object.freeze({
      serialized,
      hash: `sha256:${createHash("sha256").update(serialized, "utf8").digest("hex")}` as const,
    });
  } catch {
    invalid();
  }
}
/** Rejects corrupt, ambiguous and non-canonical stored descriptors, including placeholders. */
export function parseOutputDescriptor(
  serialized: string,
): EncodedOutputDescriptor {
  try {
    if (
      typeof serialized !== "string" ||
      Buffer.byteLength(serialized, "utf8") > 1024
    )
      invalid();
    const tuple: unknown = JSON.parse(serialized);
    if (
      !Array.isArray(tuple) ||
      tuple.length !== 10 ||
      tuple[0] !== "bookie-build-output" ||
      tuple[1] !== 1
    )
      invalid();
    const result = encodeOutputDescriptor({
      recipeHash: tuple[2],
      canonical: { hash: tuple[3], bytes: tuple[4], records: tuple[5] },
      concepts: { count: tuple[6], hash: tuple[7] },
      chunks: { count: tuple[8], hash: tuple[9] },
    });
    if (result.serialized !== serialized) invalid();
    return result;
  } catch {
    invalid();
  }
}
