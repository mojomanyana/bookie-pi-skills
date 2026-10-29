import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";
import {
  prepareLexicalProjection,
  verifyCompleteProjection,
} from "../dist/projection.js";
import { verifyPreparedProjection } from "../dist/projection-evidence.js";

const hash = (text) =>
  `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
const vault = resolve(import.meta.dirname, "../../../examples/vault");
const result = spawnSync("git", ["-C", vault, "rev-parse", "HEAD"], {
  encoding: "utf8",
});
assert.equal(result.status, 0, result.stderr);
const sourceRef = result.stdout.trim();
const prepare = () =>
  prepareLexicalProjection(vault, {
    sourceRef,
    config: {
      vaultUid: "VLT-01ARZ3NDEKTSV4RRFFQ69G5FAY",
      approvedSensitivityClasses: ["public", "internal"],
      maxChunkBytes: 8192,
      maxChunks: 250000,
    },
  });

test("complete prepared projection evidence can be remeasured without changing its legacy identity", async () => {
  const prepared = await prepare();
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  assert.equal(verifyPreparedProjection(prepared.projection), true);
  assert.equal(verifyCompleteProjection(prepared.projection), true);
  assert.equal(
    verifyCompleteProjection(structuredClone(prepared.projection)),
    false,
    "a structural receipt, even byte-for-byte equal, has no private sink witness",
  );
  assert.match(prepared.projection.buildId, /^bld_[a-f0-9]{64}$/);
  const empty = hash("");
  const emptyIncluded = {
    ...prepared.projection,
    canonicalOutput: { hash: empty, bytes: 0, records: 0 },
    conceptStreamHash: empty,
    chunkStreamHash: empty,
    concepts: [],
    chunks: [],
  };
  // This is a shape/integrity check, not source authorization; zero is valid only
  // when the complete canonical export actually yielded an empty included corpus.
  assert.equal(verifyPreparedProjection(emptyIncluded), true);
  assert.equal(verifyCompleteProjection(emptyIncluded), false);
  assert.equal(
    verifyPreparedProjection({
      ...emptyIncluded,
      sourceCommit: `${emptyIncluded.sourceCommit}\n`,
    }),
    false,
  );
});

test("mismatch, malformed receipts, unsafe objects and count boundaries fail closed", async () => {
  const prepared = await prepare();
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  const original = prepared.projection;
  const mutate = (patch) => ({ ...original, ...patch });
  assert.equal(
    verifyPreparedProjection(mutate({ conceptStreamHash: hash("private") })),
    false,
  );
  assert.equal(
    verifyPreparedProjection(
      mutate({
        chunks: [
          { ...original.chunks[0], text: "TAMPER" },
          ...original.chunks.slice(1),
        ],
      }),
    ),
    false,
  );
  assert.equal(
    verifyPreparedProjection(
      mutate({ canonicalOutput: { ...original.canonicalOutput, records: 0 } }),
    ),
    false,
  );
  assert.equal(
    verifyPreparedProjection(
      mutate({
        canonicalOutput: { ...original.canonicalOutput, bytes: 536870913 },
      }),
    ),
    false,
  );
  assert.equal(
    verifyPreparedProjection(
      mutate({ canonicalOutput: { ...original.canonicalOutput, hash: "bad" } }),
    ),
    false,
  );
  assert.equal(
    verifyPreparedProjection(
      mutate({
        canonicalOutput: {
          ...original.canonicalOutput,
          hash: `${original.canonicalOutput.hash}\n`,
        },
      }),
    ),
    false,
  );
  assert.equal(verifyPreparedProjection(mutate({ concepts: [] })), false);
  assert.equal(verifyPreparedProjection(mutate({ chunks: null })), false);
  let executed = false;
  const forgedHash = {
    toString() {
      executed = true;
      return original.canonicalOutput.hash;
    },
  };
  assert.equal(
    verifyPreparedProjection(
      mutate({
        canonicalOutput: { ...original.canonicalOutput, hash: forgedHash },
      }),
    ),
    false,
  );
  assert.equal(
    executed,
    false,
    "non-string receipts must not execute coercion hooks",
  );
  assert.equal(
    verifyPreparedProjection(
      mutate({
        chunks: [
          { ...original.chunks[0], ordinal: -1 },
          ...original.chunks.slice(1),
        ],
      }),
    ),
    false,
  );
  const hostile = structuredClone(original);
  Object.defineProperty(hostile.chunks[0], "text", {
    get() {
      throw Error("PRIVATE");
    },
  });
  assert.equal(verifyPreparedProjection(hostile), false);
  assert.equal(
    verifyPreparedProjection(original),
    true,
    "failed checks must not mutate the source projection",
  );
});
