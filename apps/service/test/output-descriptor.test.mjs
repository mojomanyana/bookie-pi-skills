import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  encodeOutputDescriptor,
  parseOutputDescriptor,
} from "../dist/output-descriptor.js";

const sha = (bytes) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const empty = sha("");
const input = {
  recipeHash: `sha256:${"a".repeat(64)}`,
  canonical: { hash: `sha256:${"b".repeat(64)}`, bytes: 9, records: 1 },
  concepts: { count: 1, hash: `sha256:${"c".repeat(64)}` },
  chunks: { count: 2, hash: `sha256:${"d".repeat(64)}` },
};
const bad = { name: "TypeError", message: "Output descriptor is invalid." };

test("literal v1 output descriptor encoding is stable and round-trips canonically", () => {
  const encoded = encodeOutputDescriptor(input);
  const literal = `["bookie-build-output",1,"${input.recipeHash}","${input.canonical.hash}",9,1,1,"${input.concepts.hash}",2,"${input.chunks.hash}"]`;
  assert.equal(encoded.serialized, literal);
  assert.equal(
    encoded.hash,
    "sha256:3b9fb26ad300bdc85d6751ea30dad9ebbfaf959eba26c5573493c32a0fe6d550",
  );
  assert.equal(encoded.hash, sha(literal));
  assert.deepEqual(parseOutputDescriptor(literal), encoded);
  assert.ok(Object.isFrozen(encoded));
  assert.throws(() => {
    encoded.serialized = "changed";
  }, TypeError);
  assert.throws(() => parseOutputDescriptor(` ${literal}`), bad);
  assert.throws(() => parseOutputDescriptor(`${literal}\n`), bad);
});

test("hash tokens reject trailing line terminators in every field", () => {
  for (const suffix of ["\n", "\r", "\r\n", "\u2028", "\u2029"]) {
    for (const field of ["recipeHash", "canonical", "concepts", "chunks"]) {
      const value = structuredClone(input);
      if (field === "recipeHash") value.recipeHash += suffix;
      else value[field].hash += suffix;
      assert.throws(() => encodeOutputDescriptor(value), bad);
      const tuple = JSON.parse(encodeOutputDescriptor(input).serialized);
      tuple[{ recipeHash: 2, canonical: 3, concepts: 7, chunks: 9 }[field]] +=
        suffix;
      assert.throws(() => parseOutputDescriptor(JSON.stringify(tuple)), bad);
    }
  }
});

test("genuine empty included corpus is not a fabricated placeholder", () => {
  const encoded = encodeOutputDescriptor({
    recipeHash: input.recipeHash,
    canonical: { hash: empty, bytes: 0, records: 0 },
    concepts: { count: 0, hash: empty },
    chunks: { count: 0, hash: empty },
  });
  assert.equal(parseOutputDescriptor(encoded.serialized).hash, encoded.hash);
  for (const badInput of [
    { ...input, canonical: { hash: empty, bytes: 0, records: 1 } },
    { ...input, canonical: { hash: empty, bytes: 1, records: 0 } },
    { ...input, canonical: { hash: empty, bytes: 0, records: 0 } },
    { ...input, concepts: { count: 0, hash: input.concepts.hash } },
    { ...input, chunks: { count: 0, hash: input.chunks.hash } },
  ])
    assert.throws(() => encodeOutputDescriptor(badInput), bad);
});

test("counts, hashes, fields, hostile objects and malformed stored descriptors fail closed", () => {
  assert.ok(
    encodeOutputDescriptor({
      ...input,
      canonical: { ...input.canonical, bytes: 536870912, records: 50000 },
      concepts: { ...input.concepts, count: 50000 },
      chunks: { ...input.chunks, count: 250000 },
    }),
  );
  for (const badInput of [
    { ...input, canonical: { ...input.canonical, records: 2 } },
    { ...input, canonical: { ...input.canonical, bytes: 536870913 } },
    { ...input, canonical: { ...input.canonical, hash: empty } },
    { ...input, concepts: { ...input.concepts, hash: empty } },
    { ...input, chunks: { ...input.chunks, hash: empty } },
    { ...input, concepts: { ...input.concepts, count: 50001 } },
    { ...input, chunks: { ...input.chunks, count: 250001 } },
    { ...input, chunks: { ...input.chunks, count: -1 } },
    { ...input, chunks: { count: -0, hash: empty } },
    { ...input, concepts: { ...input.concepts, count: 1.5 } },
    { ...input, extra: "private" },
    { ...input, recipeHash: `sha256:${"A".repeat(64)}` },
  ])
    assert.throws(() => encodeOutputDescriptor(badInput), bad);
  let touched = false;
  const hostile = new Proxy(input, {
    ownKeys() {
      touched = true;
      throw Error("private");
    },
  });
  assert.throws(() => encodeOutputDescriptor(hostile), bad);
  assert.equal(touched, false);
  assert.throws(
    () =>
      encodeOutputDescriptor({
        ...input,
        canonical: {
          get hash() {
            throw Error("private");
          },
          bytes: 9,
          records: 1,
        },
      }),
    bad,
  );
  for (const value of ["", "null", "{}", "[0]", "private", "x".repeat(1025)])
    assert.throws(() => parseOutputDescriptor(value), bad);
  const encoded = encodeOutputDescriptor(input);
  const array = JSON.parse(encoded.serialized);
  array[0] = "bookie-build-output-other";
  assert.throws(() => parseOutputDescriptor(JSON.stringify(array)), bad);
  array[0] = "bookie-build-output";
  array[2] = `sha256:${"e".repeat(64)}`;
  assert.notEqual(
    parseOutputDescriptor(JSON.stringify(array)).hash,
    encoded.hash,
  );
});
