import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  DEFAULT_MAX_VAULT_CONCEPTS,
  DEFAULT_MAX_VAULT_DIAGNOSTICS,
  DEFAULT_MAX_VAULT_ENTRIES,
  loadConcept,
  validateVault,
} from "../dist/index.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const exampleVault = resolve(repositoryRoot, "examples/vault");
const validVault = resolve(repositoryRoot, "fixtures/valid-vault");
const invalidVaults = resolve(repositoryRoot, "fixtures/invalid-vaults");
const policyFixtureRoot = resolve(repositoryRoot, "fixtures/policy/1.0");
const conceptFixtureRoot = resolve(
  repositoryRoot,
  "fixtures/concepts/1.0/valid",
);

function mergeFixture(base, patch) {
  if (
    patch === null ||
    typeof patch !== "object" ||
    Array.isArray(patch) ||
    base === null ||
    typeof base !== "object" ||
    Array.isArray(base)
  ) {
    return structuredClone(patch);
  }
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(patch)) {
    result[key] = mergeFixture(result[key], value);
  }
  return result;
}

async function materializePolicyCase(t, fixture) {
  const parent = await mkdtemp(join(tmpdir(), "bookie-policy-vault-"));
  const vault = join(parent, "vault");
  await mkdir(vault, { recursive: true });
  t.after(() => rm(parent, { recursive: true, force: true }));
  const policy = fixture.facts.policy;
  await writeFile(
    join(vault, "bookie.yaml"),
    JSON.stringify({
      profile: "1.0",
      vault: {
        uid: "VLT-00000000000000000000000001",
        title: fixture.id,
      },
      allowed_concept_types: policy.allowed_concept_types,
      policy: {
        evidence_roots: policy.evidence_roots,
        exclude: [],
        sensitivity: { classes: ["public"], excluded_classes: [] },
        attachment_max_bytes: policy.attachment_max_bytes,
      },
    }),
  );
  await writeFile(
    join(vault, "index.md"),
    '---\nokf_version: "0.2"\n---\n\n# Policy fixture\n',
  );

  for (const descriptor of fixture.facts.proposed.concepts ?? []) {
    const base = JSON.parse(
      await readFile(
        join(conceptFixtureRoot, `${descriptor.fixture}.json`),
        "utf8",
      ),
    );
    const frontmatter = mergeFixture(base, descriptor.patch ?? {});
    const path = join(vault, descriptor.path.slice(1));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      `---\n${JSON.stringify(frontmatter)}\n---\n${descriptor.body}`,
    );
  }
  for (const descriptor of fixture.facts.proposed.resources ?? []) {
    const path = join(vault, descriptor.path.slice(1));
    await mkdir(dirname(path), { recursive: true });
    if (descriptor.kind === "symlink") {
      const target = join(parent, `${fixture.id}-outside-resource`);
      await cp(join(policyFixtureRoot, descriptor.fixture), target);
      await symlink(target, path);
    } else {
      await cp(join(policyFixtureRoot, descriptor.fixture), path);
    }
  }
  return vault;
}

async function temporaryVault(t, source = validVault) {
  const parent = await mkdtemp(join(tmpdir(), "bookie-vault-"));
  const vault = join(parent, "vault");
  await cp(source, vault, { recursive: true });
  t.after(() => rm(parent, { recursive: true, force: true }));
  return vault;
}

async function rewriteFlowConcept(path, change, body) {
  const source = await readFile(path, "utf8");
  const match = /^---\n([^\n]+)\n---\n([\s\S]*)$/.exec(source);
  assert.ok(match, `Expected flow-style fixture at ${path}`);
  const frontmatter = JSON.parse(match[1]);
  change(frontmatter);
  await writeFile(
    path,
    `---\n${JSON.stringify(frontmatter)}\n---\n${body ?? match[2]}`,
  );
}

function diagnosticCodes(result) {
  return [...new Set(result.diagnostics.map((diagnostic) => diagnostic.code))];
}

test("production validator accepts the example and complete valid vault", async () => {
  for (const root of [exampleVault, validVault]) {
    const result = await validateVault(root);
    assert.equal(result.valid, true, JSON.stringify(result.diagnostics));
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.complete, true);
    assert.equal(result.diagnosticsTruncated, false);
    assert.equal(
      result.root,
      await import("node:fs/promises").then(({ realpath }) => realpath(root)),
    );
  }
});

