import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cp,
  link,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  captureEvidence,
  computeConceptSourceHash,
  loadConcept,
  validateVault,
} from "../dist/index.js";
import {
  captureParent,
  publishStagedCandidate,
  resolveMutationTarget,
  stageTemporary,
} from "../dist/concept-mutation-filesystem.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const validVault = resolve(repositoryRoot, "fixtures/valid-vault");

async function temporaryVault(t) {
  const parent = await mkdtemp(join(tmpdir(), "bookie-evidence-capture-"));
  const root = join(parent, "vault");
  await cp(validVault, root, { recursive: true });
  t.after(() => rm(parent, { recursive: true, force: true }));
  return { parent, root };
}

async function evidenceFrontmatter(
  root,
  uid = "EVD-00000000000000000000000009",
) {
  const loaded = loadConcept(
    await readFile(join(root, "projects/fixture/evidence/evidence.md")),
    { file: "fixture" },
  );
  assert.equal(loaded.ok, true);
  const frontmatter = structuredClone(loaded.concept.frontmatter);
  frontmatter.title = "Captured exact evidence";
  frontmatter.bookie.uid = uid;
  delete frontmatter.resource;
  delete frontmatter.bookie.sha256;
  return frontmatter;
}

function request(source, root, overrides = {}) {
  return evidenceFrontmatter(root).then((frontmatter) => ({
    source,
    path: "projects/fixture/evidence/captured.md",
    resourcePath: "references/files/captured.bin",
    frontmatter,
    bodyText: "Captured evidence.\n",
    ...overrides,
  }));
}

function codes(result) {
  return result.diagnostics.map((diagnostic) => diagnostic.code);
}

async function noCaptureTemporaries(root) {
  const found = [];
  const walk = async (path) => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (
        entry.name.startsWith(".bookie-") &&
        entry.name.endsWith(".tmp")
      ) {
        found.push(child);
      }
    }
  };
  await walk(root);
  assert.deepEqual(found, []);
}

test("atomic publication never replaces a target created after the final check", async (t) => {
  const { root } = await temporaryVault(t);
  const resolved = await resolveMutationTarget(
    root,
    "projects/fixture/evidence/raced.md",
    undefined,
  );
  assert.equal(resolved.ok, true);
  const parent = await captureParent(resolved.target, undefined);
  assert.ok(parent);
  const candidate = Buffer.from("complete candidate");
  const staged = await stageTemporary(
    resolved.target,
    parent,
    candidate,
    undefined,
    undefined,
  );
  const external = Buffer.from("external writer wins");

  const published = await publishStagedCandidate(
    resolved.target,
    parent,
    staged,
    candidate.byteLength,
    "no-replace",
    undefined,
    async () => {
      await writeFile(resolved.target.target, external, { flag: "wx" });
      return "publish";
    },
  );

  assert.equal(published, "conflict");
  assert.deepEqual(await readFile(resolved.target.target), external);
  await noCaptureTemporaries(root);
});

test("publication distinguishes I/O before a target is linked", async (t) => {
  const { root } = await temporaryVault(t);
  const resolved = await resolveMutationTarget(
    root,
    "projects/fixture/evidence/missing-stage.md",
    undefined,
  );
  assert.equal(resolved.ok, true);
  const parent = await captureParent(resolved.target, undefined);
  assert.ok(parent);
  const candidate = Buffer.from("complete candidate");
  const staged = await stageTemporary(
    resolved.target,
    parent,
    candidate,
    undefined,
    undefined,
  );

  const published = await publishStagedCandidate(
    resolved.target,
    parent,
    staged,
    candidate.byteLength,
    "no-replace",
    undefined,
    async () => {
      await rm(staged.path);
      return "publish";
    },
  );

  assert.equal(published, "io-before-publication");
  assert.equal(
    await readFile(resolved.target.target).catch(() => undefined),
    undefined,
  );
});

