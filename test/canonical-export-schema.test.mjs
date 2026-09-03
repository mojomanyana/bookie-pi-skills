import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { Ajv2020 } from "ajv/dist/2020.js";
import * as formatsModule from "ajv-formats";

const root = resolve(import.meta.dirname, "..");
const schemaRoot = resolve(root, "schemas");
const typeNames = [
  "activity",
  "decision",
  "document",
  "evidence",
  "person",
  "project",
  "research",
  "task",
];

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function exportValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const addFormats = formatsModule.default;
  addFormats(ajv);
  ajv.addSchema(
    await readJson(resolve(schemaRoot, "bookie-common.schema.json")),
  );
  for (const name of typeNames) {
    ajv.addSchema(
      await readJson(resolve(schemaRoot, `types/${name}.schema.json`)),
    );
  }
  return ajv.compile(
    await readJson(
      resolve(schemaRoot, "export/1.0/canonical-record.schema.json"),
    ),
  );
}

function taskRecord(frontmatter) {
  return {
    schema_version: "1.0",
    source_commit: "0".repeat(40),
    source_hash: `sha256:${"1".repeat(64)}`,
    profile: "1.0",
    uid: frontmatter.bookie.uid,
    path: "/projects/demo/tasks/task.md",
    type: frontmatter.type,
    title: frontmatter.title,
    frontmatter,
    body_markdown: "# Task\n",
  };
}

test("canonical JSONL record schema accepts complete profile metadata", async () => {
  const validate = await exportValidator();
  const frontmatter = await readJson(
    resolve(root, "fixtures/concepts/1.0/valid/task.json"),
  );
  frontmatter.unknown_top_level = {
    "unicode-😀": [null, true, 1.25, "preserved"],
  };
  frontmatter.bookie.unknown_extension = { empty: {} };

  const record = taskRecord(frontmatter);
  assert.equal(validate(record), true, JSON.stringify(validate.errors));
});

test("canonical JSONL record schema rejects malformed envelopes", async () => {
  const validate = await exportValidator();
  const frontmatter = await readJson(
    resolve(root, "fixtures/concepts/1.0/valid/task.json"),
  );
  const valid = taskRecord(frontmatter);
  const invalid = [
    { ...valid, schema_version: "2.0" },
    { ...valid, source_commit: null },
    { ...valid, source_commit: "A".repeat(40) },
    { ...valid, source_hash: "sha256:short" },
    { ...valid, path: "projects/demo/tasks/task.md" },
    { ...valid, uid: "TSK-invalid" },
    { ...valid, type: "Project" },
    { ...valid, body_markdown: 1 },
    { ...valid, unexpected: true },
  ];

  for (const candidate of invalid) {
    assert.equal(validate(candidate), false, JSON.stringify(candidate));
  }
});