test("production validator preserves isolated invalid-vault rule codes", async (t) => {
  const expectations = {
    "activity-correction-multiple-predecessors": "RELATION-TARGET",
    "decision-supersession-lifecycle": "DECISION-SUPERSESSION",
    "missing-evidence-resource": "EVIDENCE-RESOURCE",
    "missing-relation-target": "RELATION-TARGET",
    "missing-type": "CONCEPT-SCHEMA",
    "profile-version-mismatch": "CONCEPT-SCHEMA",
    "type-not-allowed": "TYPE-ALLOWED",
  };

  for (const [name, expected] of Object.entries(expectations)) {
    await t.test(name, async () => {
      const result = await validateVault(join(invalidVaults, name));
      assert.equal(result.valid, false);
      assert.deepEqual(diagnosticCodes(result), [expected]);
    });
  }
});

test("production validator consumes every current-tree policy fixture", async (t) => {
  const selected = new Set([
    "activity-correction-multiple-predecessors",
    "decision-supersession-lifecycle",
    "decision-supersession-missing-reciprocal",
    "decision-supersession-missing-successor",
    "decision-supersession-multiple-replacements",
    "evidence-digest-mismatch",
    "evidence-resource-deleted",
    "evidence-resource-escape",
    "evidence-resource-missing",
    "evidence-resource-oversized",
    "evidence-resource-root-itself",
    "evidence-resource-symlink",
    "evidence-support-missing",
    "project-target-wrong-type",
    "relation-inverse-missing",
    "relation-inverse-wrong-kind",
    "relation-supersession-wrong-type",
    "relation-target-missing",
    "relation-target-uid-mismatch",
    "type-not-allowed",
    "uid-duplicate",
  ]);
  const fixtures = JSON.parse(
    await readFile(join(policyFixtureRoot, "invalid/cases.json"), "utf8"),
  ).filter((fixture) => selected.has(fixture.id));
  assert.equal(fixtures.length, selected.size);

  for (const fixture of fixtures) {
    await t.test(fixture.id, async (t) => {
      const vault = await materializePolicyCase(t, fixture);
      const result = await validateVault(vault);
      const policyCodes = diagnosticCodes(result).filter((code) =>
        [
          "TYPE-ALLOWED",
          "UID-UNIQUE",
          "PROJECT-TARGET",
          "RELATION-TARGET",
          "RELATION-INVERSE",
          "DECISION-SUPERSESSION",
          "EVIDENCE-RESOURCE",
          "EVIDENCE-DIGEST",
          "EVIDENCE-SUPPORT",
        ].includes(code),
      );
      assert.deepEqual(new Set(policyCodes), new Set(fixture.expected.rules));
    });
  }
});

test("BK-009 base-only policy fixtures remain valid current trees", async (t) => {
  const deferredIds = new Set([
    "activity-deleted",
    "activity-edited",
    "activity-renamed",
    "decision-deleted",
    "evidence-deleted",
    "evidence-edited",
    "evidence-renamed",
    "immutable-project-target-renamed",
    "immutable-relation-target-renamed",
    "immutable-support-target-renamed",
  ]);
  const fixtures = JSON.parse(
    await readFile(join(policyFixtureRoot, "invalid/cases.json"), "utf8"),
  ).filter((fixture) => deferredIds.has(fixture.id));
  assert.equal(fixtures.length, deferredIds.size);
  for (const fixture of fixtures) {
    await t.test(fixture.id, async (t) => {
      const vault = await materializePolicyCase(t, fixture);
      const result = await validateVault(vault);
      assert.equal(result.valid, true, JSON.stringify(result.diagnostics));
    });
  }
});

test("production validator accepts every valid current-tree policy fixture", async (t) => {
  const fixtures = JSON.parse(
    await readFile(join(policyFixtureRoot, "valid/cases.json"), "utf8"),
  );
  assert.equal(fixtures.length, 5);
  for (const fixture of fixtures) {
    await t.test(fixture.id, async (t) => {
      const vault = await materializePolicyCase(t, fixture);
      const result = await validateVault(vault);
      assert.equal(result.valid, true, JSON.stringify(result.diagnostics));
    });
  }
});

