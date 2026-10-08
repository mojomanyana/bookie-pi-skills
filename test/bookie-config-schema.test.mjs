import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

const root = resolve(import.meta.dirname, "..");
const schemaPath = resolve(
  root,
  "schemas/profile/1.0/bookie-config.schema.json",
);
const fixtureRoot = resolve(root, "fixtures/profile/1.0/bookie-config");
const exampleConfigPath = resolve(root, "examples/vault/bookie.yaml");
const schema = JSON.parse(readFileSync(schemaPath, "utf8"));

function readFixture(kind, name) {
  return JSON.parse(
    readFileSync(resolve(fixtureRoot, kind, `${name}.json`), "utf8"),
  );
}

function createAjv() {
  return new Ajv2020({ allErrors: true, strict: true });
}

function normalizeErrors(errors) {
  return (errors ?? [])
    .map(({ instancePath, keyword }) => ({ instancePath, keyword }))
    .sort((left, right) =>
      `${left.instancePath}:${left.keyword}`.localeCompare(
        `${right.instancePath}:${right.keyword}`,
      ),
    );
}

function renderExampleConfig(config) {
  const sequence = (values, indent) =>
    values.map((value) => `${" ".repeat(indent)}- ${value}`);

  return [
    `profile: "${config.profile}"`,
    "vault:",
    `  uid: ${config.vault.uid}`,
    `  title: ${config.vault.title}`,
    "allowed_concept_types:",
    ...sequence(config.allowed_concept_types, 2),
    "policy:",
    "  evidence_roots:",
    ...sequence(config.policy.evidence_roots, 4),
    "  exclude:",
    ...sequence(config.policy.exclude, 4),
    "  sensitivity:",
    "    classes:",
    ...sequence(config.policy.sensitivity.classes, 6),
    "    excluded_classes:",
    ...sequence(config.policy.sensitivity.excluded_classes, 6),
    `  attachment_max_bytes: ${config.policy.attachment_max_bytes}`,
    "",
  ].join("\n");
}

const validFixtures = [
  "minimal",
  "example",
  "boundary-minimum",
  "boundary-maximum",
];

const expectedError = (keyword, instancePath) => [{ keyword, instancePath }];

