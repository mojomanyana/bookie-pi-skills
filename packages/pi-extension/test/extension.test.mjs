import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import registerBookie from "../dist/index.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const fixture = resolve(repositoryRoot, "fixtures/valid-vault");
const packageRoot = resolve(repositoryRoot, "packages/pi-extension");

async function temporaryVault(t) {
  const parent = await mkdtemp(join(tmpdir(), "bookie-pi-extension-"));
  const vault = join(parent, "vault");
  await cp(fixture, vault, { recursive: true });
  t.after(() => rm(parent, { recursive: true, force: true }));
  return vault;
}

function registeredTools() {
  const tools = [];
  registerBookie({ registerTool: (tool) => tools.push(tool) });
  return tools;
}

function toolNamed(tools, name) {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `missing ${name}`);
  return tool;
}

function textResult(result) {
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, "text");
  return result.content[0].text;
}

const context = (cwd) => ({ cwd, isProjectTrusted: () => true });

test("extension registers the BK-013 read-only tool contracts", () => {
  const tools = registeredTools();
  assert.deepEqual(
    tools.map(({ name }) => name),
    ["bookie_read", "bookie_search", "bookie_validate"],
  );
  for (const tool of tools) {
    assert.equal(tool.parameters.additionalProperties, false);
    assert.match(tool.description, /untrusted|validation/iu);
    assert.match(tool.description, /50KB|bounded/u);
  }
  assert.deepEqual(
    toolNamed(tools, "bookie_read").parameters.properties.selector.enum,
    ["path", "uid"],
  );
});

test("read, local search, and validation call core with labelled results", async (t) => {
  const vault = await temporaryVault(t);
  const tools = registeredTools();

  const read = await toolNamed(tools, "bookie_read").execute(
    "read-call",
    {
      vault,
      selector: "path",
      value: "/projects/fixture/tasks/task.md",
    },
    undefined,
    undefined,
    context(repositoryRoot),
  );
  const readPayload = JSON.parse(textResult(read));
  assert.equal(readPayload.tool, "bookie_read");
  assert.equal(readPayload.result.ok, true);
  assert.equal(readPayload.result.mode, "filesystem");
  assert.equal(readPayload.result.untrusted, true);
  assert.equal(readPayload.result.source.commit, null);
  assert.equal(read.details.outputTruncated, false);

  const search = await toolNamed(tools, "bookie_search").execute(
    "search-call",
    {
      vault,
      query: "Fixture task",
      type: "Task",
      state: "ready",
    },
    undefined,
    undefined,
    context(repositoryRoot),
  );
  const searchPayload = JSON.parse(textResult(search));
  assert.equal(searchPayload.tool, "bookie_search");
  assert.equal(searchPayload.result.mode, "filesystem");
  assert.equal(searchPayload.result.complete, true);
  assert.equal(searchPayload.result.results.length, 1);
  assert.equal(searchPayload.result.results[0].untrusted, true);
  assert.equal(searchPayload.result.results[0].source.commit, null);

  const validate = await toolNamed(tools, "bookie_validate").execute(
    "validate-call",
    { vault },
    undefined,
    undefined,
    context(repositoryRoot),
  );
  const validatePayload = JSON.parse(textResult(validate));
  assert.equal(validatePayload.tool, "bookie_validate");
  assert.equal(validatePayload.result.valid, true);
  assert.equal(validatePayload.result.complete, true);
  assert.equal(validate.details.outputTruncated, false);
});

test("tool output escapes terminal controls from untrusted concepts", async (t) => {
  const vault = await temporaryVault(t);
  const taskPath = join(vault, "projects/fixture/tasks/task.md");
  const source = await readFile(taskPath, "utf8");
  const match = /^---\n([^\n]+)\n---\n([\s\S]*)$/u.exec(source);
  assert.ok(match);
  const frontmatter = JSON.parse(match[1]);
  frontmatter.title = "Needle\u009b\u0085\u2028\u2029";
  await writeFile(
    taskPath,
    `---\n${JSON.stringify(frontmatter)}\n---\n${match[2]}`,
  );
  const result = await toolNamed(registeredTools(), "bookie_search").execute(
    "controls",
    { vault, query: "Needle" },
    undefined,
    undefined,
    context(repositoryRoot),
  );
  const output = textResult(result);
  for (const control of ["\u009b", "\u0085", "\u2028", "\u2029"]) {
    assert.equal(output.includes(control), false);
    assert.match(
      output,
      new RegExp(
        `\\\\u${control.charCodeAt(0).toString(16).padStart(4, "0")}`,
        "u",
      ),
    );
  }
});

test("excluded reads fail with static redaction", async (t) => {
  const vault = await temporaryVault(t);
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
  const taskPath = join(vault, "projects/fixture/tasks/task.md");
  const source = await readFile(taskPath, "utf8");
  const match = /^---\n([^\n]+)\n---\n([\s\S]*)$/u.exec(source);
  assert.ok(match);
  const frontmatter = JSON.parse(match[1]);
  frontmatter.title = "EXCLUDED-MARKER";
  frontmatter.bookie.sensitivity = "restricted";
  await writeFile(
    taskPath,
    `---\n${JSON.stringify(frontmatter)}\n---\n${match[2]}`,
  );

  const read = toolNamed(registeredTools(), "bookie_read");
  for (const input of [
    { selector: "path", value: "/projects/fixture/tasks/task.md" },
    { selector: "uid", value: "TSK-00000000000000000000000002" },
  ]) {
    await assert.rejects(
      read.execute(
        "excluded",
        { vault, ...input },
        undefined,
        undefined,
        context(repositoryRoot),
      ),
      (error) => {
        assert.equal(
          error?.message,
          "Bookie read rejected by sensitivity policy.",
        );
        assert.equal(error.message.includes("EXCLUDED-MARKER"), false);
        assert.equal(error.message.includes("tasks/task.md"), false);
        assert.equal(error.message.includes("TSK-"), false);
        return true;
      },
    );
  }
});