test("current-tree resource changes and predecessor-only Decision links keep phase-correct codes", async (t) => {
  const invalidFixtures = JSON.parse(
    await readFile(join(policyFixtureRoot, "invalid/cases.json"), "utf8"),
  );
  const bytesChanged = invalidFixtures.find(
    (fixture) => fixture.id === "evidence-resource-bytes-changed",
  );
  assert.ok(bytesChanged);
  const changedVault = await materializePolicyCase(t, bytesChanged);
  const changed = await validateVault(changedVault);
  assert.ok(diagnosticCodes(changed).includes("EVIDENCE-DIGEST"));
  assert.equal(diagnosticCodes(changed).includes("EVIDENCE-IMMUTABLE"), false);

  const validFixtures = JSON.parse(
    await readFile(join(policyFixtureRoot, "valid/cases.json"), "utf8"),
  );
  const decision = validFixtures.find(
    (fixture) => fixture.id === "decision-supersession",
  );
  assert.ok(decision);
  const decisionVault = await materializePolicyCase(t, decision);
  await rewriteFlowConcept(
    join(decisionVault, "projects/demo/decisions/new.md"),
    (frontmatter) => {
      frontmatter.bookie.relations = [];
    },
  );
  const missingReplacementEdge = await validateVault(decisionVault);
  assert.ok(
    diagnosticCodes(missingReplacementEdge).includes("DECISION-SUPERSESSION"),
  );
  assert.ok(
    diagnosticCodes(missingReplacementEdge).includes("RELATION-INVERSE"),
  );
});

test("one run reports independent schema, Markdown link, relation, resource, and digest errors", async (t) => {
  const vault = await temporaryVault(t);

  await rewriteFlowConcept(
    join(vault, "projects/fixture/project.md"),
    (frontmatter) => delete frontmatter.title,
  );
  await rewriteFlowConcept(
    join(vault, "projects/fixture/tasks/task.md"),
    (frontmatter) => {
      frontmatter.bookie.relations = [
        { kind: "relates_to", target: "/projects/fixture/missing.md" },
      ];
    },
  );
  await rewriteFlowConcept(
    join(vault, "projects/fixture/documents/document.md"),
    () => {},
    "# Document\n\n[Broken local link](missing-document.md)\n",
  );
  const evidencePath = join(vault, "projects/fixture/evidence/evidence.md");
  await rewriteFlowConcept(evidencePath, (frontmatter) => {
    frontmatter.bookie.sha256 = "0".repeat(64);
  });
  const missingEvidence = join(
    vault,
    "projects/fixture/evidence/missing-resource.md",
  );
  await cp(evidencePath, missingEvidence);
  await rewriteFlowConcept(missingEvidence, (frontmatter) => {
    frontmatter.title = "Missing resource";
    frontmatter.resource = "/references/files/missing.bin";
    frontmatter.bookie.uid = "EVD-00000000000000000000000009";
  });

  const result = await validateVault(vault);
  const codes = new Set(diagnosticCodes(result));
  for (const code of [
    "CONCEPT-SCHEMA",
    "MARKDOWN-LINK",
    "RELATION-TARGET",
    "EVIDENCE-RESOURCE",
    "EVIDENCE-DIGEST",
  ]) {
    assert.ok(codes.has(code), `Missing ${code}: ${JSON.stringify(result)}`);
  }
  assert.equal(result.valid, false);
  assert.equal(result.complete, true);
  assert.equal(result.diagnosticsTruncated, false);
});

test("manifest failures do not hide independent concept parse failures", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "bookie-invalid-vault-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  await writeFile(join(parent, "bookie.yaml"), "profile: [\n");
  await writeFile(join(parent, "index.md"), '---\nokf_version: "0.2"\n---\n');
  await writeFile(join(parent, "broken.md"), "---\ntype: [\n---\nBody\n");

  const result = await validateVault(parent);
  assert.equal(result.valid, false);
  assert.deepEqual(
    new Set(diagnosticCodes(result)),
    new Set(["MANIFEST-SYNTAX", "YAML-SYNTAX"]),
  );
});

test("generic OKF and excluded paths remain portable without escaping Bookie policy", async (t) => {
  const vault = await temporaryVault(t);
  await mkdir(join(vault, "exports"));
  await writeFile(join(vault, "exports/broken.md"), "not frontmatter");
  await writeFile(
    join(vault, "generic.md"),
    "---\ntype: CustomConcept\n---\n\n[Project](projects/fixture/project.md)\n",
  );

  const valid = await validateVault(vault);
  assert.equal(valid.valid, true, JSON.stringify(valid.diagnostics));

  await writeFile(
    join(vault, "known-type.md"),
    "---\ntype: Task\ntitle: Generic OKF Task\n---\nBody\n",
  );
  const knownGeneric = await validateVault(vault);
  assert.equal(
    knownGeneric.valid,
    true,
    JSON.stringify(knownGeneric.diagnostics),
  );
});

