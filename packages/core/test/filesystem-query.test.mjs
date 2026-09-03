import assert from "node:assert/strict";
import {
  cp,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  computeConceptSourceHash,
  DEFAULT_MAX_CONCEPT_BYTES,
  DEFAULT_MAX_MANIFEST_BYTES,
  DEFAULT_MAX_TOTAL_CONCEPT_BYTES,
  DEFAULT_MAX_VAULT_CONCEPTS,
  DEFAULT_MAX_VAULT_DIAGNOSTICS,
  DEFAULT_MAX_VAULT_ENTRIES,
  DEFAULT_MAX_YAML_DEPTH,
  inspectConcept,
  searchVault,
} from "../dist/index.js";
import { scanVaultForQuery } from "../dist/vault-query-scan.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const validVault = resolve(repositoryRoot, "fixtures/valid-vault");
const researchPath = "/projects/fixture/research/Δ-findings.md";
const researchUid = "RSC-00000000000000000000000004";

async function temporaryVault(t) {
  const parent = await mkdtemp(join(tmpdir(), "bookie-query-"));
  const root = join(parent, "vault");
  await cp(validVault, root, { recursive: true });
  t.after(() => rm(parent, { recursive: true, force: true }));
  return { parent, root };
}

function taskUid(suffix) {
  return `TSK-${"0".repeat(24)}${suffix}`;
}

function codes(result) {
  return result.diagnostics.map((diagnostic) => diagnostic.code);
}

async function writeTask(root, relativePath, values = {}) {
  const path = join(root, relativePath);
  await mkdir(join(path, ".."), { recursive: true });
  const frontmatter = {
    type: "Task",
    title: values.title ?? "Filesystem query task",
    status: values.status ?? "stable",
    ...(values.description === undefined
      ? {}
      : { description: values.description }),
    generated: {
      by: "human:query-test",
      at: "2026-09-03T12:00:00Z",
    },
    ...(values.tags === undefined ? {} : { tags: values.tags }),
    ...(values.verified === undefined ? {} : { verified: values.verified }),
    ...(values.staleAfter === undefined
      ? {}
      : { stale_after: values.staleAfter }),
    bookie: {
      profile: "1.0",
      uid: values.uid ?? taskUid("10"),
      project: "/projects/fixture/project.md",
      state: values.state ?? "ready",
      created_at: "2026-09-03T12:00:00Z",
      ...(values.sensitivity === undefined
        ? {}
        : { sensitivity: values.sensitivity }),
    },
  };
  await writeFile(
    path,
    `---\n${JSON.stringify(frontmatter)}\n---\n${values.body ?? ""}`,
  );
  return path;
}

test("filesystem search and inspect expose exact local Unicode concept bytes", async (t) => {
  const { root } = await temporaryVault(t);
  const sourceBytes = await readFile(join(root, researchPath.slice(1)));
  const sourceHash = computeConceptSourceHash(sourceBytes);

  const search = await searchVault(
    root,
    {
      query: "Unicode",
      filters: {
        type: "Research",
        project: "/projects/fixture/project.md",
        status: "draft",
      },
    },
    { maxResults: 10 },
  );

  assert.equal(search.mode, "filesystem");
  assert.equal(search.root, root);
  assert.equal(search.complete, true, JSON.stringify(search.diagnostics));
  assert.equal(search.matchedCount, 1);
  assert.equal(search.resultsTruncated, false);
  assert.equal(search.outputTruncated, false);
  assert.equal(search.rejectedConcepts, 0);
  assert.deepEqual(search.diagnostics, []);
  assert.deepEqual(search.results, [
    {
      source: {
        path: researchPath,
        state: "working-tree",
        commit: null,
        sourceHash,
      },
      type: "Research",
      uid: researchUid,
      project: "/projects/fixture/project.md",
      status: "draft",
      state: null,
      sensitivity: { value: null, classification: "missing" },
      verification: "absent",
      staleAfter: null,
      untrusted: true,
      title: "Unicode path research",
      titleTruncated: false,
      matchedField: "title",
      excerpt: "Unicode path research",
      excerptTruncated: false,
    },
  ]);

  const fromFileUrl = await searchVault(pathToFileURL(root), {
    query: "Unicode",
  });
  assert.deepEqual(fromFileUrl.results, search.results);

  for (const selector of [{ path: researchPath }, { uid: researchUid }]) {
    const inspected = await inspectConcept(root, selector);
    assert.equal(inspected.ok, true, JSON.stringify(inspected.diagnostics));
    assert.equal(inspected.mode, "filesystem");
    assert.equal(inspected.complete, true);
    assert.equal(inspected.handling, "ordinary");
    assert.equal(inspected.source.path, researchPath);
    assert.equal(inspected.source.commit, null);
    assert.equal(inspected.source.sourceHash, sourceHash);
    assert.equal(inspected.sourceText, sourceBytes.toString("utf8"));
    assert.equal(inspected.sourceByteLength, sourceBytes.byteLength);
    assert.equal(inspected.returnedByteLength, sourceBytes.byteLength);
    assert.equal(inspected.sourceTruncated, false);
    assert.equal(inspected.untrusted, true);
  }
});

