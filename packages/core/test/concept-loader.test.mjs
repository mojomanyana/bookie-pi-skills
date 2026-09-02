import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_MAX_CONCEPT_BYTES,
  DEFAULT_MAX_YAML_DEPTH,
  loadConcept,
  serializeConcept,
} from "../dist/index.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const encoder = new TextEncoder();

function bytes(text) {
  return encoder.encode(text);
}

function wrapped(frontmatter, body = "Body.\n") {
  return bytes(`---\n${frontmatter}\n---\n${body}`);
}

function assertFailure(result, code, file = "concept.md") {
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.length >= 1);
  assert.deepEqual(
    [...new Set(result.diagnostics.map((diagnostic) => diagnostic.code))],
    [code],
  );
  for (const diagnostic of result.diagnostics) {
    assert.equal(diagnostic.severity, "error");
    assert.equal(diagnostic.file, file);
    assert.ok(
      diagnostic.message.length > 0 && diagnostic.message.length <= 160,
    );
    assert.equal(diagnostic.message.includes("\n"), false);
    assert.ok(diagnostic.remediation.length > 0);
  }
  return result.diagnostics[0];
}

test("golden concepts load and serialize byte-for-byte without exposing YAML ASTs", () => {
  for (const name of [
    "lossless-lf.md",
    "lossless-crlf.md",
    "lossless-no-final-newline.md",
  ]) {
    const input = readFileSync(join(fixtures, name));
    const result = loadConcept(input, { file: name });

    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    assert.equal(
      Buffer.from(serializeConcept(result.concept)).equals(input),
      true,
    );
    assert.equal(
      Buffer.from(result.concept.rawText, "utf8").equals(input),
      true,
    );
    assert.equal("document" in result.concept, false);
    assert.equal("ast" in result.concept, false);
    assert.equal(Object.isFrozen(result.concept.frontmatter), true);
    assert.throws(
      () => serializeConcept({ ...result.concept }),
      TypeError,
      "Only loader-owned concepts may use the lossless serializer",
    );
  }
});

