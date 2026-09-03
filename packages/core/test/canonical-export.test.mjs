import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { Ajv2020 } from "ajv/dist/2020.js";
import * as formatsModule from "ajv-formats";

import {
  DEFAULT_MAX_CANONICAL_JSONL_BYTES,
  exportCanonicalJsonl,
} from "../dist/index.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const validVault = resolve(repositoryRoot, "fixtures/valid-vault");

function git(root, args) {
  const result = spawnSync(
    "git",
    [
      "-c",
      "user.name=Bookie Export Tests",
      "-c",
      "user.email=bookie-export-tests@example.invalid",
      "-c",
      "commit.gpgSign=false",
      "-C",
      root,
      ...args,
    ],
    { encoding: "utf8" },
  );
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
  );
  return result.stdout.trim();
}

function gitInput(root, args, input) {
  const result = spawnSync(
    "git",
    [
      "-c",
      "user.name=Bookie Export Tests",
      "-c",
      "user.email=bookie-export-tests@example.invalid",
      "-c",
      "commit.gpgSign=false",
      "-C",
      root,
      ...args,
    ],
    { encoding: "utf8", input },
  );
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
  );
  return result.stdout.trim();
}

function gitBinaryInput(root, args, input) {
  const result = spawnSync("git", ["-C", root, ...args], { input });
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`,
  );
  return result.stdout.toString("utf8").trim();
}

function gitBytes(root, args) {
  const result = spawnSync("git", ["-C", root, ...args]);
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`,
  );
  return result.stdout;
}

async function markdownFiles(root, relative = "") {
  const files = [];
  for (const entry of await readdir(join(root, relative), {
    withFileTypes: true,
  })) {
    const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await markdownFiles(root, path)));
    else if (
      entry.isFile() &&
      path.endsWith(".md") &&
      !["index.md", "log.md"].includes(path.split("/").at(-1))
    ) {
      files.push(path);
    }
  }
  return files.sort();
}

async function rewriteConcept(root, relativePath, mutate) {
  const path = join(root, relativePath);
  const source = await readFile(path, "utf8");
  const match = /^---\n([^\n]+)\n---\n([\s\S]*)$/u.exec(source);
  assert.ok(match, `expected flow JSON frontmatter in ${relativePath}`);
  const frontmatter = JSON.parse(match[1]);
  mutate(frontmatter);
  await writeFile(
    path,
    `---\n${JSON.stringify(frontmatter)}\n---\n${match[2]}`,
  );
}

async function rewriteBody(root, relativePath, body) {
  const path = join(root, relativePath);
  const source = await readFile(path, "utf8");
  const closing = source.indexOf("\n---\n", 4);
  assert.notEqual(closing, -1);
  await writeFile(path, `${source.slice(0, closing + 5)}${body}`);
}

async function classifyAll(root, sensitivity = "public") {
  for (const path of await markdownFiles(root)) {
    await rewriteConcept(root, path, (frontmatter) => {
      frontmatter.bookie.sensitivity = sensitivity;
    });
  }
}

async function temporaryGitVault(t) {
  const parent = await mkdtemp(join(tmpdir(), "bookie-export-"));
  const root = join(parent, "vault");
  await cp(validVault, root, { recursive: true });
  t.after(() => rm(parent, { recursive: true, force: true }));
  await classifyAll(root);
  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "--no-gpg-sign", "-m", "export source"]);
  return { parent, root, commit: git(root, ["rev-parse", "HEAD"]) };
}

async function collectExport(root, sourceRef = "HEAD", options = {}) {
  const chunks = [];
  let calls = 0;
  const result = await exportCanonicalJsonl(
    root,
    {
      sourceRef,
      write(bytes) {
        calls += 1;
        chunks.push(Buffer.from(bytes));
      },
    },
    options,
  );
  return { result, calls, bytes: Buffer.concat(chunks) };
}

function recordsFrom(bytes) {
  if (bytes.byteLength === 0) return [];
  assert.equal(bytes.at(-1), 0x0a);
  return bytes
    .toString("utf8")
    .slice(0, -1)
    .split("\n")
    .map((line) => JSON.parse(line));
}

function codes(result) {
  return result.diagnostics.map((diagnostic) => diagnostic.code);
}

async function canonicalRecordValidator() {
  const schemaRoot = resolve(repositoryRoot, "packages/core/dist/schemas");
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const addFormats = formatsModule.default;
  addFormats(ajv);
  ajv.addSchema(
    JSON.parse(await readFile(join(schemaRoot, "bookie-common.schema.json"))),
  );
  for (const name of [
    "activity",
    "decision",
    "document",
    "evidence",
    "person",
    "project",
    "research",
    "task",
  ]) {
    ajv.addSchema(
      JSON.parse(await readFile(join(schemaRoot, `types/${name}.schema.json`))),
    );
  }
  return ajv.compile(
    JSON.parse(
      await readFile(
        join(schemaRoot, "export/1.0/canonical-record.schema.json"),
      ),
    ),
  );
}