test("search uses exact title/body matching and exact metadata filters", async (t) => {
  const { root } = await temporaryVault(t);
  await writeTask(root, "projects/fixture/tasks/query.md", {
    uid: taskUid("10"),
    title: "Résumé Ω query",
    body: "Body needle 😀 is exact.\n",
    tags: ["alpha", "unicode"],
    description: "DESCRIPTION-ONLY-MARKER",
    sensitivity: "public",
    verified: {
      by: "human:reviewer",
      at: "2026-09-03T12:05:00Z",
    },
    staleAfter: "2026-12-31",
  });
  await writeTask(root, "projects/fixture/tasks/undeclared.md", {
    uid: taskUid("11"),
    title: "Undeclared sensitivity",
    body: "undeclared marker\n",
    sensitivity: "mystery",
  });
  await writeFile(
    join(root, "generic.md"),
    "---\ntype: Generic\n---\nBody needle 😀 is exact.\n",
  );

  const request = {
    query: "needle 😀",
    filters: {
      type: "Task",
      project: "/projects/fixture/project.md",
      status: "stable",
      state: "ready",
      sensitivity: "public",
      tag: "alpha",
    },
  };
  const result = await searchVault(root, request);
  assert.equal(result.complete, true, JSON.stringify(result.diagnostics));
  assert.equal(result.matchedCount, 1);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].matchedField, "body");
  assert.match(result.results[0].excerpt, /needle 😀/u);
  assert.equal(result.results[0].sensitivity.classification, "declared");
  assert.equal(result.results[0].verification, "present");
  assert.equal(result.results[0].staleAfter, "2026-12-31");
  assert.equal(result.rejectedConcepts, 0);

  for (const metadataOnly of [taskUid("10"), "DESCRIPTION-ONLY-MARKER"]) {
    const notYaml = await searchVault(root, { query: metadataOnly });
    assert.equal(notYaml.matchedCount, 0, metadataOnly);
  }

  const differentCase = await searchVault(root, {
    query: "résumé",
    filters: { type: "Task" },
  });
  assert.equal(differentCase.matchedCount, 0);
  const decomposed = await searchVault(root, {
    query: "Résumé",
    filters: { type: "Task" },
  });
  assert.equal(decomposed.matchedCount, 0);

  for (const filters of [
    { type: "Document" },
    { project: "/projects/other/project.md" },
    { status: "draft" },
    { state: "done" },
    { sensitivity: "internal" },
    { tag: "beta" },
  ]) {
    const filtered = await searchVault(root, {
      query: "needle 😀",
      filters,
    });
    assert.equal(filtered.matchedCount, 0, JSON.stringify(filters));
  }

  const undeclared = await searchVault(root, {
    query: "undeclared marker",
  });
  assert.equal(undeclared.matchedCount, 1);
  assert.deepEqual(undeclared.results[0].sensitivity, {
    value: "mystery",
    classification: "undeclared",
  });
});

