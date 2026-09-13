import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const cliPackage = resolve(repositoryRoot, "packages/cli");
const corePackage = resolve(repositoryRoot, "packages/core");
const cli = resolve(cliPackage, "dist/cli.js");
const fixture = resolve(repositoryRoot, "fixtures/valid-vault");

async function temporaryVault(t, git = false) {
  const parent = await mkdtemp(join(tmpdir(), "bookie-cli-"));
  const vault = join(parent, "vault");
  await cp(fixture, vault, { recursive: true });
  if (git) {
    execFileSync("git", ["init", "-q"], { cwd: vault });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], {
      cwd: vault,
    });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: vault });
    execFileSync("git", ["add", "."], { cwd: vault });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: vault });
  }
  t.after(() => rm(parent, { recursive: true, force: true }));
  return { parent, vault };
}

function run(args, options = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
    ...options,
  });
}

function jsonOutput(result) {
  assert.match(result.stdout, /^\{[^\n]*\}\n$/u);
  return JSON.parse(result.stdout);
}

test("validate emits one machine-safe JSON result", async (t) => {
  const { vault } = await temporaryVault(t);
  const result = run(["validate", "--vault", vault, "--format", "json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const parsed = jsonOutput(result);
  assert.equal(parsed.command, "validate");
  assert.equal(parsed.valid, true);
  assert.equal(parsed.complete, true);
});

test("search maps every filter and inspect returns exact source bytes", async (t) => {
  const { vault } = await temporaryVault(t);
  const search = run([
    "search",
    "--vault",
    vault,
    "Fixture task",
    "--type",
    "Task",
    "--project",
    "/projects/fixture/project.md",
    "--status",
    "draft",
    "--state",
    "ready",
    "--sensitivity",
    "public",
    "--tag",
    "missing",
    "--format",
    "json",
  ]);
  assert.equal(search.status, 0, search.stderr);
  const filtered = jsonOutput(search);
  assert.equal(filtered.command, "search");
  assert.equal(filtered.results.length, 0);

  const foundResult = run([
    "search",
    "--vault",
    vault,
    "Fixture task",
    "--type",
    "Task",
    "--state",
    "ready",
    "--format",
    "json",
  ]);
  assert.equal(foundResult.status, 0, foundResult.stderr);
  const found = jsonOutput(foundResult);
  assert.equal(found.results.length, 1);
  assert.equal(found.results[0].source.path, "/projects/fixture/tasks/task.md");
  assert.equal(found.results[0].untrusted, true);

  const path = "/projects/fixture/tasks/task.md";
  const inspect = run(["inspect", "--vault", vault, "--path", path]);
  assert.equal(inspect.status, 0, inspect.stderr);
  assert.equal(
    inspect.stdout,
    await readFile(join(vault, path.slice(1)), "utf8"),
  );
  assert.equal(inspect.stderr, "");
});

test("text search escapes untrusted controls and discloses truncation", async (t) => {
  const { vault } = await temporaryVault(t);
  const sourcePath = join(vault, "projects/fixture/tasks/task.md");
  const source = await readFile(sourcePath, "utf8");
  const directory = join(vault, "projects/fixture/tasks/many");
  await mkdir(directory);
  for (let index = 0; index < 51; index += 1) {
    const uid = `TSK-${(index + 100).toString().padStart(26, "0")}`;
    const title =
      index === 0
        ? "Needle\n\u001b[31m\u009b\u0085\u2028\u2029FORGED"
        : `Needle ${index}`;
    const match = /^---\n([^\n]+)\n---\n([\s\S]*)$/u.exec(source);
    assert.ok(match);
    const frontmatter = JSON.parse(match[1]);
    frontmatter.bookie.uid = uid;
    frontmatter.title = title;
    await writeFile(
      join(directory, `${index}.md`),
      `---\n${JSON.stringify(frontmatter)}\n---\n${match[2]}`,
    );
  }
  const result = run(["search", "--vault", vault, "Needle"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.split("\n").length - 1, 50);
  for (const control of ["\u001b", "\u009b", "\u0085", "\u2028", "\u2029"]) {
    assert.equal(result.stdout.includes(control), false);
    assert.equal(
      result.stdout.includes(
        `\\u${control.charCodeAt(0).toString(16).padStart(4, "0")}`,
      ),
      true,
    );
  }
  assert.equal(result.stdout.includes("\\n"), true);
  assert.equal(result.stderr, "CLI-TRUNCATED: Search result limit reached.\n");
});

test("validation returns exit 3 for immutable-policy failures", async (t) => {
  const { vault } = await temporaryVault(t, true);
  const noise = join(vault, "noise");
  await mkdir(noise);
  await Promise.all(
    Array.from({ length: 1_005 }, (_, index) =>
      writeFile(
        join(noise, `${index}.md`),
        `---\ntype: Note\ntitle: Noise ${index}\nstatus: draft\n---\n`,
      ),
    ),
  );
  execFileSync("git", ["add", "."], { cwd: vault });
  execFileSync("git", ["commit", "-qm", "noise baseline"], { cwd: vault });
  await Promise.all(
    Array.from({ length: 1_005 }, (_, index) =>
      writeFile(join(noise, `${index}.md`), "---\n: broken [\n---\n"),
    ),
  );
  for (const path of [
    "projects/fixture/activities/checkpoint.md",
    "projects/fixture/evidence/evidence.md",
  ]) {
    await writeFile(join(vault, path), "\nchanged\n", { flag: "a" });
  }
  const result = run([
    "validate",
    "--vault",
    vault,
    "--base",
    "HEAD",
    "--format",
    "json",
  ]);
  assert.equal(result.status, 3, result.stderr);
  const parsed = jsonOutput(result);
  assert.equal(parsed.valid, false);
  assert.equal(parsed.immutablePolicyViolation, true);
  assert.equal(parsed.diagnosticsTruncated, true);
});

test("deferred filesystem-writing names and malformed grammar are static errors", async (t) => {
  const { vault } = await temporaryVault(t);
  for (const args of [
    ["init", "--vault", join(vault, "password:do-not-print")],
    ["create", "--vault", vault],
    ["amend", "--vault", vault],
    ["evidence", "add", "--vault", vault],
    ["export", "jsonl", "--vault", vault],
    ["validate", "--format", "json", "--vault", vault],
    ["validate", "--vault", "--format", "json"],
    ["validate", "--vault", vault, "--format"],
    ["validate", "--vault", vault, "--vault", vault],
    ["search", "query", "--vault", vault],
    ["search", "--vault", vault, "--literal-query"],
    ["search", "--vault", vault, "query", "--type", "--format"],
    ["search", "--vault", vault, "query", "--type"],
    ["search", "--type", "Task", "--vault", vault, "query"],
    ["inspect", "--vault", vault, "--uid", "--format", "json"],
    ["inspect", "--vault", vault, "--uid"],
    ["inspect", "--vault", vault, "--uid", "x", "--path", "secret"],
  ]) {
    const result = run(args);
    assert.equal(result.status, 2, args.join(" "));
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr,
      "CLI-INVOCATION: Invalid command invocation.\n",
    );
    assert.equal(result.stderr.includes("do-not-print"), false);
  }

  const leadingDashQuery = run([
    "search",
    "--vault",
    vault,
    "--",
    "--literal-query",
    "--format",
    "json",
  ]);
  assert.equal(leadingDashQuery.status, 0, leadingDashQuery.stderr);
  assert.equal(jsonOutput(leadingDashQuery).command, "search");
});

test("search output omits excluded identities and marker content", async (t) => {
  const { vault } = await temporaryVault(t);
  const manifestPath = join(vault, "bookie.yaml");
  await writeFile(
    manifestPath,
    (await readFile(manifestPath, "utf8"))
      .replace("      - public\n", "      - public\n      - restricted\n")
      .replace(
        "    excluded_classes: []",
        "    excluded_classes:\n      - restricted",
      ),
  );
  const path = join(vault, "projects/fixture/tasks/task.md");
  const source = await readFile(path, "utf8");
  const match = /^---\n([^\n]+)\n---\n([\s\S]*)$/u.exec(source);
  assert.ok(match);
  const frontmatter = JSON.parse(match[1]);
  frontmatter.title = "EXCLUDED-MARKER";
  frontmatter.bookie.sensitivity = "restricted";
  await writeFile(
    path,
    `---\n${JSON.stringify(frontmatter)}\n---\n${match[2]}`,
  );
  const result = run([
    "search",
    "--vault",
    vault,
    "EXCLUDED-MARKER",
    "--format",
    "json",
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.includes("EXCLUDED-MARKER"), false);
  assert.equal(result.stdout.includes("tasks/task.md"), false);
  assert.equal(result.stderr, "");
});

test("supported commands do not mutate Git/filesystem state or open network clients", async (t) => {
  const { parent, vault } = await temporaryVault(t, true);
  const blocker = join(parent, "block-network.cjs");
  await writeFile(
    blocker,
    [
      'const fail = () => { throw new Error("network forbidden"); };',
      'require("node:net").connect = fail;',
      'require("node:http").request = fail;',
      'require("node:http").get = fail;',
      'require("node:https").request = fail;',
      'require("node:https").get = fail;',
      "globalThis.fetch = fail;",
    ].join("\n"),
  );
  const git = (...args) =>
    execFileSync("git", args, { cwd: vault, encoding: "utf8" });
  const beforeStatus = git("status", "--porcelain=v1", "--untracked-files=all");
  const beforeHead = git("rev-parse", "HEAD");
  const env = {
    PATH: process.env.PATH,
    NODE_OPTIONS: `--require=${blocker}`,
  };
  for (const args of [
    ["validate", "--vault", vault, "--base", "HEAD"],
    ["search", "--vault", vault, "Fixture"],
    ["inspect", "--vault", vault, "--path", "/projects/fixture/tasks/task.md"],
  ]) {
    const result = run(args, { env });
    assert.equal(result.status, 0, `${args[0]}: ${result.stderr}`);
  }
  assert.equal(
    git("status", "--porcelain=v1", "--untracked-files=all"),
    beforeStatus,
  );
  assert.equal(git("rev-parse", "HEAD"), beforeHead);
});

test("CLI source cannot reach filesystem-writing APIs", async () => {
  const source = await readFile(resolve(cliPackage, "src/cli.ts"), "utf8");
  for (const forbidden of [
    "createConcept",
    "amendConcept",
    "captureEvidence",
    "initializeVault",
    "exportCanonicalJsonl",
    "node:fs",
    "node:http",
    "node:https",
    "node:net",
    "child_process",
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});

test("clean package artifacts install and expose the bookie binary", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "bookie-cli-pack-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  await Promise.all([
    rm(resolve(corePackage, "dist"), { recursive: true, force: true }),
    rm(resolve(cliPackage, "dist"), { recursive: true, force: true }),
  ]);
  const pack = (path) => {
    const packed = JSON.parse(
      execFileSync(
        "npm",
        ["pack", path, "--pack-destination", parent, "--json"],
        {
          cwd: repositoryRoot,
          encoding: "utf8",
        },
      ),
    );
    return Array.isArray(packed) ? packed[0] : Object.values(packed)[0];
  };
  const core = pack(corePackage);
  assert.ok(core.files.some(({ path }) => path === "dist/index.js"));
  assert.ok(
    core.files.some(
      ({ path }) =>
        path === "dist/schemas/profile/1.0/bookie-config.schema.json",
    ),
  );
  const cliArtifact = pack(cliPackage);
  assert.ok(cliArtifact.files.some(({ path }) => path === "dist/cli.js"));

  const installation = join(parent, "installation");
  await mkdir(installation);
  execFileSync("npm", ["init", "-y"], { cwd: installation, stdio: "ignore" });
  execFileSync(
    "npm",
    [
      "install",
      "--ignore-scripts",
      join(parent, core.filename),
      join(parent, cliArtifact.filename),
    ],
    { cwd: installation, stdio: "ignore" },
  );
  const binary = resolve(installation, "node_modules/.bin/bookie");
  const result = spawnSync(binary, ["validate", "--vault", fixture], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Vault is valid.\n");
});

test("SIGINT cancellation is static and writes no output", async (t) => {
  const { vault } = await temporaryVault(t);
  const task = await readFile(
    join(vault, "projects/fixture/tasks/task.md"),
    "utf8",
  );
  const directory = join(vault, "projects/fixture/tasks/many");
  await mkdir(directory);
  await Promise.all(
    Array.from({ length: 4_000 }, (_, index) =>
      writeFile(join(directory, `${index}.md`), task),
    ),
  );

  const child = spawn(
    process.execPath,
    [cli, "validate", "--vault", vault, "--format", "json"],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH },
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  child.kill("SIGINT");
  const exitCode = await new Promise((resolvePromise) =>
    child.once("exit", resolvePromise),
  );
  assert.equal(exitCode, 1);
  assert.equal(stdout, "");
  assert.equal(stderr, "CLI-CANCELLED: Operation cancelled.\n");
  assert.deepEqual(
    (await readdir(vault)).filter((name) => name.startsWith(".bookie-")),
    [],
  );
});
