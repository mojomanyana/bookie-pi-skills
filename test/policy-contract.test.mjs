import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const root = resolve(import.meta.dirname, "..");
const fixtureRoot = resolve(root, "fixtures/policy/1.0");
const conceptFixtureRoot = resolve(root, "fixtures/concepts/1.0/valid");
const commonSchemaPath = resolve(root, "schemas/bookie-common.schema.json");
const typeSchemaRoot = resolve(root, "schemas/types");
const specPath = resolve(root, "docs/specs/001-canonical-ledger.md");

const uidPrefixes = {
  Project: "PRJ",
  Task: "TSK",
  Document: "DOC",
  Research: "RSC",
  Decision: "DSN",
  Activity: "ACT",
  Evidence: "EVD",
  Person: "PER",
};

const relations = {
  part_of: null,
  relates_to: "relates_to",
  blocks: "blocked_by",
  blocked_by: "blocks",
  depends_on: null,
  supports: null,
  supersedes: "superseded_by",
  superseded_by: "supersedes",
  owned_by: null,
};

const ruleCodes = [
  "TYPE-ALLOWED",
  "UID-UNIQUE",
  "PROJECT-TARGET",
  "RELATION-TARGET",
  "RELATION-INVERSE",
  "DECISION-SUPERSESSION",
  "ACTIVITY-IMMUTABLE",
  "EVIDENCE-IMMUTABLE",
  "EVIDENCE-RESOURCE",
  "EVIDENCE-DIGEST",
  "EVIDENCE-SUPPORT",
];

const validCases = [
  "decision-supersession",
  "decision-supersession-consolidated",
  "evidence-exact-bytes",
  "immutable-replacements",
  "relation-inverses",
];

const invalidCases = {
  "activity-deleted": ["ACTIVITY-IMMUTABLE"],
  "activity-edited": ["ACTIVITY-IMMUTABLE"],
  "activity-correction-multiple-predecessors": ["RELATION-TARGET"],
  "activity-renamed": ["ACTIVITY-IMMUTABLE"],
  "decision-deleted": ["DECISION-SUPERSESSION"],
  "decision-supersession-lifecycle": ["DECISION-SUPERSESSION"],
  "decision-supersession-missing-reciprocal": [
    "RELATION-INVERSE",
    "DECISION-SUPERSESSION",
  ],
  "decision-supersession-missing-successor": ["DECISION-SUPERSESSION"],
  "decision-supersession-multiple-replacements": ["DECISION-SUPERSESSION"],
  "evidence-deleted": ["EVIDENCE-IMMUTABLE"],
  "evidence-digest-mismatch": ["EVIDENCE-DIGEST"],
  "evidence-edited": ["EVIDENCE-IMMUTABLE"],
  "evidence-renamed": ["EVIDENCE-IMMUTABLE"],
  "evidence-resource-bytes-changed": ["EVIDENCE-DIGEST", "EVIDENCE-RESOURCE"],
  "evidence-resource-deleted": ["EVIDENCE-RESOURCE"],
  "evidence-resource-escape": ["EVIDENCE-RESOURCE"],
  "evidence-resource-missing": ["EVIDENCE-RESOURCE"],
  "evidence-resource-oversized": ["EVIDENCE-RESOURCE"],
  "evidence-resource-root-itself": ["EVIDENCE-RESOURCE"],
  "evidence-resource-symlink": ["EVIDENCE-RESOURCE"],
  "evidence-support-missing": ["EVIDENCE-SUPPORT"],
  "immutable-project-target-renamed": ["PROJECT-TARGET"],
  "immutable-relation-target-renamed": ["RELATION-TARGET"],
  "immutable-support-target-renamed": ["EVIDENCE-SUPPORT"],
  "project-target-wrong-type": ["PROJECT-TARGET"],
  "relation-inverse-missing": ["RELATION-INVERSE"],
  "relation-inverse-wrong-kind": ["RELATION-INVERSE"],
  "relation-supersession-wrong-type": ["RELATION-TARGET"],
  "relation-target-missing": ["RELATION-TARGET"],
  "relation-target-uid-mismatch": ["RELATION-TARGET"],
  "type-not-allowed": ["TYPE-ALLOWED"],
  "uid-duplicate": ["UID-UNIQUE"],
};

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

const commonSchema = readJson(commonSchemaPath);
const conceptPathPattern = new RegExp(
  commonSchema.$defs.conceptPath.pattern,
  "u",
);
const bundleFilePathPattern = new RegExp(
  commonSchema.$defs.bundleFilePath.pattern,
  "u",
);

function readCases(kind) {
  return readJson(resolve(fixtureRoot, kind, "cases.json"));
}

function readCase(kind, name) {
  return readCases(kind).find((fixture) => fixture.id === name);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function merge(base, patch) {
  if (
    patch === null ||
    typeof patch !== "object" ||
    Array.isArray(patch) ||
    typeof base !== "object" ||
    base === null ||
    Array.isArray(base)
  ) {
    return structuredClone(patch);
  }
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(patch)) {
    result[key] = merge(result[key], value);
  }
  return result;
}

function materializeTree(tree) {
  const concepts = (tree.concepts ?? []).map((descriptor) => {
    const frontmatter = merge(
      readJson(resolve(conceptFixtureRoot, `${descriptor.fixture}.json`)),
      descriptor.patch ?? {},
    );
    return {
      path: descriptor.path,
      frontmatter,
      markdown: `---\n${JSON.stringify(frontmatter)}\n---\n${descriptor.body}`,
    };
  });
  const resources = new Map(
    (tree.resources ?? []).map((descriptor) => [
      descriptor.path,
      {
        bytes: readFileSync(resolve(fixtureRoot, descriptor.fixture)),
        kind: descriptor.kind ?? "regular",
      },
    ]),
  );
  return { concepts, resources };
}