test("excluded sensitivity never enters search but exact inspect is labelled", async (t) => {
  const { root } = await temporaryVault(t);
  const manifestPath = join(root, "bookie.yaml");
  await writeFile(
    manifestPath,
    (await readFile(manifestPath, "utf8"))
      .replace("      - public\n", "      - public\n      - secret\n")
      .replace(
        "    excluded_classes: []",
        "    excluded_classes:\n      - secret",
      ),
  );
  await writeTask(root, "projects/fixture/tasks/included-query.md", {
    uid: taskUid("30"),
    title: "retrieval marker included",
    body: "ordinary result\n",
    sensitivity: "public",
  });
  const excludedPath = "/projects/fixture/tasks/secret-task.md";
  const excludedUid = taskUid("31");
  await writeTask(root, excludedPath.slice(1), {
    uid: excludedUid,
    title: "retrieval marker CLASSIFIED-ALBATROSS",
    body: "CLASSIFIED-BODY-MARKER\n",
    sensitivity: "secret",
  });

  const secretResource = "/references/files/SECRET-RESOURCE-MARKER.md";
  await writeFile(join(root, secretResource.slice(1)), "no frontmatter\n");
  const invalidEvidence = {
    type: "Evidence",
    status: "stable",
    generated: {
      by: "human:query-test",
      at: "2026-09-03T12:00:00Z",
    },
    resource: secretResource,
    bookie: {
      profile: "1.0",
      uid: "EVD-00000000000000000000000032",
      project: "/projects/fixture/project.md",
      captured_at: "2026-09-03T12:00:00Z",
      sensitivity: "secret",
      sha256: "0".repeat(64),
      mime_type: "text/markdown",
      supports: ["/projects/fixture/project.md"],
    },
  };
  await writeFile(
    join(root, "projects/fixture/evidence/SECRET-DESCRIPTOR.md"),
    `---\n${JSON.stringify(invalidEvidence)}\n---\nexcluded invalid descriptor\n`,
  );

  const result = await searchVault(root, { query: "retrieval marker" });
  assert.equal(result.matchedCount, 1);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].sensitivity.classification, "declared");
  assert.equal(result.rejectedConcepts, 0);
  const serialized = JSON.stringify(result);
  for (const marker of [
    excludedPath,
    excludedUid,
    "CLASSIFIED-ALBATROSS",
    "CLASSIFIED-BODY-MARKER",
    "SECRET-DESCRIPTOR",
    "SECRET-RESOURCE-MARKER",
  ]) {
    assert.equal(serialized.includes(marker), false, marker);
  }
  assert.ok(
    result.diagnostics.some((diagnostic) => diagnostic.file === "<excluded>"),
  );

  const filtered = await searchVault(root, {
    query: "retrieval marker",
    filters: { sensitivity: "secret" },
  });
  assert.equal(filtered.matchedCount, 0);
  assert.equal(filtered.results.length, 0);

  for (const selector of [{ path: excludedPath }, { uid: excludedUid }]) {
    const inspected = await inspectConcept(root, selector);
    assert.equal(inspected.ok, true, JSON.stringify(inspected.diagnostics));
    assert.equal(inspected.handling, "excluded");
    assert.equal(inspected.untrusted, true);
    assert.deepEqual(inspected.sensitivity, {
      value: "secret",
      classification: "excluded",
    });
    assert.match(inspected.sourceText, /CLASSIFIED-ALBATROSS/u);
    assert.equal(
      JSON.stringify(inspected.diagnostics).includes("SECRET-RESOURCE-MARKER"),
      false,
    );
  }
});