test("captureEvidence publishes exact binary bytes before a valid descriptor", async (t) => {
  const { parent, root } = await temporaryVault(t);
  const source = join(parent, "source.bin");
  const bytes = Uint8Array.from([0x00, 0xff, 0x0d, 0x0a, 0x41, 0x00]);
  await writeFile(source, bytes);
  const input = await request(source, root);
  const untouched = structuredClone(input.frontmatter);
  let coordinatedPath;
  let callbackCount = 0;

  const result = await captureEvidence(root, input, {
    runExclusive: async (path, mutation) => {
      coordinatedPath = path;
      callbackCount += 1;
      assert.equal(await lstat(path).catch(() => undefined), undefined);
      return mutation();
    },
  });

  const resourcePath = join(root, "references/files/captured.bin");
  const descriptorPath = join(root, "projects/fixture/evidence/captured.md");
  const digest = createHash("sha256").update(bytes).digest("hex");
  assert.deepEqual(result, {
    ok: true,
    operation: "capture-evidence",
    outcome: "captured",
    path: "/projects/fixture/evidence/captured.md",
    resourcePath: "/references/files/captured.bin",
    changedPaths: [
      "/references/files/captured.bin",
      "/projects/fixture/evidence/captured.md",
    ],
    sourceHash: computeConceptSourceHash(await readFile(descriptorPath)),
    sha256: digest,
    byteLength: bytes.byteLength,
    diagnostics: [],
  });
  assert.equal(coordinatedPath, descriptorPath);
  assert.equal(callbackCount, 1);
  assert.deepEqual(await readFile(resourcePath), Buffer.from(bytes));
  assert.deepEqual(input.frontmatter, untouched);
  assert.equal(Object.hasOwn(input.frontmatter, "resource"), false);
  assert.equal(Object.hasOwn(input.frontmatter.bookie, "sha256"), false);

  const descriptor = loadConcept(await readFile(descriptorPath), {
    file: descriptorPath,
  });
  assert.equal(descriptor.ok, true);
  assert.equal(
    descriptor.concept.frontmatter.resource,
    "/references/files/captured.bin",
  );
  assert.equal(descriptor.concept.frontmatter.bookie.sha256, digest);
  const validation = await validateVault(root);
  assert.equal(validation.valid, true, JSON.stringify(validation.diagnostics));
  await noCaptureTemporaries(root);
});