const invalidFixtures = {
  "unknown-root": expectedError("additionalProperties", ""),
  "unknown-vault": expectedError("additionalProperties", "/vault"),
  "unknown-policy": expectedError("additionalProperties", "/policy"),
  "unknown-sensitivity": expectedError(
    "additionalProperties",
    "/policy/sensitivity",
  ),
  "version-mismatch": expectedError("const", "/profile"),
  "version-number": [
    { keyword: "const", instancePath: "/profile" },
    { keyword: "type", instancePath: "/profile" },
  ],
  "uid-overflow": expectedError("pattern", "/vault/uid"),
  "uid-forbidden-symbol": expectedError("pattern", "/vault/uid"),
  "uid-lowercase": expectedError("pattern", "/vault/uid"),
  "uid-too-short": expectedError("pattern", "/vault/uid"),
  "uid-too-long": expectedError("pattern", "/vault/uid"),
  "uid-missing-prefix": expectedError("pattern", "/vault/uid"),
  "vault-missing-uid": expectedError("required", "/vault"),
  "allowed-type-unknown": expectedError("enum", "/allowed_concept_types/0"),
  "allowed-type-duplicate": expectedError(
    "uniqueItems",
    "/allowed_concept_types",
  ),
  "allowed-types-empty": expectedError("minItems", "/allowed_concept_types"),
  "evidence-roots-empty": expectedError("minItems", "/policy/evidence_roots"),
  "evidence-root-absolute": expectedError(
    "pattern",
    "/policy/evidence_roots/0",
  ),
  "evidence-root-parent": expectedError("pattern", "/policy/evidence_roots/0"),
  "evidence-root-backslash": expectedError(
    "pattern",
    "/policy/evidence_roots/0",
  ),
  "evidence-root-glob": expectedError("pattern", "/policy/evidence_roots/0"),
  "evidence-root-dot-segment": expectedError(
    "pattern",
    "/policy/evidence_roots/0",
  ),
  "evidence-root-empty-segment": expectedError(
    "pattern",
    "/policy/evidence_roots/0",
  ),
  "evidence-root-drive-path": expectedError(
    "pattern",
    "/policy/evidence_roots/0",
  ),
  "evidence-root-uri-colon": expectedError(
    "pattern",
    "/policy/evidence_roots/0",
  ),
  "evidence-root-percent-encoded": expectedError(
    "pattern",
    "/policy/evidence_roots/0",
  ),
  "evidence-root-c1-control": expectedError(
    "pattern",
    "/policy/evidence_roots/0",
  ),
  "exclude-absolute": expectedError("pattern", "/policy/exclude/0"),
  "exclude-parent": expectedError("pattern", "/policy/exclude/0"),
  "exclude-backslash": expectedError("pattern", "/policy/exclude/0"),
  "exclude-embedded-star": expectedError("pattern", "/policy/exclude/0"),
  "exclude-unsupported-glob": expectedError("pattern", "/policy/exclude/0"),
  "exclude-dot-segment": expectedError("pattern", "/policy/exclude/0"),
  "exclude-empty-segment": expectedError("pattern", "/policy/exclude/0"),
  "sensitivity-uppercase": expectedError(
    "pattern",
    "/policy/sensitivity/classes/0",
  ),
  "sensitivity-underscore": expectedError(
    "pattern",
    "/policy/sensitivity/classes/0",
  ),
  "sensitivity-leading-digit": expectedError(
    "pattern",
    "/policy/sensitivity/classes/0",
  ),
  "sensitivity-duplicate": expectedError(
    "uniqueItems",
    "/policy/sensitivity/classes",
  ),
  "sensitivity-reserved-class": expectedError(
    "not",
    "/policy/sensitivity/classes/0",
  ),
  "sensitivity-reserved-exclusion": expectedError(
    "not",
    "/policy/sensitivity/excluded_classes/0",
  ),
  "sensitivity-classes-empty": expectedError(
    "minItems",
    "/policy/sensitivity/classes",
  ),
  "sensitivity-class-too-long": expectedError(
    "maxLength",
    "/policy/sensitivity/classes/0",
  ),
  "attachment-zero": expectedError("minimum", "/policy/attachment_max_bytes"),
  "attachment-fraction": expectedError("type", "/policy/attachment_max_bytes"),
  "attachment-unsafe": expectedError("maximum", "/policy/attachment_max_bytes"),
};

const validate = createAjv().compile(schema);

test("bookie config schema is valid JSON Schema 2020-12 in Ajv strict mode", () => {
  const ajv = createAjv();
  assert.equal(ajv.validateSchema(schema), true, ajv.errorsText(ajv.errors));
  assert.doesNotThrow(() => ajv.compile(schema));
});

test("bookie config patterns use a validator-portable absolute end guard", () => {
  const patterns = [
    schema.properties.vault.properties.uid.pattern,
    schema.$defs.relativePosixPath.pattern,
    schema.$defs.constrainedGlob.pattern,
    schema.$defs.sensitivityClass.pattern,
  ];

  for (const pattern of patterns) {
    assert.ok(
      pattern.endsWith("(?![\\s\\S])"),
      `Pattern lacks a portable absolute end guard: ${pattern}`,
    );
  }
});

test("bookie config valid fixtures cover minimal, example, and boundaries", async (t) => {
  assert.deepEqual(
    readdirSync(resolve(fixtureRoot, "valid"))
      .filter((name) => name.endsWith(".json"))
      .sort(),
    validFixtures.map((name) => `${name}.json`).sort(),
    "Every valid fixture must be enumerated",
  );

  for (const name of validFixtures) {
    await t.test(name, () => {
      const fixture = readFixture("valid", name);
      const declaredClasses = new Set(fixture.policy.sensitivity.classes);
      assert.ok(
        fixture.policy.sensitivity.excluded_classes.every((className) =>
          declaredClasses.has(className),
        ),
        `${name} excludes an undeclared sensitivity class`,
      );
      assert.equal(validate(fixture), true, JSON.stringify(validate.errors));
    });
  }
});

