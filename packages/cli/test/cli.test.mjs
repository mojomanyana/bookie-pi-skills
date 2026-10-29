import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { OperationError, runReadOperation } from "../dist/operation-process.js";
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
  for (const entry of await readdir(join(cliPackage, "src"), {
    recursive: true,
  })) {
    if (!entry.endsWith(".ts")) continue;
    const source = await readFile(join(cliPackage, "src", entry), "utf8");
    for (const forbidden of [
      "createConcept",
      "amendConcept",
      "captureEvidence",
      "initializeVault",
      "exportCanonicalJsonl",
      "writeFile",
      "appendFile",
      "node:http",
      "node:https",
      "node:net",
      "fetch(",
      "git commit",
      "git push",
      "exec(",
      "spawn(",
    ]) {
      assert.equal(source.includes(forbidden), false, `${entry}: ${forbidden}`);
    }
    assert.doesNotMatch(
      source,
      /\b(?:rename|unlink|mkdir|rm|spawn|exec)\s*\(/u,
      entry,
    );
    if (entry !== "operation-process.ts") {
      assert.equal(source.includes("node:fs"), false, entry);
      assert.equal(source.includes("child_process"), false, entry);
    } else {
      assert.match(
        source,
        /import \{ opendir, readFile \} from "node:fs\/promises"/u,
      );
      assert.match(
        source,
        /fork\(new URL\("\.\/operation-worker\.js", import\.meta\.url\)/u,
      );
      assert.match(
        source,
        /execFile\(\s*"taskkill",\s*\["\/PID", String\(child.pid\), "\/T", "\/F"\]/u,
      );
    }
  }
});

test("clean package artifacts install and expose the bookie binary", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "bookie-cli-pack-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const source = join(parent, "source");
  await mkdir(join(source, "packages"), { recursive: true });
  for (const [name, packageRoot] of [
    ["core", corePackage],
    ["cli", cliPackage],
  ]) {
    await cp(packageRoot, join(source, "packages", name), {
      recursive: true,
      filter: (path) =>
        !["dist", "tsconfig.tsbuildinfo"].includes(path.split(/[\\/]/u).at(-1)),
    });
  }
  await cp(join(repositoryRoot, "schemas"), join(source, "schemas"), {
    recursive: true,
  });
  await symlink(
    join(repositoryRoot, "node_modules"),
    join(source, "node_modules"),
    "dir",
  );
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
  const core = pack(join(source, "packages/core"));
  assert.ok(core.files.some(({ path }) => path === "dist/index.js"));
  assert.ok(
    core.files.some(
      ({ path }) =>
        path === "dist/schemas/profile/1.0/bookie-config.schema.json",
    ),
  );
  const cliArtifact = pack(join(source, "packages/cli"));
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

function isRunning(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return !["Z", "X"].includes(
      stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0],
    );
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes(error.code)) return false;
    throw error;
  }
}

async function parserFixture(t) {
  const fixture = await temporaryVault(t);
  const path = join(fixture.vault, "projects/fixture/tasks/task.md");
  await writeFile(
    path,
    `${await readFile(path, "utf8")}\nBOOKIE-PARSER-CONTROL\n`,
  );
  // The marker must be parsed YAML, not merely a body passed around by core.
  await writeFile(
    path,
    (await readFile(path, "utf8")).replace(
      "Fixture task",
      "BOOKIE-PARSER-CONTROL",
    ),
  );
  const marker = join(fixture.parent, "parser-started.json");
  return {
    ...fixture,
    marker,
    env: {
      PATH: process.env.PATH,
      NODE_OPTIONS: `--import=${join(cliPackage, "test/fixtures/parser-control.mjs")}`,
      BOOKIE_TEST_CORE: corePackage,
      BOOKIE_TEST_MARKER: marker,
    },
  };
}

const commandArgs = (command, vault) =>
  command === "validate"
    ? ["validate", "--vault", vault, "--format", "json"]
    : command === "search"
      ? ["search", "--vault", vault, "Fixture", "--format", "json"]
      : [
          "inspect",
          "--vault",
          vault,
          "--path",
          "/projects/fixture/tasks/task.md",
          "--format",
          "json",
        ];