test("canonical export emits every initial type deterministically from one commit", async (t) => {
  const { root, commit } = await temporaryGitVault(t);
  const taskPath = "projects/fixture/tasks/task.md";
  await rewriteConcept(root, taskPath, (frontmatter) => {
    frontmatter.title = "DIRTY-WORKTREE-MARKER";
  });

  const first = await collectExport(pathToFileURL(root));
  assert.equal(first.result.ok, true, JSON.stringify(first.result.diagnostics));
  assert.equal(first.result.format, "bookie-canonical-jsonl");
  assert.equal(first.result.schemaVersion, "1.0");
  assert.equal(first.result.sourceCommit, commit);
  assert.equal(first.result.secretPolicy, "reject-detected");
  assert.equal(first.result.recordCount, 8);
  assert.equal(first.calls, 8);
  assert.equal(first.result.byteLength, first.bytes.byteLength);
  assert.equal(
    first.result.outputHash,
    `sha256:${createHash("sha256").update(first.bytes).digest("hex")}`,
  );
  assert.equal(first.result.complete, true);
  assert.deepEqual(first.result.diagnostics, []);
  assert.equal(first.result.diagnosticsTruncated, false);
  assert.equal(first.bytes.includes("DIRTY-WORKTREE-MARKER"), false);

  const records = recordsFrom(first.bytes);
  const validateRecord = await canonicalRecordValidator();
  assert.deepEqual(
    records.map((record) => record.uid),
    [...records.map((record) => record.uid)].sort(),
  );
  assert.deepEqual(
    new Set(records.map((record) => record.type)),
    new Set([
      "Project",
      "Task",
      "Document",
      "Research",
      "Decision",
      "Activity",
      "Evidence",
      "Person",
    ]),
  );
  for (const record of records) {
    assert.equal(
      validateRecord(record),
      true,
      JSON.stringify(validateRecord.errors),
    );
    assert.equal(record.source_commit, commit);
    assert.equal(record.profile, "1.0");
    assert.equal(record.uid, record.frontmatter.bookie.uid);
    assert.equal(record.type, record.frontmatter.type);
    assert.equal(record.title, record.frontmatter.title);
    assert.ok(record.path.startsWith("/"));
    assert.ok(record.path.endsWith(".md"));
    assert.equal(
      record.source_hash,
      `sha256:${createHash("sha256")
        .update(gitBytes(root, ["show", `${commit}:${record.path.slice(1)}`]))
        .digest("hex")}`,
    );
    assert.equal(typeof record.body_markdown, "string");
  }

  const second = await collectExport(root, commit.toUpperCase());
  assert.equal(
    second.result.ok,
    true,
    JSON.stringify(second.result.diagnostics),
  );
  assert.equal(second.result.sourceCommit, commit);
  assert.deepEqual(second.bytes, first.bytes);
  assert.equal(second.result.outputHash, first.result.outputHash);

  const inheritedPolicy = Object.create({
    secretPolicy: "allow-unchecked",
  });
  const inheritedChunks = [];
  const inherited = await exportCanonicalJsonl(
    root,
    {
      sourceRef: commit,
      write(line) {
        inheritedChunks.push(Buffer.from(line));
      },
    },
    inheritedPolicy,
  );
  assert.equal(inherited.ok, true);
  assert.equal(inherited.secretPolicy, "reject-detected");
  assert.deepEqual(Buffer.concat(inheritedChunks), first.bytes);

  let snapshottedCalls = 0;
  const mutableRequest = {
    sourceRef: commit,
    write() {
      snapshottedCalls += 1;
    },
  };
  const mutableOptions = { maxOutputBytes: first.bytes.byteLength };
  const snapshotted = exportCanonicalJsonl(
    root,
    mutableRequest,
    mutableOptions,
  );
  mutableRequest.sourceRef = "HEAD~1";
  mutableRequest.write = () => {
    throw new Error("mutated write callback");
  };
  mutableOptions.maxOutputBytes = 1;
  const snapshottedResult = await snapshotted;
  assert.equal(snapshottedResult.ok, true);
  assert.equal(snapshottedCalls, 8);
  assert.equal(DEFAULT_MAX_CANONICAL_JSONL_BYTES, 536_870_912);
});

test("canonical export preserves decoded extensions and exact Markdown body", async (t) => {
  const { root } = await temporaryGitVault(t);
  const taskPath = "projects/fixture/tasks/task.md";
  const body = "# Exact body\r\n\r\nUnicode 😀 and U+2028 \u2028 separator";
  await rewriteConcept(root, taskPath, (frontmatter) => {
    frontmatter.generated.at = "2026-06-27T09:05:00.250Z";
    frontmatter.z_extension = { z: [], a: null };
    frontmatter.a_extension = [false, 1.25, "Ω"];
    frontmatter.unicode_order = { "\uE000": "bmp", "😀": "astral" };
    frontmatter.bookie.z_unknown = { z: "last", a: "first" };
  });
  const source = await readFile(join(root, taskPath), "utf8");
  const closing = source.indexOf("\n---\n", 4);
  await writeFile(
    join(root, taskPath),
    `${source.slice(0, closing + 5)}${body}`,
  );
  git(root, ["add", taskPath]);
  git(root, ["commit", "-q", "--no-gpg-sign", "-m", "extensions"]);

  const exported = await collectExport(root);
  assert.equal(
    exported.result.ok,
    true,
    JSON.stringify(exported.result.diagnostics),
  );
  const task = recordsFrom(exported.bytes).find(
    (record) => record.path === `/${taskPath}`,
  );
  assert.ok(task);
  assert.equal(task.body_markdown, body);
  assert.equal(task.frontmatter.generated.at, "2026-06-27T09:05:00.250Z");
  assert.deepEqual(task.frontmatter.z_extension, { a: null, z: [] });
  assert.deepEqual(task.frontmatter.a_extension, [false, 1.25, "Ω"]);
  assert.deepEqual(task.frontmatter.unicode_order, {
    "😀": "astral",
    "\uE000": "bmp",
  });
  assert.deepEqual(task.frontmatter.bookie.z_unknown, {
    a: "first",
    z: "last",
  });

  const line = exported.bytes
    .toString("utf8")
    .split("\n")
    .find((candidate) => candidate.includes(`"path":"/${taskPath}"`));
  assert.ok(line);
  assert.ok(line.indexOf('"body_markdown"') < line.indexOf('"frontmatter"'));
  assert.ok(line.indexOf('"a_extension"') < line.indexOf('"z_extension"'));
  assert.ok(line.indexOf('"a":"first"') < line.indexOf('"z":"last"'));
  assert.ok(line.indexOf('"😀":"astral"') < line.indexOf('"":"bmp"'));
});