test("trusted type and UID fields still enforce policy when a Bookie schema fails", async (t) => {
  const vault = await temporaryVault(t);
  const manifestPath = join(vault, "bookie.yaml");
  await writeFile(
    manifestPath,
    (await readFile(manifestPath, "utf8")).replace(
      /allowed_concept_types:\n(?:[ ]{2}- [A-Za-z]+\n)+/u,
      "allowed_concept_types:\n  - Project\n",
    ),
  );
  const taskPath = join(vault, "projects/fixture/tasks/task.md");
  await rewriteFlowConcept(taskPath, (frontmatter) => {
    delete frontmatter.title;
  });
  const duplicatePath = join(
    vault,
    "projects/fixture/tasks/duplicate-invalid.md",
  );
  await cp(taskPath, duplicatePath);
  await writeFile(
    join(vault, "unknown-bookie.md"),
    `---\n${JSON.stringify({
      type: "UnknownBookieType",
      title: "Unknown",
      bookie: {
        profile: "1.0",
        uid: "ZZZ-00000000000000000000000009",
      },
    })}\n---\nBody\n`,
  );

  const result = await validateVault(vault);
  const codes = diagnosticCodes(result);
  for (const code of ["CONCEPT-SCHEMA", "TYPE-ALLOWED", "UID-UNIQUE"]) {
    assert.ok(
      codes.includes(code),
      `Missing ${code}: ${JSON.stringify(result)}`,
    );
  }
});

test("CommonMark inline, image, and reference links resolve without rendering or fetching", async (t) => {
  const vault = await temporaryVault(t);
  const path = join(vault, "projects/fixture/documents/document.md");
  await rewriteFlowConcept(
    path,
    () => {},
    [
      "# Links",
      "",
      "[Project][project]",
      "![Evidence bytes](/references/files/source.bin)",
      "[Unicode research](../research/%CE%94-findings.md)",
      "[Remote](https://example.com/not-fetched)",
      "[Fragment](#links)",
      "[Query](?view=1)",
      "[Directory](../tasks/)",
      "[Project query](../project.md?view=1#summary)",
      '<a href="../../outside.md">raw HTML is inert</a>',
      "",
      "[project]: ../project.md",
      "[unused]: missing.md",
      "",
    ].join("\n"),
  );

  const valid = await validateVault(vault);
  assert.equal(valid.valid, true, JSON.stringify(valid.diagnostics));

  await rewriteFlowConcept(
    path,
    () => {},
    "[Project][project]\n\n[project]: ../project.md\n[project]: missing.md\n",
  );
  const firstDefinitionWins = await validateVault(vault);
  assert.equal(
    firstDefinitionWins.valid,
    true,
    JSON.stringify(firstDefinitionWins.diagnostics),
  );

  await rewriteFlowConcept(
    path,
    () => {},
    "[Missing][target]\n\n[target]: ../../../../outside.md\n",
  );
  const invalid = await validateVault(vault);
  assert.ok(diagnosticCodes(invalid).includes("MARKDOWN-LINK"));

  await rewriteFlowConcept(
    path,
    () => {},
    "[Encoded separator](%2Fprojects%2Ffixture%2Fproject.md)\n",
  );
  const encodedSeparator = await validateVault(vault);
  assert.ok(diagnosticCodes(encodedSeparator).includes("MARKDOWN-LINK"));
});

test("resource and traversal symlinks fail closed without exposing outside content", async (t) => {
  const vault = await temporaryVault(t);
  const outside = join(dirname(vault), "TOP-SECRET-OUTSIDE-MARKER.txt");
  await writeFile(outside, "TOP-SECRET-CONTENT-MARKER");
  const resource = join(vault, "references/files/source.bin");
  await unlink(resource);
  await symlink(outside, resource);
  await symlink(".", join(vault, "loop"));

  const result = await validateVault(vault);
  assert.equal(result.valid, false);
  assert.ok(diagnosticCodes(result).includes("EVIDENCE-RESOURCE"));
  assert.ok(diagnosticCodes(result).includes("VAULT-IO"));
  assert.equal(
    JSON.stringify(result).includes("TOP-SECRET-CONTENT-MARKER"),
    false,
  );
  assert.equal(JSON.stringify(result).includes(basename(outside)), false);
});

