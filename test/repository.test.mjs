import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

const requiredFiles = [
  ".gitattributes",
  "AGENTS.md",
  "README.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "package-lock.json",
  "tsconfig.json",
  "eslint.config.js",
  "packages/core/package.json",
  "packages/core/src/index.ts",
  "packages/core/test/versions.test.mjs",
  "packages/cli/package.json",
  "packages/pi-extension/package.json",
  "apps/service/package.json",
  "docs/INDEX.md",
  "docs/product/vision.md",
  "docs/product/requirements.md",
  "docs/architecture/overview.md",
  "docs/architecture/data-model.md",
  "docs/architecture/retrieval.md",
  "docs/architecture/security.md",
  "docs/architecture/decisions/0001-okf-git-canonical-store.md",
  "docs/architecture/decisions/0002-redis-derived-retrieval.md",
  "docs/architecture/decisions/0003-provider-neutral-embeddings.md",
  "docs/architecture/decisions/0004-typescript-monorepo.md",
  "docs/architecture/decisions/0005-yaml-document-ast.md",
  "docs/architecture/decisions/0006-exact-commit-streaming-export.md",
  "docs/planning/roadmap.md",
  "docs/planning/backlog.md",
  "docs/planning/definition-of-done.md",
  "docs/planning/open-questions.md",
  "docs/planning/toolchain.md",
  "docs/specs/001-canonical-ledger.md",
  "docs/specs/002-core-and-cli.md",
  "docs/specs/003-pi-extension.md",
  "docs/specs/004-retrieval-service.md",
  "docs/specs/005-export-adapters.md",
  "schemas/export/1.0/canonical-record.schema.json",
  "examples/vault/index.md",
  "examples/vault/bookie.yaml",
  "examples/vault/projects/demo/project.md",
  "examples/vault/projects/demo/tasks/first-task.md",
  "examples/vault/projects/demo/activities/first-checkpoint.md",
];

function filesBelow(path) {
  const absolute = resolve(root, path);
  const result = [];
  for (const entry of readdirSync(absolute)) {
    if ([".git", "node_modules"].includes(entry)) continue;
    const child = join(absolute, entry);
    if (statSync(child).isDirectory()) result.push(...filesBelow(child));
    else result.push(child);
  }
  return result;
}

function repoPath(absolute) {
  return absolute.slice(root.length + 1);
}

test("repository contains the agent handoff contract", () => {
  const missing = requiredFiles.filter(
    (path) => !existsSync(resolve(root, path)),
  );
  assert.deepEqual(
    missing,
    [],
    `Missing required files:\n${missing.join("\n")}`,
  );
});

test("exact-byte CRLF fixtures are protected from text normalization", () => {
  for (const path of [
    "fixtures/policy/1.0/resources/crlf.txt",
    "packages/core/test/fixtures/lossless-crlf.md",
  ]) {
    const checked = spawnSync(
      "git",
      ["check-attr", "text", "diff", "--", path],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(checked.status, 0, checked.stderr);
    assert.match(checked.stdout, /text: unset/u);
    assert.match(checked.stdout, /diff: unset/u);
  }
});

test("local Markdown links resolve", () => {
  const markdownFiles = filesBelow(".").filter(
    (path) =>
      extname(path) === ".md" &&
      !path.includes(`${join(root, "node_modules")}`),
  );
  const broken = [];
  const linkPattern = /(?<!!)\[[^\]]*\]\(([^)]+)\)/g;
  const invalidVaultRoot = resolve(root, "fixtures/invalid-vaults");
  const vaultRoots = [
    resolve(root, "examples/vault"),
    resolve(root, "fixtures/valid-vault"),
    ...(existsSync(invalidVaultRoot)
      ? readdirSync(invalidVaultRoot).map((name) =>
          resolve(invalidVaultRoot, name),
        )
      : []),
  ];

  for (const file of markdownFiles) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(linkPattern)) {
      const destination = match[1].trim().replace(/^<|>$/g, "");
      if (
        destination === "" ||
        destination.startsWith("#") ||
        /^[a-z][a-z0-9+.-]*:/i.test(destination)
      )
        continue;

      const pathOnly = decodeURIComponent(destination.split("#", 1)[0]);
      const bundleRoot = vaultRoots.find((vaultRoot) =>
        file.startsWith(`${vaultRoot}/`),
      );
      const target = pathOnly.startsWith("/")
        ? normalize(resolve(bundleRoot ?? root, `.${pathOnly}`))
        : normalize(resolve(dirname(file), pathOnly));
      if (!existsSync(target)) {
        broken.push(`${repoPath(file)} -> ${destination}`);
      }
    }
  }

  assert.deepEqual(broken, [], `Broken local links:\n${broken.join("\n")}`);
});