test("canonical export rejects detected credentials by default and permits an explicit unchecked run", async (t) => {
  const { root } = await temporaryGitVault(t);
  const ownerPath = "people/owner.md";
  const baseBody = "Owner.\n";
  const cases = [
    {
      name: "private key",
      value: ["-----BEGIN OPENSSH", "PRIVATE KEY-----"].join(" "),
      placement: "body",
    },
    {
      name: "AWS access key",
      value: ["AKIA", "ABCDEFGHIJKLMNOP"].join(""),
      placement: "field",
    },
    {
      name: "GitHub token",
      value: ["ghp_", "1234567890abcdefghijABCDE"].join(""),
      placement: "field",
    },
    {
      name: "OpenAI token",
      value: ["sk-", "1234567890abcdefghijklmnopqrstuv"].join(""),
      placement: "field",
    },
    {
      name: "Slack token",
      value: ["xoxb-", "1234567890-abcdefghijkl"].join(""),
      placement: "field",
    },
    {
      name: "Stripe token",
      value: ["sk_live_", "1234567890abcdefghijkl"].join(""),
      placement: "field",
    },
    {
      name: "Google API key",
      value: `AIza${"A".repeat(35)}`,
      placement: "field",
    },
    {
      name: "credential URI",
      value: ["postgres", "//bookie", "S3cretPass@localhost/db"].join(":"),
      placement: "field",
    },
    {
      name: "256-byte credential URI password",
      value: ["postgres", "//bookie", `${"a".repeat(256)}@localhost/db`].join(
        ":",
      ),
      placement: "field",
    },
    {
      name: "257-byte credential URI password",
      value: ["postgres", "//bookie", `${"a".repeat(257)}@localhost/db`].join(
        ":",
      ),
      placement: "field",
    },
    {
      name: "structured secret",
      key: "aws_secret_access_key",
      value: ["wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLE", "KEY"].join(""),
      placement: "structured",
    },
    {
      name: "credential container",
      key: "credentials",
      value: "alice:CorrectHorseBatteryStaple1!",
      placement: "structured",
    },
    {
      name: "qualified password",
      key: "db_password",
      value: "CorrectHorseBatteryStaple1!",
      placement: "structured",
    },
    {
      name: "camel-case client secret",
      key: "prodClientSecret",
      value: "CorrectHorseBatteryStaple1!",
      placement: "structured",
    },
    {
      name: "API token",
      key: "api_token",
      value: "CorrectHorseBatteryStaple1!",
      placement: "structured",
    },
    {
      name: "low-entropy password",
      key: "password",
      value: "password",
      placement: "structured",
    },
    {
      name: "bracketed password",
      key: "password",
      value: "[CorrectHorseBatteryStaple1!]",
      placement: "structured",
    },
    {
      name: "angle-bracketed password",
      key: "password",
      value: "<CorrectHorseBatteryStaple1!>",
      placement: "structured",
    },
    {
      name: "nested credential field",
      key: "api_key",
      value: "CorrectHorseBatteryStaple1!",
      placement: "nested",
    },
    {
      name: "body assignment",
      value: 'password = "CorrectHorseBatteryStaple1!"',
      placement: "body",
    },
    {
      name: "256-byte quoted assignment",
      value: `password = "${"a".repeat(256)}"`,
      placement: "body",
    },
    {
      name: "257-byte quoted assignment",
      value: `password = "${"a".repeat(257)}"`,
      placement: "body",
    },
    {
      name: "qualified body token",
      value: "api_token = CorrectHorseBatteryStaple1!",
      placement: "body",
    },
    {
      name: "quoted assignment key",
      value: `'api_key': 'CorrectHorseBatteryStaple1!'`,
      placement: "body",
    },
    {
      name: "JSON assignment",
      value: '{"password":"CorrectHorseBatteryStaple1!"}',
      placement: "body",
    },
    {
      name: "low-entropy body assignment",
      value: "password: pineapple",
      placement: "body",
    },
    {
      name: "emphasized Markdown assignment",
      value: "**Password:** CorrectHorseBatteryStaple1!",
      placement: "body",
    },
    {
      name: "qualified Markdown assignment",
      value: "Password (production): CorrectHorseBatteryStaple1!",
      placement: "body",
    },
  ];

  for (const secretCase of cases) {
    await rewriteConcept(root, ownerPath, (frontmatter) => {
      delete frontmatter.export_probe;
      if (secretCase.placement === "field") {
        frontmatter.export_probe = { note: secretCase.value };
      } else if (secretCase.placement === "structured") {
        frontmatter.export_probe = {
          [secretCase.key]: secretCase.value,
        };
      } else if (secretCase.placement === "nested") {
        frontmatter.export_probe = {
          [secretCase.key]: { value: secretCase.value },
        };
      }
    });
    await rewriteBody(
      root,
      ownerPath,
      secretCase.placement === "body" ? `${secretCase.value}\n` : baseBody,
    );
    git(root, ["add", "-A"]);
    git(root, [
      "commit",
      "-q",
      "--no-gpg-sign",
      "-m",
      `secret ${secretCase.name}`,
    ]);

    const rejected = await collectExport(root);
    assert.equal(rejected.result.ok, false, secretCase.name);
    assert.equal(rejected.result.reason, "secret-policy", secretCase.name);
    assert.equal(rejected.result.secretPolicy, "reject-detected");
    assert.equal(rejected.result.complete, true);
    assert.equal(rejected.calls, 0);
    assert.equal(rejected.result.possiblyWrittenRecords, 0);
    assert.equal(rejected.result.possiblyWrittenBytes, 0);
    assert.deepEqual(codes(rejected.result), ["EXPORT-SECRET"]);
    assert.deepEqual(rejected.result.diagnostics[0], {
      code: "EXPORT-SECRET",
      severity: "error",
      file: "<redacted>",
      message: "Canonical export rejected possible credential material.",
      remediation:
        "Remove or redact credential material, or explicitly select the audited unchecked export policy.",
    });
    assert.equal(
      JSON.stringify(rejected.result).includes(secretCase.value),
      false,
      secretCase.name,
    );
  }

  const unchecked = await collectExport(root, "HEAD", {
    secretPolicy: "allow-unchecked",
  });
  assert.equal(unchecked.result.ok, true, JSON.stringify(unchecked.result));
  assert.equal(unchecked.result.secretPolicy, "allow-unchecked");
  assert.equal(unchecked.bytes.includes("CorrectHorseBatteryStaple1!"), true);

  await rewriteConcept(root, ownerPath, (frontmatter) => {
    frontmatter.export_probe = { api_key: "not-a-secret" };
  });
  await rewriteBody(
    root,
    ownerPath,
    "password=${PASSWORD}\napi_token=<redacted>\nsecret=[REDACTED]\n",
  );
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "--no-gpg-sign", "-m", "safe placeholder"]);
  const placeholder = await collectExport(root);
  assert.equal(placeholder.result.ok, true, JSON.stringify(placeholder.result));
  assert.equal(placeholder.result.secretPolicy, "reject-detected");

  const secretPath = ["people/ghp_", "1234567890abcdefghijABCDE.md"].join("");
  await writeFile(
    join(root, secretPath),
    `---\n${JSON.stringify({
      type: "Person",
      title: "Path probe",
      status: "stable",
      generated: {
        by: "human:export-test",
        at: "2026-09-03T12:00:00Z",
      },
      bookie: {
        profile: "1.0",
        uid: "PER-00000000000000000000000009",
        created_at: "2026-09-03T12:00:00Z",
        sensitivity: "public",
      },
    })}\n---\nPath probe.\n`,
  );
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "--no-gpg-sign", "-m", "secret path"]);
  const pathRejected = await collectExport(root);
  assert.equal(pathRejected.result.ok, false);
  assert.equal(pathRejected.result.reason, "secret-policy");
  assert.equal(pathRejected.calls, 0);
  assert.equal(JSON.stringify(pathRejected.result).includes(secretPath), false);
});

