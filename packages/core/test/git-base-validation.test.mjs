import assert from "node:assert/strict";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter as pathDelimiter, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { loadConcept, serializeConcept, validateVault } from "../dist/index.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const validVault = resolve(repositoryRoot, "fixtures/valid-vault");
const policyFixtureRoot = resolve(repositoryRoot, "fixtures/policy/1.0");
const conceptFixtureRoot = resolve(
  repositoryRoot,
  "fixtures/concepts/1.0/valid",
);

function git(root, args, options = {}) {
  const result = spawnSync(
    "git",
    [
      "-c",
      "user.name=Bookie Tests",
      "-c",
      "user.email=bookie-tests@example.invalid",
      "-c",
      "commit.gpgSign=false",
      "-C",
      root,
      ...args,
    ],
    { encoding: "utf8", ...options },
  );
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
  );
  return result.stdout.trim();
}

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

async function clearWorktree(root) {
  for (const entry of await readdir(root)) {
    if (entry !== ".git") await rm(join(root, entry), { recursive: true });
  }
}

async function materializeTree(root, fixture, tree) {
  await clearWorktree(root);
  const policy = fixture.facts.policy;
  await writeFile(
    join(root, "bookie.yaml"),
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
    join(root, "index.md"),
    '---\nokf_version: "0.2"\n---\n\n# Git-base fixture\n',
  );

  for (const descriptor of tree.concepts ?? []) {
    const base = JSON.parse(
      await readFile(
        join(conceptFixtureRoot, `${descriptor.fixture}.json`),
        "utf8",
      ),
    );
    const frontmatter = mergeFixture(base, descriptor.patch ?? {});
    const path = join(root, descriptor.path.slice(1));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      `---\n${JSON.stringify(frontmatter)}\n---\n${descriptor.body}`,
    );
  }
  for (const descriptor of tree.resources ?? []) {
    const path = join(root, descriptor.path.slice(1));
    await mkdir(dirname(path), { recursive: true });
    await cp(join(policyFixtureRoot, descriptor.fixture), path);
  }
}

async function materializeGitCase(t, fixture) {
  const root = await mkdtemp(join(tmpdir(), "bookie-git-base-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, ["init", "-q"]);
  await materializeTree(root, fixture, fixture.facts.base);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "--no-gpg-sign", "-m", "base"]);
  const baseCommit = git(root, ["rev-parse", "HEAD"]);
  await materializeTree(root, fixture, fixture.facts.proposed);
  git(root, ["add", "-A"]);
  return { root, baseCommit };
}

function diagnosticCodes(result) {
  return [...new Set(result.diagnostics.map((diagnostic) => diagnostic.code))];
}

async function copyGitVault(t) {
  const parent = await mkdtemp(join(tmpdir(), "bookie-git-vault-"));
  const root = join(parent, "vault");
  await cp(validVault, root, { recursive: true });
  t.after(() => rm(parent, { recursive: true, force: true }));
  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "--no-gpg-sign", "-m", "base"]);
  return root;
}

async function rewriteConcept(path, mutate) {
  const loaded = loadConcept(await readFile(path), { file: path });
  assert.equal(loaded.ok, true);
  const frontmatter = structuredClone(loaded.concept.frontmatter);
  mutate(frontmatter);
  const source = Buffer.from(serializeConcept(loaded.concept)).toString("utf8");
  const closing = source.indexOf("\n---", 4);
  assert.notEqual(closing, -1);
  await writeFile(
    path,
    `---\n${JSON.stringify(frontmatter)}\n---${source.slice(closing + 4)}`,
  );
}

test("Git-base validation consumes all deferred policy fixtures", async (t) => {
  const deferred = new Set([
    "activity-deleted",
    "activity-edited",
    "activity-renamed",
    "decision-deleted",
    "evidence-deleted",
    "evidence-edited",
    "evidence-renamed",
    "evidence-resource-bytes-changed",
    "immutable-project-target-renamed",
    "immutable-relation-target-renamed",
    "immutable-support-target-renamed",
  ]);
  const fixtures = JSON.parse(
    await readFile(join(policyFixtureRoot, "invalid/cases.json"), "utf8"),
  ).filter((fixture) => deferred.has(fixture.id));
  assert.equal(fixtures.length, deferred.size);

  for (const fixture of fixtures) {
    await t.test(fixture.id, async (t) => {
      const { root, baseCommit } = await materializeGitCase(t, fixture);
      const result = await validateVault(root, { baseRef: baseCommit });
      assert.equal(result.valid, false);
      assert.equal(result.complete, true, JSON.stringify(result.diagnostics));
      assert.equal(result.baseCommit, baseCommit);
      for (const expected of fixture.expected.rules) {
        assert.ok(
          diagnosticCodes(result).includes(expected),
          `Missing ${expected}: ${JSON.stringify(result)}`,
        );
      }
    });
  }
});