test("example vault follows the minimum OKF v0.2 envelope", () => {
  const vaultRoot = resolve(root, "examples/vault");
  const index = readFileSync(join(vaultRoot, "index.md"), "utf8");
  assert.match(
    index,
    /^---\n[\s\S]*okf_version:\s*["']?0\.2["']?[\s\S]*\n---\n/,
  );

  const config = readFileSync(join(vaultRoot, "bookie.yaml"), "utf8");
  assert.match(config, /^profile:\s*["']?\d+\.\d+["']?$/m);
  assert.match(config, /^\s{2}uid:\s+VLT-[0-9A-HJKMNP-TV-Z]{26}$/m);

  const conceptFiles = filesBelow("examples/vault").filter(
    (path) =>
      extname(path) === ".md" &&
      !["index.md", "log.md"].includes(path.split("/").at(-1)),
  );
  assert.ok(
    conceptFiles.length > 0,
    "Example vault must contain concept documents",
  );

  for (const file of conceptFiles) {
    const text = readFileSync(file, "utf8");
    assert.ok(
      text.startsWith("---\n"),
      `${repoPath(file)} lacks YAML frontmatter`,
    );
    const frontmatterEnd = text.indexOf("\n---\n", 4);
    assert.ok(
      frontmatterEnd > 4,
      `${repoPath(file)} has unclosed YAML frontmatter`,
    );
    const frontmatter = text.slice(4, frontmatterEnd);
    assert.match(
      frontmatter,
      /^type:\s*\S.+$/m,
      `${repoPath(file)} lacks an OKF type`,
    );
    assert.match(
      frontmatter,
      /^\s{2}uid:\s+[A-Z]{3}-[0-9A-HJKMNP-TV-Z]{26}$/m,
      `${repoPath(file)} lacks a prefixed ULID bookie.uid`,
    );
  }
});

test("specifications carry implementation-ready sections", () => {
  const requiredHeadings = [
    "## Status",
    "## Goal",
    "## Non-goals",
    "## Requirements",
    "## Acceptance criteria",
    "## Test strategy",
    "## Dependencies",
  ];

  for (const file of filesBelow("docs/specs").filter(
    (path) => extname(path) === ".md",
  )) {
    const text = readFileSync(file, "utf8");
    for (const heading of requiredHeadings) {
      assert.ok(
        text.includes(heading),
        `${repoPath(file)} is missing ${heading}`,
      );
    }
  }
});

test("requirement and backlog row identifiers are unique", () => {
  const requirements = readFileSync(
    resolve(root, "docs/product/requirements.md"),
    "utf8",
  );
  const backlog = readFileSync(
    resolve(root, "docs/planning/backlog.md"),
    "utf8",
  );
  const ids = [
    ...requirements.matchAll(/^\|\s*(REQ-\d{3})\s*\|/gm),
    ...backlog.matchAll(/^\|\s*(BK-\d{3})\s*\|/gm),
  ].map((match) => match[1]);
  const duplicates = [
    ...new Set(ids.filter((id, index) => ids.indexOf(id) !== index)),
  ];
  assert.ok(
    ids.some((id) => id.startsWith("REQ-")),
    "No requirement rows found",
  );
  assert.ok(
    ids.some((id) => id.startsWith("BK-")),
    "No backlog rows found",
  );
  assert.deepEqual(
    duplicates,
    [],
    `Duplicate primary identifiers: ${duplicates.join(", ")}`,
  );
});

function assertSequential(ids, label) {
  const numbers = [...ids]
    .map((id) => Number(id.match(/\d+$/)?.[0]))
    .sort((left, right) => left - right);
  assert.deepEqual(
    numbers,
    Array.from({ length: numbers.at(-1) ?? 0 }, (_, index) => index + 1),
    `${label} identifiers must be contiguous`,
  );
}

test("toolchain, workspaces, and lockfile versions stay aligned", () => {
  const rootPackage = JSON.parse(
    readFileSync(resolve(root, "package.json"), "utf8"),
  );
  const lockfile = JSON.parse(
    readFileSync(resolve(root, "package-lock.json"), "utf8"),
  );
  const toolchain = readFileSync(
    resolve(root, "docs/planning/toolchain.md"),
    "utf8",
  );
  const nodeMajor = readFileSync(resolve(root, ".nvmrc"), "utf8").trim();
  const workspacePaths = [
    "packages/core",
    "packages/cli",
    "packages/pi-extension",
    "apps/service",
  ];

  assert.equal(rootPackage.engines.node, `>=${nodeMajor}`);
  assert.match(rootPackage.packageManager ?? "", /^npm@\d+\.\d+\.\d+$/);
  const npmVersion = rootPackage.packageManager.split("@")[1];
  assert.ok(
    toolchain.includes(`| Node.js | ${nodeMajor} |`),
    "Toolchain Node version drifted",
  );
  assert.ok(
    toolchain.includes(`| npm | ${npmVersion} |`),
    "Toolchain npm version drifted",
  );
  assert.equal(lockfile.packages[""].version, rootPackage.version);

  const names = [];
  for (const workspacePath of workspacePaths) {
    const manifest = JSON.parse(
      readFileSync(resolve(root, workspacePath, "package.json"), "utf8"),
    );
    names.push(manifest.name);
    assert.equal(
      manifest.private,
      true,
      `${manifest.name} must remain private pre-release`,
    );
    assert.equal(
      manifest.version,
      rootPackage.version,
      `${manifest.name} version drifted`,
    );
    assert.equal(
      lockfile.packages[workspacePath]?.version,
      manifest.version,
      `${manifest.name} lockfile entry drifted`,
    );
    if (workspacePath === "packages/core") {
      assert.equal(manifest.engines?.node, rootPackage.engines.node);
      assert.equal(
        lockfile.packages[workspacePath]?.engines?.node,
        rootPackage.engines.node,
      );
      assert.deepEqual(
        lockfile.packages[workspacePath]?.dependencies,
        manifest.dependencies,
      );
    }
  }
  assert.equal(
    new Set(names).size,
    names.length,
    "Workspace package names must be unique",
  );
});

test("OKF and example profile versions stay aligned", () => {
  const core = readFileSync(
    resolve(root, "packages/core/src/index.ts"),
    "utf8",
  );
  const index = readFileSync(resolve(root, "examples/vault/index.md"), "utf8");
  const config = readFileSync(
    resolve(root, "examples/vault/bookie.yaml"),
    "utf8",
  );
  const okfVersion = core.match(/OKF_VERSION\s*=\s*"([^"]+)"/)?.[1];
  const indexedVersion = index.match(
    /okf_version:\s*["']?([^"'\n]+)["']?/,
  )?.[1];
  const profileVersion = config.match(
    /^profile:\s*["']?([^"'\n]+)["']?$/m,
  )?.[1];

  assert.ok(okfVersion, "Core OKF version is missing");
  assert.equal(
    indexedVersion,
    okfVersion,
    "Example OKF version drifted from core",
  );
  assert.ok(profileVersion, "Example profile version is missing");

  for (const file of filesBelow("examples/vault").filter(
    (path) =>
      extname(path) === ".md" &&
      !["index.md", "log.md"].includes(path.split("/").at(-1)),
  )) {
    const frontmatter = readFileSync(file, "utf8").split("\n---\n", 1)[0];
    const conceptProfile = frontmatter.match(
      /^\s{2}profile:\s*["']?([^"'\n]+)["']?$/m,
    )?.[1];
    assert.equal(
      conceptProfile,
      profileVersion,
      `${repoPath(file)} profile version drifted`,
    );
  }
});

test("backlog dependencies, states, and completion evidence stay coherent", () => {
  const backlogPath = resolve(root, "docs/planning/backlog.md");
  const backlog = readFileSync(backlogPath, "utf8");
  const openQuestions = readFileSync(
    resolve(root, "docs/planning/open-questions.md"),
    "utf8",
  );
  const rows = backlog
    .split("\n")
    .filter((line) => /^\|\s*BK-\d{3}\s*\|/.test(line))
    .map((line) => {
      const [id, status, specification, work, dependencies] = line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim());
      return { id, status, specification, work, dependencies };
    });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const openQuestionIds = new Set(
    [...openQuestions.matchAll(/^##\s+(OQ-\d{3}):/gm)].map((match) => match[1]),
  );
  const validSpecIds = new Set(
    filesBelow("docs/specs").map(
      (path) => `SPEC-${path.split("/").at(-1).slice(0, 3)}`,
    ),
  );
  const validAdrIds = new Set(
    filesBelow("docs/architecture/decisions").map(
      (path) => `ADR-${path.split("/").at(-1).slice(0, 4)}`,
    ),
  );

  assertSequential(
    rows.map((row) => row.id),
    "Backlog",
  );
  assertSequential(openQuestionIds, "Open-question");
  const readyRows = rows.filter((row) => row.status === "Ready");
  if (readyRows.length === 0) {
    const nextBlocked = rows.find(
      (row) => !["Done", "Deferred"].includes(row.status),
    );
    assert.ok(nextBlocked, "Backlog has no Ready or Blocked work");
    assert.equal(
      nextBlocked.status,
      "Blocked",
      `${nextBlocked.id} must explain why no work is Ready`,
    );
    const questionDependencies =
      nextBlocked.dependencies.match(/OQ-\d{3}/g) ?? [];
    assert.ok(
      questionDependencies.length > 0,
      `No Ready work and ${nextBlocked.id} has no decision gate`,
    );
    assert.ok(
      backlog.includes("No implementation item is Ready"),
      "Backlog must disclose an empty Ready queue",
    );
  }

  for (const [index, row] of rows.entries()) {
    assert.ok(
      ["Ready", "Blocked", "Deferred", "Done"].includes(row.status),
      `${row.id} has unknown status ${row.status}`,
    );
    for (const reference of row.specification.match(
      /(?:SPEC-\d{3}|ADR-\d{4})/g,
    ) ?? []) {
      const valid = reference.startsWith("SPEC-") ? validSpecIds : validAdrIds;
      assert.ok(
        valid.has(reference),
        `${row.id} references missing ${reference}`,
      );
    }
    for (const dependency of row.dependencies.match(/(?:BK|OQ)-\d{3}/g) ?? []) {
      if (dependency.startsWith("OQ-")) {
        assert.ok(
          openQuestionIds.has(dependency),
          `${row.id} references missing ${dependency}`,
        );
        continue;
      }
      assert.ok(
        byId.has(dependency),
        `${row.id} references missing ${dependency}`,
      );
      assert.ok(
        rows.findIndex((candidate) => candidate.id === dependency) < index,
        `${row.id} depends on non-prior ${dependency}`,
      );
    }
    if (row.status === "Ready") {
      for (const dependency of row.dependencies.match(/BK-\d{3}/g) ?? []) {
        assert.equal(
          byId.get(dependency)?.status,
          "Done",
          `${row.id} is Ready before ${dependency}`,
        );
      }
      assert.equal(
        (row.dependencies.match(/OQ-\d{3}/g) ?? []).length,
        0,
        `${row.id} is Ready with an open-question dependency`,
      );
    }
    if (row.status === "Done") {
      const evidence = row.work.match(/\[evidence\]\(([^)]+)\)/)?.[1];
      assert.ok(evidence, `${row.id} is Done without linked evidence`);
      assert.ok(
        existsSync(resolve(dirname(backlogPath), evidence)),
        `${row.id} evidence file is missing`,
      );
    }
  }
});

test("numbered requirements, specifications, and ADRs have no gaps", () => {
  const requirements = readFileSync(
    resolve(root, "docs/product/requirements.md"),
    "utf8",
  );
  const requirementIds = [
    ...requirements.matchAll(/^\|\s*(REQ-\d{3})\s*\|/gm),
  ].map((match) => match[1]);
  const specificationIds = filesBelow("docs/specs").map(
    (path) => `SPEC-${path.split("/").at(-1).slice(0, 3)}`,
  );
  const adrIds = filesBelow("docs/architecture/decisions").map(
    (path) => `ADR-${path.split("/").at(-1).slice(0, 4)}`,
  );

  assertSequential(requirementIds, "Requirement");
  assertSequential(specificationIds, "Specification");
  assertSequential(adrIds, "ADR");
});