test("canonical export omits excluded records and fails unclassified data before output", async (t) => {
  const { root } = await temporaryGitVault(t);
  const manifestPath = join(root, "bookie.yaml");
  await writeFile(
    manifestPath,
    (await readFile(manifestPath, "utf8"))
      .replace("      - public\n", "      - public\n      - restricted\n")
      .replace(
        "    excluded_classes: []",
        "    excluded_classes:\n      - restricted",
      ),
  );
  const excludedPath = "projects/fixture/documents/document.md";
  const excludedUid = "DOC-00000000000000000000000003";
  await rewriteConcept(root, excludedPath, (frontmatter) => {
    frontmatter.title = "EXCLUDED-TITLE-MARKER";
    frontmatter.bookie.sensitivity = "restricted";
  });
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "--no-gpg-sign", "-m", "excluded task"]);

  const included = await collectExport(root);
  assert.equal(included.result.ok, true, JSON.stringify(included.result));
  assert.equal(included.result.recordCount, 7);
  const serialized = included.bytes.toString("utf8");
  for (const marker of [excludedPath, excludedUid, "EXCLUDED-TITLE-MARKER"]) {
    assert.equal(serialized.includes(marker), false, marker);
    assert.equal(
      JSON.stringify(included.result).includes(marker),
      false,
      marker,
    );
  }

  await rewriteConcept(root, "people/owner.md", (frontmatter) => {
    delete frontmatter.bookie.sensitivity;
    frontmatter.title = "UNCLASSIFIED-TITLE-MARKER";
  });
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "--no-gpg-sign", "-m", "missing class"]);
  const missing = await collectExport(root);
  assert.equal(missing.result.ok, false);
  assert.equal(missing.result.reason, "sensitivity-policy");
  assert.equal(missing.calls, 0);
  assert.equal(missing.bytes.byteLength, 0);
  assert.equal(missing.result.possiblyWrittenRecords, 0);
  assert.equal(missing.result.possiblyWrittenBytes, 0);
  assert.deepEqual(codes(missing.result), ["EXPORT-SENSITIVITY"]);
  assert.equal(missing.result.diagnostics[0].file, "<unclassified>");
  assert.equal(
    JSON.stringify(missing.result).includes("UNCLASSIFIED-TITLE-MARKER"),
    false,
  );
});