test("loader preserves comments, unknown values, scalar text, ordering, and body bytes", () => {
  const input = readFileSync(join(fixtures, "lossless-lf.md"));
  const result = loadConcept(input, { file: "projects/demo/task.md" });
  assert.equal(result.ok, true);

  const { concept } = result;
  assert.match(concept.frontmatterText, /^# leading concept comment\n/);
  assert.match(concept.frontmatterText, /type: Task # inline type comment/);
  assert.match(concept.frontmatterText, /description: \|-\n/);
  assert.match(concept.frontmatterText, /summary: >\+\n/);
  assert.ok(
    concept.frontmatterText.indexOf("unknown_extension:") <
      concept.frontmatterText.indexOf("description:"),
  );
  assert.equal(concept.frontmatter.unknown_extension.nested, "yes");
  assert.equal(concept.frontmatter.unknown_extension.constructor, "safe");
  assert.equal(concept.frontmatter.unknown_extension.__proto__, "inert");
  assert.equal(
    concept.frontmatter.unknown_extension.largest_safe_integer,
    Number.MAX_SAFE_INTEGER,
  );
  assert.equal(Object.isFrozen(concept.frontmatter.unknown_extension), true);
  assert.match(concept.bodyText, /^\n# Body Δ\n/);
  assert.match(concept.bodyText, /\n---\n/);
  assert.equal(Object.prototype.polluted, undefined);
  assert.throws(() => {
    concept.frontmatter.status = "stable";
  }, TypeError);
});

test("CRLF and absent final newlines remain exact", () => {
  const crlf = readFileSync(join(fixtures, "lossless-crlf.md"));
  const crlfResult = loadConcept(crlf, { file: "crlf.md" });
  assert.equal(crlfResult.ok, true);
  assert.match(crlfResult.concept.frontmatterText, /\r\n/);
  assert.match(crlfResult.concept.bodyText, /^\r\n# CRLF body\r\n/);
  assert.equal(
    Buffer.from(serializeConcept(crlfResult.concept)).equals(crlf),
    true,
  );

  const noFinal = readFileSync(join(fixtures, "lossless-no-final-newline.md"));
  const noFinalResult = loadConcept(noFinal, { file: "no-final.md" });
  assert.equal(noFinalResult.ok, true);
  assert.equal(noFinalResult.concept.rawText.endsWith("\n"), false);
  assert.equal(
    Buffer.from(serializeConcept(noFinalResult.concept)).equals(noFinal),
    true,
  );
});

test("configured and default byte limits fail before parsing", () => {
  const input = wrapped("type: Project");
  const exact = loadConcept(input, {
    file: "exact.md",
    maxBytes: input.byteLength,
  });
  assert.equal(exact.ok, true);

  const oversized = loadConcept(input, {
    file: "large.md",
    maxBytes: input.byteLength - 1,
  });
  const diagnostic = assertFailure(oversized, "CONCEPT-SIZE", "large.md");
  assert.equal(diagnostic.range, undefined);
  assert.equal(DEFAULT_MAX_CONCEPT_BYTES, 1_048_576);
  assert.throws(
    () => loadConcept(input, { file: "bad-limit.md", maxBytes: 0 }),
    TypeError,
  );
  assert.throws(
    () =>
      loadConcept(input, {
        file: "bad-limit.md",
        maxBytes: DEFAULT_MAX_CONCEPT_BYTES + 1,
      }),
    TypeError,
  );
  assert.throws(
    () => loadConcept(input, { file: "bad-depth.md", maxDepth: 0 }),
    TypeError,
  );
  assert.throws(
    () =>
      loadConcept(input, {
        file: "bad-depth.md",
        maxDepth: DEFAULT_MAX_YAML_DEPTH + 1,
      }),
    TypeError,
  );
});

test("invalid UTF-8 is rejected without replacement decoding", () => {
  const cases = [
    Uint8Array.from([0xff]),
    Uint8Array.from([0xc3]),
    Uint8Array.from([0x80]),
    Uint8Array.from([0xc0, 0xaf]),
  ];
  for (const input of cases) {
    assertFailure(
      loadConcept(input, { file: "invalid-utf8.md" }),
      "CONCEPT-UTF8",
      "invalid-utf8.md",
    );
  }
});

test("frontmatter envelope requires exact opening and closing lines", () => {
  const cases = [
    [bytes("type: Task\n"), "FRONTMATTER-OPEN"],
    [bytes("\n---\ntype: Task\n---\n"), "FRONTMATTER-OPEN"],
    [
      Uint8Array.from([0xef, 0xbb, 0xbf, ...bytes("---\ntype: Task\n---\n")]),
      "FRONTMATTER-OPEN",
    ],
    [bytes("---\ntype: Task\n"), "FRONTMATTER-CLOSE"],
    [bytes("---\ntype: Task\n  ---\n"), "FRONTMATTER-CLOSE"],
  ];

  for (const [input, code] of cases) {
    assertFailure(
      loadConcept(input, { file: "envelope.md" }),
      code,
      "envelope.md",
    );
  }
});

test("malformed YAML returns stable sanitized diagnostics with source ranges", () => {
  const malformed = wrapped(
    "title: Δ\nsecret: redacted-test-placeholder\nbroken: [1,",
  );
  const result = loadConcept(malformed, { file: "malformed.md" });
  const diagnostic = assertFailure(result, "YAML-SYNTAX", "malformed.md");
  assert.ok(diagnostic.range);
  assert.ok(diagnostic.range.start.byteOffset > 0);
  assert.ok(diagnostic.range.start.line >= 2);
  assert.ok(diagnostic.range.start.column >= 1);
  assert.equal(
    JSON.stringify(result.diagnostics).includes("redacted-test-placeholder"),
    false,
  );

  const unicodeCrlf = Buffer.from(
    "---\r\n😀: β\r\nbroken: [1,\r\n---\r\nBody",
    "utf8",
  );
  const unicodeResult = loadConcept(unicodeCrlf, { file: "unicode-crlf.md" });
  const unicodeDiagnostic = assertFailure(
    unicodeResult,
    "YAML-SYNTAX",
    "unicode-crlf.md",
  );
  const closingOffset = unicodeCrlf.indexOf(Buffer.from("---\r\n", "utf8"), 5);
  assert.ok(unicodeDiagnostic.range);
  assert.ok(unicodeDiagnostic.range.start.byteOffset <= closingOffset);
  assert.ok(unicodeDiagnostic.range.end.byteOffset <= closingOffset);
  assert.ok(
    unicodeDiagnostic.range.end.byteOffset >=
      unicodeDiagnostic.range.start.byteOffset,
  );

  assertFailure(
    loadConcept(wrapped("type: Task\ntype: Project"), {
      file: "duplicate.md",
    }),
    "YAML-SYNTAX",
    "duplicate.md",
  );
  const duplicateFlood = loadConcept(
    wrapped(Array.from({ length: 200 }, () => "same: value").join("\n")),
    { file: "duplicate-flood.md" },
  );
  assertFailure(duplicateFlood, "YAML-SYNTAX", "duplicate-flood.md");
  assert.equal(duplicateFlood.diagnostics.length, 1);
  assertFailure(
    loadConcept(wrapped("? [complex, key]\n: value"), {
      file: "non-string-key.md",
    }),
    "YAML-SYNTAX",
    "non-string-key.md",
  );
});

test("non-mapping YAML roots are rejected", () => {
  for (const frontmatter of ["- one\n- two", "scalar", "null"]) {
    const diagnostic = assertFailure(
      loadConcept(wrapped(frontmatter), { file: "root.md" }),
      "YAML-ROOT",
      "root.md",
    );
    assert.ok(diagnostic.range);
  }
});

test("unsupported YAML versions, tags, aliases, unsafe integers, and depth fail closed", () => {
  const cases = [
    ["%YAML 1.1\ntype: Task", undefined],
    ["%YAML 1.1 # legacy\ntype: Task", undefined],
    ["%YAML 1.3\ntype: Task", undefined],
    ["type: !custom Task", undefined],
    ["base: &base [one]\ncopy: *base", undefined],
    ["unsafe: 9007199254740992", undefined],
    ["unsafe: 9007199254740993.0", undefined],
    ["unsafe: 9007199254740993e0", undefined],
    ["unsafe: 9007199254740990.9", undefined],
    ["not_finite: .inf", undefined],
    ["not_a_number: .nan", undefined],
    ["a:\n  b:\n    c:\n      d: value", 3],
  ];

  const exactDepth = loadConcept(wrapped("a:\n  b:\n    c: value"), {
    file: "exact-depth.md",
    maxDepth: 3,
  });
  assert.equal(exactDepth.ok, true);

  for (const [frontmatter, maxDepth] of cases) {
    const options = { file: "unsupported.md" };
    if (maxDepth !== undefined) options.maxDepth = maxDepth;
    assertFailure(
      loadConcept(wrapped(frontmatter), options),
      "YAML-UNSUPPORTED",
      "unsupported.md",
    );
  }
  assert.equal(DEFAULT_MAX_YAML_DEPTH, 64);
});

test("near-limit hostile nesting fails closed within the accepted parser budget", () => {
  const nesting = 250_000;
  const input = wrapped(`value: ${"[".repeat(nesting)}0${"]".repeat(nesting)}`);
  assert.ok(input.byteLength < DEFAULT_MAX_CONCEPT_BYTES);

  const started = performance.now();
  const result = loadConcept(input, { file: "hostile-depth.md" });
  const elapsed = performance.now() - started;

  assertFailure(result, "YAML-UNSUPPORTED", "hostile-depth.md");
  assert.ok(elapsed < 5_000, `hostile parse took ${elapsed.toFixed(0)} ms`);
});

test("loader ownership is nominal in TypeScript", () => {
  const directory = mkdtempSync(join(tmpdir(), "bookie-loader-types-"));
  try {
    const declarationRoot = resolve(fixtures, "../../dist/index.js");
    const relativeModule = relative(directory, declarationRoot)
      .split("\\")
      .join("/")
      .replace(/^(?!\.)/u, "./");
    const importLine = `import { serializeConcept, type LoadedConcept, type ReadonlyYamlValue } from ${JSON.stringify(relativeModule)};\n`;
    writeFileSync(
      join(directory, "valid.ts"),
      `${importLine}declare const concept: LoadedConcept;\nserializeConcept(concept);\n`,
    );
    writeFileSync(
      join(directory, "ownership.ts"),
      `${importLine}declare const concept: LoadedConcept;\nserializeConcept({ ...concept });\n`,
    );
    writeFileSync(
      join(directory, "mutation.ts"),
      `${importLine}declare const sequence: Extract<ReadonlyYamlValue, readonly ReadonlyYamlValue[]>;\nsequence[0] = null;\n`,
    );
    const compilerOptions = {
      module: "NodeNext",
      moduleResolution: "NodeNext",
      noEmit: true,
      strict: true,
      target: "ES2023",
    };
    for (const name of ["valid", "ownership", "mutation"]) {
      writeFileSync(
        join(directory, `tsconfig-${name}.json`),
        JSON.stringify({ compilerOptions, files: [`${name}.ts`] }),
      );
    }
    const compiler = resolve(fixtures, "../../../../node_modules/.bin/tsc");
    const valid = spawnSync(
      compiler,
      ["-p", join(directory, "tsconfig-valid.json"), "--pretty", "false"],
      { encoding: "utf8" },
    );
    assert.equal(valid.status, 0, valid.stdout || valid.stderr);
    const forged = spawnSync(
      compiler,
      ["-p", join(directory, "tsconfig-ownership.json"), "--pretty", "false"],
      { encoding: "utf8" },
    );
    assert.notEqual(
      forged.status,
      0,
      "spread concept unexpectedly type-checked",
    );
    assert.match(
      `${forged.stdout}${forged.stderr}`,
      /LoadedConceptOwnership|loadedConceptOwnership|private/u,
    );
    const mutation = spawnSync(
      compiler,
      ["-p", join(directory, "tsconfig-mutation.json"), "--pretty", "false"],
      { encoding: "utf8" },
    );
    assert.notEqual(
      mutation.status,
      0,
      "nested frontmatter mutation unexpectedly type-checked",
    );
    assert.match(
      `${mutation.stdout}${mutation.stderr}`,
      /TS2542|only permits reading|readonly/u,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("public declarations do not expose parser-specific AST types", () => {
  const declarations = [
    "index.d.ts",
    "concept-loader.d.ts",
    "concept-mutation.d.ts",
  ].map((name) =>
    readFileSync(join(dirname(fixtures), "..", "dist", name), "utf8"),
  );
  for (const declaration of declarations) {
    assert.doesNotMatch(declaration, /from ["']yaml["']|yaml\//i);
    assert.doesNotMatch(declaration, /Document|ParsedNode|SourceToken/);
  }
  assert.match(declarations[1], /private readonly loadedConceptOwnership/u);
  assert.match(declarations[1], /ReadonlyYamlValue/u);
  assert.doesNotMatch(
    declarations[1],
    /frontmatter: Readonly<Record<string, unknown>>/u,
  );
});