test("inspect truncates exact UTF-8 prefixes and fails exact selectors closed", async (t) => {
  const { root } = await temporaryVault(t);
  const inspectedPath = "/projects/fixture/tasks/inspect.md";
  const inspectedUid = taskUid("40");
  await writeTask(root, inspectedPath.slice(1), {
    uid: inspectedUid,
    title: "Inspect target",
    body: "prefix 😀 suffix\n",
  });
  const sourceBytes = await readFile(join(root, inspectedPath.slice(1)));
  const emojiOffset = sourceBytes.indexOf(Buffer.from("😀"));
  assert.ok(emojiOffset > 0);

  const truncated = await inspectConcept(
    root,
    { path: inspectedPath },
    { maxContentBytes: emojiOffset + 1 },
  );
  assert.equal(truncated.ok, true, JSON.stringify(truncated.diagnostics));
  assert.equal(truncated.sourceTruncated, true);
  assert.equal(truncated.returnedByteLength, emojiOffset);
  assert.equal(Buffer.byteLength(truncated.sourceText), emojiOffset);
  assert.doesNotMatch(truncated.sourceText, /�/u);
  assert.equal(truncated.sourceByteLength, sourceBytes.byteLength);
  assert.equal(
    truncated.source.sourceHash,
    computeConceptSourceHash(sourceBytes),
  );

  await writeFile(
    join(root, "generic-inspect.md"),
    "---\ntype: Generic\n---\ngeneric\n",
  );
  const invalidPath = "/projects/fixture/tasks/invalid-inspect.md";
  await writeFile(
    join(root, invalidPath.slice(1)),
    `---\n${JSON.stringify({
      type: "Task",
      status: "draft",
      generated: {
        by: "human:query-test",
        at: "2026-09-03T12:00:00Z",
      },
      bookie: {
        profile: "1.0",
        uid: inspectedUid,
        project: "/projects/fixture/project.md",
        state: "ready",
        created_at: "2026-09-03T12:00:00Z",
      },
    })}\n---\ninvalid\n`,
  );
  const validWithInvalidPeer = await inspectConcept(root, {
    uid: inspectedUid,
  });
  assert.equal(
    validWithInvalidPeer.ok,
    true,
    JSON.stringify(validWithInvalidPeer.diagnostics),
  );
  assert.equal(validWithInvalidPeer.source.path, inspectedPath);

  await writeTask(root, "projects/fixture/tasks/duplicate-a.md", {
    uid: taskUid("42"),
    title: "duplicate one",
  });
  await writeTask(root, "projects/fixture/tasks/duplicate-b.md", {
    uid: taskUid("42"),
    title: "duplicate two",
  });

  const missing = await inspectConcept(root, {
    path: "/projects/fixture/tasks/missing.md",
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, "not-found");
  assert.ok(codes(missing).includes("INSPECT-NOT-FOUND"));
  assert.equal(Object.hasOwn(missing, "sourceText"), false);

  const generic = await inspectConcept(root, { path: "/generic-inspect.md" });
  assert.equal(generic.ok, false);
  assert.equal(generic.reason, "not-found");

  const invalid = await inspectConcept(root, { path: invalidPath });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.reason, "invalid-concept");
  assert.ok(codes(invalid).includes("CONCEPT-SCHEMA"));
  assert.equal(Object.hasOwn(invalid, "sourceText"), false);

  const ambiguous = await inspectConcept(root, { uid: taskUid("42") });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.reason, "ambiguous");
  assert.ok(codes(ambiguous).includes("INSPECT-AMBIGUOUS"));
  assert.equal(Object.hasOwn(ambiguous, "sourceText"), false);

  const segmentBoundary = `/${[
    ...Array.from({ length: 63 }, () => "a"),
    "target.md",
  ].join("/")}`;
  assert.equal(
    (await inspectConcept(root, { path: segmentBoundary })).reason,
    "not-found",
  );
  const deeperBoundary = `/${[
    ...Array.from({ length: 64 }, () => "a"),
    "target.md",
  ].join("/")}`;
  assert.equal(
    (await inspectConcept(root, { path: deeperBoundary })).reason,
    "not-found",
  );
  const componentBoundary = `/projects/${"x".repeat(252)}.md`;
  assert.equal(
    (await inspectConcept(root, { path: componentBoundary })).reason,
    "not-found",
  );

  for (const selector of [
    {},
    { path: inspectedPath, uid: inspectedUid },
    { path: "projects/fixture/tasks/inspect.md" },
    { path: "/projects/../inspect.md" },
    { path: "/.md" },
    { path: "/projects/.GiT/inspect.md" },
    { path: `/projects/${"x".repeat(253)}.md` },
    { path: "/index.md" },
    { uid: "TSK-invalid" },
  ]) {
    const rejected = await inspectConcept(root, selector);
    assert.equal(rejected.ok, false, JSON.stringify(selector));
    assert.equal(rejected.reason, "invalid-selector", JSON.stringify(selector));
    assert.deepEqual(codes(rejected), ["INSPECT-INPUT"]);
    assert.equal(Object.hasOwn(rejected, "sourceText"), false);
  }

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    inspectConcept(
      root,
      { path: inspectedPath },
      { signal: controller.signal },
    ),
    { name: "AbortError" },
  );
  await assert.rejects(
    inspectConcept(root, { path: "invalid" }, { signal: controller.signal }),
    { name: "AbortError" },
  );
});