test("canonical export rejects unsafe sources and invalid programmer input", async (t) => {
  const { parent, root } = await temporaryGitVault(t);
  const abbreviated = git(root, ["rev-parse", "HEAD"]).slice(0, 8);
  git(root, ["branch", abbreviated, "HEAD"]);
  for (const sourceRef of [
    "",
    "--help",
    "HEAD~1",
    "HEAD:path",
    "HEAD@{0}",
    abbreviated,
  ]) {
    const rejected = await collectExport(root, sourceRef);
    assert.equal(rejected.result.ok, false, sourceRef);
    assert.equal(rejected.result.reason, "invalid-source", sourceRef);
    assert.equal(rejected.calls, 0, sourceRef);
    assert.deepEqual(codes(rejected.result), ["EXPORT-SOURCE"], sourceRef);
  }

  const uncheckedFailure = await collectExport(root, "HEAD~1", {
    secretPolicy: "allow-unchecked",
  });
  assert.equal(uncheckedFailure.result.ok, false);
  assert.equal(uncheckedFailure.result.secretPolicy, "allow-unchecked");
  assert.equal(uncheckedFailure.calls, 0);

  const noRepository = join(parent, "no-repository");
  await cp(validVault, noRepository, { recursive: true });
  const missingGit = await collectExport(noRepository);
  assert.equal(missingGit.result.ok, false);
  assert.equal(missingGit.result.reason, "invalid-source");
  assert.equal(missingGit.calls, 0);
  assert.deepEqual(codes(missingGit.result), ["EXPORT-SOURCE"]);

  const previousPath = process.env.PATH;
  process.env.PATH = "";
  let missingExecutable;
  try {
    missingExecutable = await collectExport(root);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
  assert.equal(missingExecutable.result.ok, false);
  assert.equal(missingExecutable.result.reason, "invalid-source");
  assert.equal(missingExecutable.calls, 0);
  assert.deepEqual(codes(missingExecutable.result), ["EXPORT-SOURCE"]);

  const invalidUrl = await collectExport(
    new URL("https://example.invalid/vault"),
  );
  assert.equal(invalidUrl.result.ok, false);
  assert.equal(invalidUrl.result.root, "<invalid>");
  assert.equal(invalidUrl.calls, 0);
  assert.deepEqual(codes(invalidUrl.result), ["VAULT-ROOT"]);

  const write = () => undefined;
  for (const operation of [
    () => exportCanonicalJsonl(123, { sourceRef: "HEAD", write }),
    () => exportCanonicalJsonl(root, null),
    () => exportCanonicalJsonl(root, { sourceRef: 1, write }),
    () => exportCanonicalJsonl(root, { sourceRef: "HEAD", write: 1 }),
    () =>
      exportCanonicalJsonl(root, {
        sourceRef: "HEAD",
        write,
        unsupported: true,
      }),
    () =>
      exportCanonicalJsonl(
        root,
        { sourceRef: "HEAD", write },
        {
          unsupported: true,
        },
      ),
    () =>
      exportCanonicalJsonl(
        root,
        { sourceRef: "HEAD", write },
        {
          secretPolicy: "disabled",
        },
      ),
    () =>
      exportCanonicalJsonl(
        root,
        { sourceRef: "HEAD", write },
        Object.defineProperty({}, "secretPolicy", {
          enumerable: true,
          get() {
            return "allow-unchecked";
          },
        }),
      ),
    () =>
      exportCanonicalJsonl(
        root,
        { sourceRef: "HEAD", write },
        { signal: null },
      ),
    () =>
      exportCanonicalJsonl(root, { sourceRef: "HEAD", write }, { signal: 1 }),
    () =>
      exportCanonicalJsonl(root, { sourceRef: "HEAD", write }, { signal: {} }),
    () =>
      exportCanonicalJsonl(
        root,
        { sourceRef: "HEAD", write },
        {
          maxOutputBytes: 0,
        },
      ),
    () =>
      exportCanonicalJsonl(
        root,
        { sourceRef: "HEAD", write },
        {
          maxOutputBytes: DEFAULT_MAX_CANONICAL_JSONL_BYTES + 1,
        },
      ),
    () => exportCanonicalJsonl(root, { sourceRef: "HEAD", write }, null),
  ]) {
    await assert.rejects(operation(), TypeError);
  }
});

test("canonical export enforces output bounds and accounts for sink failure", async (t) => {
  const { root } = await temporaryGitVault(t);
  const complete = await collectExport(root);
  assert.equal(complete.result.ok, true);

  const exact = await collectExport(root, "HEAD", {
    maxOutputBytes: complete.bytes.byteLength,
  });
  assert.equal(exact.result.ok, true, JSON.stringify(exact.result));
  assert.deepEqual(exact.bytes, complete.bytes);

  const bounded = await collectExport(root, "HEAD", {
    maxOutputBytes: complete.bytes.byteLength - 1,
  });
  assert.equal(bounded.result.ok, false);
  assert.equal(bounded.result.reason, "incomplete");
  assert.equal(bounded.calls, 0);
  assert.equal(bounded.bytes.byteLength, 0);
  assert.deepEqual(codes(bounded.result), ["VAULT-BOUNDS"]);

  const conceptBound = await collectExport(root, "HEAD", { maxConcepts: 7 });
  assert.equal(conceptBound.result.ok, false);
  assert.equal(conceptBound.result.reason, "incomplete");
  assert.equal(conceptBound.calls, 0);
  assert.ok(codes(conceptBound.result).includes("VAULT-BOUNDS"));

  const resourceSize = gitBytes(root, [
    "show",
    "HEAD:references/files/source.bin",
  ]).byteLength;
  const exactResource = await collectExport(root, "HEAD", {
    maxTotalResourceBytes: resourceSize,
  });
  assert.equal(
    exactResource.result.ok,
    true,
    JSON.stringify(exactResource.result),
  );
  const resourceBound = await collectExport(root, "HEAD", {
    maxTotalResourceBytes: resourceSize - 1,
  });
  assert.equal(resourceBound.result.ok, false);
  assert.equal(resourceBound.result.reason, "incomplete");
  assert.equal(resourceBound.calls, 0);
  assert.ok(codes(resourceBound.result).includes("VAULT-BOUNDS"));

  const lines = complete.bytes
    .toString("utf8")
    .slice(0, -1)
    .split("\n")
    .map((line) => Buffer.from(`${line}\n`));
  let calls = 0;
  const sinkFailure = await exportCanonicalJsonl(root, {
    sourceRef: "HEAD",
    write() {
      calls += 1;
      if (calls === 2) throw new Error("SINK-SECRET-MARKER");
    },
  });
  assert.equal(sinkFailure.ok, false);
  assert.equal(sinkFailure.reason, "output-error");
  assert.equal(calls, 2);
  assert.equal(sinkFailure.possiblyWrittenRecords, 2);
  assert.equal(
    sinkFailure.possiblyWrittenBytes,
    lines[0].byteLength + lines[1].byteLength,
  );
  assert.deepEqual(codes(sinkFailure), ["EXPORT-OUTPUT"]);
  assert.equal(
    JSON.stringify(sinkFailure).includes("SINK-SECRET-MARKER"),
    false,
  );

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    exportCanonicalJsonl(
      root,
      { sourceRef: "HEAD", write: () => undefined },
      { signal: controller.signal },
    ),
    { name: "AbortError" },
  );

  const midController = new AbortController();
  let written = 0;
  await assert.rejects(
    exportCanonicalJsonl(
      root,
      {
        sourceRef: "HEAD",
        write(bytes) {
          written += 1;
          assert.equal(bytes.at(-1), 0x0a);
          midController.abort();
        },
      },
      { signal: midController.signal },
    ),
    { name: "AbortError" },
  );
  assert.equal(written, 1);

  const duringController = new AbortController();
  let duringCalls = 0;
  const during = exportCanonicalJsonl(
    root,
    {
      sourceRef: "HEAD",
      write() {
        duringCalls += 1;
      },
    },
    { signal: duringController.signal },
  );
  setImmediate(() => duringController.abort());
  await assert.rejects(during, { name: "AbortError" });
  assert.equal(duringCalls, 0);

  const stalledController = new AbortController();
  const stalledOptions = { signal: stalledController.signal };
  const stalled = exportCanonicalJsonl(
    root,
    {
      sourceRef: "HEAD",
      write() {
        stalledOptions.signal = undefined;
        stalledController.abort();
        return new Promise(() => undefined);
      },
    },
    stalledOptions,
  );
  const stalledOutcome = await Promise.race([
    stalled.then(
      () => "resolved",
      (error) => (error?.name === "AbortError" ? "aborted" : "rejected"),
    ),
    new Promise((resolveTimeout) =>
      setTimeout(() => resolveTimeout("timeout"), 250),
    ),
  ]);
  assert.equal(stalledOutcome, "aborted");
});

test("canonical export rejects invalid commit policy before writing", async (t) => {
  const { root } = await temporaryGitVault(t);
  await rewriteConcept(
    root,
    "projects/fixture/tasks/task.md",
    (frontmatter) => {
      delete frontmatter.title;
      frontmatter.bookie.relations = [
        { kind: "relates_to", target: "/missing.md" },
      ];
    },
  );
  await rewriteConcept(
    root,
    "projects/fixture/documents/document.md",
    (frontmatter) => {
      frontmatter.bookie.uid = "PRJ-00000000000000000000000001";
    },
  );
  await rewriteBody(
    root,
    "projects/fixture/research/Δ-findings.md",
    "[missing commit target](missing.md)\n",
  );
  await writeFile(
    join(root, "references/files/source.bin"),
    "changed evidence bytes",
  );
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "--no-gpg-sign", "-m", "invalid snapshot"]);

  const invalid = await collectExport(root);
  assert.equal(invalid.result.ok, false);
  assert.equal(invalid.result.reason, "invalid-vault");
  assert.equal(invalid.result.complete, true);
  assert.equal(invalid.calls, 0);
  const found = new Set(codes(invalid.result));
  for (const code of [
    "CONCEPT-SCHEMA",
    "RELATION-TARGET",
    "UID-UNIQUE",
    "MARKDOWN-LINK",
    "EVIDENCE-DIGEST",
  ]) {
    assert.ok(found.has(code), `${code}: ${JSON.stringify(invalid.result)}`);
  }
});