test("descriptor collision reports the already durable resource as an orphan", async (t) => {
  const { parent, root } = await temporaryVault(t);
  const source = join(parent, "source.bin");
  const sourceBytes = Buffer.from("durable orphan bytes");
  await writeFile(source, sourceBytes);
  const descriptorPath = join(root, "projects/fixture/evidence/captured.md");
  const resourcePath = join(root, "references/files/captured.bin");
  const externalDescriptor = Buffer.from("external descriptor wins\n");

  const result = await captureEvidence(root, await request(source, root), {
    runExclusive: async (_path, mutation) => {
      const work = mutation();
      const collide = (async () => {
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          if (
            (await lstat(resourcePath).catch(() => undefined)) !== undefined
          ) {
            await writeFile(descriptorPath, externalDescriptor, { flag: "wx" });
            return;
          }
          await new Promise((resolve) => setImmediate(resolve));
        }
        throw new Error("Timed out waiting for resource publication.");
      })();
      const [completed] = await Promise.all([work, collide]);
      return completed;
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.conflict, true);
  assert.deepEqual(result.changedPaths, ["/references/files/captured.bin"]);
  assert.ok(codes(result).includes("MUTATION-CONFLICT"));
  assert.deepEqual(await readFile(resourcePath), sourceBytes);
  assert.deepEqual(await readFile(descriptorPath), externalDescriptor);
  await noCaptureTemporaries(root);
});

test("captured Markdown remains an Evidence resource rather than a concept", async (t) => {
  const { parent, root } = await temporaryVault(t);
  const source = join(parent, "source.md");
  await writeFile(source, "# Raw captured Markdown\n\nNo frontmatter.\n");
  const result = await captureEvidence(
    root,
    await request(source, root, {
      resourcePath: "references/files/captured.md",
    }),
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  const validation = await validateVault(root);
  assert.equal(validation.valid, true, JSON.stringify(validation.diagnostics));
});

test("an evidence root cannot hide unreferenced Markdown concepts", async (t) => {
  const { root } = await temporaryVault(t);
  const manifestPath = join(root, "bookie.yaml");
  await writeFile(
    manifestPath,
    (await readFile(manifestPath, "utf8")).replace(
      "    - references/files",
      "    - projects",
    ),
  );
  await writeFile(
    join(root, "projects/fixture/tasks/task.md"),
    "---\ntype: [\n---\nMalformed but not an Evidence resource.\n",
  );
  const result = await validateVault(root);
  assert.equal(result.valid, false);
  assert.ok(codes(result).includes("YAML-SYNTAX"));
  assert.ok(codes(result).includes("CONCEPT-PATH"));
});

test("captureEvidence rejects unsafe paths, sources, targets, and candidates without partial records", async (t) => {
  const pathCases = [
    { resourcePath: "../outside.bin" },
    { resourcePath: "/references/files/absolute.bin" },
    { resourcePath: "references/private/outside-root.bin" },
    { resourcePath: "references/files/%2e%2e.bin" },
    { resourcePath: "references/.GIT/object" },
    { resourcePath: "exports/captured.bin" },
    { path: "../captured.md" },
    { path: "references/files/descriptor.md" },
  ];
  for (const [index, patch] of pathCases.entries()) {
    await t.test(`path ${index}`, async (t) => {
      const { parent, root } = await temporaryVault(t);
      const source = join(parent, "source.bin");
      await writeFile(source, "source");
      const result = await captureEvidence(
        root,
        await request(source, root, patch),
      );
      assert.equal(result.ok, false);
      assert.deepEqual(result.changedPaths, []);
      assert.ok(codes(result).includes("MUTATION-PATH"));
      assert.equal(
        await readFile(
          join(root, "projects/fixture/evidence/captured.md"),
        ).catch(() => undefined),
        undefined,
      );
      await noCaptureTemporaries(root);
    });
  }

  await t.test("source symlink", async (t) => {
    const { parent, root } = await temporaryVault(t);
    const outside = join(parent, "outside.bin");
    const source = join(parent, "source-link.bin");
    await writeFile(outside, "outside");
    await symlink(outside, source);
    const result = await captureEvidence(root, await request(source, root));
    assert.equal(result.ok, false);
    assert.deepEqual(result.changedPaths, []);
    assert.ok(codes(result).includes("MUTATION-TARGET"));
    assert.equal(
      await readFile(join(root, "references/files/captured.bin")).catch(
        () => undefined,
      ),
      undefined,
    );
  });

  await t.test("multiply linked destination", async (t) => {
    const { parent, root } = await temporaryVault(t);
    const source = join(parent, "source.bin");
    const outside = join(parent, "outside-target.bin");
    const target = join(root, "references/files/captured.bin");
    await writeFile(source, "source");
    await writeFile(outside, "do not replace");
    await link(outside, target);
    const before = await readFile(outside);
    const result = await captureEvidence(root, await request(source, root));
    assert.equal(result.ok, false);
    assert.deepEqual(result.changedPaths, []);
    assert.ok(codes(result).includes("MUTATION-TARGET"));
    assert.deepEqual(await readFile(outside), before);
  });

  await t.test("invalid descriptor and UID collision", async (t) => {
    const { parent, root } = await temporaryVault(t);
    const source = join(parent, "source.bin");
    await writeFile(source, "source");
    const suppliedResource = await request(source, root);
    suppliedResource.frontmatter.resource = "/references/files/wrong.bin";
    const suppliedResourceResult = await captureEvidence(
      root,
      suppliedResource,
    );
    assert.equal(suppliedResourceResult.ok, false);
    assert.deepEqual(suppliedResourceResult.changedPaths, []);
    assert.ok(codes(suppliedResourceResult).includes("MUTATION-INPUT"));

    const suppliedDigest = await request(source, root);
    suppliedDigest.frontmatter.bookie.sha256 = "0".repeat(64);
    const suppliedDigestResult = await captureEvidence(root, suppliedDigest);
    assert.equal(suppliedDigestResult.ok, false);
    assert.deepEqual(suppliedDigestResult.changedPaths, []);
    assert.ok(codes(suppliedDigestResult).includes("MUTATION-INPUT"));

    const invalid = await request(source, root);
    invalid.frontmatter.type = "Task";
    const invalidResult = await captureEvidence(root, invalid);
    assert.equal(invalidResult.ok, false);
    assert.deepEqual(invalidResult.changedPaths, []);
    assert.ok(codes(invalidResult).includes("CONCEPT-SCHEMA"));

    const collision = await captureEvidence(
      root,
      await request(source, root, {
        frontmatter: await evidenceFrontmatter(
          root,
          "EVD-00000000000000000000000007",
        ),
      }),
    );
    assert.equal(collision.ok, false);
    assert.deepEqual(collision.changedPaths, []);
    assert.ok(codes(collision).includes("UID-UNIQUE"));
  });
});

test("captureEvidence enforces exact and plus-one resource bounds", async (t) => {
  const { parent, root } = await temporaryVault(t);
  const source = join(parent, "source.bin");
  const bytes = Buffer.from("boundary");
  await writeFile(source, bytes);

  const below = await captureEvidence(root, await request(source, root), {
    maxResourceBytes: bytes.byteLength - 1,
  });
  assert.equal(below.ok, false);
  assert.deepEqual(below.changedPaths, []);
  assert.ok(codes(below).includes("MUTATION-BOUNDS"));

  const exact = await captureEvidence(root, await request(source, root), {
    maxResourceBytes: bytes.byteLength,
  });
  assert.equal(exact.ok, true, JSON.stringify(exact));
  assert.equal(exact.byteLength, bytes.byteLength);

  await assert.rejects(
    captureEvidence(root, await request(source, root), {
      maxResourceBytes: 0,
    }),
    TypeError,
  );
});

test("captureEvidence cancellation and concurrent collision never publish a partial descriptor", async (t) => {
  const cancelledVault = await temporaryVault(t);
  const cancelledSource = join(cancelledVault.parent, "source.bin");
  await writeFile(cancelledSource, "cancelled");
  const controller = new AbortController();
  controller.abort("custom");
  await assert.rejects(
    captureEvidence(
      cancelledVault.root,
      await request(cancelledSource, cancelledVault.root),
      { signal: controller.signal },
    ),
    (error) => error?.name === "AbortError",
  );
  assert.equal(
    await readFile(
      join(cancelledVault.root, "references/files/captured.bin"),
    ).catch(() => undefined),
    undefined,
  );

  const concurrentVault = await temporaryVault(t);
  const firstSource = join(concurrentVault.parent, "first.bin");
  const secondSource = join(concurrentVault.parent, "second.bin");
  await writeFile(firstSource, "first");
  await writeFile(secondSource, "second");
  const [first, second] = await Promise.all([
    captureEvidence(
      concurrentVault.root,
      await request(firstSource, concurrentVault.root),
    ),
    captureEvidence(
      concurrentVault.root,
      await request(secondSource, concurrentVault.root),
    ),
  ]);
  assert.equal([first, second].filter((result) => result.ok).length, 1);
  assert.equal([first, second].filter((result) => !result.ok).length, 1);
  const failure = [first, second].find((result) => !result.ok);
  assert.deepEqual(failure.changedPaths, []);
  assert.ok(
    codes(failure).some((code) =>
      ["MUTATION-TARGET", "MUTATION-CONFLICT"].includes(code),
    ),
  );
  const descriptor = loadConcept(
    await readFile(
      join(concurrentVault.root, "projects/fixture/evidence/captured.md"),
    ),
    { file: "captured" },
  );
  assert.equal(descriptor.ok, true);
  const resource = await readFile(
    join(concurrentVault.root, "references/files/captured.bin"),
  );
  assert.equal(
    createHash("sha256").update(resource).digest("hex"),
    descriptor.concept.frontmatter.bookie.sha256,
  );
  await noCaptureTemporaries(concurrentVault.root);
});

test("in-progress cancellation cleans staged resource bytes", async (t) => {
  const { parent, root } = await temporaryVault(t);
  const source = join(parent, "cancelled-late.bin");
  const bytes = Buffer.alloc(4 * 1024 * 1024, 0x41);
  await writeFile(source, bytes);
  const manifestPath = join(root, "bookie.yaml");
  await writeFile(
    manifestPath,
    (await readFile(manifestPath, "utf8")).replace(
      "attachment_max_bytes: 1024",
      `attachment_max_bytes: ${bytes.byteLength + 1}`,
    ),
  );
  const controller = new AbortController();
  const resourceDirectory = join(root, "references/files");
  const capture = captureEvidence(root, await request(source, root), {
    signal: controller.signal,
  });
  const cancelDuringStaging = (async () => {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      for (const name of await readdir(resourceDirectory)) {
        if (!name.startsWith(".bookie-") || !name.endsWith(".tmp")) continue;
        const metadata = await lstat(join(resourceDirectory, name)).catch(
          () => undefined,
        );
        if ((metadata?.size ?? 0) > 0) {
          controller.abort("cancel while staging");
          return;
        }
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error("Timed out waiting for Evidence resource staging.");
  })();
  await Promise.all([
    cancelDuringStaging,
    assert.rejects(capture, (error) => error?.name === "AbortError"),
  ]);
  assert.equal(
    await readFile(join(root, "references/files/captured.bin")).catch(
      () => undefined,
    ),
    undefined,
  );
  assert.equal(
    await readFile(join(root, "projects/fixture/evidence/captured.md")).catch(
      () => undefined,
    ),
    undefined,
  );
  await noCaptureTemporaries(root);
});

test("captureEvidence verifies staged bytes and stable source identity", async (t) => {
  const { parent, root } = await temporaryVault(t);
  const source = join(parent, "large-source.bin");
  const bytes = Buffer.alloc(2 * 1024 * 1024, 0x61);
  await writeFile(source, bytes);
  const manifestPath = join(root, "bookie.yaml");
  await writeFile(
    manifestPath,
    (await readFile(manifestPath, "utf8")).replace(
      "attachment_max_bytes: 1024",
      `attachment_max_bytes: ${bytes.byteLength + 1}`,
    ),
  );

  let sawTemporary = false;
  const resourceDirectory = join(root, "references/files");
  const tamper = (async () => {
    const deadline = Date.now() + 5_000;
    while (!sawTemporary && Date.now() < deadline) {
      for (const name of await readdir(resourceDirectory)) {
        if (name.startsWith(".bookie-") && name.endsWith(".tmp")) {
          const temporary = join(resourceDirectory, name);
          const metadata = await lstat(temporary).catch(() => undefined);
          if (metadata?.size !== bytes.byteLength) continue;
          sawTemporary = true;
          await writeFile(temporary, "tampered").catch(() => undefined);
          return;
        }
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error("Timed out waiting to tamper with staged Evidence bytes.");
  })();
  const capture = captureEvidence(root, await request(source, root), {
    maxResourceBytes: bytes.byteLength,
  });
  const [result] = await Promise.all([capture, tamper]);

  assert.equal(sawTemporary, true);
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.deepEqual(result.changedPaths, []);
  assert.ok(codes(result).includes("MUTATION-IO"));
  assert.equal(
    await readFile(join(root, "references/files/captured.bin")).catch(
      () => undefined,
    ),
    undefined,
  );
  assert.equal(
    await readFile(join(root, "projects/fixture/evidence/captured.md")).catch(
      () => undefined,
    ),
    undefined,
  );
  await noCaptureTemporaries(root);
});