test("in-place file changes after reading make the vault snapshot incomplete", async (t) => {
  const vault = await temporaryVault(t);
  const manifestPath = join(vault, "bookie.yaml");
  const original = await readFile(manifestPath, "utf8");
  await writeFile(
    join(vault, "index.md"),
    Array.from({ length: 20_000 }, (_, index) => `[link ${index}](#same)`).join(
      "\n",
    ),
  );

  const validation = validateVault(vault);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await writeFile(manifestPath, `${original}\n# changed after read\n`);
  const result = await validation;

  assert.equal(result.valid, false);
  assert.equal(result.complete, false);
  assert.ok(diagnosticCodes(result).includes("VAULT-IO"));
});

test("resource metadata changes during streamed hashing fail closed", async (t) => {
  const vault = await temporaryVault(t);
  const resourcePath = join(vault, "references/files/source.bin");
  const resource = Buffer.alloc(8 * 1024 * 1024, 0x61);
  await writeFile(resourcePath, resource);
  const manifestPath = join(vault, "bookie.yaml");
  await writeFile(
    manifestPath,
    (await readFile(manifestPath, "utf8")).replace(
      "attachment_max_bytes: 1024",
      `attachment_max_bytes: ${resource.byteLength + 1}`,
    ),
  );
  const evidencePath = join(vault, "projects/fixture/evidence/evidence.md");
  await rewriteFlowConcept(evidencePath, (frontmatter) => {
    frontmatter.bookie.sha256 = createHash("sha256")
      .update(resource)
      .digest("hex");
  });
  const secondResource = Buffer.from("second resource");
  await writeFile(join(vault, "references/files/second.bin"), secondResource);
  const loadedEvidence = loadConcept(await readFile(evidencePath), {
    file: evidencePath,
  });
  assert.equal(loadedEvidence.ok, true);
  const secondEvidence = structuredClone(loadedEvidence.concept.frontmatter);
  secondEvidence.title = "Second evidence";
  secondEvidence.resource = "/references/files/second.bin";
  secondEvidence.bookie.uid = "EVD-00000000000000000000000008";
  secondEvidence.bookie.sha256 = createHash("sha256")
    .update(secondResource)
    .digest("hex");
  await writeFile(
    join(vault, "projects/fixture/evidence/zz-second.md"),
    `---\n${JSON.stringify(secondEvidence)}\n---\n`,
  );

  let mutate = true;
  const mutator = (async () => {
    let mode = 0o600;
    while (mutate) {
      await chmod(resourcePath, mode);
      mode = mode === 0o600 ? 0o644 : 0o600;
      await new Promise((resolve) => setImmediate(resolve));
    }
  })();
  let result;
  try {
    result = await validateVault(vault, {
      maxTotalResourceBytes: resource.byteLength,
    });
  } finally {
    mutate = false;
    await mutator;
  }

  assert.equal(result.valid, false);
  assert.ok(diagnosticCodes(result).includes("EVIDENCE-RESOURCE"));
  assert.ok(diagnosticCodes(result).includes("VAULT-BOUNDS"));
  assert.equal(result.complete, false);
});

test("excluded sensitivity diagnostics redact canonical identifiers and content", async (t) => {
  const vault = await temporaryVault(t);
  const manifestPath = join(vault, "bookie.yaml");
  const manifest = await readFile(manifestPath, "utf8");
  await writeFile(
    manifestPath,
    manifest
      .replace("      - public\n", "      - public\n      - restricted\n")
      .replace(
        "    excluded_classes: []",
        "    excluded_classes:\n      - restricted",
      ),
  );
  const taskPath = join(vault, "projects/fixture/tasks/task.md");
  await rewriteFlowConcept(
    taskPath,
    (frontmatter) => {
      frontmatter.title = "TOP-SECRET-TITLE-MARKER";
      frontmatter.bookie.sensitivity = "restricted";
      frontmatter.bookie.relations = [
        {
          kind: "relates_to",
          target: "/projects/fixture/TOP-SECRET-TARGET-MARKER.md",
        },
      ];
    },
    "[TOP-SECRET-BODY-MARKER](TOP-SECRET-LINK-MARKER.md)\n",
  );
  const outsideResource = join(dirname(vault), "outside-resource.bin");
  await writeFile(outsideResource, "TOP-SECRET-RESOURCE-CONTENT");
  await unlink(join(vault, "references/files/source.bin"));
  await symlink(
    outsideResource,
    join(vault, "references/files/TOP-SECRET-RESOURCE-MARKER.bin"),
  );
  await rewriteFlowConcept(
    join(vault, "projects/fixture/evidence/evidence.md"),
    (frontmatter) => {
      frontmatter.bookie.sensitivity = "restricted";
      frontmatter.resource = "/references/files/TOP-SECRET-RESOURCE-MARKER.bin";
    },
  );

  const result = await validateVault(vault);
  const serialized = JSON.stringify(result.diagnostics);
  assert.equal(result.valid, false);
  assert.ok(
    result.diagnostics.some((diagnostic) => diagnostic.file === "<excluded>"),
  );
  for (const marker of [
    "TOP-SECRET-TITLE-MARKER",
    "TOP-SECRET-TARGET-MARKER",
    "TOP-SECRET-BODY-MARKER",
    "TOP-SECRET-LINK-MARKER",
    "TOP-SECRET-RESOURCE-MARKER",
    "TOP-SECRET-RESOURCE-CONTENT",
    "TSK-00000000000000000000000002",
    "/projects/fixture/tasks/task.md",
  ]) {
    assert.equal(serialized.includes(marker), false, `Leaked ${marker}`);
  }
});