test("canonical export fails references to excluded identities without disclosure", async (t) => {
  const { root } = await temporaryGitVault(t);
  const manifestPath = join(root, "bookie.yaml");
  await writeFile(
    manifestPath,
    (await readFile(manifestPath, "utf8"))
      .replace("      - public\n", "      - public\n      - restricted\n")
      .replace(
        "    excluded_classes: []",
        "    excluded_classes:\n      - restricted",
      ),
  );
  const excludedPath = "/projects/fixture/documents/document.md";
  const excludedUid = "DOC-00000000000000000000000003";
  await rewriteConcept(root, excludedPath.slice(1), (frontmatter) => {
    frontmatter.title = "EXCLUDED-REFERENCE-TITLE";
    frontmatter.bookie.sensitivity = "restricted";
  });
  await rewriteConcept(root, "people/owner.md", (frontmatter) => {
    frontmatter.unknown_reference = excludedUid;
  });
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "--no-gpg-sign", "-m", "excluded reference"]);

  const result = await collectExport(root);
  assert.equal(result.result.ok, false);
  assert.equal(result.result.reason, "sensitivity-policy");
  assert.equal(result.calls, 0);
  assert.deepEqual(codes(result.result), ["EXPORT-SENSITIVITY"]);
  const serialized = JSON.stringify(result.result);
  for (const marker of [
    excludedPath,
    excludedUid,
    "EXCLUDED-REFERENCE-TITLE",
  ]) {
    assert.equal(serialized.includes(marker), false, marker);
  }

  await rewriteConcept(root, "people/owner.md", (frontmatter) => {
    delete frontmatter.unknown_reference;
  });
  const leakingPath = `people/${excludedUid}-public.md`;
  await writeFile(
    join(root, leakingPath),
    `---\n${JSON.stringify({
      type: "Person",
      title: "Public path collision",
      status: "stable",
      generated: {
        by: "human:export-test",
        at: "2026-09-03T12:00:00Z",
      },
      bookie: {
        profile: "1.0",
        uid: "PER-00000000000000000000000009",
        created_at: "2026-09-03T12:00:00Z",
        sensitivity: "public",
      },
    })}\n---\nPublic record.\n`,
  );
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "--no-gpg-sign", "-m", "excluded UID path"]);
  const pathLeak = await collectExport(root);
  assert.equal(pathLeak.result.ok, false);
  assert.equal(pathLeak.result.reason, "sensitivity-policy");
  assert.equal(pathLeak.calls, 0);
  await unlink(join(root, leakingPath));

  await rewriteBody(
    root,
    "projects/fixture/tasks/task.md",
    `Plain excluded identifiers: ${excludedUid} ${excludedPath}\n`,
  );
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "--no-gpg-sign", "-m", "excluded text"]);
  const mentioned = await collectExport(root);
  assert.equal(mentioned.result.ok, false);
  assert.equal(mentioned.result.reason, "sensitivity-policy");
  assert.equal(mentioned.calls, 0);

  await rewriteBody(
    root,
    "projects/fixture/tasks/task.md",
    "[excluded document](../documents/document.md)\n",
  );
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "--no-gpg-sign", "-m", "excluded link"]);
  const linked = await collectExport(root);
  assert.equal(linked.result.ok, false);
  assert.equal(linked.result.reason, "sensitivity-policy");
  assert.equal(linked.calls, 0);
  assert.equal(JSON.stringify(linked.result).includes(excludedPath), false);

  await rewriteBody(
    root,
    "projects/fixture/tasks/task.md",
    "No excluded link.\n",
  );
  await rewriteConcept(root, "people/owner.md", (frontmatter) => {
    frontmatter.bookie.sensitivity = "undeclared-class";
  });
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "--no-gpg-sign", "-m", "undeclared class"]);
  const undeclared = await collectExport(root);
  assert.equal(undeclared.result.ok, false);
  assert.equal(undeclared.result.reason, "sensitivity-policy");
  assert.equal(undeclared.calls, 0);
  assert.equal(
    JSON.stringify(undeclared.result).includes("undeclared-class"),
    false,
  );
});

test("canonical export redacts invalid excluded records and ignores generic/excluded-path data", async (t) => {
  const { root } = await temporaryGitVault(t);
  await writeFile(
    join(root, "bookie.yaml"),
    (await readFile(join(root, "bookie.yaml"), "utf8"))
      .replace("      - public\n", "      - public\n      - restricted\n")
      .replace(
        "    excluded_classes: []",
        "    excluded_classes:\n      - restricted",
      ),
  );
  const excludedPath = "projects/fixture/documents/document.md";
  const excludedUid = "DOC-00000000000000000000000003";
  await rewriteConcept(root, excludedPath, (frontmatter) => {
    frontmatter.title = "INVALID-EXCLUDED-TITLE-MARKER";
    frontmatter.bookie.sensitivity = "restricted";
    delete frontmatter.generated;
  });
  await writeFile(
    join(root, "generic.md"),
    "---\ntype: PortableGeneric\n---\nGeneric content without sensitivity.\n",
  );
  await mkdir(join(root, "exports"), { recursive: true });
  await writeFile(
    join(root, "exports/EXCLUDED-PATH-MARKER.md"),
    "malformed excluded-path content",
  );
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "--no-gpg-sign", "-m", "redacted invalid"]);

  const result = await collectExport(root);
  assert.equal(result.result.ok, false);
  assert.equal(result.result.reason, "invalid-vault");
  assert.equal(result.result.complete, true);
  assert.equal(result.calls, 0);
  assert.ok(codes(result.result).includes("CONCEPT-SCHEMA"));
  assert.ok(
    result.result.diagnostics.some(
      (diagnostic) => diagnostic.file === "<excluded>",
    ),
  );
  const serialized = JSON.stringify(result.result);
  for (const marker of [
    excludedPath,
    excludedUid,
    "INVALID-EXCLUDED-TITLE-MARKER",
    "EXCLUDED-PATH-MARKER",
  ]) {
    assert.equal(serialized.includes(marker), false, marker);
  }
  const diagnosticBound = await collectExport(root, "HEAD", {
    maxDiagnostics: 1,
  });
  assert.equal(diagnosticBound.result.ok, false);
  assert.equal(diagnosticBound.result.reason, "incomplete");
  assert.equal(diagnosticBound.calls, 0);
  assert.deepEqual(codes(diagnosticBound.result), ["DIAGNOSTICS-TRUNCATED"]);
  assert.equal(
    JSON.stringify(diagnosticBound.result).includes(excludedPath),
    false,
  );

  await rewriteConcept(root, excludedPath, (frontmatter) => {
    frontmatter.generated = {
      by: "human:export-test",
      at: "2026-09-03T12:00:00Z",
    };
  });
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "--no-gpg-sign", "-m", "valid excluded"]);
  const valid = await collectExport(root);
  assert.equal(valid.result.ok, true, JSON.stringify(valid.result));
  assert.equal(valid.result.recordCount, 7);
});

