import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, relative, resolve } from "node:path";
import test from "node:test";

import { parseDocument } from "yaml";

const root = resolve(import.meta.dirname, "..");
const exampleRoot = resolve(root, "examples/vault");
const validVaultRoot = resolve(root, "fixtures/valid-vault");
const invalidVaultRoot = resolve(root, "fixtures/invalid-vaults");
const referencePath = resolve(root, "docs/reference/profile-v1.md");

const typePrefixes = {
  Project: "PRJ",
  Task: "TSK",
  Document: "DOC",
  Research: "RSC",
  Decision: "DSN",
  Activity: "ACT",
  Evidence: "EVD",
  Person: "PER",
};

const invalidCases = [
  "activity-correction-multiple-predecessors",
  "decision-supersession-lifecycle",
  "missing-evidence-resource",
  "missing-relation-target",
  "missing-type",
  "profile-version-mismatch",
  "type-not-allowed",
];

function filesBelow(path) {
  const result = [];
  for (const name of readdirSync(path)) {
    const child = resolve(path, name);
    if (statSync(child).isDirectory()) result.push(...filesBelow(child));
    else result.push(child);
  }
  return result;
}

function conceptFiles(vaultRoot) {
  return filesBelow(vaultRoot).filter(
    (path) =>
      extname(path) === ".md" &&
      !["index.md", "log.md"].includes(path.split("/").at(-1)),
  );
}

function frontmatter(text) {
  assert.ok(text.startsWith("---\n"), "Markdown lacks frontmatter start");
  const end = text.indexOf("\n---\n", 4);
  assert.ok(end > 4, "Markdown lacks frontmatter end");
  return text.slice(4, end);
}

function parseYaml(text, label) {
  const document = parseDocument(text, {
    merge: false,
    prettyErrors: true,
    strict: true,
    uniqueKeys: true,
  });
  assert.deepEqual(
    document.errors,
    [],
    `${label}: ${document.errors.map((error) => error.message).join("; ")}`,
  );
  return document.toJS({ maxAliasCount: 0 });
}

function yamlConcept(path) {
  return parseYaml(frontmatter(readFileSync(path, "utf8")), path);
}

function readVaultFixture(vaultRoot) {
  return {
    manifest: parseYaml(
      readFileSync(resolve(vaultRoot, "bookie.yaml"), "utf8"),
      `${vaultRoot}/bookie.yaml`,
    ),
    concepts: conceptFiles(vaultRoot).map((path) => ({
      path: `/${relative(vaultRoot, path).replaceAll("\\", "/")}`,
      frontmatter: yamlConcept(path),
    })),
  };
}

test("profile reference documents the complete portable contract and migrations", () => {
  const reference = readFileSync(referencePath, "utf8");
  for (const heading of [
    "# Bookie profile 1.0",
    "## Vault manifest",
    "## Common concept metadata",
    "## Initial concept types",
    "## Paths and resources",
    "## Relations",
    "## Cross-file validation",
    "## Compatibility and migration",
    "## Authoring checklist",
  ]) {
    assert.ok(reference.includes(heading), `Missing ${heading}`);
  }
  for (const [type, prefix] of Object.entries(typePrefixes)) {
    assert.ok(reference.includes(`| ${type} | \`${prefix}-\` |`));
  }
  for (const phrase of [
    "same major",
    "newer minor",
    "breaking major",
    "explicit migration",
    "legacy immutable",
    "Git rollback",
  ]) {
    assert.ok(
      reference.includes(phrase),
      `Missing compatibility rule: ${phrase}`,
    );
  }
});

test("example vault retains complete types and readable block-style YAML", () => {
  const { concepts, manifest } = readVaultFixture(exampleRoot);
  assert.deepEqual(
    [...new Set(concepts.map((concept) => concept.frontmatter.type))].sort(),
    Object.keys(typePrefixes).sort(),
  );
  assert.deepEqual(
    [...manifest.allowed_concept_types].sort(),
    Object.keys(typePrefixes).sort(),
  );
  for (const path of conceptFiles(exampleRoot)) {
    assert.equal(
      frontmatter(readFileSync(path, "utf8")).trimStart().startsWith("{"),
      false,
      `${path} should remain a human-readable block-style YAML example`,
    );
  }
});

test("valid vault retains its profile, complete types and extension boundaries", () => {
  const { concepts, manifest } = readVaultFixture(validVaultRoot);
  assert.deepEqual(
    [...new Set(concepts.map((concept) => concept.frontmatter.type))].sort(),
    Object.keys(typePrefixes).sort(),
  );
  assert.equal(manifest.profile, "1.0");
  assert.ok(
    concepts.some(
      (concept) => concept.frontmatter.custom_fixture_extension === true,
    ),
    "Boundary fixture must retain an unknown top-level extension",
  );
  assert.ok(
    concepts.some((concept) => concept.path.includes("Δ")),
    "Boundary fixture must include a Unicode concept path",
  );
});

test("invalid vault fixture inventory stays complete", () => {
  assert.deepEqual(
    readdirSync(invalidVaultRoot).sort(),
    [...invalidCases].sort(),
  );
});