test("bookie config schema leaves excluded-class membership to runtime policy", () => {
  const fixture = structuredClone(readFixture("valid", "minimal"));
  fixture.policy.sensitivity.excluded_classes = ["restricted"];

  assert.equal(validate(fixture), true, JSON.stringify(validate.errors));
});

test("decoded example fixture stays aligned with its complete canonical YAML rendering", () => {
  const fixture = readFixture("valid", "example");
  const exampleWithoutComments = readFileSync(exampleConfigPath, "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");

  assert.equal(exampleWithoutComments, renderExampleConfig(fixture));
});

test("bookie config required properties reject omission at every level", async (t) => {
  const requiredProperties = [
    ["profile"],
    ["vault"],
    ["allowed_concept_types"],
    ["policy"],
    ["vault", "uid"],
    ["vault", "title"],
    ["policy", "evidence_roots"],
    ["policy", "exclude"],
    ["policy", "sensitivity"],
    ["policy", "attachment_max_bytes"],
    ["policy", "sensitivity", "classes"],
    ["policy", "sensitivity", "excluded_classes"],
  ];

  for (const path of requiredProperties) {
    await t.test(path.join("."), () => {
      const fixture = structuredClone(readFixture("valid", "minimal"));
      const parent = path
        .slice(0, -1)
        .reduce((value, property) => value[property], fixture);
      delete parent[path.at(-1)];

      assert.equal(
        validate(fixture),
        false,
        `${path.join(".")} omission passed`,
      );
      assert.ok(
        validate.errors?.some((error) => error.keyword === "required"),
        JSON.stringify(validate.errors),
      );
    });
  }
});

test("bookie config rejects wrong JSON types at every typed location", async (t) => {
  const wrongTypes = [
    ["root", [], []],
    ["profile", ["profile"], null],
    ["vault", ["vault"], "x"],
    ["vault.uid", ["vault", "uid"], 1],
    ["vault.title", ["vault", "title"], 1],
    ["allowed_concept_types", ["allowed_concept_types"], {}],
    ["policy", ["policy"], []],
    ["policy.evidence_roots", ["policy", "evidence_roots"], null],
    ["policy.evidence_roots item", ["policy", "evidence_roots", 0], null],
    ["policy.exclude", ["policy", "exclude"], null],
    ["policy.exclude item", ["policy", "exclude", 0], null],
    ["policy.sensitivity", ["policy", "sensitivity"], null],
    ["policy.sensitivity.classes", ["policy", "sensitivity", "classes"], null],
    [
      "policy.sensitivity.classes item",
      ["policy", "sensitivity", "classes", 0],
      null,
    ],
    [
      "policy.sensitivity.excluded_classes",
      ["policy", "sensitivity", "excluded_classes"],
      null,
    ],
    [
      "policy.sensitivity.excluded_classes item",
      ["policy", "sensitivity", "excluded_classes", 0],
      null,
    ],
    ["policy.attachment_max_bytes", ["policy", "attachment_max_bytes"], "1"],
  ];

  for (const [name, path, value] of wrongTypes) {
    await t.test(name, () => {
      let fixture = structuredClone(readFixture("valid", "minimal"));
      if (path.length === 0) fixture = value;
      else {
        const parent = path
          .slice(0, -1)
          .reduce((current, property) => current[property], fixture);
        parent[path.at(-1)] = value;
      }

      assert.equal(validate(fixture), false, `${name} unexpectedly passed`);
      const instancePath = path.length === 0 ? "" : `/${path.join("/")}`;
      assert.ok(
        validate.errors?.some(
          (error) =>
            error.keyword === "type" && error.instancePath === instancePath,
        ),
        `${name} should fail type at ${instancePath}: ${JSON.stringify(validate.errors)}`,
      );
    });
  }
});