test("parseable invalid manifests still provide fail-closed diagnostic redaction", async (t) => {
  const vault = await temporaryVault(t);
  const manifestPath = join(vault, "bookie.yaml");
  const manifest = (await readFile(manifestPath, "utf8"))
    .replace("  title: Profile 1.0 valid vault fixture\n", "")
    .replace("      - public\n", "      - public\n      - restricted\n")
    .replace(
      "    excluded_classes: []",
      "    excluded_classes:\n      - restricted",
    );
  await writeFile(manifestPath, manifest);
  const taskPath = join(vault, "projects/fixture/tasks/task.md");
  await rewriteFlowConcept(taskPath, (frontmatter) => {
    frontmatter.bookie.sensitivity = "restricted";
    frontmatter.bookie.relations = [
      { kind: "relates_to", target: "/TOP-SECRET-TARGET.md" },
    ];
  });

  const result = await validateVault(vault);
  assert.ok(diagnosticCodes(result).includes("MANIFEST-SCHEMA"));
  assert.ok(
    result.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "RELATION-TARGET" &&
        diagnostic.file === "<excluded>",
    ),
  );
  assert.equal(
    JSON.stringify(result.diagnostics).includes(
      "/projects/fixture/tasks/task.md",
    ),
    false,
  );
});

test("diagnostic and traversal bounds are explicit and deterministic", async (t) => {
  const vault = await temporaryVault(t);
  const documentPath = join(vault, "projects/fixture/documents/document.md");
  await rewriteFlowConcept(
    documentPath,
    () => {},
    Array.from(
      { length: 20 },
      (_, index) => `[missing ${index}](missing-${index}.md)`,
    ).join("\n"),
  );

  const first = await validateVault(vault, { maxDiagnostics: 3 });
  const second = await validateVault(vault, { maxDiagnostics: 3 });
  assert.deepEqual(first, second);
  assert.equal(first.valid, false);
  assert.equal(first.complete, false);
  assert.equal(first.diagnosticsTruncated, true);
  assert.equal(first.diagnostics.length, 3);
  assert.equal(first.diagnostics.at(-1).code, "DIAGNOSTICS-TRUNCATED");

  const bounded = await validateVault(vault, { maxEntries: 1 });
  assert.equal(bounded.valid, false);
  assert.equal(bounded.complete, false);
  assert.equal(bounded.diagnosticsTruncated, false);
  assert.ok(diagnosticCodes(bounded).includes("VAULT-BOUNDS"));

  const resourceBound = await validateVault(validVault, {
    maxTotalResourceBytes: 31,
  });
  assert.equal(resourceBound.valid, false);
  assert.equal(resourceBound.complete, false);
  assert.ok(diagnosticCodes(resourceBound).includes("VAULT-BOUNDS"));

  await assert.rejects(validateVault(vault, { maxEntries: 0 }), TypeError);

  assert.equal(DEFAULT_MAX_VAULT_CONCEPTS, 50_000);
  assert.equal(DEFAULT_MAX_VAULT_ENTRIES, 100_000);
  assert.equal(DEFAULT_MAX_VAULT_DIAGNOSTICS, 1_000);
});