test("synchronous parser stalls terminate under deadline, SIGINT and SIGTERM with owned Git teardown", async (t) => {
  for (const command of ["validate", "search", "inspect"]) {
    for (const stop of ["deadline", "SIGINT", "SIGTERM"]) {
      await t.test(`${command}: ${stop}`, async (t) => {
        const { vault, marker, env } = await parserFixture(t);
        const child = spawn(
          process.execPath,
          [
            cli,
            ...commandArgs(command, vault),
            ...(stop === "deadline" ? ["--timeout-ms", "3000"] : []),
          ],
          { detached: true, stdio: ["ignore", "pipe", "pipe"], env },
        );
        let stdout = "";
        let stderr = "";
        let owned;
        let liveAtExit;
        child.stdout.setEncoding("utf8").on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr.setEncoding("utf8").on("data", (chunk) => {
          stderr += chunk;
        });
        const closed = new Promise((resolve) => {
          child.once("exit", () => {
            if (owned) liveAtExit = Object.values(owned).map(isRunning);
          });
          child.once("close", (code) => resolve(code));
        });
        let watchdog;
        try {
          const until = Date.now() + 5000;
          while (
            owned === undefined &&
            child.exitCode === null &&
            Date.now() < until
          ) {
            try {
              owned = JSON.parse(await readFile(marker, "utf8"));
            } catch (error) {
              if (error.code !== "ENOENT") throw error;
            }
            if (!owned) await new Promise((resolve) => setTimeout(resolve, 10));
          }
          assert.ok(owned, `parser never started: ${stderr}`);
          assert.ok(
            Object.values(owned).every(isRunning),
            "current parser and both descendants acknowledged startup",
          );
          if (stop !== "deadline") child.kill(stop);
          const result = await Promise.race([
            closed,
            new Promise((resolve) => {
              watchdog = setTimeout(() => resolve("hung"), 5000);
            }),
          ]);
          assert.equal(
            result,
            1,
            "CLI signal/deadline owner must remain responsive",
          );
          assert.equal(stdout, "");
          assert.equal(
            stderr,
            stop === "deadline"
              ? "CLI-OPERATION: Operation could not complete safely.\n"
              : "CLI-CANCELLED: Operation cancelled.\n",
          );
          assert.deepEqual(
            liveAtExit,
            [false, false, false],
            "no parser/descendant/Git running at CLI settlement",
          );
        } finally {
          clearTimeout(watchdog);
          for (const group of new Set(
            [owned?.parser, child.pid].filter(Boolean),
          )) {
            try {
              process.kill(-group, "SIGKILL");
            } catch (error) {
              assert.equal(error.code, "ESRCH");
            }
          }
          await closed;
        }
      });
    }
  }
});