test("inspect and search agree on case-sensitive reserved basenames", async (t) => {
  const { root } = await temporaryVault(t);
  await writeTask(root, "INDEX.md", {
    uid: taskUid("43"),
    title: "Uppercase index query target",
  });
  await writeTask(root, "projects/.GiT/hidden.md", {
    uid: taskUid("44"),
    title: "Portable Git metadata hazard",
  });

  const searched = await searchVault(root, { query: "Uppercase index" });
  assert.equal(searched.matchedCount, 1);
  assert.equal(searched.results[0].source.path, "/INDEX.md");
  const inspected = await inspectConcept(root, { path: "/INDEX.md" });
  assert.equal(inspected.ok, true, JSON.stringify(inspected.diagnostics));
  assert.equal(inspected.source.path, "/INDEX.md");

  const gitHazard = await searchVault(root, {
    query: "Portable Git metadata hazard",
  });
  assert.equal(gitHazard.matchedCount, 0);
  assert.equal(gitHazard.rejectedConcepts, 1);
  assert.ok(codes(gitHazard).includes("CONCEPT-PATH"));
});

test("query scan distinguishes valid Markdown resources from concept candidates", async (t) => {
  const { root } = await temporaryVault(t);
  const source = join(root, "references/files/source.bin");
  const markdownResource = join(root, "references/files/source.md");
  await cp(source, markdownResource);
  await unlink(source);
  const evidence = join(root, "projects/fixture/evidence/evidence.md");
  await writeFile(
    evidence,
    (await readFile(evidence, "utf8")).replaceAll("source.bin", "source.md"),
  );

  const resourceOnly = await searchVault(root, {
    query: "Flow-JSON vault evidence bytes",
  });
  assert.equal(
    resourceOnly.complete,
    true,
    JSON.stringify(resourceOnly.diagnostics),
  );
  assert.equal(resourceOnly.matchedCount, 0);
  assert.equal(resourceOnly.rejectedConcepts, 0);
  assert.deepEqual(resourceOnly.diagnostics, []);

  await writeFile(
    join(root, "references/files/unreferenced.md"),
    "no frontmatter unreferenced marker\n",
  );
  await writeFile(
    join(root, "generic-evidence.md"),
    "---\ntype: Evidence\nresource: /references/files/generic-hidden.md\n---\ngeneric\n",
  );
  await writeFile(
    join(root, "references/files/generic-hidden.md"),
    "no frontmatter generic marker\n",
  );
  await writeFile(
    join(root, "references/files/portable-generic.md"),
    "---\ntype: Generic\n---\nportable generic marker\n",
  );
  const rejected = await searchVault(root, { query: "marker" });
  assert.equal(rejected.complete, true);
  assert.equal(rejected.matchedCount, 0);
  assert.equal(rejected.rejectedConcepts, 2);
  assert.ok(codes(rejected).includes("FRONTMATTER-OPEN"));
});