test("manifest and reserved Markdown parsing remain bounded content failures", async (t) => {
  const unsafeManifestVault = await temporaryVault(t);
  const manifestPath = join(unsafeManifestVault, "bookie.yaml");
  const manifest = await readFile(manifestPath, "utf8");
  await writeFile(
    manifestPath,
    manifest.replace(
      'profile: "1.0"',
      'profile: &profile "1.0"\ncopy: *profile',
    ),
  );
  const alias = await validateVault(unsafeManifestVault);
  assert.ok(diagnosticCodes(alias).includes("MANIFEST-SYNTAX"));

  const unsafeNumberVault = await temporaryVault(t);
  const unsafeNumberManifest = join(unsafeNumberVault, "bookie.yaml");
  await writeFile(
    unsafeNumberManifest,
    (await readFile(unsafeNumberManifest, "utf8")).replace(
      "attachment_max_bytes: 1024",
      "attachment_max_bytes: 9007199254740993",
    ),
  );
  const unsafeNumber = await validateVault(unsafeNumberVault);
  assert.ok(diagnosticCodes(unsafeNumber).includes("MANIFEST-SYNTAX"));

  const sizedVault = await temporaryVault(t);
  const manifestBytes = await readFile(join(sizedVault, "bookie.yaml"));
  const sized = await validateVault(sizedVault, {
    maxManifestBytes: manifestBytes.byteLength - 1,
  });
  assert.ok(diagnosticCodes(sized).includes("MANIFEST-SIZE"));
  assert.equal(sized.complete, false);

  const conceptSized = await validateVault(sizedVault, {
    maxConceptBytes: 100,
  });
  assert.ok(diagnosticCodes(conceptSized).includes("CONCEPT-SIZE"));
  assert.equal(conceptSized.complete, false);

  const invalidReservedVault = await temporaryVault(t);
  await writeFile(
    join(invalidReservedVault, "index.md"),
    Uint8Array.from([0xff, 0xfe]),
  );
  const invalidReserved = await validateVault(invalidReservedVault);
  assert.ok(diagnosticCodes(invalidReserved).includes("CONCEPT-UTF8"));
});

test("canonical paths and cancellation fail without process exits", async (t) => {
  const vault = await temporaryVault(t);
  const source = join(vault, "projects/fixture/tasks/task.md");
  const invalidPath = join(vault, "projects/fixture/tasks/bad:name.md");
  await cp(source, invalidPath);
  await rewriteFlowConcept(invalidPath, (frontmatter) => {
    frontmatter.bookie.uid = "TSK-00000000000000000000000009";
  });
  const result = await validateVault(vault);
  assert.ok(diagnosticCodes(result).includes("CONCEPT-PATH"));

  for (const reason of [undefined, new Error("custom"), "custom"]) {
    const controller = new AbortController();
    controller.abort(reason);
    await assert.rejects(
      validateVault(vault, { signal: controller.signal }),
      (error) => error?.name === "AbortError",
    );
  }
  const timeoutSignal = AbortSignal.timeout(0);
  await new Promise((resolve) => setTimeout(resolve, 1));
  await assert.rejects(
    validateVault(vault, { signal: timeoutSignal }),
    (error) => error?.name === "AbortError",
  );

  let checks = 0;
  const countingSignal = {
    get aborted() {
      checks += 1;
      return false;
    },
  };
  const counted = await validateVault(vault, { signal: countingSignal });
  assert.equal(counted.valid, false);
  assert.ok(checks > 20);

  let lateChecks = 0;
  const lateSignal = {
    get aborted() {
      lateChecks += 1;
      return lateChecks >= checks - 5;
    },
  };
  await assert.rejects(
    validateVault(vault, { signal: lateSignal }),
    (error) => error?.name === "AbortError",
  );
});