test("read failures throw and outputs disclose Pi-limit truncation", async (t) => {
  const vault = await temporaryVault(t);
  const read = toolNamed(registeredTools(), "bookie_read");

  await assert.rejects(
    read.execute(
      "missing",
      { vault, selector: "uid", value: "TSK-00000000000000000000000999" },
      undefined,
      undefined,
      context(repositoryRoot),
    ),
    /Bookie read failed: not-found\./u,
  );
  await assert.rejects(
    read.execute(
      "empty-vault",
      { vault: "@", selector: "path", value: "/index.md" },
      undefined,
      undefined,
      context(repositoryRoot),
    ),
    /vault must not be empty/u,
  );
  await assert.rejects(
    toolNamed(registeredTools(), "bookie_validate").execute(
      "missing-vault",
      { vault: join(vault, "missing") },
      undefined,
      undefined,
      context(repositoryRoot),
    ),
    /Bookie validation could not complete safely\./u,
  );

  const taskPath = join(vault, "projects/fixture/tasks/task.md");
  await writeFile(
    taskPath,
    `${await readFile(taskPath, "utf8")}${"\u001b".repeat(80_000)}`,
  );
  const result = await read.execute(
    "bounded",
    { vault, selector: "path", value: "/projects/fixture/tasks/task.md" },
    undefined,
    undefined,
    context(repositoryRoot),
  );
  const output = textResult(result);
  assert.ok(Buffer.byteLength(output, "utf8") <= 50 * 1024);
  assert.match(output, /projects\/fixture\/tasks\/task\.md/u);
  assert.match(output, /# Task/u);
  assert.match(output, /--- untrusted sourceText ---/u);
  assert.equal(output.includes("\u001b"), false);
  assert.match(output, /\\u001b/u);
  assert.match(output, /\[Bookie output truncated:/u);
  assert.equal(result.details.outputTruncated, true);
  assert.equal(result.details.mode, "filesystem");
});

test("local and Git package manifests expose the built extension", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "bookie-pi-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { HOME: home, PATH: process.env.PATH };
  execFileSync("pi", ["install", packageRoot], { env, stdio: "pipe" });
  const settings = JSON.parse(
    await readFile(join(home, ".pi/agent/settings.json"), "utf8"),
  );
  assert.ok(
    settings.packages.some((entry) => {
      const source = typeof entry === "string" ? entry : entry.source;
      return resolve(home, ".pi/agent", source) === packageRoot;
    }),
  );

  const packageManifest = JSON.parse(
    await readFile(join(packageRoot, "package.json"), "utf8"),
  );
  assert.deepEqual(packageManifest.pi.extensions, ["./dist/index.js"]);
  const rootManifest = JSON.parse(
    await readFile(join(repositoryRoot, "package.json"), "utf8"),
  );
  assert.deepEqual(rootManifest.pi.extensions, [
    "./packages/pi-extension/dist/index.js",
  ]);
  assert.equal(
    rootManifest.scripts.prepare,
    "npm run build --workspace @bookie/pi-extension",
  );

  const checkout = join(home, "git-checkout");
  await cp(repositoryRoot, checkout, {
    recursive: true,
    filter: (source) => {
      const name = source.split(/[\\/]/u).at(-1);
      return (
        name !== ".git" &&
        name !== "node_modules" &&
        name !== "dist" &&
        !name.endsWith(".tsbuildinfo")
      );
    },
  });
  execFileSync("npm", ["install", "--omit=dev"], {
    cwd: checkout,
    env,
    stdio: "pipe",
    timeout: 180_000,
  });
  const builtExtension = join(checkout, "packages/pi-extension/dist/index.js");
  await readFile(builtExtension);
  await readFile(join(checkout, "packages/core/dist/index.js"));
  await readFile(
    join(
      checkout,
      "packages/core/dist/schemas/profile/1.0/bookie-config.schema.json",
    ),
  );
  const installed = await import(`${builtExtension}?smoke=${Date.now()}`);
  const installedTools = [];
  installed.default({ registerTool: (tool) => installedTools.push(tool) });
  assert.deepEqual(
    installedTools.map(({ name }) => name),
    ["bookie_read", "bookie_search", "bookie_validate"],
  );
});

test("BK-013 source remains read-only, local, and core-backed", async () => {
  const source = await readFile(join(packageRoot, "src/index.ts"), "utf8");
  for (const required of ["inspectConcept", "searchVault", "validateVault"]) {
    assert.match(source, new RegExp(`\\b${required}\\b`, "u"));
  }
  for (const forbidden of [
    "createConcept",
    "amendConcept",
    "captureEvidence",
    "exportCanonicalJsonl",
    "withFileMutationQueue",
    "fetch(",
    "git commit",
    "git push",
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});

test("an aborted tool call rejects without returning error-looking success", async (t) => {
  const vault = await temporaryVault(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    toolNamed(registeredTools(), "bookie_search").execute(
      "aborted",
      { vault, query: "fixture" },
      controller.signal,
      undefined,
      context(repositoryRoot),
    ),
    (error) => error?.name === "AbortError",
  );
});