test("canonical export supports empty and nested commit-scoped vaults", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "bookie-export-empty-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const repository = join(parent, "repository");
  const root = join(
    repository,
    ...Array.from({ length: 70 }, (_, index) => `nested-${index}`),
    "vault",
  );
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "bookie.yaml"),
    JSON.stringify({
      profile: "1.0",
      vault: {
        uid: "VLT-00000000000000000000000001",
        title: "Empty export vault",
      },
      allowed_concept_types: ["Project"],
      policy: {
        evidence_roots: ["references/files"],
        exclude: ["exports/**"],
        sensitivity: { classes: ["public"], excluded_classes: [] },
        attachment_max_bytes: 1024,
      },
    }),
  );
  const index = '---\nokf_version: "0.2"\n---\n# Empty\n\n[Bundle root](/)\n';
  await writeFile(join(root, "index.md"), index);
  git(repository, ["init", "-q"]);
  git(repository, ["add", "-A"]);
  git(repository, ["commit", "-q", "--no-gpg-sign", "-m", "empty vault"]);
  const commit = git(repository, ["rev-parse", "HEAD"]);

  const empty = await collectExport(root);
  assert.equal(empty.result.ok, true, JSON.stringify(empty.result));
  assert.equal(empty.result.sourceCommit, commit);
  assert.equal(empty.result.recordCount, 0);
  assert.equal(empty.calls, 0);
  assert.equal(empty.bytes.byteLength, 0);
  assert.equal(
    empty.result.outputHash,
    `sha256:${createHash("sha256").update("").digest("hex")}`,
  );
  let invalidSignalCalls = 0;
  await assert.rejects(
    exportCanonicalJsonl(
      root,
      {
        sourceRef: "HEAD",
        write() {
          invalidSignalCalls += 1;
        },
      },
      { signal: null },
    ),
    TypeError,
  );
  assert.equal(invalidSignalCalls, 0);

  const exactEntries = await collectExport(root, "HEAD", { maxEntries: 2 });
  assert.equal(
    exactEntries.result.ok,
    true,
    JSON.stringify(exactEntries.result),
  );

  await writeFile(
    join(root, "project.md"),
    `---\n${JSON.stringify({
      type: "Project",
      title: "Nested project",
      status: "stable",
      generated: {
        by: "human:export-test",
        at: "2026-09-03T12:00:00Z",
      },
      bookie: {
        profile: "1.0",
        uid: "PRJ-00000000000000000000000001",
        state: "active",
        created_at: "2026-09-03T12:00:00Z",
        sensitivity: "public",
      },
    })}\n---\nNested body\n`,
  );
  git(repository, ["add", "-A"]);
  git(repository, ["commit", "-q", "--no-gpg-sign", "-m", "nested record"]);
  const nested = await collectExport(root);
  assert.equal(nested.result.ok, true, JSON.stringify(nested.result));
  assert.equal(nested.result.recordCount, 1);
  assert.equal(recordsFrom(nested.bytes)[0].path, "/project.md");

  const belowIndex = await collectExport(root, "HEAD", {
    maxTotalConceptBytes: Buffer.byteLength(index) - 1,
  });
  assert.equal(belowIndex.result.ok, false);
  assert.equal(belowIndex.result.reason, "incomplete");
  assert.equal(belowIndex.calls, 0);
  assert.deepEqual(codes(belowIndex.result), ["VAULT-BOUNDS"]);
});

test("canonical export resolves a ref once and ignores later ref movement", async (t) => {
  const { root, commit: firstCommit } = await temporaryGitVault(t);
  git(root, ["branch", "export-source", firstCommit]);
  await rewriteConcept(root, "people/owner.md", (frontmatter) => {
    frontmatter.title = "LATER-COMMIT-MARKER";
  });
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "--no-gpg-sign", "-m", "later commit"]);
  const laterCommit = git(root, ["rev-parse", "HEAD"]);

  const chunks = [];
  let moved = false;
  const result = await exportCanonicalJsonl(root, {
    sourceRef: "export-source",
    write(bytes) {
      chunks.push(Buffer.from(bytes));
      if (!moved) {
        moved = true;
        git(root, ["update-ref", "refs/heads/export-source", laterCommit]);
      }
    },
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.sourceCommit, firstCommit);
  const output = Buffer.concat(chunks).toString("utf8");
  assert.equal(output.includes("LATER-COMMIT-MARKER"), false);
});

test("canonical export rejects active unsafe Git entries but honors exclusions", async (t) => {
  const { root } = await temporaryGitVault(t);
  const baselineEntries = git(root, [
    "ls-tree",
    "-r",
    "-t",
    "--name-only",
    "HEAD",
  ]).split("\n").length;
  await mkdir(join(root, "exports"), { recursive: true });
  for (let index = 0; index < 50; index += 1) {
    await writeFile(join(root, "exports", `${index}.md`), "excluded data");
  }
  await symlink("../index.md", join(root, "exports/ignored-link.md"));
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "--no-gpg-sign", "-m", "excluded subtree"]);
  const excluded = await collectExport(root, "HEAD", {
    maxEntries: baselineEntries + 1,
  });
  assert.equal(excluded.result.ok, true, JSON.stringify(excluded.result));
  const oneBelow = await collectExport(root, "HEAD", {
    maxEntries: baselineEntries,
  });
  assert.equal(oneBelow.result.ok, false);
  assert.equal(oneBelow.result.reason, "incomplete");
  assert.equal(oneBelow.calls, 0);
  assert.deepEqual(codes(oneBelow.result), ["VAULT-BOUNDS"]);

  await symlink("index.md", join(root, "unsafe-link.md"));
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "--no-gpg-sign", "-m", "unsafe symlink"]);
  const unsafe = await collectExport(root);
  assert.equal(unsafe.result.ok, false);
  assert.equal(unsafe.result.reason, "invalid-source");
  assert.equal(unsafe.calls, 0);
  assert.deepEqual(codes(unsafe.result), ["EXPORT-SOURCE"]);
});