async function stopTestGroups(groups) {
  for (const group of new Set(groups.filter(Boolean))) {
    try {
      process.kill(-group, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
}

test(
  "terminal teardown uncertainty exits without claiming descendants stopped",
  { skip: process.platform !== "linux" },
  async (t) => {
    for (const fault of ["kill-denied", "no-close"]) {
      await t.test(fault, async (t) => {
        const { vault, marker, env } = await parserFixture(t);
        const child = spawn(
          process.execPath,
          [cli, ...commandArgs("validate", vault), "--timeout-ms", "7000"],
          {
            detached: true,
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...env, BOOKIE_TEST_FAULT: fault },
          },
        );
        let stdout = "";
        let stderr = "";
        let owned;
        let liveAtExit;
        child.stdout.setEncoding("utf8").on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr.setEncoding("utf8").on("data", (chunk) => {
          stderr += chunk;
        });
        const closed = new Promise((resolve) => {
          child.once("exit", () => {
            if (owned) liveAtExit = Object.values(owned).map(isRunning);
          });
          child.once("close", (code) => resolve(code));
        });
        let watchdog;
        try {
          const until = Date.now() + 5000;
          while (!owned && child.exitCode === null && Date.now() < until) {
            try {
              owned = JSON.parse(await readFile(marker, "utf8"));
            } catch (error) {
              if (error.code !== "ENOENT") throw error;
            }
            if (!owned) await new Promise((resolve) => setTimeout(resolve, 10));
          }
          assert.ok(owned, "current blocked parser must start");
          assert.ok(Object.values(owned).every(isRunning));
          child.kill("SIGINT");
          const result = await Promise.race([
            closed,
            new Promise((resolve) => {
              watchdog = setTimeout(() => resolve("hung"), 2500);
            }),
          ]);
          assert.equal(
            result,
            1,
            "terminal failure must release parent IPC/process references",
          );
          assert.equal(stdout, "");
          assert.equal(
            stderr,
            "CLI-OPERATION: Operation could not complete safely.\n",
          );
          assert.deepEqual(
            liveAtExit,
            fault === "kill-denied"
              ? [true, true, true]
              : [false, false, false],
          );
        } finally {
          clearTimeout(watchdog);
          try {
            await stopTestGroups([owned?.parser, child.pid]);
          } finally {
            await closed;
          }
          if (owned) {
            for (
              let n = 0;
              n < 100 && Object.values(owned).some(isRunning);
              n++
            )
              await new Promise((resolve) => setTimeout(resolve, 10));
            assert.ok(
              Object.values(owned).every((pid) => !isRunning(pid)),
              "test-owned survivors must be stopped",
            );
          }
        }
      });
    }
  },
);

test("malformed worker replies fail before any command output", async (t) => {
  const { vault } = await temporaryVault(t);
  const commands = ["validate", "search", "inspect"];
  const controls = {};
  for (const command of commands) {
    const result = run(commandArgs(command, vault));
    assert.equal(result.status, 0, result.stderr);
    controls[command] = jsonOutput(result);
    delete controls[command].command;
  }
  for (const [index, command] of commands.entries()) {
    const other = commands[(index + 1) % commands.length];
    const envelope = (result) => ({ kind: "result", command, result });
    const env = {
      PATH: process.env.PATH,
      NODE_OPTIONS: `--import=${join(cliPackage, "test/fixtures/parser-control.mjs")}`,
      BOOKIE_TEST_CORE: corePackage,
      BOOKIE_TEST_FAULT: "protocol",
    };
    for (const [label, reply] of [
      ["null", null],
      ["envelope", {}],
      ["empty", envelope({})],
      ["array", envelope([])],
      ["wrong-command-result", envelope(controls[other])],
      ["wrong-command-tag", { ...envelope(controls[command]), command: other }],
      ["diagnostic", envelope({ ...controls[command], diagnostics: [null] })],
    ]) {
      await t.test(`${command}: ${label}`, () => {
        const result = run(commandArgs(command, vault), {
          env: { ...env, BOOKIE_TEST_REPLY: JSON.stringify(reply) },
          timeout: 5000,
        });
        assert.equal(result.status, 1);
        assert.equal(result.stdout, "");
        assert.equal(
          result.stderr,
          "CLI-OPERATION: Operation could not complete safely.\n",
        );
      });
    }
    const valid = run(commandArgs(command, vault), {
      env: {
        ...env,
        BOOKIE_TEST_REPLY: JSON.stringify(envelope(controls[command])),
      },
      timeout: 5000,
    });
    assert.equal(valid.status, 0, valid.stderr);
    assert.deepEqual(jsonOutput(valid), { command, ...controls[command] });
  }
});

test(
  "late close cannot revise terminal teardown failure",
  { skip: process.platform !== "linux" },
  async (t) => {
    const { vault } = await temporaryVault(t);
    const cpModule = createRequire(import.meta.url)("node:child_process");
    const original = cpModule.fork;
    let lateClose;
    let childPid;
    const mock = t.mock.method(cpModule, "fork", (...args) => {
      const child = Reflect.apply(original, cpModule, args);
      childPid = child.pid;
      const emit = child.emit;
      child.emit = function (event, ...values) {
        if (event === "close") {
          lateClose = () => Reflect.apply(emit, this, [event, ...values]);
          return true;
        }
        return Reflect.apply(emit, this, [event, ...values]);
      };
      return child;
    });
    syncBuiltinESMExports();
    try {
      const pending = runReadOperation(
        { command: "validate", vault },
        { timeoutMs: 2000, signal: new AbortController().signal },
      );
      await assert.rejects(pending, OperationError);
      assert.equal(typeof lateClose, "function");
      assert.equal(isRunning(childPid), false);
      lateClose();
      await assert.rejects(pending, OperationError);
    } finally {
      mock.mock.restore();
      syncBuiltinESMExports();
    }
  },
);

test("timeout grammar and endpoint values are checked before worker work", async (t) => {
  const { vault, env } = await parserFixture(t);
  for (const command of ["validate", "search", "inspect"]) {
    for (const suffix of [
      ["--timeout-ms"],
      ...["0", "21600001", "-1", "1.5", "1e3", "+2", "x"].map((value) => [
        "--timeout-ms",
        value,
      ]),
      ["--timeout-ms", "1", "--timeout-ms", "2"],
    ]) {
      const result = run([...commandArgs(command, vault), ...suffix], { env });
      assert.equal(result.status, 2, `${command}: ${suffix}`);
      assert.equal(result.stdout, "");
      assert.equal(
        result.stderr,
        "CLI-INVOCATION: Invalid command invocation.\n",
      );
    }
    const timeout = run([...commandArgs(command, vault), "--timeout-ms", "1"]);
    assert.equal(timeout.status, 1);
    assert.equal(timeout.stdout, "");
    assert.equal(
      timeout.stderr,
      "CLI-OPERATION: Operation could not complete safely.\n",
    );
    const normal = run([
      ...commandArgs(command, fixture),
      "--timeout-ms",
      "21600000",
    ]);
    assert.equal(normal.status, 0, normal.stderr);
  }
});

test("worker start failure and parser crash never emit partial or false success", async (t) => {
  const { vault, marker, env } = await parserFixture(t);
  for (const command of ["validate", "search", "inspect"]) {
    for (const fault of ["start", "crash"]) {
      await rm(marker, { force: true });
      await rm(`${marker}.descendant`, { force: true });
      const result = run(commandArgs(command, vault), {
        env: { ...env, BOOKIE_TEST_FAULT: fault },
        timeout: 5000,
      });
      assert.equal(result.status, 1, `${command}: ${fault}: ${result.stderr}`);
      assert.equal(result.stdout, "");
      assert.equal(
        result.stderr,
        "CLI-OPERATION: Operation could not complete safely.\n",
      );
      if (fault === "crash") {
        const owned = JSON.parse(await readFile(marker, "utf8"));
        assert.deepEqual(Object.values(owned).map(isRunning), [
          false,
          false,
          false,
        ]);
      } else await assert.rejects(readFile(marker), { code: "ENOENT" });
    }
  }
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