test("Git-base validation treats referenced Markdown as exact resource bytes", async (t) => {
  const root = await copyGitVault(t);
  const originalResource = join(root, "references/files/source.bin");
  const markdownResource = join(root, "references/files/source.md");
  await cp(originalResource, markdownResource);
  await rm(originalResource);
  const evidencePath = join(root, "projects/fixture/evidence/evidence.md");
  await rewriteConcept(evidencePath, (frontmatter) => {
    frontmatter.resource = "/references/files/source.md";
  });
  await writeFile(
    evidencePath,
    (await readFile(evidencePath, "utf8")).replaceAll(
      "source.bin",
      "source.md",
    ),
  );
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "--no-gpg-sign", "-m", "Markdown resource"]);
  const baseCommit = git(root, ["rev-parse", "HEAD"]);

  const result = await validateVault(root, { baseRef: baseCommit });
  assert.equal(result.valid, true, JSON.stringify(result.diagnostics));
  assert.equal(result.baseCommit, baseCommit);
});

test("Git-base validation accepts every valid base/proposed fixture", async (t) => {
  const fixtures = JSON.parse(
    await readFile(join(policyFixtureRoot, "valid/cases.json"), "utf8"),
  );
  for (const fixture of fixtures) {
    await t.test(fixture.id, async (t) => {
      const { root, baseCommit } = await materializeGitCase(t, fixture);
      const result = await validateVault(root, { baseRef: baseCommit });
      assert.equal(result.valid, true, JSON.stringify(result.diagnostics));
      assert.equal(result.complete, true);
      assert.equal(result.baseCommit, baseCommit);
    });
  }
});