function createValidators() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  ajv.addSchema(readJson(commonSchemaPath));
  return new Map(
    Object.keys(uidPrefixes).map((type) => [
      type,
      ajv.compile(
        readJson(resolve(typeSchemaRoot, `${type.toLowerCase()}.schema.json`)),
      ),
    ]),
  );
}

function assertSchemaValid(tree, validators, label) {
  assert.equal(
    new Set(tree.concepts.map((concept) => concept.path)).size,
    tree.concepts.length,
    `${label} has duplicate concept paths`,
  );
  for (const concept of tree.concepts) {
    assert.match(concept.path, conceptPathPattern, `${label} invalid path`);
    assert.equal(
      typeof concept.markdown,
      "string",
      `${label} missing Markdown`,
    );
    assert.ok(concept.markdown.length > 0, `${label} has empty Markdown`);
    const validate = validators.get(concept.frontmatter.type);
    assert.ok(
      validate,
      `${label} has unknown type ${concept.frontmatter.type}`,
    );
    assert.equal(
      validate(concept.frontmatter),
      true,
      `${label} ${concept.path}: ${JSON.stringify(validate.errors)}`,
    );
  }
  for (const resourcePath of tree.resources.keys()) {
    assert.match(
      resourcePath,
      bundleFilePathPattern,
      `${label} invalid resource path`,
    );
  }
}

test("SPEC-001 fixes UID prefixes, relation inverses, and stable rule codes", () => {
  const spec = readFileSync(specPath, "utf8");

  for (const [type, prefix] of Object.entries(uidPrefixes)) {
    assert.ok(
      spec.includes(`| ${type} | \`${prefix}-\` |`),
      `Missing ${type}/${prefix} mapping`,
    );
  }
  for (const [kind, inverse] of Object.entries(relations)) {
    const renderedInverse = inverse === null ? "None" : `\`${inverse}\``;
    assert.ok(
      spec.includes(`| \`${kind}\` | ${renderedInverse} |`),
      `Missing ${kind} inverse contract`,
    );
  }

  const documentedRules = [...spec.matchAll(/^#### `([A-Z-]+)`$/gm)].map(
    (match) => match[1],
  );
  assert.deepEqual(documentedRules, ruleCodes);
});

test("cross-file fixtures retain schema-valid trees and independent rule expectations", async (t) => {
  assert.deepEqual(
    readdirSync(resolve(fixtureRoot, "valid"))
      .filter((name) => name.endsWith(".json"))
      .sort(),
    ["cases.json"],
  );
  assert.deepEqual(
    readdirSync(resolve(fixtureRoot, "invalid"))
      .filter((name) => name.endsWith(".json"))
      .sort(),
    ["cases.json"],
  );
  assert.deepEqual(
    readCases("valid")
      .map((fixture) => fixture.id)
      .sort(),
    [...validCases].sort(),
  );
  assert.deepEqual(
    readCases("invalid")
      .map((fixture) => fixture.id)
      .sort(),
    Object.keys(invalidCases).sort(),
  );

  const validators = createValidators();
  for (const name of validCases) {
    await t.test(`valid/${name}`, () => {
      const fixture = readCase("valid", name);
      assert.equal(fixture.profile, "1.0");
      assert.ok(fixture.description.length > 0);
      const base = materializeTree(fixture.facts.base);
      const proposed = materializeTree(fixture.facts.proposed);
      assertSchemaValid(base, validators, `${name} base`);
      assertSchemaValid(proposed, validators, `${name} proposed`);
      assert.deepEqual(fixture.expected, { valid: true, rules: [] });
    });
  }

  for (const [name, expectedRules] of Object.entries(invalidCases)) {
    await t.test(`invalid/${name}`, () => {
      const fixture = readCase("invalid", name);
      assert.equal(fixture.profile, "1.0");
      assert.ok(fixture.description.length > 0);
      const base = materializeTree(fixture.facts.base);
      const proposed = materializeTree(fixture.facts.proposed);
      assertSchemaValid(base, validators, `${name} base`);
      assertSchemaValid(proposed, validators, `${name} proposed`);
      assert.deepEqual(fixture.expected, {
        valid: false,
        rules: expectedRules,
      });
    });
  }

  assert.deepEqual(
    [...new Set(Object.values(invalidCases).flat())].sort(),
    [...ruleCodes].sort(),
    "Every named rule needs a failing fixture",
  );
});

test("digest resources pin exact UTF-8, CRLF, and binary bytes", () => {
  const exact = readFileSync(resolve(fixtureRoot, "resources/exact.txt"));
  const changed = readFileSync(resolve(fixtureRoot, "resources/changed.txt"));
  const crlf = readFileSync(resolve(fixtureRoot, "resources/crlf.txt"));
  const binary = readFileSync(resolve(fixtureRoot, "resources/binary.bin"));

  assert.notEqual(sha256(exact), sha256(changed));
  assert.notEqual(sha256(exact), sha256(crlf));
  assert.equal(binary.includes(0), true);
  assert.equal(
    readCase("valid", "evidence-exact-bytes").facts.expected_digests[
      "exact.txt"
    ],
    sha256(exact),
  );
  assert.equal(
    readCase("valid", "evidence-exact-bytes").facts.expected_digests[
      "crlf.txt"
    ],
    sha256(crlf),
  );
  assert.equal(
    readCase("valid", "evidence-exact-bytes").facts.expected_digests[
      "binary.bin"
    ],
    sha256(binary),
  );
});
