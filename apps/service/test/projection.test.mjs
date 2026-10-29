import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createHook } from "node:async_hooks";
import {
  cp,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { exportCanonicalJsonl } from "@bookie/core";
import {
  encodeOutputDescriptor,
  parseOutputDescriptor,
} from "../dist/output-descriptor.js";
import {
  CANONICAL_EXPORT_VERSION,
  PROJECTION_VERSIONS,
} from "../dist/build-input-versions.js";
import * as projectionApi from "../dist/projection.js";
const { prepareLexicalProjection } = projectionApi;
const fixture = resolve(import.meta.dirname, "../../../fixtures/valid-vault");
const documentPath = "projects/fixture/documents/document.md";
const config = {
  vaultUid: "VLT-00000000000000000000000009",
  approvedSensitivityClasses: ["public"],
  maxChunkBytes: 64,
  maxChunks: 250_000,
};

function git(root, args) {
  const result = spawnSync(
    "git",
    [
      "-c",
      "user.name=Bookie Projection Tests",
      "-c",
      "user.email=projection@example.invalid",
      "-c",
      "commit.gpgSign=false",
      "-C",
      root,
      ...args,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function rewrite(root, path, mutate, body) {
  const source = await readFile(join(root, path), "utf8");
  const match = /^---\n([^\n]+)\n---\n([\s\S]*)$/u.exec(source);
  assert.ok(match);
  const frontmatter = JSON.parse(match[1]);
  mutate(frontmatter);
  await writeFile(
    join(root, path),
    `---\n${JSON.stringify(frontmatter)}\n---\n${body ?? match[2]}`,
  );
}

async function classify(root, sensitivity) {
  for (const path of await readdir(root, { recursive: true })) {
    if (path.endsWith(".md") && !path.endsWith("index.md")) {
      await rewrite(root, path, (fm) => {
        fm.bookie.sensitivity = sensitivity;
      });
    }
  }
}

async function vault(t, change = async () => {}) {
  const root = await mkdtemp(join(tmpdir(), "bookie-projection-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(fixture, root, { recursive: true });
  await classify(root, "public");
  await change(root);
  git(root, ["init", "-q"]);
  return { root, commit: commitVault(root) };
}

function commitVault(root) {
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "--no-gpg-sign", "-m", "projection fixture"]);
  return git(root, ["rev-parse", "HEAD"]);
}

const prepare = ({ root, commit }, overrides = {}, options = {}) =>
  prepareLexicalProjection(root, {
    sourceRef: commit,
    config: { ...config, ...overrides },
    ...options,
  });

async function sensitivityManifest(root, excluded = []) {
  const path = join(root, "bookie.yaml");
  const source = await readFile(path, "utf8");
  await writeFile(
    path,
    source
      .replace("      - public", "      - public\n      - restricted")
      .replace(
        "    excluded_classes: []",
        `    excluded_classes: ${JSON.stringify(excluded)}`,
      ),
  );
}

test("projection is deterministic, exact-commit cited, and has no unchecked record API", async (t) => {
  assert.equal("projectCanonicalRecords" in projectionApi, false);
  const source = await vault(t);
  const first = await prepare(source);
  assert.equal(first.ok, true, JSON.stringify(first));
  const second = await prepare(source);
  assert.deepEqual(first, second);
  const { projection } = first;
  assert.match(projection.buildId, /^bld_[0-9a-f]{64}$/u);
  assert.equal(projection.sourceCommit, source.commit);
  assert.equal(projection.profile, "1.0");
  assert.equal(projection.concepts.length, 8);
  assert.deepEqual(projection.versions, PROJECTION_VERSIONS);
  const receipt = await exportCanonicalJsonl(source.root, {
    sourceRef: source.commit,
    write() {},
  });
  assert.equal(receipt.ok, true, JSON.stringify(receipt));
  assert.equal(receipt.schemaVersion, CANONICAL_EXPORT_VERSION);
  assert.deepEqual(projection.canonicalOutput, {
    hash: receipt.outputHash,
    bytes: receipt.byteLength,
    records: receipt.recordCount,
  });
  const streamHash = (records) =>
    `sha256:${createHash("sha256")
      .update(
        records.map((record) => `${JSON.stringify(record)}\n`).join(""),
        "utf8",
      )
      .digest("hex")}`;
  assert.equal(projection.conceptStreamHash, streamHash(projection.concepts));
  assert.equal(projection.chunkStreamHash, streamHash(projection.chunks));
  const descriptor = encodeOutputDescriptor({
    recipeHash: `sha256:${"a".repeat(64)}`,
    canonical: projection.canonicalOutput,
    concepts: {
      count: projection.concepts.length,
      hash: projection.conceptStreamHash,
    },
    chunks: {
      count: projection.chunks.length,
      hash: projection.chunkStreamHash,
    },
  });
  assert.deepEqual(parseOutputDescriptor(descriptor.serialized), descriptor);
  assert.equal(
    descriptor.serialized.includes(projection.concepts[0].uid),
    false,
  );
  assert.equal(
    projection.manifestHash,
    `sha256:${createHash("sha256")
      .update(await readFile(join(source.root, "bookie.yaml")))
      .digest("hex")}`,
  );
  assert.ok(projection.chunks.length > 0);
  assert.ok(
    projection.chunks.every(
      (chunk, ordinal) =>
        chunk.ordinal === ordinal &&
        chunk.sourceCommit === source.commit &&
        /^sha256:[a-f0-9]{64}$/u.test(chunk.sourceHash) &&
        chunk.contentTrust === "untrusted" &&
        Buffer.byteLength(chunk.text) <= config.maxChunkBytes &&
        chunk.embeddingGeneration === null &&
        chunk.projectionSchemaVersion ===
          projection.versions.projectionSchemaVersion,
    ),
  );
  assert.deepEqual(
    projection.concepts.map((c) => c.uid),
    projection.concepts.map((c) => c.uid).sort(),
  );
  await writeFile(join(source.root, "bookie.yaml"), "invalid working tree\n");
  await writeFile(join(source.root, documentPath), "uncommitted changes\n");
  assert.deepEqual(await prepare(source), first);
});

test("heading-aware chunks preserve formatted labels, code fences, links, and UTF-8 boundaries", async (t) => {
  const source = await vault(t, async (root) => {
    await rewrite(
      root,
      documentPath,
      (fm) => {
        fm.tags = ["redis", "design"];
      },
      `Intro.\n\n## Use \`Redis\` ![diagram](https://example.invalid/a.png)\n\n${"😀".repeat(20)}\n\n### Risk\n\n\`\`\`md\n# Not a heading\n\`\`\`\n\n[Reference][ref]\n\n[ref]: https://example.invalid/ref\n\nLast heading\n============\n`,
    );
  });
  const result = await prepare(source, { maxChunkBytes: 17 });
  assert.equal(result.ok, true, JSON.stringify(result));
  const chunks = result.projection.chunks.filter(
    (c) => c.path === `/${documentPath}`,
  );
  assert.deepEqual(
    [...new Set(chunks.map((c) => c.heading))],
    [null, "Use Redis diagram", "Risk", "Last heading"],
  );
  assert.deepEqual(chunks.find((c) => c.heading === "Risk").headingPath, [
    "Use Redis diagram",
    "Risk",
  ]);
  assert.deepEqual(chunks.at(-1).headingPath, ["Last heading"]);
  assert.ok(
    chunks.every(
      (c) => Buffer.byteLength(c.text) <= 17 && !c.text.includes("�"),
    ),
  );
  const concept = result.projection.concepts.find(
    (c) => c.path === `/${documentPath}`,
  );
  assert.deepEqual(concept.tags, ["redis", "design"]);
  assert.deepEqual(concept.links, [
    "https://example.invalid/a.png",
    "https://example.invalid/ref",
  ]);
});

test("single and array verification events retain trust and verifier identity", async (t) => {
  const source = await vault(t, async (root) => {
    await rewrite(root, documentPath, (fm) => {
      fm.verified = { by: "human:alice", at: "2026-09-14T00:00:00Z" };
      fm.stale_after = "2026-10-01";
    });
  });
  const first = await prepare(source);
  assert.equal(first.ok, true, JSON.stringify(first));
  const concept = first.projection.concepts.find(
    (c) => c.path === `/${documentPath}`,
  );
  assert.equal(concept.trust, "verified");
  assert.deepEqual(concept.verifiedBy, ["human:alice"]);
  assert.equal(concept.staleAfter, "2026-10-01");
  await rewrite(source.root, documentPath, (fm) => {
    fm.verified = [fm.verified];
  });
  const second = await prepare({ ...source, commit: commitVault(source.root) });
  assert.equal(second.ok, true);
  assert.equal(
    second.projection.concepts.find((c) => c.path === `/${documentPath}`).trust,
    "verified",
  );
});

test("chunk size, manifest, source, and deployment policy bind build identity", async (t) => {
  const source = await vault(t, (root) => sensitivityManifest(root));
  const first = await prepare(source);
  const smaller = await prepare(source, { maxChunkBytes: 32 });
  const policy = await prepare(source, {
    approvedSensitivityClasses: ["public", "restricted"],
  });
  const reordered = await prepare(source, {
    approvedSensitivityClasses: ["restricted", "public"],
  });
  for (const result of [first, smaller, policy, reordered])
    assert.equal(result.ok, true, JSON.stringify(result));
  assert.notEqual(first.projection.buildId, smaller.projection.buildId);
  assert.deepEqual(
    first.projection.canonicalOutput,
    smaller.projection.canonicalOutput,
  );
  assert.notEqual(
    first.projection.chunkStreamHash,
    smaller.projection.chunkStreamHash,
  );
  assert.notEqual(first.projection.buildId, policy.projection.buildId);
  assert.equal(policy.projection.buildId, reordered.projection.buildId);
  const manifestPath = join(source.root, "bookie.yaml");
  await writeFile(
    manifestPath,
    `${await readFile(manifestPath, "utf8")}# New snapshot\n`,
  );
  const changed = await prepare({
    ...source,
    commit: commitVault(source.root),
  });
  assert.equal(changed.ok, true);
  assert.notEqual(changed.projection.buildId, first.projection.buildId);
  assert.notEqual(
    changed.projection.manifestHash,
    first.projection.manifestHash,
  );
});

test("mixed-sensitivity projections include controls and omit excluded identifiers and content", async (t) => {
  const uid = "DOC-00000000000000000000000099";
  const path = "projects/fixture/documents/excluded.md";
  const marker = "EXCLUDED_MARKER_7391";
  const source = await vault(t, async (root) => {
    await sensitivityManifest(root, ["restricted"]);
    await cp(join(root, documentPath), join(root, path));
    await rewrite(
      root,
      path,
      (fm) => {
        fm.bookie.uid = uid;
        fm.bookie.sensitivity = "restricted";
      },
      marker,
    );
  });
  const result = await prepare(source);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.projection.concepts.length, 8);
  assert.ok(
    result.projection.concepts.some((c) => c.path === `/${documentPath}`),
  );
  for (const excluded of [uid, path, marker])
    assert.equal(JSON.stringify(result).includes(excluded), false);
  await rewrite(source.root, documentPath, () => {}, `Leak ${uid}`);
  assert.deepEqual(
    await prepare({ ...source, commit: commitVault(source.root) }),
    { ok: false, reason: "sensitivity-policy" },
  );
  for (const body of [
    `## &#68;${uid.slice(1)}`,
    `## \`DO\`C-${uid.slice(4)}`,
    `[link](https://example.invalid/&#68;${uid.slice(1)})`,
  ]) {
    await rewrite(source.root, documentPath, () => {}, body);
    assert.deepEqual(
      await prepare({ ...source, commit: commitVault(source.root) }),
      { ok: false, reason: "sensitivity-policy" },
    );
  }
});

test("all-excluded vaults produce empty exact-commit projections", async (t) => {
  const source = await vault(t, async (root) => {
    await sensitivityManifest(root, ["restricted"]);
    await classify(root, "restricted");
  });
  const result = await prepare(source);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.projection.sourceCommit, source.commit);
  assert.deepEqual(result.projection.concepts, []);
  assert.deepEqual(result.projection.chunks, []);
  const empty = `sha256:${createHash("sha256").update("").digest("hex")}`;
  assert.deepEqual(result.projection.canonicalOutput, {
    hash: empty,
    bytes: 0,
    records: 0,
  });
  assert.equal(result.projection.conceptStreamHash, empty);
  assert.equal(result.projection.chunkStreamHash, empty);
});

test("policy and vault mismatches fail before returning a projection", async (t) => {
  const source = await vault(t);
  assert.deepEqual(
    await prepare(source, { vaultUid: "VLT-00000000000000000000000008" }),
    { ok: false, reason: "invalid-vault" },
  );
  assert.deepEqual(await prepare(source, { approvedSensitivityClasses: [] }), {
    ok: false,
    reason: "sensitivity-policy",
  });
  assert.deepEqual(
    await prepare(source, { approvedSensitivityClasses: ["undeclared"] }),
    { ok: false, reason: "sensitivity-policy" },
  );
  await rewrite(source.root, documentPath, (fm) => {
    delete fm.bookie.sensitivity;
  });
  assert.deepEqual(
    await prepare({ ...source, commit: commitVault(source.root) }),
    { ok: false, reason: "sensitivity-policy" },
  );
});

test("final chunk boundaries cannot bypass secret policy while neighboring splits remain valid", async (t) => {
  for (const [body, rejected] of [
    ["a".repeat(64) + "ghp_" + "b".repeat(36), true],
    ["a".repeat(63) + "ghp_" + "b".repeat(36), false],
    ["a".repeat(65) + "ghp_" + "b".repeat(36), false],
    ["Unicode λ🎯 notes. ".repeat(10), false],
    ["password: <redacted>", false],
  ]) {
    const source = await vault(t, (root) =>
      rewrite(root, documentPath, () => {}, body),
    );
    const canonical = await exportCanonicalJsonl(source.root, {
      sourceRef: source.commit,
      write() {},
    });
    assert.equal(
      canonical.ok,
      true,
      "source passes canonical policy before chunk transformation",
    );
    const result = await prepare(source);
    assert.equal(result.ok, !rejected);
    if (rejected)
      assert.deepEqual(result, { ok: false, reason: "secret-policy" });
    else {
      const chunks = result.projection.chunks.filter(
        (chunk) => chunk.path === `/${documentPath}`,
      );
      assert.ok(chunks.length > 0);
      assert.equal(chunks.map((chunk) => chunk.text).join(""), body.trim());
      assert.ok(
        chunks.every(
          (chunk) =>
            Buffer.byteLength(chunk.text) <= 64 && !chunk.text.includes("�"),
        ),
      );
    }
  }
});

test("detected secrets and invalid canonical records fail with static results", async (t) => {
  const source = await vault(t, (root) =>
    rewrite(root, documentPath, () => {}, `Secret ${"ghp_"}${"a".repeat(36)}`),
  );
  assert.deepEqual(await prepare(source), {
    ok: false,
    reason: "secret-policy",
  });
  await rewrite(
    source.root,
    documentPath,
    () => {},
    `## &#103;hp_${"a".repeat(36)}`,
  );
  assert.deepEqual(
    await prepare({ ...source, commit: commitVault(source.root) }),
    { ok: false, reason: "secret-policy" },
  );
  await writeFile(
    join(source.root, documentPath),
    "---\ntitle: [invalid\n---\n",
  );
  assert.deepEqual(
    await prepare({ ...source, commit: commitVault(source.root) }),
    { ok: false, reason: "invalid-vault" },
  );
});

test("full object IDs are mandatory and chunk limits fail closed without partial output", async (t) => {
  const source = await vault(t);
  for (const sourceRef of [
    "HEAD",
    "HEAD~99999",
    "a".repeat(39),
    "A".repeat(40),
    "a".repeat(40),
  ]) {
    assert.deepEqual(await prepare(source, {}, { sourceRef }), {
      ok: false,
      reason: "invalid-source",
    });
  }
  const full = await prepare(source);
  assert.equal(full.ok, true);
  const count = full.projection.chunks.length;
  assert.deepEqual(await prepare(source, { maxChunks: count }), full);
  assert.deepEqual(await prepare(source, { maxChunks: count - 1 }), {
    ok: false,
    reason: "incomplete",
  });
  for (const overrides of [
    { maxChunkBytes: 15 },
    { maxChunkBytes: 65_537 },
    { maxChunks: 250_001 },
    { maxChunks: 0 },
    { approvedSensitivityClasses: ["public", "public"] },
    { manifestHash: "caller-claimed" },
    { approvedSensitivityClasses: ["unknown"] },
    { approvedSensitivityClasses: ["public\n"] },
    { vaultUid: `${config.vaultUid}\n` },
  ]) {
    await assert.rejects(
      () => prepare(source, overrides),
      /projection config is invalid/u,
    );
  }
});

// Deployment policy must reject non-data configurations before any Git process.
for (const [label, invalidConfig] of [
  [
    "sparse class array",
    () => ({
      ...config,
      approvedSensitivityClasses: Object.assign(new Array(2), { 0: "public" }),
    }),
  ],
  [
    "unknown own fields with inherited required fields",
    () => Object.assign(Object.create(config), { a: 1, b: 2, c: 3, d: 4 }),
  ],
  ["symbol config field", () => ({ ...config, [Symbol("extra")]: true })],
  [
    "named array field",
    () => ({
      ...config,
      approvedSensitivityClasses: Object.assign(["public"], { extra: true }),
    }),
  ],
  [
    "symbol array field",
    () => ({
      ...config,
      approvedSensitivityClasses: Object.assign(["public"], {
        [Symbol("extra")]: true,
      }),
    }),
  ],
  [
    "config accessor",
    (observe) =>
      Object.defineProperty({ ...config }, "vaultUid", { get: observe }),
  ],
  [
    "array item accessor",
    (observe) => ({
      ...config,
      approvedSensitivityClasses: Object.defineProperty(["public"], "0", {
        get: observe,
      }),
    }),
  ],
  [
    "inherited array item",
    (observe) => {
      const classes = Object.assign(new Array(2), { 0: "public" });
      Object.setPrototypeOf(
        classes,
        Object.defineProperty(Object.create(Array.prototype), "1", {
          get: observe,
        }),
      );
      return { ...config, approvedSensitivityClasses: classes };
    },
  ],
  [
    "config proxy",
    (observe) => new Proxy(config, { ownKeys: observe, get: observe }),
  ],
  [
    "array proxy",
    (observe) => ({
      ...config,
      approvedSensitivityClasses: new Proxy(["public"], {
        get: observe,
        ownKeys: observe,
      }),
    }),
  ],
]) {
  test(`projection rejects ${label} without property execution or Git work`, async () => {
    let observations = 0;
    const input = invalidConfig(() => {
      observations++;
      throw new Error("PRIVATE_CONFIG_MARKER");
    });
    let processes = 0;
    const hook = createHook({
      init(_id, type) {
        if (type === "PROCESSWRAP") processes++;
      },
    });
    hook.enable();
    try {
      await assert.rejects(
        prepareLexicalProjection("/nonexistent-projection-config-fixture", {
          sourceRef: "a".repeat(40),
          config: input,
        }),
        { name: "TypeError", message: "projection config is invalid" },
      );
      assert.equal(observations, 0);
      assert.equal(processes, 0);
    } finally {
      hook.disable();
    }
  });
}

test("projection snapshots closed dense class arrays at their policy bounds", () => {
  for (const classes of [
    [],
    ["public"],
    Array.from({ length: 64 }, (_, i) => `class-${i}`),
  ]) {
    const input = { ...config, approvedSensitivityClasses: classes };
    const snapshot = projectionApi.snapshotProjectionConfig(input);
    assert.deepEqual(snapshot.approvedSensitivityClasses, [...classes].sort());
    classes.length = 0;
    assert.ok(Object.isFrozen(snapshot.approvedSensitivityClasses));
    assert.notEqual(snapshot.approvedSensitivityClasses, classes);
  }
  assert.throws(
    () =>
      projectionApi.snapshotProjectionConfig({
        ...config,
        approvedSensitivityClasses: Array.from(
          { length: 65 },
          (_, i) => `class-${i}`,
        ),
      }),
    { name: "TypeError", message: "projection config is invalid" },
  );
});

test("worker-stage cancellation terminates parsing without leaking the abort reason", async (t) => {
  const source = await vault(t);
  const controller = new AbortController();
  let observedWorker = false;
  const hook = createHook({
    init(_id, type) {
      if (type === "WORKER") {
        observedWorker = true;
        setImmediate(() => controller.abort("private marker"));
      }
    },
  });
  hook.enable();
  try {
    await assert.rejects(
      () => prepare(source, {}, { signal: controller.signal }),
      (error) =>
        error.name === "AbortError" &&
        !error.message.includes("private marker"),
    );
    assert.equal(observedWorker, true);
  } finally {
    hook.disable();
  }
});

test("ESM eval callers can prepare projections and exit without retained workers", async (t) => {
  const source = await vault(t);
  const script = `
    import { prepareLexicalProjection } from ${JSON.stringify(new URL("../dist/projection.js", import.meta.url).href)};
    const result = await prepareLexicalProjection(${JSON.stringify(source.root)}, {
      sourceRef: ${JSON.stringify(source.commit)}, config: ${JSON.stringify(config)}
    });
    console.log(JSON.stringify({ ok: result.ok, commit: result.projection?.sourceCommit }));
  `;
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    { encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), {
    ok: true,
    commit: source.commit,
  });
});

test("worker dispatch failures return a static error and do not leak dependency text", async (t) => {
  const source = await vault(t);
  const script = `
    import { Worker } from 'node:worker_threads';
    import { prepareLexicalProjection } from ${JSON.stringify(new URL("../dist/projection.js", import.meta.url).href)};
    Worker.prototype.postMessage = function () { throw new Error('PRIVATE_DEPENDENCY_MARKER'); };
    try {
      console.log(JSON.stringify(await prepareLexicalProjection(${JSON.stringify(source.root)}, {
        sourceRef: ${JSON.stringify(source.commit)}, config: ${JSON.stringify(config)}
      })));
    } catch (error) { console.log(JSON.stringify({ error: error.message })); }
  `;
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    { encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), {
    ok: false,
    reason: "projection-error",
  });
});

