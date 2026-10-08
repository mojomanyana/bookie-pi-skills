import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { fileWriter, writeRuntimeSchemas } from "./helpers/runtime-fixture.mjs";
import { stageRuntimeArtifact } from "../dist/stage-runtime.js";
import { hashRuntimeArtifact } from "../dist/runtime-artifact.js";

const pkg = (name, dependencies = {}, extras = {}) =>
  JSON.stringify({
    name,
    version: "1.0.0",
    type: "module",
    dependencies,
    ...extras,
  });
async function fixture(t) {
  const parent = await mkdtemp(join(tmpdir(), "bookie-stage-test-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const source = join(parent, "source");
  const dest = (name) => join(parent, name);
  const write = fileWriter(source);
  await write("package.json", pkg("root"));
  await write("package-lock.json", '{"lockfileVersion":3}');
  await write(
    "apps/service/package.json",
    pkg("@bookie/service", { "@bookie/core": "0.0.0", dep: "1.0.0" }),
  );
  await write(
    "packages/core/package.json",
    pkg("@bookie/core", {}, { exports: { ".": "./dist/index.js" } }),
  );
  await write(
    "apps/service/dist/server.js",
    "import { core } from '@bookie/core'; import { dep } from 'dep'; import { readFileSync } from 'node:fs'; const schema = readFileSync(new URL('../../../schemas/service/v1/protocol.schema.json', import.meta.url), 'utf8'); export default `${core}:${dep}:${schema.length}`;",
  );
  await write("packages/core/dist/index.js", "export const core = 'core';");
  await writeRuntimeSchemas(write);
  await write(
    "node_modules/dep/package.json",
    pkg("dep", { trans: "1.0.0" }, { exports: "./index.js" }),
  );
  await write(
    "node_modules/dep/index.js",
    "import { trans } from 'trans'; export const dep = trans;",
  );
  await write(
    "node_modules/dep/node_modules/trans/package.json",
    pkg("trans", {}, { exports: "./index.js" }),
  );
  await write(
    "node_modules/dep/node_modules/trans/index.js",
    "export const trans = 'nested';",
  );
  await write("node_modules/unused/secret.js", "PRIVATE_UNRELATED");
  await mkdir(join(source, "node_modules/@bookie"), { recursive: true });
  await symlink(
    "../../packages/core",
    join(source, "node_modules/@bookie/core"),
  );
  return { source, dest, write };
}
const bad = { name: "TypeError", message: "Runtime staging failed." };

test("staging a dependency closure produces a relocatable, hashable, bootable tree", async (t) => {
  const { source, dest, write } = await fixture(t);
  const first = await stageRuntimeArtifact(source, dest("first"));
  const second = await stageRuntimeArtifact(source, dest("second"));
  assert.equal(first, second);
  assert.equal(await hashRuntimeArtifact(dest("first")), first);
  assert.equal(
    (
      await import(
        pathToFileURL(join(dest("first"), "apps/service/dist/server.js")).href
      )
    ).default,
    "core:nested:42",
  );
  await assert.rejects(
    stat(join(dest("first"), "node_modules/unused/secret.js")),
    { code: "ENOENT" },
  );
  assert.equal(
    (
      await stat(join(dest("first"), "node_modules/@bookie/core"))
    ).isDirectory(),
    true,
  );
  await write("node_modules/dep/index.js", "export const dep = 'changed';");
  assert.notEqual(await stageRuntimeArtifact(source, dest("changed")), first);
  assert.equal(await hashRuntimeArtifact(dest("first")), first);
});

test("installed service stages offline and serves liveness from the isolated tree", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "bookie-stage-live-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const source = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
  const staged = join(parent, "runtime");
  const digest = await stageRuntimeArtifact(source, staged);
  assert.equal(await hashRuntimeArtifact(staged), digest);
  const { createBookieService } = await import(
    pathToFileURL(join(staged, "apps/service/dist/server.js")).href
  );
  const app = await createBookieService({
    tokens: [],
    store: {
      ready: async () => true,
      listIndexes: async () => [],
      search: async () => {
        throw Error("not used");
      },
    },
  });
  try {
    const response = await app.inject({ method: "GET", url: "/health/live" });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, "ok");
  } finally {
    await app.close();
  }
});