test("canonical export rejects duplicate paths in malformed Git trees", async (t) => {
  const { root, commit } = await temporaryGitVault(t);
  const tree = git(root, ["rev-parse", `${commit}^{tree}`]);
  const raw = gitBytes(root, ["cat-file", "tree", tree]);
  const marker = Buffer.from("100644 bookie.yaml\0");
  const start = raw.indexOf(marker);
  assert.notEqual(start, -1);
  const end = start + marker.byteLength + 20;
  const duplicate = raw.subarray(start, end);
  const malformed = Buffer.concat([
    raw.subarray(0, end),
    duplicate,
    raw.subarray(end),
  ]);
  const malformedTree = gitBinaryInput(
    root,
    ["hash-object", "--literally", "-t", "tree", "-w", "--stdin"],
    malformed,
  );
  const malformedCommit = gitInput(
    root,
    ["commit-tree", malformedTree, "-p", commit],
    "duplicate path\n",
  );
  git(root, ["update-ref", "HEAD", malformedCommit]);

  const result = await collectExport(root);
  assert.equal(result.result.ok, false);
  assert.equal(result.result.reason, "invalid-source");
  assert.equal(result.calls, 0);
  assert.deepEqual(codes(result.result), ["EXPORT-SOURCE"]);

  const treeMarker = Buffer.from("40000 projects\0");
  const treeStart = raw.indexOf(treeMarker);
  assert.notEqual(treeStart, -1);
  const treeEnd = treeStart + treeMarker.byteLength + 20;
  const duplicateTree = raw.subarray(treeStart, treeEnd);
  const malformedSubtree = gitBinaryInput(
    root,
    ["hash-object", "--literally", "-t", "tree", "-w", "--stdin"],
    Buffer.concat([
      raw.subarray(0, treeEnd),
      duplicateTree,
      raw.subarray(treeEnd),
    ]),
  );
  const subtreeCommit = gitInput(
    root,
    ["commit-tree", malformedSubtree, "-p", commit],
    "duplicate subtree\n",
  );
  git(root, ["update-ref", "HEAD", subtreeCommit]);
  const subtree = await collectExport(root);
  assert.equal(subtree.result.ok, false);
  assert.equal(subtree.result.reason, "invalid-source");
  assert.equal(subtree.calls, 0);
  assert.deepEqual(codes(subtree.result), ["EXPORT-SOURCE"]);
});

test("canonical export rejects portable Git metadata paths and gitlinks", async (t) => {
  const metadataVault = await temporaryGitVault(t);
  const markerPath = join(metadataVault.parent, "hidden-metadata");
  await writeFile(markerPath, "hidden metadata");
  const blob = git(metadataVault.root, ["hash-object", "-w", markerPath]);
  const metadataTree = gitInput(
    metadataVault.root,
    ["mktree"],
    `100644 blob ${blob}\thidden\n`,
  );
  const rootEntries = git(metadataVault.root, ["ls-tree", "HEAD"]);
  const rootTree = gitInput(
    metadataVault.root,
    ["mktree"],
    `040000 tree ${metadataTree}\t.GiT\n${rootEntries}\n`,
  );
  const maliciousCommit = gitInput(
    metadataVault.root,
    ["commit-tree", rootTree, "-p", metadataVault.commit],
    "case variant metadata\n",
  );
  git(metadataVault.root, ["update-ref", "HEAD", maliciousCommit]);
  const metadata = await collectExport(metadataVault.root);
  assert.equal(metadata.result.ok, false);
  assert.equal(metadata.result.reason, "invalid-source");
  assert.equal(metadata.calls, 0);
  assert.deepEqual(codes(metadata.result), ["EXPORT-SOURCE"]);

  const gitlinkVault = await temporaryGitVault(t);
  git(gitlinkVault.root, [
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${gitlinkVault.commit},embedded`,
  ]);
  git(gitlinkVault.root, ["commit", "-q", "--no-gpg-sign", "-m", "gitlink"]);
  const gitlink = await collectExport(gitlinkVault.root);
  assert.equal(gitlink.result.ok, false);
  assert.equal(gitlink.result.reason, "invalid-source");
  assert.equal(gitlink.calls, 0);
  assert.deepEqual(codes(gitlink.result), ["EXPORT-SOURCE"]);
});

test("canonical export ignores inherited Git selectors", async (t) => {
  const { root } = await temporaryGitVault(t);
  const names = [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_CONFIG_GLOBAL",
  ];
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  for (const name of names) process.env[name] = "/missing/attacker-selected";
  let result;
  try {
    result = await collectExport(root);
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  assert.equal(result.result.ok, true, JSON.stringify(result.result));
  assert.equal(result.result.recordCount, 8);
});

test("canonical export supports SHA-256 commit object IDs", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "bookie-export-sha256-"));
  const root = join(parent, "vault");
  await cp(validVault, root, { recursive: true });
  t.after(() => rm(parent, { recursive: true, force: true }));
  await classifyAll(root);
  const initialized = spawnSync(
    "git",
    ["-C", root, "init", "-q", "--object-format=sha256"],
    { encoding: "utf8" },
  );
  if (initialized.status !== 0) {
    t.skip("installed Git does not support SHA-256 repositories");
    return;
  }
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "--no-gpg-sign", "-m", "sha256 source"]);
  const commit = git(root, ["rev-parse", "HEAD"]);
  assert.equal(commit.length, 64);

  const exported = await collectExport(root, commit.toUpperCase());
  assert.equal(exported.result.ok, true, JSON.stringify(exported.result));
  assert.equal(exported.result.sourceCommit, commit);
  for (const record of recordsFrom(exported.bytes)) {
    assert.equal(record.source_commit, commit);
  }

  const wrongFormat = await collectExport(root, commit.slice(0, 40));
  assert.equal(wrongFormat.result.ok, false);
  assert.equal(wrongFormat.result.reason, "invalid-source");
  assert.equal(wrongFormat.calls, 0);
});

test("canonical export declarations and implementation keep boundaries explicit", async () => {
  const declarations = await readFile(
    resolve(repositoryRoot, "packages/core/dist/index.d.ts"),
    "utf8",
  );
  assert.match(declarations, /exportCanonicalJsonl/u);
  assert.match(declarations, /CanonicalJsonlSink/u);
  assert.match(declarations, /CanonicalExportSecretPolicy/u);
  assert.doesNotMatch(
    declarations,
    /GitBatchReader|GitEntry|ExportSnapshotRecord|Document|yaml|Ajv|WriteStream/u,
  );

  const source = await Promise.all(
    [
      "canonical-export.ts",
      "vault-export-scan.ts",
      "vault-secret-detection.ts",
    ].map((name) =>
      readFile(resolve(repositoryRoot, "packages/core/src", name), "utf8"),
    ),
  );
  assert.doesNotMatch(
    source.join("\n"),
    /\bfetch\s*\(|\bRedis\b|\bPi\b|console\.|process\.exit|git commit|git push/u,
  );
});