test("worker construction and shutdown failures return static projection errors", async (t) => {
  const source = await vault(t);
  for (const phase of ["construction", "shutdown"]) {
    const script = `
      import { createRequire, syncBuiltinESMExports } from 'node:module';
      const threads = createRequire(import.meta.url)('node:worker_threads');
      const OriginalWorker = threads.Worker;
      threads.Worker = class extends OriginalWorker {
        constructor(...args) {
          if (${JSON.stringify(phase)} === 'construction') throw new Error('PRIVATE_STARTUP_MARKER');
          super(...args);
        }
        async terminate() {
          await super.terminate();
          throw new Error('PRIVATE_SHUTDOWN_MARKER');
        }
      };
      syncBuiltinESMExports();
      const { prepareLexicalProjection } = await import(${JSON.stringify(new URL("../dist/projection.js", import.meta.url).href)});
      try {
        console.log(JSON.stringify(await prepareLexicalProjection(${JSON.stringify(source.root)}, {
          sourceRef: ${JSON.stringify(source.commit)}, config: ${JSON.stringify(config)}
        })));
      } catch (error) { console.log(JSON.stringify({ error: error.message })); }
    `;
    const child = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", script],
      { encoding: "utf8", timeout: 10_000 },
    );
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(
      JSON.parse(child.stdout),
      { ok: false, reason: "projection-error" },
      phase,
    );
  }
});

test("cancellation is observable and caller mutation cannot alter the accepted config", async (t) => {
  const source = await vault(t);
  const controller = new AbortController();
  controller.abort("sensitive abort reason");
  await assert.rejects(
    () => prepare(source, {}, { signal: controller.signal }),
    (error) =>
      error.name === "AbortError" && !error.message.includes("sensitive"),
  );
  const mutable = { ...config, approvedSensitivityClasses: ["public"] };
  const pending = prepareLexicalProjection(source.root, {
    sourceRef: source.commit,
    config: mutable,
  });
  mutable.vaultUid = "VLT-00000000000000000000000008";
  mutable.approvedSensitivityClasses.length = 0;
  assert.equal((await pending).ok, true);
  const active = new AbortController();
  const interrupted = prepare(source, {}, { signal: active.signal });
  setTimeout(() => active.abort(), 1);
  await assert.rejects(() => interrupted, { name: "AbortError" });
});