test("base-aware validation requires local refs and tracked ordinary files", async (t) => {
  const root = await copyGitVault(t);
  const baseCommit = git(root, ["rev-parse", "HEAD"]);

  const valid = await validateVault(root, { baseRef: "HEAD" });
  assert.equal(valid.valid, true, JSON.stringify(valid.diagnostics));
  assert.equal(valid.baseCommit, baseCommit);

  await writeFile(
    join(root, "untracked.md"),
    "---\ntype: Generic\n---\nUntracked canonical content.\n",
  );
  const untracked = await validateVault(root, { baseRef: "HEAD" });
  assert.equal(untracked.valid, false);
  assert.equal(untracked.complete, false);
  assert.equal(untracked.baseCommit, baseCommit);
  assert.ok(diagnosticCodes(untracked).includes("GIT-BASE"));

  git(root, ["add", "untracked.md"]);
  const staged = await validateVault(root, { baseRef: "HEAD" });
  assert.equal(staged.valid, true, JSON.stringify(staged.diagnostics));

  await writeFile(
    join(root, "intent-to-add.md"),
    "---\ntype: Generic\n---\nIntent-to-add is not a complete index entry.\n",
  );
  git(root, ["add", "--intent-to-add", "intent-to-add.md"]);
  const intentToAdd = await validateVault(root, { baseRef: "HEAD" });
  assert.equal(intentToAdd.valid, false);
  assert.equal(intentToAdd.complete, false);
  assert.ok(diagnosticCodes(intentToAdd).includes("GIT-BASE"));
  git(root, ["add", "intent-to-add.md"]);

  await mkdir(join(root, "embedded"));
  git(root, [
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${baseCommit},embedded`,
  ]);
  const gitlink = await validateVault(root, { baseRef: "HEAD" });
  assert.equal(gitlink.valid, false);
  assert.equal(gitlink.complete, false);
  assert.ok(diagnosticCodes(gitlink).includes("GIT-BASE"));
  git(root, ["rm", "--cached", "-q", "embedded"]);
  await rm(join(root, "embedded"), { recursive: true });

  for (const baseRef of [
    "",
    "--help",
    "HEAD~1",
    "HEAD:path",
    "HEAD@{0}",
    baseCommit.slice(0, 8),
    "\u00a0main",
    "main\u2028other",
    "main\ud800other",
  ]) {
    const rejected = await validateVault(root, { baseRef });
    assert.equal(rejected.valid, false, baseRef);
    assert.equal(rejected.complete, false, baseRef);
    assert.ok(diagnosticCodes(rejected).includes("GIT-BASE"), baseRef);
  }
});

test("Git-base validation scopes a vault nested in its containing worktree", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "bookie-nested-git-"));
  const repository = join(parent, "repository");
  const root = join(repository, "nested/vault");
  await mkdir(repository, { recursive: true });
  await cp(validVault, root, { recursive: true });
  t.after(() => rm(parent, { recursive: true, force: true }));
  git(repository, ["init", "-q"]);
  git(repository, ["add", "-A"]);
  git(repository, ["commit", "-q", "--no-gpg-sign", "-m", "base"]);
  const baseCommit = git(repository, ["rev-parse", "HEAD"]);

  const result = await validateVault(root, { baseRef: "HEAD" });
  assert.equal(result.valid, true, JSON.stringify(result.diagnostics));
  assert.equal(result.complete, true);
  assert.equal(result.baseCommit, baseCommit);
});

test("hexadecimal base IDs must match the repository object format", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "bookie-sha256-git-"));
  const root = join(parent, "vault");
  await cp(validVault, root, { recursive: true });
  t.after(() => rm(parent, { recursive: true, force: true }));
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
  git(root, ["commit", "-q", "--no-gpg-sign", "-m", "base"]);
  const commit = git(root, ["rev-parse", "HEAD"]);
  assert.equal(commit.length, 64);

  const full = await validateVault(root, { baseRef: commit });
  assert.equal(full.valid, true, JSON.stringify(full.diagnostics));
  const abbreviated = await validateVault(root, {
    baseRef: commit.slice(0, 40),
  });
  assert.equal(abbreviated.valid, false);
  assert.equal(abbreviated.complete, false);
  assert.ok(diagnosticCodes(abbreviated).includes("GIT-BASE"));
});

test("Git-base validation ignores alternate indexes and repository hooks", async (t) => {
  const root = await copyGitVault(t);
  const untrackedPath = join(root, "alternate-only.md");
  await writeFile(
    untrackedPath,
    "---\ntype: Generic\n---\nOnly present in an attacker-selected index.\n",
  );
  const alternateIndex = join(dirname(root), "alternate-index");
  const alternateEnvironment = {
    ...process.env,
    GIT_INDEX_FILE: alternateIndex,
  };
  git(root, ["read-tree", "HEAD"], { env: alternateEnvironment });
  git(root, ["add", "alternate-only.md"], { env: alternateEnvironment });

  const previousIndex = process.env.GIT_INDEX_FILE;
  process.env.GIT_INDEX_FILE = alternateIndex;
  let alternateResult;
  try {
    alternateResult = await validateVault(root, { baseRef: "HEAD" });
  } finally {
    if (previousIndex === undefined) delete process.env.GIT_INDEX_FILE;
    else process.env.GIT_INDEX_FILE = previousIndex;
  }
  assert.equal(alternateResult.valid, false);
  assert.equal(alternateResult.complete, false);
  assert.ok(diagnosticCodes(alternateResult).includes("GIT-BASE"));

  await rm(untrackedPath);
  const marker = join(dirname(root), "fsmonitor-invoked");
  const hook = join(dirname(root), "fsmonitor-hook.sh");
  await writeFile(
    hook,
    `#!/bin/sh\nprintf invoked >${JSON.stringify(marker)}\nprintf '2\\n'\n`,
  );
  await chmod(hook, 0o755);
  git(root, ["config", "core.fsmonitor", hook]);
  const hookResult = await validateVault(root, { baseRef: "HEAD" });
  assert.equal(hookResult.valid, true, JSON.stringify(hookResult.diagnostics));
  assert.equal(
    await readFile(marker, "utf8").catch(() => undefined),
    undefined,
  );
});

test("Git-base validation rechecks index tracking at completion", async (t) => {
  const root = await copyGitVault(t);
  const wrapperDirectory = join(dirname(root), "git-wrapper");
  await mkdir(wrapperDirectory);
  const wrapper = join(wrapperDirectory, "git");
  const counter = join(wrapperDirectory, "seen-ls-files");
  const located = spawnSync("sh", ["-c", "command -v git"], {
    encoding: "utf8",
  });
  assert.equal(located.status, 0, located.stderr);
  const realGit = located.stdout.trim();
  await writeFile(
    wrapper,
    [
      "#!/bin/sh",
      'case " $* " in',
      '  *" ls-files "*" --debug "*)',
      '    "$BOOKIE_REAL_GIT" "$@"',
      "    status=$?",
      '    if [ ! -e "$BOOKIE_COUNTER" ]; then',
      '      : >"$BOOKIE_COUNTER"',
      '      "$BOOKIE_REAL_GIT" -C "$BOOKIE_VAULT" rm --cached -q index.md',
      "    fi",
      "    exit $status",
      "    ;;",
      "esac",
      'exec "$BOOKIE_REAL_GIT" "$@"',
      "",
    ].join("\n"),
  );
  await chmod(wrapper, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${wrapperDirectory}${pathDelimiter}${previousPath ?? ""}`;
  process.env.BOOKIE_REAL_GIT = realGit;
  process.env.BOOKIE_COUNTER = counter;
  process.env.BOOKIE_VAULT = root;
  let result;
  try {
    result = await validateVault(root, { baseRef: "HEAD" });
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    delete process.env.BOOKIE_REAL_GIT;
    delete process.env.BOOKIE_COUNTER;
    delete process.env.BOOKIE_VAULT;
  }
  assert.equal(result.valid, false);
  assert.equal(result.complete, false);
  assert.ok(diagnosticCodes(result).includes("GIT-BASE"));
});

test("Git-base infrastructure failure is static, bounded, and cancellable", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "bookie-no-git-"));
  const root = join(parent, "vault");
  await cp(validVault, root, { recursive: true });
  t.after(() => rm(parent, { recursive: true, force: true }));

  const missingRepository = await validateVault(root, { baseRef: "main" });
  assert.equal(missingRepository.valid, false);
  assert.equal(missingRepository.complete, false);
  assert.deepEqual(diagnosticCodes(missingRepository), ["GIT-BASE"]);
  assert.equal(JSON.stringify(missingRepository).includes("fatal:"), false);

  const controller = new AbortController();
  controller.abort("custom reason");
  await assert.rejects(
    validateVault(root, { baseRef: "main", signal: controller.signal }),
    (error) => error?.name === "AbortError",
  );
  await assert.rejects(validateVault(root, { baseRef: 123 }), TypeError);
});

test("base-only diagnostics redact excluded immutable identities", async (t) => {
  const malformedRoot = await copyGitVault(t);
  const malformedManifest = join(malformedRoot, "bookie.yaml");
  await writeFile(
    malformedManifest,
    (await readFile(malformedManifest, "utf8"))
      .replace("      - public\n", "      - public\n      - restricted\n")
      .replace(
        "    excluded_classes: []",
        "    excluded_classes:\n      - restricted",
      ),
  );
  const malformedActivity = join(
    malformedRoot,
    "projects/fixture/activities/checkpoint.md",
  );
  await rewriteConcept(malformedActivity, (frontmatter) => {
    frontmatter.title = "DO-NOT-LEAK-MALFORMED-TITLE";
    frontmatter.bookie.sensitivity = "restricted";
  });
  await writeFile(
    join(malformedRoot, "a-earlier-malformed.md"),
    "---\ntype: [\n---\nEarlier malformed base input.\n",
  );
  git(malformedRoot, ["add", "-A"]);
  git(malformedRoot, [
    "commit",
    "-q",
    "--no-gpg-sign",
    "-m",
    "restricted malformed base",
  ]);
  const malformedBase = git(malformedRoot, ["rev-parse", "HEAD"]);
  await writeFile(malformedActivity, "---\ntype: [\n---\nsecret\n");
  git(malformedRoot, ["add", "-A"]);
  const malformed = await validateVault(malformedRoot, {
    baseRef: malformedBase,
  });
  const malformedSerialized = JSON.stringify(malformed);
  assert.ok(diagnosticCodes(malformed).includes("YAML-SYNTAX"));
  assert.equal(malformedSerialized.includes("checkpoint.md"), false);
  assert.equal(
    malformedSerialized.includes("DO-NOT-LEAK-MALFORMED-TITLE"),
    false,
  );

  const root = await copyGitVault(t);
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
  const activityPath = join(root, "projects/fixture/activities/checkpoint.md");
  await rewriteConcept(activityPath, (frontmatter) => {
    frontmatter.title = "DO-NOT-LEAK-TITLE";
    frontmatter.bookie.sensitivity = "restricted";
  });
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "--no-gpg-sign", "-m", "restricted base"]);
  const baseCommit = git(root, ["rev-parse", "HEAD"]);
  await rm(activityPath);
  git(root, ["add", "-A"]);

  const result = await validateVault(root, { baseRef: baseCommit });
  const serialized = JSON.stringify(result);
  assert.ok(
    result.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "ACTIVITY-IMMUTABLE" &&
        diagnostic.file === "<excluded>",
    ),
  );
  assert.equal(serialized.includes("checkpoint.md"), false);
  assert.equal(serialized.includes("DO-NOT-LEAK-TITLE"), false);
});