test("query input, scan bounds, cancellation, and unsafe files fail observably", async (t) => {
  const { parent, root } = await temporaryVault(t);
  const exactQuery = "😀".repeat(1_024);
  const exact = await searchVault(root, { query: exactQuery });
  assert.equal(exact.complete, true, JSON.stringify(exact.diagnostics));

  for (const operation of [
    () => searchVault(root, { query: "" }),
    () => searchVault(root, { query: `${exactQuery}a` }),
    () => searchVault(root, { query: "bad\ud800query" }),
    () => searchVault(root, { query: "x", extra: true }),
    () => searchVault(root, { query: "x", filters: { extra: "x" } }),
    () => searchVault(root, { query: "x", filters: { type: "" } }),
    () => searchVault(root, { query: "x" }, { maxResults: 51 }),
    () => searchVault(root, { query: "x" }, { maxExcerptBytes: 1_025 }),
    () => searchVault(root, { query: "x" }, { maxTotalTextBytes: 32_769 }),
    () => inspectConcept(root, { path: researchPath }, { maxContentBytes: 0 }),
    () =>
      inspectConcept(
        root,
        { path: researchPath },
        {
          maxContentBytes: DEFAULT_MAX_CONCEPT_BYTES + 1,
        },
      ),
    () => searchVault(123, { query: "x" }),
  ]) {
    await assert.rejects(operation(), TypeError);
  }

  for (const options of [
    { maxEntries: 1 },
    { maxConcepts: 1 },
    { maxTotalConceptBytes: 1 },
    { maxConceptBytes: 1 },
  ]) {
    const bounded = await searchVault(root, { query: "Fixture" }, options);
    assert.equal(bounded.complete, false, JSON.stringify(options));
    assert.ok(
      codes(bounded).includes("VAULT-BOUNDS") ||
        codes(bounded).includes("CONCEPT-SIZE") ||
        codes(bounded).includes("DIAGNOSTICS-TRUNCATED"),
      JSON.stringify(bounded),
    );
  }

  await writeFile(join(root, "malformed-query.md"), "no frontmatter\n");
  const diagnosticBound = await searchVault(
    root,
    { query: "Fixture" },
    { maxDiagnostics: 1 },
  );
  assert.equal(diagnosticBound.complete, false);
  assert.deepEqual(codes(diagnosticBound), ["DIAGNOSTICS-TRUNCATED"]);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    searchVault(root, { query: "Fixture" }, { signal: controller.signal }),
    { name: "AbortError" },
  );

  const outside = join(parent, "OUTSIDE-QUERY-MARKER.md");
  await writeFile(outside, "---\ntype: Task\n---\nOUTSIDE-CONTENT-MARKER\n");
  await symlink(outside, join(root, "unsafe-symlink.md"));
  await link(outside, join(root, "unsafe-hardlink.md"));
  const unsafe = await searchVault(root, { query: "OUTSIDE-CONTENT-MARKER" });
  assert.equal(unsafe.complete, false);
  assert.equal(unsafe.matchedCount, 0);
  assert.equal(unsafe.results.length, 0);
  assert.ok(codes(unsafe).includes("VAULT-IO"));
  assert.equal(
    JSON.stringify(unsafe).includes("OUTSIDE-CONTENT-MARKER"),
    false,
  );
  for (const path of ["/unsafe-symlink.md", "/unsafe-hardlink.md"]) {
    const inspected = await inspectConcept(root, { path });
    assert.equal(inspected.ok, false);
    assert.equal(inspected.reason, "incomplete");
    assert.equal(inspected.complete, false);
    assert.equal(Object.hasOwn(inspected, "sourceText"), false);
  }

  const missing = await searchVault(join(parent, "missing"), {
    query: "anything",
  });
  assert.equal(missing.complete, false);
  assert.deepEqual(codes(missing), ["VAULT-ROOT"]);
  const nonFileUrl = await searchVault(
    new URL("https://example.invalid/vault"),
    {
      query: "anything",
    },
  );
  assert.equal(nonFileUrl.complete, false);
  assert.equal(nonFileUrl.root, "<invalid>");
  assert.deepEqual(codes(nonFileUrl), ["VAULT-ROOT"]);
});