test("optional peer metadata does not force an uninstalled peer into the runtime", async (t) => {
  const { source, dest, write } = await fixture(t);
  await write(
    "node_modules/dep/package.json",
    pkg(
      "dep",
      { trans: "1.0.0" },
      {
        exports: "./index.js",
        peerDependencies: { "absent-peer": "1.0.0" },
        peerDependenciesMeta: { "absent-peer": { optional: true } },
      },
    ),
  );
  assert.match(
    await stageRuntimeArtifact(source, dest("optional-peer")),
    /^sha256:[a-f0-9]{64}$/,
  );
  assert.equal(
    (
      await stat(join(dest("optional-peer"), "node_modules/dep/package.json"))
    ).isFile(),
    true,
  );
});

test("an npm alias retains its import path but checks the installed package identity", async (t) => {
  const { source, dest, write } = await fixture(t);
  await write(
    "apps/service/package.json",
    pkg("@bookie/service", {
      "@bookie/core": "0.0.0",
      alias: "npm:real-dep@1.0.0",
    }),
  );
  await write(
    "apps/service/dist/server.js",
    "import { value } from 'alias'; export default value;",
  );
  await write(
    "node_modules/alias/package.json",
    pkg("real-dep", {}, { exports: "./index.js" }),
  );
  await write("node_modules/alias/index.js", "export const value = 'aliased';");
  assert.match(
    await stageRuntimeArtifact(source, dest("alias")),
    /^sha256:[a-f0-9]{64}$/,
  );
  assert.equal(
    (
      await import(
        pathToFileURL(join(dest("alias"), "apps/service/dist/server.js")).href
      )
    ).default,
    "aliased",
  );
  await write(
    "node_modules/alias/package.json",
    pkg("impostor", {}, { exports: "./index.js" }),
  );
  await assert.rejects(
    stageRuntimeArtifact(source, dest("alias-mismatch")),
    bad,
  );
  await assert.rejects(stat(dest("alias-mismatch")), { code: "ENOENT" });
});

test("a symlinked intermediate installed dependency directory cannot escape the source", async (t) => {
  const { source, dest } = await fixture(t);
  const nested = join(source, "node_modules/dep/node_modules");
  await rename(nested, dest("external"));
  await symlink(dest("external"), nested);
  await assert.rejects(
    stageRuntimeArtifact(source, dest("escaped-parent")),
    bad,
  );
  await assert.rejects(stat(dest("escaped-parent")), { code: "ENOENT" });
});

test("missing schemas, external dependency links and existing targets fail without publishing", async (t) => {
  const { source, dest, write } = await fixture(t);
  const schema = join(
    source,
    "packages/core/dist/schemas/types/task.schema.json",
  );
  const saved = await readFile(schema);
  await rm(schema);
  await assert.rejects(stageRuntimeArtifact(source, dest("missing")), bad);
  await assert.rejects(stat(dest("missing")), { code: "ENOENT" });
  await write("packages/core/dist/schemas/types/task.schema.json", saved);
  await symlink("/etc/passwd", join(source, "node_modules/dep/escape"));
  await assert.rejects(stageRuntimeArtifact(source, dest("escape")), bad);
  await assert.rejects(stat(dest("escape")), { code: "ENOENT" });
  await rm(join(source, "node_modules/dep/escape"));
  await mkdir(dest("exists"));
  await assert.rejects(stageRuntimeArtifact(source, dest("exists")), bad);
  assert.equal((await stat(dest("exists"))).isDirectory(), true);
  await write(
    "apps/service/package.json",
    '{"name":"@bookie/service","dependencies":{"dep":"1.0.0","@bookie/core":"0.0.0","__proto__":"1.0.0"}}',
  );
  await assert.rejects(stageRuntimeArtifact(source, dest("prototype")), bad);
  await assert.rejects(stat(dest("prototype")), { code: "ENOENT" });
  await write(
    "apps/service/package.json",
    pkg("@bookie/service", { "@bookie/core": "0.0.0", missing: "1.0.0" }),
  );
  await assert.rejects(
    stageRuntimeArtifact(source, dest("missing-dependency")),
    bad,
  );
  await assert.rejects(stat(dest("missing-dependency")), { code: "ENOENT" });
  await assert.rejects(
    stageRuntimeArtifact(source, join(source, "nested-stage")),
    bad,
  );
  await assert.rejects(stat(join(source, "nested-stage")), { code: "ENOENT" });
});