test("bookie config arrays reject duplicates and vault title rejects empty", async (t) => {
  const invalidMutations = [
    [
      "vault.title empty",
      (fixture) => {
        fixture.vault.title = "";
      },
      "minLength",
    ],
    [
      "allowed_concept_types duplicate",
      (fixture) => fixture.allowed_concept_types.push("Project"),
      "uniqueItems",
    ],
    [
      "policy.evidence_roots duplicate",
      (fixture) => fixture.policy.evidence_roots.push("evidence"),
      "uniqueItems",
    ],
    [
      "policy.exclude duplicate",
      (fixture) => fixture.policy.exclude.push("cache/**", "cache/**"),
      "uniqueItems",
    ],
    [
      "policy.sensitivity.classes duplicate",
      (fixture) => fixture.policy.sensitivity.classes.push("public"),
      "uniqueItems",
    ],
    [
      "policy.sensitivity.excluded_classes duplicate",
      (fixture) =>
        fixture.policy.sensitivity.excluded_classes.push(
          "restricted",
          "restricted",
        ),
      "uniqueItems",
    ],
  ];

  for (const [name, mutate, keyword] of invalidMutations) {
    await t.test(name, () => {
      const fixture = structuredClone(readFixture("valid", "minimal"));
      mutate(fixture);

      assert.equal(validate(fixture), false, `${name} unexpectedly passed`);
      assert.ok(
        validate.errors?.some((error) => error.keyword === keyword),
        `${name} should fail ${keyword}: ${JSON.stringify(validate.errors)}`,
      );
    });
  }
});

test("evidence roots reject line-separator bypasses and lone surrogates", async (t) => {
  const invalidRoots = [
    ["U+2028 then colon", `safe\u2028:escape`],
    ["U+2029 then colon", `safe\u2029:escape`],
    ["U+2028 then percent", `safe\u2028%2fescape`],
    ["U+2029 then percent", `safe\u2029%2fescape`],
    ["U+2028 then glob", `safe\u2028*escape`],
    ["U+2029 then glob", `safe\u2029*escape`],
    ["U+2028 then traversal", `safe\u2028/../escape`],
    ["U+2029 then traversal", `safe\u2029/../escape`],
    ["U+2028 then C0", `safe\u2028\u0001escape`],
    ["U+2029 then C0", `safe\u2029\u0001escape`],
    ["lone UTF-16 surrogate", `safe\ud800escape`],
  ];

  for (const [name, evidenceRoot] of invalidRoots) {
    await t.test(name, () => {
      const fixture = structuredClone(readFixture("valid", "minimal"));
      fixture.policy.evidence_roots = [evidenceRoot];

      assert.equal(validate(fixture), false, `${name} unexpectedly passed`);
      assert.ok(
        validate.errors?.some((error) => error.keyword === "pattern"),
        `${name} should fail pattern: ${JSON.stringify(validate.errors)}`,
      );
    });
  }

  await t.test("valid supplementary Unicode scalar", () => {
    const fixture = structuredClone(readFixture("valid", "minimal"));
    fixture.policy.evidence_roots = ["evidence/😀"];
    assert.equal(validate(fixture), true, JSON.stringify(validate.errors));
  });
});

test("bookie config invalid fixtures cover strict, lexical, and numeric boundaries", async (t) => {
  assert.deepEqual(
    readdirSync(resolve(fixtureRoot, "invalid"))
      .filter((name) => name.endsWith(".json"))
      .sort(),
    Object.keys(invalidFixtures)
      .map((name) => `${name}.json`)
      .sort(),
    "Every invalid fixture must have an asserted failure reason",
  );

  for (const [name, expectedErrors] of Object.entries(invalidFixtures)) {
    await t.test(name, () => {
      const fixture = readFixture("invalid", name);
      assert.equal(validate(fixture), false, `${name} unexpectedly passed`);
      assert.deepEqual(
        normalizeErrors(validate.errors),
        normalizeErrors(expectedErrors),
        `${name} failed for the wrong reason: ${JSON.stringify(validate.errors)}`,
      );
    });
  }
});