test("query scan rejects a changed filesystem snapshot and mid-scan cancellation", async (t) => {
  const { root } = await temporaryVault(t);
  const taskPath = join(root, "projects/fixture/tasks/task.md");
  const original = await readFile(taskPath);
  const limits = {
    maxManifestBytes: DEFAULT_MAX_MANIFEST_BYTES,
    maxConceptBytes: DEFAULT_MAX_CONCEPT_BYTES,
    maxYamlDepth: DEFAULT_MAX_YAML_DEPTH,
    maxEntries: DEFAULT_MAX_VAULT_ENTRIES,
    maxConcepts: DEFAULT_MAX_VAULT_CONCEPTS,
    maxTotalConceptBytes: DEFAULT_MAX_TOTAL_CONCEPT_BYTES,
    maxTotalResourceBytes: 1,
    maxDiagnostics: DEFAULT_MAX_VAULT_DIAGNOSTICS,
  };
  let changed = false;
  const raced = await scanVaultForQuery({
    rootPath: root,
    limits,
    async visit() {
      if (changed) return;
      changed = true;
      await writeFile(taskPath, Buffer.concat([original, Buffer.from("race")]));
    },
  });
  assert.equal(raced.safeToReturn, false);
  assert.equal(raced.complete, false);
  assert.ok(codes(raced).includes("VAULT-IO"));

  await writeFile(taskPath, original);
  const controller = new AbortController();
  await assert.rejects(
    scanVaultForQuery({
      rootPath: root,
      limits,
      signal: controller.signal,
      visit() {
        controller.abort();
      },
    }),
    { name: "AbortError" },
  );
});

test("filesystem query declarations and runtime stay provider-free", async () => {
  const declarations = await readFile(
    resolve(repositoryRoot, "packages/core/dist/index.d.ts"),
    "utf8",
  );
  assert.match(declarations, /searchVault/u);
  assert.match(declarations, /inspectConcept/u);
  assert.doesNotMatch(
    declarations,
    /ScannedQueryConcept|PathTracker|BigIntStats|Document|yaml/u,
  );

  const runtime = await Promise.all(
    ["filesystem-query.ts", "vault-query-scan.ts"].map((name) =>
      readFile(resolve(repositoryRoot, "packages/core/src", name), "utf8"),
    ),
  );
  const source = runtime.join("\n");
  assert.doesNotMatch(
    source,
    /node:child_process|\bfetch\s*\(|\bRedis\b|\bPi\b|process\.exit|git commit|git push/u,
  );
});

test("search ordering and UTF-8 output truncation are deterministic", async (t) => {
  const { root } = await temporaryVault(t);
  await writeTask(root, "projects/fixture/tasks/late-body-match.md", {
    uid: taskUid("59"),
    title: "Late body target",
    body: `${"a".repeat(2_000)}END-MATCH\n`,
  });
  const retainedMatch = await searchVault(
    root,
    { query: "END-MATCH" },
    { maxExcerptBytes: 16 },
  );
  assert.equal(retainedMatch.results.length, 1);
  assert.ok(retainedMatch.results[0].excerpt.includes("END-MATCH"));

  for (const [index, name] of ["z", "a", "m", "b"].entries()) {
    await writeTask(root, `projects/fixture/tasks/${name}.md`, {
      uid: taskUid(String(20 + index).padStart(2, "0")),
      title: `A deliberately long ${name} title ΩΩΩ`,
      body: "prefix prefix MATCH😀 suffix suffix\n",
    });
  }
  const options = {
    maxResults: 2,
    maxExcerptBytes: 10,
    maxTotalTextBytes: 20,
  };

  const first = await searchVault(root, { query: "MATCH😀" }, options);
  const second = await searchVault(root, { query: "MATCH😀" }, options);
  assert.deepEqual(second, first);
  assert.equal(first.complete, true, JSON.stringify(first.diagnostics));
  assert.equal(first.matchedCount, 4);
  assert.equal(first.resultsTruncated, true);
  assert.equal(first.outputTruncated, true);
  assert.deepEqual(
    first.results.map((result) => result.source.path),
    ["/projects/fixture/tasks/a.md", "/projects/fixture/tasks/b.md"],
  );
  assert.match(first.results[0].excerpt, /MATCH😀/u);
  assert.equal(first.results[0].excerptTruncated, true);
  assert.equal(first.results[0].titleTruncated, true);
  const textBytes = first.results.reduce(
    (total, result) =>
      total +
      Buffer.byteLength(result.title) +
      Buffer.byteLength(result.excerpt),
    0,
  );
  assert.ok(textBytes <= options.maxTotalTextBytes);
  for (const result of first.results) {
    assert.ok(Buffer.byteLength(result.title) <= options.maxExcerptBytes);
    assert.ok(Buffer.byteLength(result.excerpt) <= options.maxExcerptBytes);
    assert.doesNotMatch(result.title, /�/u);
    assert.doesNotMatch(result.excerpt, /�/u);
  }
});