test("a clean relocated package carries canonical schemas and supported runtime metadata", async (t) => {
  const coreRoot = resolve(repositoryRoot, "packages/core");
  const packageManifest = JSON.parse(
    await readFile(resolve(coreRoot, "package.json"), "utf8"),
  );
  assert.equal(packageManifest.engines?.node, ">=24");
  for (const relativePath of [
    "bookie-common.schema.json",
    "export/1.0/canonical-record.schema.json",
    "profile/1.0/bookie-config.schema.json",
    ...[
      "activity",
      "decision",
      "document",
      "evidence",
      "person",
      "project",
      "research",
      "task",
    ].map((name) => `types/${name}.schema.json`),
  ]) {
    const canonical = await readFile(
      resolve(repositoryRoot, "schemas", relativePath),
    );
    const packaged = await readFile(
      resolve(coreRoot, "dist/schemas", relativePath),
    );
    assert.equal(packaged.equals(canonical), true, relativePath);
  }

  const packRoot = await mkdtemp(join(tmpdir(), "bookie-core-pack-"));
  t.after(() => rm(packRoot, { recursive: true, force: true }));
  const cleanRepository = join(packRoot, "source");
  const cleanCore = join(cleanRepository, "packages/core");
  await mkdir(join(cleanRepository, "packages"), { recursive: true });
  await cp(coreRoot, cleanCore, { recursive: true });
  await rm(join(cleanCore, "dist"), { recursive: true, force: true });
  await rm(join(cleanCore, "tsconfig.tsbuildinfo"), { force: true });
  await cp(
    resolve(repositoryRoot, "schemas"),
    join(cleanRepository, "schemas"),
    { recursive: true },
  );
  await symlink(
    resolve(repositoryRoot, "node_modules"),
    join(cleanRepository, "node_modules"),
    "dir",
  );
  const packed = spawnSync(
    "npm",
    ["pack", "--json", "--pack-destination", packRoot],
    { cwd: cleanCore, encoding: "utf8" },
  );
  assert.equal(packed.status, 0, packed.stderr);
  const parsedReport = JSON.parse(packed.stdout);
  const report = Array.isArray(parsedReport)
    ? parsedReport[0]
    : (parsedReport["@bookie/core"] ?? Object.values(parsedReport)[0]);
  assert.ok(report);
  const files = new Set(report.files.map((file) => file.path));
  for (const required of [
    "dist/index.js",
    "dist/index.d.ts",
    "dist/vault-markdown-worker.js",
    "dist/schemas/bookie-common.schema.json",
    "dist/schemas/export/1.0/canonical-record.schema.json",
    "dist/schemas/profile/1.0/bookie-config.schema.json",
  ]) {
    assert.ok(files.has(required), `Packed core is missing ${required}`);
  }
  for (const declaration of report.files
    .filter((file) => file.path.endsWith(".d.ts"))
    .map((file) => readFile(resolve(cleanCore, file.path), "utf8"))) {
    assert.doesNotMatch(await declaration, /from ["'](?:yaml|ajv|mdast)/u);
  }

  const extracted = join(packRoot, "extracted");
  await mkdir(extracted);
  const unpacked = spawnSync(
    "tar",
    ["-xzf", join(packRoot, report.filename), "-C", extracted],
    { encoding: "utf8" },
  );
  assert.equal(unpacked.status, 0, unpacked.stderr);
  const relocatedRoot = join(extracted, "package");
  const packedManifest = JSON.parse(
    await readFile(join(relocatedRoot, "package.json"), "utf8"),
  );
  assert.deepEqual(Object.keys(packedManifest.dependencies).sort(), [
    "ajv",
    "ajv-formats",
    "mdast-util-from-markdown",
    "yaml",
  ]);
  const installRoot = join(packRoot, "installed");
  await mkdir(installRoot);
  await writeFile(
    join(installRoot, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  const installed = spawnSync(
    "npm",
    [
      "install",
      "--prefer-offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      join(packRoot, report.filename),
    ],
    { cwd: installRoot, encoding: "utf8" },
  );
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  const relocated = await import(
    `${pathToFileURL(join(installRoot, "node_modules/@bookie/core/dist/index.js")).href}?packed`
  );
  assert.equal(typeof relocated.exportCanonicalJsonl, "function");
  const result = await relocated.validateVault(validVault);
  assert.equal(result.valid, true, JSON.stringify(result.diagnostics));
  const packedWorkerVault = join(packRoot, "packed-worker-vault");
  await cp(validVault, packedWorkerVault, { recursive: true });
  const packedIndex = join(packedWorkerVault, "index.md");
  await writeFile(
    packedIndex,
    `${await readFile(packedIndex, "utf8")}\n${"> ".repeat(300)}nested\n`,
  );
  const workerResult = await relocated.validateVault(packedWorkerVault);
  assert.equal(workerResult.complete, false);
  assert.ok(diagnosticCodes(workerResult).includes("MARKDOWN-LINK"));
});

test("missing roots and manifests return stable diagnostics", async (t) => {
  const missingPath = join(tmpdir(), `missing-bookie-vault-${Date.now()}`);
  const missing = await validateVault(missingPath);
  assert.deepEqual(diagnosticCodes(missing), ["VAULT-ROOT"]);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    validateVault(missingPath, { signal: controller.signal }),
    (error) => error?.name === "AbortError",
  );

  const empty = await mkdtemp(join(tmpdir(), "bookie-empty-vault-"));
  t.after(() => rm(empty, { recursive: true, force: true }));
  const noManifest = await validateVault(empty);
  assert.ok(diagnosticCodes(noManifest).includes("MANIFEST-MISSING"));
});
