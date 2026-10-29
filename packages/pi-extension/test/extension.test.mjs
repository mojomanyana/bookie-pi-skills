import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
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

function registeredExtension() {
  const tools = [];
  const handlers = new Map();
  registerBookie({
    registerTool: (tool) => tools.push(tool),
    on: (event, handler) => {
      const values = handlers.get(event) ?? [];
      values.push(handler);
      handlers.set(event, values);
    },
  });
  return { tools, handlers };
}

function registeredTools() {
  return registeredExtension().tools;
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

const context = (cwd, overrides = {}) => ({
  cwd,
  mode: "print",
  hasUI: false,
  isProjectTrusted: () => true,
  ui: { confirm: async () => false, notify: () => {} },
  ...overrides,
});

const checkpointSections = [
  "outcome",
  "changed-artifacts",
  "decisions",
  "evidence",
  "validation",
  "unresolved-work",
  "next-action",
];

function checkpointRequest(path = "projects/fixture/activities/session.md") {
  return {
    path,
    frontmatter: {
      type: "Activity",
      title: "Session checkpoint",
      status: "stable",
      generated: { by: "human:test", at: "2026-09-14T13:00:00Z" },
      bookie: {
        profile: "1.0",
        uid: "ACT-00000000000000000000000160",
        project: "/projects/fixture/project.md",
        occurred_at: "2026-09-14T13:00:00Z",
        sensitivity: "public",
      },
    },
    fragments: checkpointSections.map((section) => ({
      section,
      sensitivity: "public",
      text: `Included ${section}.`,
    })),
  };
}

test("extension registers the BK-013 read-only tool contracts", () => {
  const tools = registeredTools();
  assert.deepEqual(
    tools.map(({ name }) => name),
    [
      "bookie_read",
      "bookie_search",
      "bookie_validate",
      "bookie_write",
      "bookie_checkpoint",
    ],
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
  assert.deepEqual(
    toolNamed(tools, "bookie_write").parameters.properties.action.enum,
    ["create", "amend"],
  );
  assert.deepEqual(
    toolNamed(tools, "bookie_checkpoint").parameters.properties.timing.enum,
    ["now", "before-compaction"],
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

test("real host loader shares create, amend and checkpoint queues through both package entries", async (t) => {
  // A separate physical host of the supported Pi line, not Bookie's import or a fake queue.
  const parent = await mkdtemp(join(tmpdir(), "bookie-pi-host-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const hostRoot = join(parent, "host");
  await cp(
    join(repositoryRoot, "node_modules/@earendil-works/pi-coding-agent"),
    hostRoot,
    {
      recursive: true,
      filter: (path) => path.split(/[\\/]/u).at(-1) !== "node_modules",
    },
  );
  await symlink(
    join(repositoryRoot, "node_modules"),
    join(hostRoot, "node_modules"),
    "dir",
  );
  const host = await import(join(hostRoot, "dist/index.js"));
  const { discoverAndLoadExtensions } = await import(
    join(hostRoot, "dist/core/extensions/loader.js")
  );
  for (const entry of [repositoryRoot, packageRoot]) {
    for (const action of ["create", "amend", "checkpoint"]) {
      await t.test(
        `${entry === repositoryRoot ? "root-Git" : "local-subpackage"}: ${action}`,
        async (t) => {
          const vault = await temporaryVault(t);
          const loaded = await discoverAndLoadExtensions(
            [entry],
            vault,
            join(parent, "agent"),
          );
          assert.deepEqual(loaded.errors, []);
          const tools = [...loaded.extensions[0].tools.values()].map(
            ({ definition }) => definition,
          );
          const request =
            action === "checkpoint"
              ? checkpointRequest()
              : action === "create"
                ? {
                    path: "people/queued.md",
                    frontmatter: {
                      type: "Person",
                      title: "Queued",
                      status: "draft",
                      generated: {
                        by: "human:test",
                        at: "2026-09-14T13:00:00Z",
                      },
                      bookie: {
                        profile: "1.0",
                        uid: "PER-00000000000000000000000180",
                        created_at: "2026-09-14T13:00:00Z",
                        sensitivity: "public",
                      },
                    },
                    bodyText: "# Queued\n",
                  }
                : {
                    path: "projects/fixture/tasks/task.md",
                    expectedSourceHash: `sha256:${(await import("node:crypto"))
                      .createHash("sha256")
                      .update(
                        await readFile(
                          join(vault, "projects/fixture/tasks/task.md"),
                        ),
                      )
                      .digest("hex")}`,
                    edits: [],
                    bodyText: "# Bookie amendment\n",
                  };
          const target = join(vault, request.path);
          const original =
            action === "amend" ? await readFile(target, "utf8") : undefined;
          const requestPath = join(resolve(vault, ".."), "queued.json");
          await writeFile(requestPath, JSON.stringify(request));
          const entered = Promise.withResolvers();
          const release = Promise.withResolvers();
          const started = Promise.withResolvers();
          const blocker = host.withFileMutationQueue(target, async () => {
            entered.resolve();
            await release.promise;
            if (action === "amend")
              await writeFile(target, `${original}\nHost update\n`);
          });
          await entered.promise;
          let settled = false;
          const pending = toolNamed(
            tools,
            action === "checkpoint" ? "bookie_checkpoint" : "bookie_write",
          )
            .execute(
              "host-queued",
              {
                vault,
                requestPath,
                approval: "confirm",
                ...(action === "checkpoint" ? { timing: "now" } : { action }),
              },
              undefined,
              undefined,
              context(vault, {
                hasUI: true,
                mode: "tui",
                ui: {
                  confirm: async () => {
                    started.resolve();
                    return true;
                  },
                },
              }),
            )
            .then(
              (value) => ({ value }),
              (error) => ({ error }),
            )
            .finally(() => {
              settled = true;
            });
          try {
            assert.equal(
              await Promise.race([
                started.promise.then(() => true),
                pending.then(() => false),
              ]),
              true,
              "approval must start before the operation settles",
            );
            await new Promise((resolve) => setTimeout(resolve, 150));
            assert.equal(
              settled,
              false,
              "Bookie settled while the actual host queue was held",
            );
            if (original === undefined)
              await assert.rejects(readFile(target), { code: "ENOENT" });
            else assert.equal(await readFile(target, "utf8"), original);
          } finally {
            release.resolve();
            await blocker;
          }
          const result = await pending;
          if (action === "amend") {
            assert.match(result.error?.message ?? "", /MUTATION-CONFLICT/u);
            assert.equal(
              await readFile(target, "utf8"),
              `${original}\nHost update\n`,
            );
          } else {
            assert.equal(result.error, undefined);
            assert.match(
              await readFile(target, "utf8"),
              action === "checkpoint" ? /Included outcome/u : /# Queued/u,
            );
          }
        },
      );
    }
  }
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
  assert.deepEqual(packageManifest.pi.extensions, ["./src/index.ts"]);
  const rootManifest = JSON.parse(
    await readFile(join(repositoryRoot, "package.json"), "utf8"),
  );
  assert.deepEqual(rootManifest.pi.extensions, [
    "./packages/pi-extension/src/index.ts",
  ]);
  assert.equal(
    rootManifest.scripts.prepare,
    "npm run build --workspace @bookie/core",
  );

  const checkout = join(home, "git-checkout");
  await cp(repositoryRoot, checkout, {
    recursive: true,
    filter: (source) => {
      const name = source.split(/[\\/]/u).at(-1);
      return (
        name !== ".git" &&
        name !== ".principal" &&
        name !== "node_modules" &&
        name !== "dist" &&
        !name.endsWith(".tsbuildinfo")
      );
    },
  });
  execFileSync("npm", ["install", "--omit=dev", "--legacy-peer-deps"], {
    cwd: checkout,
    env,
    stdio: "pipe",
    timeout: 180_000,
  });
  const builtExtension = join(checkout, "packages/pi-extension/src/index.ts");
  await readFile(builtExtension);
  await readFile(join(checkout, "packages/core/dist/index.js"));
  await readFile(
    join(
      checkout,
      "packages/core/dist/schemas/profile/1.0/bookie-config.schema.json",
    ),
  );
  const { discoverAndLoadExtensions } = await import(
    join(
      repositoryRoot,
      "node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js",
    )
  );
  const loaded = await discoverAndLoadExtensions(
    [checkout],
    home,
    join(home, "agent"),
  );
  assert.deepEqual(loaded.errors, []);
  const installedTools = [...loaded.extensions[0].tools.values()].map(
    ({ definition }) => definition,
  );
  // Also exercise a clean relocated local subpackage with production core dependencies only.
  const local = await discoverAndLoadExtensions(
    [join(checkout, "packages/pi-extension")],
    home,
    join(home, "agent"),
  );
  assert.deepEqual(local.errors, []);
  assert.equal(local.extensions[0].tools.size, 5);
  assert.deepEqual(
    installedTools.map(({ name }) => name),
    [
      "bookie_read",
      "bookie_search",
      "bookie_validate",
      "bookie_write",
      "bookie_checkpoint",
    ],
  );
});

test("write requires explicit approval and uses policy-bearing create", async (t) => {
  const vault = await temporaryVault(t);
  const parent = resolve(vault, "..");
  const requestPath = join(parent, "create.json");
  const target = join(vault, "people/new-person.md");
  const request = {
    path: "people/new-person.md",
    frontmatter: {
      type: "Person",
      title: "New person",
      status: "draft",
      generated: { by: "human:test", at: "2026-09-13T16:00:00Z" },
      bookie: {
        profile: "1.0",
        uid: "PER-00000000000000000000000100",
        created_at: "2026-09-13T16:00:00Z",
        sensitivity: "public",
      },
    },
    bodyText: "# New person\n",
  };
  await writeFile(requestPath, JSON.stringify(request));
  const write = toolNamed(registeredTools(), "bookie_write");

  await assert.rejects(
    write.execute(
      "ambiguous",
      { vault, action: "create", requestPath, approval: "confirm" },
      undefined,
      undefined,
      context(repositoryRoot),
    ),
    /requires explicit approval in non-interactive mode/u,
  );
  await assert.rejects(readFile(target), { code: "ENOENT" });

  await assert.rejects(
    write.execute(
      "declined",
      { vault, action: "create", requestPath, approval: "confirm" },
      undefined,
      undefined,
      context(repositoryRoot, {
        mode: "tui",
        hasUI: true,
        ui: { confirm: async () => false },
      }),
    ),
    /was not approved/u,
  );
  await assert.rejects(readFile(target), { code: "ENOENT" });

  const controller = new AbortController();
  let confirmationStarted;
  const started = new Promise((resolve) => {
    confirmationStarted = resolve;
  });
  const abortedConfirmation = write.execute(
    "aborted-confirmation",
    { vault, action: "create", requestPath, approval: "confirm" },
    controller.signal,
    undefined,
    context(repositoryRoot, {
      mode: "tui",
      hasUI: true,
      ui: {
        confirm: async (_title, _message, options) => {
          confirmationStarted();
          return new Promise((_resolve, reject) => {
            options.signal.addEventListener(
              "abort",
              () => reject(options.signal.reason),
              { once: true },
            );
          });
        },
      },
    }),
  );
  await started;
  controller.abort();
  await assert.rejects(
    abortedConfirmation,
    (error) => error?.name === "AbortError",
  );
  await assert.rejects(readFile(target), { code: "ENOENT" });

  const substituted = {
    ...request,
    path: "people/substituted.md",
    frontmatter: {
      ...request.frontmatter,
      title: "Substituted",
      bookie: {
        ...request.frontmatter.bookie,
        uid: "PER-00000000000000000000000109",
      },
    },
  };
  let releaseQueue;
  let queueEntered;
  const entered = new Promise((resolve) => {
    queueEntered = resolve;
  });
  const gate = new Promise((resolve) => {
    releaseQueue = resolve;
  });
  const blocker = withFileMutationQueue(target, async () => {
    queueEntered();
    await gate;
  });
  await entered;
  let settled = false;
  const pending = write
    .execute(
      "approved",
      { vault, action: "create", requestPath, approval: "confirm" },
      undefined,
      undefined,
      context(repositoryRoot, {
        mode: "tui",
        hasUI: true,
        ui: {
          confirm: async (title, message) => {
            assert.equal(title, "Approve Bookie create?");
            assert.match(message, /sha256:[0-9a-f]{64}/u);
            await writeFile(requestPath, JSON.stringify(substituted));
            return true;
          },
        },
      }),
    )
    .finally(() => {
      settled = true;
    });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(settled, false);
  await assert.rejects(readFile(target), { code: "ENOENT" });
  releaseQueue();
  await blocker;
  const result = await pending;
  const payload = JSON.parse(textResult(result));
  assert.equal(payload.result.ok, true);
  assert.equal(payload.result.operation, "create");
  assert.match(
    await readFile(target, "utf8"),
    /PER-00000000000000000000000100/u,
  );
  await assert.rejects(readFile(join(vault, "people/substituted.md")), {
    code: "ENOENT",
  });
});

test("parallel amendments serialize and report a stale conflict", async (t) => {
  const vault = await temporaryVault(t);
  const tools = registeredTools();
  const read = await toolNamed(tools, "bookie_read").execute(
    "source",
    { vault, selector: "path", value: "/projects/fixture/tasks/task.md" },
    undefined,
    undefined,
    context(repositoryRoot),
  );
  const sourceHash = JSON.parse(textResult(read)).result.source.sourceHash;
  const parent = resolve(vault, "..");
  const requests = ["first", "second"].map((name) => ({
    path: join(parent, `${name}.json`),
    request: {
      path: "projects/fixture/tasks/task.md",
      expectedSourceHash: sourceHash,
      edits: [],
      bodyText: `# ${name}\n`,
    },
  }));
  await Promise.all(
    requests.map(({ path, request }) =>
      writeFile(path, JSON.stringify(request)),
    ),
  );
  const write = toolNamed(tools, "bookie_write");
  const settled = await Promise.allSettled(
    requests.map(({ path }) =>
      write.execute(
        "parallel",
        { vault, action: "amend", requestPath: path, approval: "explicit" },
        undefined,
        undefined,
        context(repositoryRoot),
      ),
    ),
  );
  assert.equal(
    settled.filter(({ status }) => status === "fulfilled").length,
    1,
  );
  const rejected = settled.find(({ status }) => status === "rejected");
  assert.equal(rejected.status, "rejected");
  assert.match(rejected.reason.message, /MUTATION-CONFLICT/u);
  assert.match(
    await readFile(join(vault, "projects/fixture/tasks/task.md"), "utf8"),
    /^# (first|second)$/mu,
  );
});

test("write rejects malformed and secret request files without publication", async (t) => {
  const vault = await temporaryVault(t);
  const parent = resolve(vault, "..");
  const write = toolNamed(registeredTools(), "bookie_write");
  const malformed = join(parent, "malformed.json");
  await writeFile(malformed, "not json");
  await assert.rejects(
    write.execute(
      "malformed",
      { vault, action: "create", requestPath: malformed, approval: "explicit" },
      undefined,
      undefined,
      context(repositoryRoot),
    ),
    /Bookie write request file is invalid/u,
  );

  const exact = join(parent, "exact-limit.json");
  await writeFile(exact, `{${" ".repeat(1_999_998)}}`);
  await assert.rejects(
    write.execute(
      "exact-limit",
      { vault, action: "create", requestPath: exact, approval: "explicit" },
      undefined,
      undefined,
      context(repositoryRoot),
    ),
    /Bookie write failed: MUTATION-PATH\./u,
  );
  const over = join(parent, "over-limit.json");
  await writeFile(over, `{${" ".repeat(1_999_999)}}`);
  await assert.rejects(
    write.execute(
      "over-limit",
      { vault, action: "create", requestPath: over, approval: "explicit" },
      undefined,
      undefined,
      context(repositoryRoot),
    ),
    /Bookie write request file is invalid\./u,
  );

  const secret = join(parent, "secret.json");
  await writeFile(
    secret,
    JSON.stringify({
      path: "people/rejected.md",
      frontmatter: {
        type: "Person",
        title: "Rejected",
        status: "draft",
        generated: { by: "human:test", at: "2026-09-13T16:00:00Z" },
        bookie: {
          profile: "1.0",
          uid: "PER-00000000000000000000000101",
          created_at: "2026-09-13T16:00:00Z",
          sensitivity: "public",
        },
      },
      bodyText: "password=do-not-persist-this-value",
    }),
  );
  await assert.rejects(
    write.execute(
      "secret",
      { vault, action: "create", requestPath: secret, approval: "explicit" },
      undefined,
      undefined,
      context(repositoryRoot),
    ),
    (error) => {
      assert.equal(error.message, "Bookie write failed: WRITE-SECRET.");
      assert.equal(error.message.includes("do-not-persist"), false);
      return true;
    },
  );
  await assert.rejects(readFile(join(vault, "people/rejected.md")), {
    code: "ENOENT",
  });
});

test("request FIFOs and substitutions fail promptly and release checkpoint reservations", async (t) => {
  for (const surface of ["write", "now", "before-compaction"]) {
    for (const substitute of [false, true]) {
      for (const abort of [false, true]) {
        await t.test(
          `${surface}: ${substitute ? "regular-to-FIFO" : "FIFO"}, abort=${abort}`,
          async (t) => {
            const vault = await temporaryVault(t);
            const requestPath = join(resolve(vault, ".."), "unsafe.json");
            const request = checkpointRequest();
            if (substitute)
              await writeFile(requestPath, JSON.stringify(request));
            else execFileSync("mkfifo", [requestPath]);
            const extension = registeredExtension();
            const tool = toolNamed(
              extension.tools,
              surface === "write" ? "bookie_write" : "bookie_checkpoint",
            );
            const opening = Promise.withResolvers();
            const controller = new AbortController();
            const originalOpen = fsPromises.open;
            t.mock.method(fsPromises, "open", async (path, ...args) => {
              if (path === requestPath) {
                if (substitute) {
                  await rm(requestPath);
                  execFileSync("mkfifo", [requestPath]);
                }
                opening.resolve();
              }
              return originalOpen(path, ...args);
            });
            syncBuiltinESMExports();
            const params =
              surface === "write"
                ? { vault, requestPath, action: "create", approval: "explicit" }
                : {
                    vault,
                    requestPath,
                    timing: surface,
                    ...(surface === "now" ? { approval: "explicit" } : {}),
                  };
            const pending = tool
              .execute(
                "fifo",
                params,
                controller.signal,
                undefined,
                context(vault),
              )
              .then(
                (value) => ({ value }),
                (error) => ({ error }),
              );
            let timer;
            try {
              await opening.promise;
              if (abort) controller.abort(new Error("PRIVATE-ABORT-REASON"));
              const result = await Promise.race([
                pending,
                new Promise((resolve) => {
                  timer = setTimeout(() => resolve({ timedOut: true }), 500);
                }),
              ]);
              assert.equal(
                result.timedOut,
                undefined,
                "request open must settle without a FIFO writer",
              );
              assert.equal(result.value, undefined);
              assert.equal(result.error.name, abort ? "AbortError" : "Error");
              if (!abort)
                assert.equal(
                  result.error.message,
                  "Bookie write request file is invalid.",
                );
              assert.equal(result.error.message.includes("PRIVATE"), false);
              await assert.rejects(readFile(join(vault, request.path)), {
                code: "ENOENT",
              });
            } finally {
              clearTimeout(timer);
              // Unblock the old blocking-open implementation on regression, without hiding the failure.
              const rescue = await originalOpen(
                requestPath,
                constants.O_RDWR | constants.O_NONBLOCK,
              );
              await rescue.close();
              await pending;
              t.mock.restoreAll();
              syncBuiltinESMExports();
            }
            const valid = join(resolve(vault, ".."), "valid-checkpoint.json");
            await writeFile(valid, JSON.stringify(request));
            const result = await toolNamed(
              extension.tools,
              "bookie_checkpoint",
            ).execute(
              "after-fifo",
              {
                vault,
                requestPath: valid,
                timing: "now",
                approval: "explicit",
              },
              undefined,
              undefined,
              context(vault),
            );
            assert.equal(
              JSON.parse(textResult(result)).result.status,
              "created",
            );
            assert.match(
              await readFile(join(vault, request.path), "utf8"),
              /Included outcome/u,
            );
          },
        );
      }
    }
  }
});

test("request final-stat, close and approval cancellation keep static aborts", async (t) => {
  for (const point of ["stat", "close", "approval-return", "approval-reject"]) {
    for (const action of ["write", "checkpoint-now", "checkpoint-staged"]) {
      if (point.startsWith("approval") && action === "checkpoint-staged")
        continue;
      await t.test(`${point}: ${action}`, async (t) => {
        const vault = await temporaryVault(t);
        const request =
          action === "write"
            ? {
                path: "people/cancelled.md",
                frontmatter: {
                  type: "Person",
                  title: "Cancelled",
                  status: "draft",
                  generated: { by: "human:test", at: "2026-09-14T13:00:00Z" },
                  bookie: {
                    profile: "1.0",
                    uid: "PER-00000000000000000000000190",
                    created_at: "2026-09-14T13:00:00Z",
                    sensitivity: "public",
                  },
                },
                bodyText: "# No publication\n",
              }
            : checkpointRequest();
        const requestPath = join(resolve(vault, ".."), "finalize-request.json");
        await writeFile(requestPath, JSON.stringify(request));
        const controller = new AbortController();
        const extension = registeredExtension();
        let approvals = 0;
        const originalOpen = fsPromises.open;
        const mock = t.mock.method(
          fsPromises,
          "open",
          async (path, ...args) => {
            const handle = await originalOpen(path, ...args);
            if (path === requestPath) {
              if (point === "stat") {
                let calls = 0;
                const stat = handle.stat.bind(handle);
                handle.stat = async (...args) => {
                  const result = await stat(...args);
                  if (++calls === 2)
                    controller.abort(new Error("PRIVATE-ABORT-REASON"));
                  return result;
                };
              } else if (point === "close") {
                const close = handle.close.bind(handle);
                handle.close = async () => {
                  await close();
                  controller.abort(new Error("PRIVATE-ABORT-REASON"));
                };
              }
            }
            return handle;
          },
        );
        syncBuiltinESMExports();
        try {
          const tool = toolNamed(
            extension.tools,
            action === "write" ? "bookie_write" : "bookie_checkpoint",
          );
          await assert.rejects(
            tool.execute(
              "finalize-cancel",
              {
                vault,
                requestPath,
                ...(action === "checkpoint-staged"
                  ? {}
                  : { approval: "confirm" }),
                ...(action === "write"
                  ? { action: "create" }
                  : {
                      timing:
                        action === "checkpoint-now"
                          ? "now"
                          : "before-compaction",
                    }),
              },
              controller.signal,
              undefined,
              context(vault, {
                hasUI: true,
                mode: "tui",
                ui: {
                  confirm: async () => {
                    approvals++;
                    if (point.startsWith("approval")) {
                      controller.abort(new Error("PRIVATE-ABORT-REASON"));
                      if (point === "approval-reject")
                        throw controller.signal.reason;
                    }
                    return true;
                  },
                },
              }),
            ),
            { name: "AbortError", message: "Bookie request was aborted." },
          );
          assert.equal(
            approvals,
            point.startsWith("approval") ? 1 : 0,
            "aborted finalization must never reach approval",
          );
          await assert.rejects(readFile(join(vault, request.path)), {
            code: "ENOENT",
          });
        } finally {
          mock.mock.restore();
          syncBuiltinESMExports();
        }
        const validPath = join(
          resolve(vault, ".."),
          "checkpoint-after-cancellation.json",
        );
        await writeFile(validPath, JSON.stringify(checkpointRequest()));
        const result = await toolNamed(
          extension.tools,
          "bookie_checkpoint",
        ).execute(
          "slot-after-cancel",
          {
            vault,
            requestPath: validPath,
            timing: "before-compaction",
          },
          undefined,
          undefined,
          context(vault),
        );
        assert.equal(JSON.parse(textResult(result)).result.status, "staged");
        await extension.handlers.get("session_shutdown")[0]({}, context(vault));
      });
    }
  }
});

test("request reader enforces descriptor and fatal UTF-8 controls for checkpoints", async (t) => {
  const vault = await temporaryVault(t);
  const parent = resolve(vault, "..");
  const request = checkpointRequest();
  const valid = JSON.stringify(request);
  const extension = registeredExtension();
  const checkpoint = toolNamed(extension.tools, "bookie_checkpoint");
  for (const [name, bytes, acceptedReader] of [
    [
      "exact",
      `${valid}${" ".repeat(2_000_000 - Buffer.byteLength(valid))}`,
      true,
    ],
    [
      "over",
      `${valid}${" ".repeat(2_000_001 - Buffer.byteLength(valid))}`,
      false,
    ],
    ["utf8", Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d]), false],
    ["json", "{invalid", false],
  ]) {
    const requestPath = join(parent, `${name}.json`);
    await writeFile(requestPath, bytes);
    if (acceptedReader) {
      const result = await checkpoint.execute(
        name,
        { vault, requestPath, timing: "before-compaction" },
        undefined,
        undefined,
        context(vault),
      );
      assert.equal(JSON.parse(textResult(result)).result.status, "staged");
      await extension.handlers.get("session_shutdown")[0]({}, context(vault));
    } else {
      await assert.rejects(
        checkpoint.execute(
          name,
          { vault, requestPath, timing: "now", approval: "explicit" },
          undefined,
          undefined,
          context(vault),
        ),
        { message: "Bookie write request file is invalid." },
      );
    }
    await assert.rejects(readFile(join(vault, request.path)), {
      code: "ENOENT",
    });
  }
  const ordinary = join(parent, "ordinary.json");
  await writeFile(ordinary, valid);
  const linked = join(parent, "linked.json");
  await fsPromises.link(ordinary, linked);
  const alias = join(parent, "alias.json");
  await symlink(ordinary, alias);
  for (const requestPath of [ordinary, linked, alias, parent]) {
    await assert.rejects(
      checkpoint.execute(
        "unsafe-descriptor",
        { vault, requestPath, timing: "now", approval: "explicit" },
        undefined,
        undefined,
        context(vault),
      ),
      { message: "Bookie write request file is invalid." },
    );
  }
  await rm(linked);
  const originalOpen = fsPromises.open;
  t.mock.method(fsPromises, "open", async (path, ...args) => {
    const handle = await originalOpen(path, ...args);
    if (path === ordinary) {
      const read = handle.read.bind(handle);
      let changed = false;
      handle.read = async (...args) => {
        const result = await read(...args);
        if (!changed) {
          changed = true;
          await writeFile(ordinary, `${valid} `);
        }
        return result;
      };
    }
    return handle;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      checkpoint.execute(
        "changed-reader",
        { vault, requestPath: ordinary, timing: "now", approval: "explicit" },
        undefined,
        undefined,
        context(vault),
      ),
      { message: "Bookie write request file is invalid." },
    );
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  await writeFile(ordinary, valid);
  const result = await checkpoint.execute(
    "ordinary",
    { vault, requestPath: ordinary, timing: "now", approval: "explicit" },
    undefined,
    undefined,
    context(vault),
  );
  assert.equal(JSON.parse(textResult(result)).result.status, "created");
});

test("excluded write results serialize no source fingerprints or identities", async (t) => {
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
  const path = "people/private.md";
  const requestPath = join(resolve(vault, ".."), "private.json");
  const write = toolNamed(registeredTools(), "bookie_write");
  const frontmatter = {
    type: "Person",
    title: "PRIVATE-TITLE",
    status: "draft",
    generated: { by: "human:test", at: "2026-09-14T13:00:00Z" },
    bookie: {
      profile: "1.0",
      uid: "PER-00000000000000000000000181",
      created_at: "2026-09-14T13:00:00Z",
      sensitivity: "restricted",
    },
  };
  for (const step of ["create", "amend", "unchanged", "leave", "enter"]) {
    const request =
      step === "create"
        ? { path, frontmatter, bodyText: "PRIVATE-BODY\n" }
        : {
            path,
            expectedSourceHash: `sha256:${(await import("node:crypto"))
              .createHash("sha256")
              .update(await readFile(join(vault, path)))
              .digest("hex")}`,
            edits:
              step === "amend"
                ? [{ op: "set", path: ["title"], value: "PRIVATE-UPDATE" }]
                : step === "unchanged"
                  ? [{ op: "set", path: ["title"], value: "PRIVATE-UPDATE" }]
                  : [
                      {
                        op: "set",
                        path: ["bookie", "sensitivity"],
                        value: step === "leave" ? "public" : "restricted",
                      },
                    ],
          };
    await writeFile(requestPath, JSON.stringify(request));
    const result = await write.execute(
      step,
      {
        vault,
        action: step === "create" ? "create" : "amend",
        requestPath,
        approval: "explicit",
      },
      undefined,
      undefined,
      context(vault),
    );
    const payload = JSON.parse(textResult(result)).result;
    assert.deepEqual(payload, {
      ok: true,
      operation: step === "create" ? "create" : "amend",
      outcome:
        step === "create"
          ? "created"
          : step === "unchanged"
            ? "unchanged"
            : "amended",
      redacted: true,
      path: "<redacted>",
      changedPaths: step === "unchanged" ? [] : ["<redacted>"],
      diagnostics: [],
    });
    const serialized = JSON.stringify(result);
    for (const forbidden of [
      "sourceHash",
      "previousSourceHash",
      "sha256:",
      "PRIVATE-",
      path,
      frontmatter.bookie.uid,
      "byteLength",
      "sourceByteLength",
    ])
      assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("checkpoint preview and Activity omit excluded context before approval", async (t) => {
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
  const parent = resolve(vault, "..");
  const externalPathSecret = ["sk-", "1234567890abcdefghijklmnopqrstuv"].join(
    "",
  );
  const requestPath = join(parent, `${externalPathSecret}.json`);
  const excluded = {
    uid: "TSK-00000000000000000000000998",
    path: "/projects/private/excluded.md",
    marker: "EXCLUDED-CHECKPOINT-MARKER",
  };
  const request = checkpointRequest();
  request.fragments.push({
    section: "outcome",
    sensitivity: "restricted",
    text: `${excluded.uid} ${excluded.path} ${excluded.marker}`,
  });
  await writeFile(requestPath, JSON.stringify(request));
  const checkpoint = toolNamed(registeredTools(), "bookie_checkpoint");
  await assert.rejects(
    checkpoint.execute(
      "no-ui",
      {
        vault,
        requestPath: join(parent, "missing.json"),
        timing: "now",
        approval: "confirm",
      },
      undefined,
      undefined,
      context(repositoryRoot),
    ),
    /requires explicit approval in non-interactive mode/u,
  );

  const target = join(vault, request.path);
  let declinedMessage = "";
  const declined = await checkpoint.execute(
    "declined",
    { vault, requestPath, timing: "now", approval: "confirm" },
    undefined,
    undefined,
    context(repositoryRoot, {
      mode: "tui",
      hasUI: true,
      ui: {
        confirm: async (_title, message) => {
          declinedMessage = message;
          return false;
        },
        notify: () => {},
      },
    }),
  );
  assert.equal(JSON.parse(textResult(declined)).result.status, "declined");
  assert.match(declinedMessage, /Included outcome\./u);
  assert.equal(declinedMessage.includes(externalPathSecret), false);
  assert.equal(declinedMessage.includes(requestPath), false);
  assert.equal(declinedMessage.includes(vault), false);
  for (const value of Object.values(excluded)) {
    assert.equal(declinedMessage.includes(value), false);
  }
  await assert.rejects(readFile(target), { code: "ENOENT" });

  let releaseQueue;
  let queueEntered;
  const entered = new Promise((resolve) => {
    queueEntered = resolve;
  });
  const gate = new Promise((resolve) => {
    releaseQueue = resolve;
  });
  const blocker = withFileMutationQueue(target, async () => {
    queueEntered();
    await gate;
  });
  await entered;
  let settled = false;
  const pendingWrite = checkpoint
    .execute(
      "approved",
      { vault, requestPath, timing: "now", approval: "confirm" },
      undefined,
      undefined,
      context(repositoryRoot, {
        mode: "tui",
        hasUI: true,
        ui: { confirm: async () => true, notify: () => {} },
      }),
    )
    .finally(() => {
      settled = true;
    });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(settled, false);
  await assert.rejects(readFile(target), { code: "ENOENT" });
  releaseQueue();
  await blocker;
  const written = await pendingWrite;
  const writtenOutput = textResult(written);
  const activity = await readFile(target, "utf8");
  assert.match(writtenOutput, /"status":"created"/u);
  assert.match(activity, /Included outcome\./u);
  for (const value of Object.values(excluded)) {
    assert.equal(writtenOutput.includes(value), false);
    assert.equal(activity.includes(value), false);
  }
});

test("staged checkpoint hook continues compaction on no UI or decline and writes on approval", async (t) => {
  const vault = await temporaryVault(t);
  const parent = resolve(vault, "..");
  const requestPath = join(parent, "staged.json");
  const request = checkpointRequest(
    "projects/fixture/activities/staged-session.md",
  );
  request.frontmatter.bookie.uid = "ACT-00000000000000000000000161";
  await writeFile(requestPath, JSON.stringify(request));

  const extension = registeredExtension();
  const checkpoint = toolNamed(extension.tools, "bookie_checkpoint");
  const beforeCompact = extension.handlers.get("session_before_compact")?.[0];
  const shutdown = extension.handlers.get("session_shutdown")?.[0];
  assert.equal(typeof beforeCompact, "function");
  assert.equal(typeof shutdown, "function");
  assert.equal(extension.handlers.has("agent_end"), false);
  assert.equal(extension.handlers.has("agent_settled"), false);

  const staged = await checkpoint.execute(
    "stage",
    { vault, requestPath, timing: "before-compaction" },
    undefined,
    undefined,
    context(repositoryRoot),
  );
  assert.equal(JSON.parse(textResult(staged)).result.status, "staged");
  const secondRequestPath = join(parent, "second-staged.json");
  const secondRequest = checkpointRequest(
    "projects/fixture/activities/second-staged.md",
  );
  secondRequest.frontmatter.bookie.uid = "ACT-00000000000000000000000169";
  await writeFile(secondRequestPath, JSON.stringify(secondRequest));
  await assert.rejects(
    checkpoint.execute(
      "second-stage",
      { vault, requestPath: secondRequestPath, timing: "before-compaction" },
      undefined,
      undefined,
      context(repositoryRoot),
    ),
    /Bookie checkpoint is already staged\./u,
  );
  const target = join(vault, request.path);
  assert.equal(
    await beforeCompact({ signal: undefined }, context(repositoryRoot)),
    undefined,
  );
  await assert.rejects(readFile(target), { code: "ENOENT" });

  const notices = [];
  assert.equal(
    await beforeCompact(
      { signal: undefined },
      context(repositoryRoot, {
        mode: "tui",
        hasUI: true,
        ui: {
          confirm: async () => false,
          notify: (message) => notices.push(message),
        },
      }),
    ),
    undefined,
  );
  await assert.rejects(readFile(target), { code: "ENOENT" });

  await checkpoint.execute(
    "stage-for-cancellation",
    { vault, requestPath, timing: "before-compaction" },
    undefined,
    undefined,
    context(repositoryRoot),
  );
  const controller = new AbortController();
  let confirmationStarted;
  const started = new Promise((resolve) => {
    confirmationStarted = resolve;
  });
  const cancelledHook = beforeCompact(
    { signal: controller.signal },
    context(repositoryRoot, {
      mode: "tui",
      hasUI: true,
      ui: {
        confirm: async (_title, _message, options) => {
          confirmationStarted();
          return new Promise((_resolve, reject) => {
            options.signal.addEventListener(
              "abort",
              () => reject(options.signal.reason),
              { once: true },
            );
          });
        },
        notify: (message) => notices.push(message),
      },
    }),
  );
  await started;
  controller.abort();
  assert.equal(await cancelledHook, undefined);
  await assert.rejects(readFile(target), { code: "ENOENT" });
  assert.match(notices.at(-1), /cancelled/u);

  await checkpoint.execute(
    "restage",
    { vault, requestPath, timing: "before-compaction" },
    undefined,
    undefined,
    context(repositoryRoot),
  );
  assert.equal(
    await beforeCompact(
      { signal: undefined },
      context(repositoryRoot, {
        mode: "tui",
        hasUI: true,
        ui: {
          confirm: async (_title, message) => {
            assert.match(message, /Included outcome\./u);
            return true;
          },
          notify: (message) => notices.push(message),
        },
      }),
    ),
    undefined,
  );
  assert.match(await readFile(target, "utf8"), /Included next-action\./u);
  assert.ok(notices.every((message) => !message.includes(request.path)));

  await shutdown({}, context(repositoryRoot));
  await shutdown({}, context(repositoryRoot));
  assert.equal(
    await beforeCompact(
      { signal: undefined },
      context(repositoryRoot, {
        mode: "tui",
        hasUI: true,
        ui: {
          confirm: async () => {
            throw new Error("no prepared checkpoint should prompt");
          },
          notify: (message) => notices.push(message),
        },
      }),
    ),
    undefined,
  );
  assert.match(notices.at(-1), /No prepared Bookie checkpoint/u);
});

test("parallel staging retains exactly one pending checkpoint", async (t) => {
  const vault = await temporaryVault(t);
  const parent = resolve(vault, "..");
  const paths = [];
  for (const [index, uid] of [
    ["one", "ACT-00000000000000000000000170"],
    ["two", "ACT-00000000000000000000000171"],
  ]) {
    const requestPath = join(parent, `parallel-${index}.json`);
    const request = checkpointRequest(
      `projects/fixture/activities/parallel-${index}.md`,
    );
    request.frontmatter.bookie.uid = uid;
    await writeFile(requestPath, JSON.stringify(request));
    paths.push(requestPath);
  }
  const extension = registeredExtension();
  const checkpoint = toolNamed(extension.tools, "bookie_checkpoint");
  const results = await Promise.allSettled(
    paths.map((requestPath) =>
      checkpoint.execute(
        "parallel-stage",
        { vault, requestPath, timing: "before-compaction" },
        undefined,
        undefined,
        context(repositoryRoot),
      ),
    ),
  );
  assert.equal(
    results.filter(({ status }) => status === "fulfilled").length,
    1,
  );
  const rejection = results.find(({ status }) => status === "rejected");
  assert.equal(
    rejection.reason.message,
    "Bookie checkpoint is already staged.",
  );
  for (const params of [
    {
      vault,
      requestPath: join(parent, "missing-staged-request.json"),
      timing: "before-compaction",
    },
    {
      vault,
      requestPath: join(parent, "missing-immediate-request.json"),
      timing: "now",
      approval: "explicit",
    },
  ]) {
    await assert.rejects(
      checkpoint.execute(
        "already-staged",
        params,
        undefined,
        undefined,
        context(repositoryRoot),
      ),
      (error) => {
        assert.equal(error.message, "Bookie checkpoint is already staged.");
        return true;
      },
    );
  }
  await extension.handlers.get("session_shutdown")[0](
    {},
    context(repositoryRoot),
  );
});

test("parallel immediate checkpoints reserve one session slot", async (t) => {
  const vault = await temporaryVault(t);
  const parent = resolve(vault, "..");
  const requests = [];
  for (const [name, uid] of [
    ["immediate-one", "ACT-00000000000000000000000176"],
    ["immediate-two", "ACT-00000000000000000000000177"],
  ]) {
    const requestPath = join(parent, `${name}.json`);
    const request = checkpointRequest(`projects/fixture/activities/${name}.md`);
    request.frontmatter.bookie.uid = uid;
    await writeFile(requestPath, JSON.stringify(request));
    requests.push({ requestPath, request });
  }
  const checkpoint = toolNamed(registeredTools(), "bookie_checkpoint");
  const results = await Promise.allSettled(
    requests.map(({ requestPath }) =>
      checkpoint.execute(
        "parallel-immediate",
        { vault, requestPath, timing: "now", approval: "explicit" },
        undefined,
        undefined,
        context(repositoryRoot),
      ),
    ),
  );
  assert.equal(
    results.filter(({ status }) => status === "fulfilled").length,
    1,
  );
  assert.equal(
    results.find(({ status }) => status === "rejected").reason.message,
    "Bookie checkpoint is already staged.",
  );
  let published = 0;
  for (const { request } of requests) {
    try {
      await readFile(join(vault, request.path));
      published += 1;
    } catch (error) {
      assert.equal(error.code, "ENOENT");
    }
  }
  assert.equal(published, 1);
});

test("staged checkpoint remains reserved through its approval dialog", async (t) => {
  const vault = await temporaryVault(t);
  const parent = resolve(vault, "..");
  const firstPath = join(parent, "processing-first.json");
  const secondPath = join(parent, "processing-second.json");
  const first = checkpointRequest(
    "projects/fixture/activities/processing-first.md",
  );
  first.frontmatter.bookie.uid = "ACT-00000000000000000000000172";
  const second = checkpointRequest(
    "projects/fixture/activities/processing-second.md",
  );
  second.frontmatter.bookie.uid = "ACT-00000000000000000000000173";
  await writeFile(firstPath, JSON.stringify(first));
  await writeFile(secondPath, JSON.stringify(second));
  const extension = registeredExtension();
  const checkpoint = toolNamed(extension.tools, "bookie_checkpoint");
  await checkpoint.execute(
    "processing-first",
    { vault, requestPath: firstPath, timing: "before-compaction" },
    undefined,
    undefined,
    context(repositoryRoot),
  );
  let releaseConfirmation;
  let confirmationEntered;
  const entered = new Promise((resolve) => {
    confirmationEntered = resolve;
  });
  const gate = new Promise((resolve) => {
    releaseConfirmation = resolve;
  });
  const hook = extension.handlers.get("session_before_compact")[0](
    { signal: undefined },
    context(repositoryRoot, {
      mode: "tui",
      hasUI: true,
      ui: {
        confirm: async () => {
          confirmationEntered();
          await gate;
          return false;
        },
        notify: () => {},
      },
    }),
  );
  await entered;
  await assert.rejects(
    checkpoint.execute(
      "processing-second",
      { vault, requestPath: secondPath, timing: "before-compaction" },
      undefined,
      undefined,
      context(repositoryRoot),
    ),
    /Bookie checkpoint is already staged\./u,
  );
  releaseConfirmation();
  await hook;
  const staged = await checkpoint.execute(
    "processing-second-after-decline",
    { vault, requestPath: secondPath, timing: "before-compaction" },
    undefined,
    undefined,
    context(repositoryRoot),
  );
  assert.equal(JSON.parse(textResult(staged)).result.status, "staged");
  await extension.handlers.get("session_shutdown")[0](
    {},
    context(repositoryRoot),
  );
});

test("checkpoint rejects previews beyond Pi's line limit before staging", async (t) => {
  const vault = await temporaryVault(t);
  const parent = resolve(vault, "..");
  const requestPath = join(parent, "too-many-lines.json");
  const request = checkpointRequest(
    "projects/fixture/activities/too-many-lines.md",
  );
  request.frontmatter.bookie.uid = "ACT-00000000000000000000000174";
  request.fragments = request.fragments.map((fragment) => ({
    ...fragment,
    text: Array.from({ length: 300 }, () => "x").join("\n"),
  }));
  await writeFile(requestPath, JSON.stringify(request));
  const extension = registeredExtension();
  const checkpoint = toolNamed(extension.tools, "bookie_checkpoint");
  await assert.rejects(
    checkpoint.execute(
      "too-many-lines",
      { vault, requestPath, timing: "before-compaction" },
      undefined,
      undefined,
      context(repositoryRoot),
    ),
    /Bookie checkpoint failed: bounds\./u,
  );

  const validPath = join(parent, "after-too-many-lines.json");
  const valid = checkpointRequest(
    "projects/fixture/activities/after-too-many-lines.md",
  );
  valid.frontmatter.bookie.uid = "ACT-00000000000000000000000175";
  await writeFile(validPath, JSON.stringify(valid));
  const staged = await checkpoint.execute(
    "after-too-many-lines",
    { vault, requestPath: validPath, timing: "before-compaction" },
    undefined,
    undefined,
    context(repositoryRoot),
  );
  assert.equal(JSON.parse(textResult(staged)).result.status, "staged");
  await extension.handlers.get("session_shutdown")[0](
    {},
    context(repositoryRoot),
  );
});

test("staged checkpoint rejects sensitivity changes while waiting in Pi's queue", async (t) => {
  const vault = await temporaryVault(t);
  const manifestPath = join(vault, "bookie.yaml");
  await writeFile(
    manifestPath,
    (await readFile(manifestPath, "utf8")).replace(
      "      - public\n",
      "      - public\n      - restricted\n",
    ),
  );
  const parent = resolve(vault, "..");
  const requestPath = join(parent, "policy-change.json");
  const request = checkpointRequest(
    "projects/fixture/activities/policy-change.md",
  );
  request.frontmatter.bookie.uid = "ACT-00000000000000000000000162";
  request.fragments[0].sensitivity = "restricted";
  request.fragments[0].text = "RESTRICTED-RACE-MARKER";
  await writeFile(requestPath, JSON.stringify(request));
  const extension = registeredExtension();
  await toolNamed(extension.tools, "bookie_checkpoint").execute(
    "stage-policy",
    { vault, requestPath, timing: "before-compaction" },
    undefined,
    undefined,
    context(repositoryRoot),
  );
  const target = join(vault, request.path);
  let releaseQueue;
  let queueEntered;
  const entered = new Promise((resolve) => {
    queueEntered = resolve;
  });
  const gate = new Promise((resolve) => {
    releaseQueue = resolve;
  });
  const blocker = withFileMutationQueue(target, async () => {
    queueEntered();
    await gate;
  });
  await entered;
  const notices = [];
  const pendingHook = extension.handlers.get("session_before_compact")[0](
    { signal: new AbortController().signal },
    context(repositoryRoot, {
      mode: "tui",
      hasUI: true,
      ui: {
        confirm: async () => true,
        notify: (message) => notices.push(message),
      },
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  await writeFile(
    manifestPath,
    (await readFile(manifestPath, "utf8")).replace(
      "    excluded_classes: []",
      "    excluded_classes:\n      - restricted",
    ),
  );
  releaseQueue();
  await blocker;
  await pendingHook;
  await assert.rejects(readFile(target), { code: "ENOENT" });
  assert.deepEqual(notices, [
    "Bookie checkpoint failed; compaction will continue.",
  ]);
});

test("checkpoint approval is bound to the resolved vault identity", async (t) => {
  const originalVault = await temporaryVault(t);
  const parent = resolve(originalVault, "..");
  const replacementVault = join(parent, "replacement-vault");
  await cp(fixture, replacementVault, { recursive: true });
  const selectedVault = join(parent, "selected-vault");
  await symlink(originalVault, selectedVault, "dir");
  const requestPath = join(parent, "root-race.json");
  const request = checkpointRequest("projects/fixture/activities/root-race.md");
  request.frontmatter.bookie.uid = "ACT-00000000000000000000000163";
  await writeFile(requestPath, JSON.stringify(request));
  const checkpoint = toolNamed(registeredTools(), "bookie_checkpoint");
  await assert.rejects(
    checkpoint.execute(
      "root-race",
      {
        vault: selectedVault,
        requestPath,
        timing: "now",
        approval: "confirm",
      },
      undefined,
      undefined,
      context(repositoryRoot, {
        mode: "tui",
        hasUI: true,
        ui: {
          confirm: async (_title, message) => {
            assert.match(
              message,
              /projects\/fixture\/activities\/root-race\.md/u,
            );
            assert.equal(message.includes(originalVault), false);
            assert.equal(message.includes(selectedVault), false);
            assert.equal(message.includes(requestPath), false);
            await rm(selectedVault);
            await symlink(replacementVault, selectedVault, "dir");
            return true;
          },
          notify: () => {},
        },
      }),
    ),
    /Bookie checkpoint failed: MUTATION-CONFLICT\./u,
  );
  for (const vault of [originalVault, replacementVault]) {
    await assert.rejects(readFile(join(vault, request.path)), {
      code: "ENOENT",
    });
  }

  await rm(selectedVault);
  await symlink(originalVault, selectedVault, "dir");
  const stagedRequest = checkpointRequest(
    "projects/fixture/activities/staged-root-race.md",
  );
  stagedRequest.frontmatter.bookie.uid = "ACT-00000000000000000000000164";
  await writeFile(requestPath, JSON.stringify(stagedRequest));
  const extension = registeredExtension();
  await toolNamed(extension.tools, "bookie_checkpoint").execute(
    "stage-root-race",
    { vault: selectedVault, requestPath, timing: "before-compaction" },
    undefined,
    undefined,
    context(repositoryRoot),
  );
  await rm(selectedVault);
  await symlink(replacementVault, selectedVault, "dir");
  const notices = [];
  await extension.handlers.get("session_before_compact")[0](
    { signal: new AbortController().signal },
    context(repositoryRoot, {
      mode: "tui",
      hasUI: true,
      ui: {
        confirm: async () => true,
        notify: (message) => notices.push(message),
      },
    }),
  );
  assert.deepEqual(notices, [
    "Bookie checkpoint failed; compaction will continue.",
  ]);
  for (const vault of [originalVault, replacementVault]) {
    await assert.rejects(readFile(join(vault, stagedRequest.path)), {
      code: "ENOENT",
    });
  }
});

test("checkpoint approval rejects target-parent substitution", async (t) => {
  const vault = await temporaryVault(t);
  const parent = resolve(vault, "..");
  const requestPath = join(parent, "parent-race.json");
  const request = checkpointRequest(
    "projects/fixture/activities/parent-race.md",
  );
  request.frontmatter.bookie.uid = "ACT-00000000000000000000000165";
  await writeFile(requestPath, JSON.stringify(request));
  const activities = join(vault, "projects/fixture/activities");
  const displaced = join(vault, "projects/fixture/activities-old");
  await assert.rejects(
    toolNamed(registeredTools(), "bookie_checkpoint").execute(
      "parent-race",
      { vault, requestPath, timing: "now", approval: "confirm" },
      undefined,
      undefined,
      context(repositoryRoot, {
        mode: "tui",
        hasUI: true,
        ui: {
          confirm: async () => {
            await rename(activities, displaced);
            await mkdir(activities);
            return true;
          },
          notify: () => {},
        },
      }),
    ),
    /Bookie checkpoint failed: MUTATION-CONFLICT\./u,
  );
  await assert.rejects(readFile(join(activities, "parent-race.md")), {
    code: "ENOENT",
  });
  await assert.rejects(readFile(join(displaced, "parent-race.md")), {
    code: "ENOENT",
  });
});

test("checkpoint secret failures are static and publish nothing", async (t) => {
  const vault = await temporaryVault(t);
  const parent = resolve(vault, "..");
  const requestPath = join(parent, "secret-checkpoint.json");
  const request = checkpointRequest(
    "projects/fixture/activities/rejected-session.md",
  );
  request.fragments[0].text = ["password", "checkpoint-must-not-leak"].join(
    "=",
  );
  await writeFile(requestPath, JSON.stringify(request));
  const target = join(vault, request.path);
  await assert.rejects(
    toolNamed(registeredTools(), "bookie_checkpoint").execute(
      "secret",
      { vault, requestPath, timing: "now", approval: "explicit" },
      undefined,
      undefined,
      context(repositoryRoot),
    ),
    (error) => {
      assert.equal(error.message, "Bookie checkpoint failed: secret-policy.");
      assert.equal(error.message.includes("must-not-leak"), false);
      return true;
    },
  );
  await assert.rejects(readFile(target), { code: "ENOENT" });
});

test("extension keeps read behavior core-backed and has no network or Git side effects", async () => {
  const source = await readFile(join(packageRoot, "src/index.ts"), "utf8");
  for (const required of ["inspectConcept", "searchVault", "validateVault"]) {
    assert.match(source, new RegExp(`\\b${required}\\b`, "u"));
  }
  for (const forbidden of [
    "createConcept(",
    "amendConcept(",
    "captureEvidence",
    "exportCanonicalJsonl",
    "console.",
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
