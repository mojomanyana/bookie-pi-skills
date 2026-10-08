import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { encodeBuildInputRecipe } from "../dist/build-recipe.js";

const vectors = JSON.parse(
  await readFile(
    new URL("./fixtures/build-recipe-v2.json", import.meta.url),
    "utf8",
  ),
);
const base = vectors[0].input;
const hash = (text) =>
  `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
const bad = { name: "TypeError", message: "Build recipe inputs are invalid." };
const encode = (patch = {}) =>
  encodeBuildInputRecipe({ ...structuredClone(base), ...patch });

test("v2 encoding matches independently calculated golden bytes, intermediate hashes and build IDs", () => {
  for (const {
    input,
    expected,
    scopeSerialized,
    policySerialized,
  } of vectors) {
    const result = encodeBuildInputRecipe(input);
    assert.deepEqual(result, expected);
    assert.deepEqual(
      Buffer.from(result.serialized),
      Buffer.from(expected.serialized),
    );
    assert.equal(result.scopeHash, hash(scopeSerialized));
    assert.equal(result.policyHash, hash(policySerialized));
    assert.equal(result.recipeHash, hash(result.serialized));
    assert.equal(result.buildId, `bld_${result.recipeHash.slice(7)}`);
    assert.equal(result.serialized.endsWith("\n"), false);
    assert.equal(JSON.parse(result.serialized).length, 17);
    assert.ok(Object.isFrozen(result));
  }
});

test("class ordering and object insertion order do not change a recipe; caller data is not retained or mutated", () => {
  const input = structuredClone(base);
  const before = structuredClone(input);
  const result = encodeBuildInputRecipe(input);
  assert.deepEqual(input, before);
  const reordered = Object.fromEntries(Object.entries(before).reverse());
  reordered.versions = Object.fromEntries(
    Object.entries(reordered.versions).reverse(),
  );
  reordered.policy = {
    ...reordered.policy,
    approvedSensitivityClasses: [
      ...reordered.policy.approvedSensitivityClasses,
    ].reverse(),
  };
  assert.deepEqual(encodeBuildInputRecipe(reordered), result);
  input.policy.approvedSensitivityClasses.length = 0;
  input.versions.parserVersion = "changed";
  input.vaultScope = "changed";
  assert.deepEqual(result, vectors[0].expected);
  assert.throws(() => {
    result.buildId = "changed";
  }, TypeError);
});

test("every output-affecting input changes identity, while scope and policy hashes remain independent", () => {
  const first = encode();
  for (const patch of [
    { vaultUid: "VLT-00000000000000000000000009" },
    { sourceCommit: "e".repeat(40) },
    { sourceCommit: "e".repeat(64), objectFormat: "sha256" },
    { vaultScope: "nested" },
    { manifestHash: `sha256:${"e".repeat(64)}` },
    { runtimeArtifactHash: `sha256:${"e".repeat(64)}` },
    { maxChunkBytes: 4096 },
    { policy: { ...base.policy, approvedSensitivityClasses: ["public"] } },
    { policy: { ...base.policy, secretPolicyVersion: "fixture-secret-2" } },
    ...Object.keys(base.versions).map((key) => ({
      versions: { ...base.versions, [key]: "changed-2" },
    })),
  ])
    assert.notEqual(encode(patch).buildId, first.buildId);
  assert.equal(encode({ vaultScope: "nested" }).policyHash, first.policyHash);
  assert.equal(
    encode({ policy: { ...base.policy, approvedSensitivityClasses: [] } })
      .scopeHash,
    first.scopeHash,
  );
  assert.notEqual(
    encode({ vaultScope: "é" }).buildId,
    encode({ vaultScope: "e\u0301" }).buildId,
  );
  assert.equal(
    encode({ vaultScope: 'nested/space "vault"-😀' }).serialized.includes(
      "nested/space",
    ),
    false,
  );
});

test("operational, authorization, host and output evidence fields have no codec input slot", () => {
  for (const key of [
    "approvedTip",
    "approvedRef",
    "rollbackWindow",
    "configurationEpoch",
    "ownerEpoch",
    "fence",
    "root",
    "repositoryRoot",
    "remoteUrl",
    "inode",
    "namespaceKey",
    "jobId",
    "requestId",
    "timeoutMs",
    "maxChunks",
    "maxConcepts",
    "canonicalOutputHash",
    "outputDescriptor",
  ]) {
    assert.throws(() => encode({ [key]: "PRIVATE" }), bad, key);
  }
  // Deliberately no adapter strips these fields: trusted assembly is still a gate.
  assert.deepEqual(encode(), vectors[0].expected);
});

test("missing fields, malformed hashes/commits, unsupported profile and non-lexical settings fail statically", () => {
  for (const key of Object.keys(base)) {
    const input = structuredClone(base);
    delete input[key];
    assert.throws(() => encodeBuildInputRecipe(input), bad, key);
  }
  for (const patch of [
    { vaultUid: `${base.vaultUid}\n` },
    { vaultUid: "PRIVATE" },
    { sourceCommit: "HEAD" },
    { sourceCommit: "A".repeat(40) },
    { sourceCommit: `${base.sourceCommit}\n` },
    { objectFormat: "sha256" },
    { sourceCommit: "a".repeat(64) },
    { objectFormat: "sha512" },
    { profile: "2.0" },
    { embeddingGeneration: undefined },
    { embeddingGeneration: "gen-1" },
    ...["manifestHash", "runtimeArtifactHash"].flatMap((key) =>
      [
        null,
        "PRIVATE",
        "sha256:" + "a".repeat(63),
        "sha256:" + "A".repeat(64),
        "sha256:" + "a".repeat(64) + "\n",
      ].map((value) => ({ [key]: value })),
    ),
    ...[0, 15, 65537, NaN, Infinity, 1.5, "8192"].map((maxChunkBytes) => ({
      maxChunkBytes,
    })),
  ])
    assert.throws(() => encode(patch), bad);
  for (const value of [null, [], 1, "PRIVATE"])
    assert.throws(() => encodeBuildInputRecipe(value), bad);
});

test("policy and version inputs are explicit, bounded data with mandatory detection and no provider", () => {
  for (const key of Object.keys(base.policy)) {
    const policy = { ...base.policy };
    delete policy[key];
    assert.throws(() => encode({ policy }), bad);
  }
  for (const patch of [
    { secretPolicy: "allow-unchecked" },
    { secretPolicyVersion: "" },
    { provider: "remote" },
    { extra: true },
    ...[
      null,
      Array(1),
      ["public", "public"],
      ["unknown"],
      ["unclassified"],
      ["Public"],
      ["public\n"],
      ["a".repeat(64)],
      Array.from({ length: 65 }, (_, i) => `c-${i}`),
    ].map((approvedSensitivityClasses) => ({ approvedSensitivityClasses })),
  ])
    assert.throws(() => encode({ policy: { ...base.policy, ...patch } }), bad);
  for (const key of Object.keys(base.versions)) {
    for (const value of [
      undefined,
      "",
      "x".repeat(129),
      "private\n",
      "bad space",
      1,
    ]) {
      assert.throws(
        () => encode({ versions: { ...base.versions, [key]: value } }),
        bad,
      );
    }
  }
  assert.throws(
    () => encode({ versions: { ...base.versions, extra: "x" } }),
    bad,
  );
  const maximum = Array.from({ length: 64 }, (_, i) => `c-${i}`);
  assert.ok(
    encode({
      policy: { ...base.policy, approvedSensitivityClasses: maximum },
      maxChunkBytes: 65536,
    }),
  );
  assert.ok(
    encode({ versions: { ...base.versions, parserVersion: "x".repeat(128) } }),
  );
});

test("scope uses exact scalar POSIX spelling and fails at path, segment and depth boundaries", () => {
  for (const vaultScope of [
    "/absolute",
    ".",
    "..",
    "a/../b",
    "a//b",
    "a/",
    "a/./b",
    "a/.GiT/b",
    "a\\b",
    "a\n",
    "\ud800",
    "a".repeat(256),
    Array(65).fill("a").join("/"),
    Array(17).fill("a".repeat(255)).join("/"),
  ])
    assert.throws(() => encode({ vaultScope }), bad);
  for (const vaultScope of [
    "",
    "a".repeat(255),
    Array(64).fill("a").join("/"),
    "😀".repeat(63),
    "colon:percent%/space name",
  ])
    assert.ok(encode({ vaultScope }));
  assert.throws(() => encode({ vaultScope: "😀".repeat(64) }), bad);
  const maximum = [
    ...Array(15).fill("a".repeat(255)),
    "a".repeat(254),
    "a",
  ].join("/");
  assert.equal(Buffer.byteLength(maximum), 4096);
  assert.ok(encode({ vaultScope: maximum }));
  const boundary = [...Array(16).fill("a".repeat(255)), "a"].join("/");
  assert.equal(Buffer.byteLength(boundary), 4097);
  assert.throws(() => encode({ vaultScope: boundary }), bad);
});

test("REV-SPEC-001: class arrays are closed snapshots, and proxies cannot expand work or execute traps", () => {
  for (const key of ["extra", Symbol("extra")]) {
    for (const descriptor of [
      { value: "PRIVATE" },
      {
        get() {
          throw new Error("PRIVATE");
        },
      },
    ]) {
      const classes = ["public"];
      Object.defineProperty(classes, key, descriptor);
      assert.throws(
        () =>
          encode({
            policy: { ...base.policy, approvedSensitivityClasses: classes },
          }),
        bad,
      );
    }
  }
  let seen = 0;
  const changing = new Proxy([], {
    get(target, key, receiver) {
      if (key === "length") return seen++ === 0 ? 1 : 65;
      return Reflect.get(target, key, receiver);
    },
    getOwnPropertyDescriptor(target, key) {
      if (/^(?:[0-9]|[1-5][0-9]|6[0-4])$/.test(String(key)))
        return {
          configurable: true,
          enumerable: true,
          writable: true,
          value: `c-${key}`,
        };
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  assert.throws(
    () =>
      encode({
        policy: { ...base.policy, approvedSensitivityClasses: changing },
      }),
    bad,
  );
  assert.equal(
    seen,
    0,
    "proxy input must be rejected before observing executable properties",
  );
  let executed = false;
  const input = new Proxy(base, {
    ownKeys() {
      executed = true;
      throw new Error("PRIVATE");
    },
  });
  assert.throws(() => encodeBuildInputRecipe(input), bad);
  assert.equal(executed, false);
});

test("codec declarations work in an external TypeScript consumer without ambient Node or private types", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bookie-recipe-consumer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const api = fileURLToPath(
    new URL("../dist/build-recipe.js", import.meta.url),
  );
  await writeFile(
    join(root, "consumer.mts"),
    `
    import { encodeBuildInputRecipe, type BuildRecipeInputs } from ${JSON.stringify(api)};
    const input: BuildRecipeInputs = ${JSON.stringify(base)};
    const output = encodeBuildInputRecipe(input);
    const id: \`bld_\${string}\` = output.buildId;
    // @ts-expect-error output is readonly
    output.serialized = 'changed';
    // @ts-expect-error vectors/providers are not lexical inputs
    input.policy.provider = 'remote';
  `,
  );
  await writeFile(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        module: "NodeNext",
        moduleResolution: "NodeNext",
        target: "ES2023",
        lib: ["ES2023"],
        types: [],
      },
      files: ["consumer.mts"],
    }),
  );
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(
        new URL("../../../node_modules/typescript/bin/tsc", import.meta.url),
      ),
      "-p",
      root,
    ],
    { encoding: "utf8", timeout: 30000 },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("accessors and serialization hooks cannot inject hidden input or raw diagnostics", () => {
  const input = structuredClone(base);
  Object.defineProperty(input, "vaultUid", {
    get() {
      throw new Error("PRIVATE");
    },
  });
  assert.throws(() => encodeBuildInputRecipe(input), bad);
  assert.throws(
    () =>
      encode({
        toJSON() {
          throw new Error("PRIVATE");
        },
      }),
    bad,
  );
  const policy = { ...base.policy };
  Object.defineProperty(policy, "secretPolicy", {
    get() {
      throw new Error("PRIVATE");
    },
  });
  assert.throws(() => encode({ policy }), bad);
});
