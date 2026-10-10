import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  buildRuntime,
  docker,
  extractRuntime,
  mutateRuntimeImage,
  privateWorkspace,
  repository,
  runRuntime,
} from "../../scripts/qualify-runtime.mjs";

const hash = (bytes) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const bad = { name: "TypeError", message: "Runtime qualification failed." };
const config = {
  handle: "demo",
  root: "/vault",
  repositoryRoot: "/vault",
  approvedRef: "refs/heads/approved",
  rollbackWindow: 0,
  timeoutMs: 15000,
  projection: {
    vaultUid: "VLT-01ARZ3NDEKTSV4RRFFQ69G5FAY",
    approvedSensitivityClasses: ["public"],
    maxChunkBytes: 8192,
    maxChunks: 250000,
  },
};
const excludedUid = "DOC-00000000000000000000000009";
const excludedPath = "/excluded-qualification.md";
const excludedMarker = "EXCLUDED_QUALIFICATION_MARKER";
const secret = "-----BEGIN PRIVATE KEY-----";
async function git(root, args) {
  // Git runs in the pinned image, avoiding host version/ownership dependence.
  return await docker([
    "run",
    "--rm",
    "--network",
    "none",
    "--mount",
    `type=bind,src=${root},dst=/vault`,
    "--entrypoint",
    "/usr/bin/git",
    "node:24.19.0-bookworm@sha256:4196d66a565c6f195728d9952f161f4adfe2ad753052a08b7ec7f1c5a6bda42b",
    "-C",
    "/vault",
    "-c",
    "safe.directory=/vault",
    "-c",
    "user.name=Synthetic",
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "commit.gpgSign=false",
    "-c",
    "core.hooksPath=/dev/null",
    ...args,
  ]);
}
async function source(parent, nested = false, secretCorpus = false) {
  const root = join(
    parent,
    nested
      ? "nested-source"
      : secretCorpus === "invalid"
        ? "invalid-source"
        : secretCorpus
          ? "secret-source"
          : "source",
  );
  const vault = nested ? join(root, "nested") : root;
  await cp(join(repository, "examples/vault"), vault, { recursive: true });
  const document = await readFile(
    join(vault, "projects/demo/documents/overview.md"),
    "utf8",
  );
  await writeFile(
    join(vault, excludedPath.slice(1)),
    document
      .replace("DOC-01ARZ3NDEKTSV4RRFFQ69G5FAY", excludedUid)
      .replace("sensitivity: public", "sensitivity: restricted")
      .replace(/# Overview[\s\S]*/u, `# Excluded\n${excludedMarker}\n`),
  );
  if (secretCorpus)
    await writeFile(
      join(vault, "projects/demo/documents/overview.md"),
      secretCorpus === "invalid"
        ? document.replace("title: Demo vault overview\n", "")
        : document + `\n${secret}\n`,
    );
  await git(root, ["init", "-q"]);
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-qm", "synthetic qualification"]);
  const commit = (await git(root, ["rev-parse", "HEAD"])).trim();
  await git(root, ["update-ref", "refs/heads/approved", commit]);
  // Container Git created root-owned metadata. All runtime sources use the
  // same owner; no safe.directory bypass is injected into packaged ingestion.
  await docker([
    "run",
    "--rm",
    "--network",
    "none",
    "--mount",
    `type=bind,src=${root},dst=/vault`,
    "--entrypoint",
    "/bin/sh",
    "node:24.19.0-bookworm@sha256:4196d66a565c6f195728d9952f161f4adfe2ad753052a08b7ec7f1c5a6bda42b",
    "-c",
    "chown -R 65534:65534 /vault; chmod -R a+rX /vault",
  ]);
  return {
    root,
    commit,
    config: { ...config, root: nested ? "/vault/nested" : "/vault" },
  };
}
function integrationDriver(fixture, expected, failure) {
  return `
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { exportCanonicalJsonl } from '/opt/bookie/node_modules/@bookie/core/dist/index.js';
import { createBookieService } from '/opt/bookie/apps/service/dist/server.js';
import { preflightDeploymentSource, prepareDeploymentLexicalProjection } from '/opt/bookie/apps/service/dist/ingestion.js';
import { qualifyRuntime } from '/opt/bookie/apps/service/dist/runtime-qualification.js';
const digest = await qualifyRuntime(${JSON.stringify(expected)});
const app = await createBookieService({ tokens: [], store: { ready: async () => false, listIndexes: async () => [], search: async () => { throw Error('unused'); } } });
try {
 for (const [url, code, status] of [['/health/live',200,'ok'],['/health/ready',503,'unavailable']]) {
  const response = await app.inject({ method: 'GET', url });
  assert.equal(response.statusCode,code); assert.deepEqual(response.json(),{schema_version:'1',status});
 }
} finally { await app.close(); }
const deployment = ${JSON.stringify(fixture.config)};
const sourceRef = ${JSON.stringify(fixture.commit)};
const preflight = await preflightDeploymentSource(deployment,{sourceRef,timeoutMs:7000});
const result = await prepareDeploymentLexicalProjection(deployment,{sourceRef});
${
  failure
    ? `assert.deepEqual(result, {ok:false,reason:${JSON.stringify(failure)}}); console.log(JSON.stringify({ok:true,rejected:${JSON.stringify(failure)}}));`
    : `
assert.equal(preflight.ok,true); assert.equal(preflight.sourceCommit,sourceRef);
assert.equal(preflight.vaultScope, deployment.root === '/vault' ? '' : 'nested');
assert.equal(result.ok,true);
const p = result.projection;
assert.equal(p.sourceCommit,sourceRef); assert.equal(result.approvedTip,sourceRef);
assert.equal(p.concepts.length,8); assert.ok(p.chunks.length > 0);
assert.ok(p.concepts.some(c => c.title === 'Demo vault overview'));
const serialized = JSON.stringify(p);
for (const canary of ${JSON.stringify([excludedUid, excludedPath, excludedMarker, secret])}) assert.equal(serialized.includes(canary),false);
const canonical=[];
const exported=await exportCanonicalJsonl(deployment.root,{sourceRef,write:line=>canonical.push(Buffer.from(line))});
assert.equal(exported.ok,true);
const bytes=Buffer.concat(canonical);
const h=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
assert.deepEqual(p.canonicalOutput,{hash:h(bytes),bytes:bytes.length,records:8});
for(const [records,expected] of [[p.concepts,p.conceptStreamHash],[p.chunks,p.chunkStreamHash]]) assert.equal(h(records.map(r=>JSON.stringify(r)+'\\n').join('')),expected);
console.log(JSON.stringify({ok:true,digest,canonical:p.canonicalOutput.hash,concepts:p.conceptStreamHash,chunks:p.chunkStreamHash}));`
}
`;
}

test(
  "clean-image reproducibility, immutable qualification and packaged deployment",
  { timeout: 900000 },
  async (t) => {
    const parent = await privateWorkspace();
    let reportOutput;
    const images = [];
    t.after(async () => {
      try {
        await docker([
          "run",
          "--rm",
          "--network",
          "none",
          "--mount",
          `type=bind,src=${parent},dst=/work`,
          "--entrypoint",
          "/bin/sh",
          "node:24.19.0-bookworm@sha256:4196d66a565c6f195728d9952f161f4adfe2ad753052a08b7ec7f1c5a6bda42b",
          "-c",
          `chown -R ${process.getuid()}:${process.getgid()} /work`,
        ]);
        await rm(parent, { recursive: true, force: true });
      } catch (error) {
        reportOutput = undefined;
        throw error;
      } finally {
        if (reportOutput === undefined)
          for (const imageId of new Set(images.map((record) => record.imageId)))
            await docker(["image", "rm", "--no-prune", imageId]);
      }
      if (reportOutput !== undefined) t.diagnostic(reportOutput);
    });
    const contexts = [];
    for (const name of ["first", "relocated-second"]) {
      const context = join(parent, name);
      await mkdir(context);
      // Copy source inputs only; test forbidden ambient inputs with explicit canaries.
      for (const path of [
        "package.json",
        "package-lock.json",
        "apps/service",
        "packages/core",
        "packages/cli/package.json",
        "packages/pi-extension/package.json",
        "schemas",
      ]) {
        await mkdir(join(context, path, ".."), { recursive: true });
        await cp(join(repository, path), join(context, path), {
          recursive: true,
          filter: (path) =>
            !/(?:^|\/)(?:node_modules|dist|test|\.tsbuildinfo)(?:\/|$)/u.test(
              path,
            ) && !path.endsWith(".tsbuildinfo"),
        });
      }
      for (const path of [
        "apps/service/dist/stale.js",
        "node_modules/unrelated/index.js",
        ".env",
        ".principal/private",
        "vault/private.md",
      ]) {
        await mkdir(join(context, path, ".."), { recursive: true });
        await writeFile(join(context, path), "HOST_CREDENTIAL_CANARY");
      }
      contexts.push(context);
    }

    for (const context of contexts) images.push(await buildRuntime(context));
    assert.equal(images[0].artifactHash, images[1].artifactHash);
    assert.equal(
      images[0].lockHash,
      hash(await readFile(join(repository, "package-lock.json"))),
    );
    const image = images[0];
    assert.match(image.imageId, /^sha256:[a-f0-9]{64}$/u);
    const fixture = await source(parent);
    const results = [];
    for (const record of images)
      results.push(
        JSON.parse(
          await runRuntime(
            record.imageId,
            integrationDriver(fixture, record.artifactHash),
            { source: fixture.root },
          ),
        ),
      );
    assert.deepEqual(results[0], results[1]);
    assert.deepEqual(
      JSON.parse(
        await runRuntime(
          image.imageId,
          integrationDriver(
            { ...fixture, commit: "a".repeat(40) },
            image.artifactHash,
            "source-not-approved",
          ),
          { source: fixture.root },
        ),
      ),
      { ok: true, rejected: "source-not-approved" },
    );
    const nested = await source(parent, true);
    assert.equal(
      JSON.parse(
        await runRuntime(
          image.imageId,
          integrationDriver(nested, image.artifactHash),
          { source: nested.root },
        ),
      ).ok,
      true,
    );
    const invalid = await source(parent, false, true);
    assert.deepEqual(
      JSON.parse(
        await runRuntime(
          image.imageId,
          integrationDriver(invalid, image.artifactHash, "secret-policy"),
          { source: invalid.root },
        ),
      ),
      { ok: true, rejected: "secret-policy" },
    );
    const malformed = await source(parent, false, "invalid");
    assert.deepEqual(
      JSON.parse(
        await runRuntime(
          image.imageId,
          integrationDriver(malformed, image.artifactHash, "invalid-vault"),
          { source: malformed.root },
        ),
      ),
      { ok: true, rejected: "invalid-vault" },
    );
    const rejectDriver = `import assert from 'node:assert/strict'; import {qualifyRuntime} from '/opt/bookie/apps/service/dist/runtime-qualification.js'; await assert.rejects(qualifyRuntime(${JSON.stringify(image.artifactHash)}),${JSON.stringify(bad)}); console.log('{"ok":true}');`;
    for (const options of [
      { writableRoot: true },
      { rootUser: true },
      { capabilities: true },
      { privileges: true },
      { env: ["PATH=/tmp:/usr/bin"] },
      { env: ["PATH="] },
      {
        mounts: [
          "type=tmpfs,dst=/opt/bookie/node_modules/yaml,tmpfs-size=4096",
        ],
      },
    ])
      assert.equal(
        JSON.parse(await runRuntime(image.imageId, rejectDriver, options)).ok,
        true,
      );
    const mismatch = `import assert from 'node:assert/strict'; import {qualifyRuntime} from '/opt/bookie/apps/service/dist/runtime-qualification.js'; await assert.rejects(qualifyRuntime('sha256:'+ '0'.repeat(64)),${JSON.stringify(bad)}); console.log('{"ok":true}');`;
    assert.equal(
      JSON.parse(await runRuntime(image.imageId, mismatch)).ok,
      true,
    );
    for (const options of [
      { writableSource: true },
      { mounts: [`type=bind,src=${fixture.root},dst=/source-alias`] },
    ])
      assert.deepEqual(
        JSON.parse(
          await runRuntime(
            image.imageId,
            integrationDriver(
              fixture,
              image.artifactHash,
              "deployment-rejected",
            ),
            { source: fixture.root, ...options },
          ),
        ),
        { ok: true, rejected: "deployment-rejected" },
      );
    // Old identity must reject actual baked code/dependency/profile mutations.
    for (const path of [
      "apps/service/dist/projection-worker.js",
      "node_modules/yaml/dist/index.js",
      "runtime-profile.json",
    ]) {
      const mutated = await mutateRuntimeImage(image.imageId, path, parent);
      try {
        assert.equal(
          JSON.parse(await runRuntime(mutated.trim(), rejectDriver)).ok,
          true,
        );
      } finally {
        await docker(["image", "rm", "--no-prune", mutated.trim()]);
      }
    }
    for (const kind of ["hardlink", "symlink", "special"]) {
      const mutated = await mutateRuntimeImage(image.imageId, "", parent, kind);
      try {
        const driver =
          kind === "hardlink"
            ? `import assert from 'node:assert/strict'; import {hashRuntimeArtifact} from '/opt/bookie/apps/service/dist/runtime-artifact.js'; import {qualifyRuntime} from '/opt/bookie/apps/service/dist/runtime-qualification.js'; const current=await hashRuntimeArtifact('/opt/bookie'); await assert.rejects(qualifyRuntime(current),${JSON.stringify(bad)}); console.log('{"ok":true}');`
            : rejectDriver;
        assert.equal(JSON.parse(await runRuntime(mutated, driver)).ok, true);
      } finally {
        await docker(["image", "rm", "--no-prune", mutated]);
      }
    }
    // Real cancellation must remove its owned container, not just its Docker client.
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import {runRuntime} from ${JSON.stringify(new URL("../../scripts/qualify-runtime.mjs", import.meta.url).href)}; await runRuntime(${JSON.stringify(image.imageId)},'setInterval(()=>{},1000)');`,
      ],
      { stdio: "ignore" },
    );
    const closed = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code));
    });
    try {
      let running = false;
      for (let i = 0; i < 100; i++) {
        if (
          (await docker([
            "ps",
            "--filter",
            `name=bookie-runtime-${child.pid}-`,
            "--format",
            "{{.ID}}",
          ])) !== ""
        ) {
          running = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(running, true);
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
      try {
        assert.equal(await closed, 1);
      } finally {
        clearTimeout(timer);
      }
      assert.equal(
        await docker([
          "ps",
          "-a",
          "--filter",
          `name=bookie-runtime-${child.pid}-`,
          "--format",
          "{{.ID}}",
        ]),
        "",
      );
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await closed;
      }
    }
    const staged = join(parent, "extracted-runtime");
    await extractRuntime(image.imageId, staged);
    assert.equal(
      JSON.parse(
        await runRuntime(image.imageId, rejectDriver, {
          mounts: [
            `type=bind,src=${staged},dst=/opt/bookie,readonly`,
            `type=bind,src=${staged},dst=/runtime-alias`,
          ],
        }),
      ).ok,
      true,
    );
    // The nested dependency is byte-identical and read-only, but its backing
    // tree must not also be exposed through a visible writable alias.
    const dependency = join(staged, "node_modules/yaml");
    const dependencyMount = `type=bind,src=${dependency},dst=/opt/bookie/node_modules/yaml,readonly`;
    const qualifyDriver = `import {qualifyRuntime} from '/opt/bookie/apps/service/dist/runtime-qualification.js'; console.log(await qualifyRuntime(${JSON.stringify(image.artifactHash)}));`;
    assert.equal(
      await runRuntime(image.imageId, qualifyDriver, {
        mounts: [dependencyMount],
      }),
      image.artifactHash,
    );
    assert.equal(
      JSON.parse(
        await runRuntime(image.imageId, rejectDriver, {
          mounts: [
            dependencyMount,
            `type=bind,src=${dependency},dst=/dependency-alias`,
          ],
        }),
      ).ok,
      true,
    );
    // Manifest-lock inconsistency cannot produce a successful image/record.
    const manifestPath = join(contexts[1], "apps/service/package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.dependencies.yaml = "0.0.1";
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(
      buildRuntime(contexts[1]),
      /Runtime image build failed\./u,
    );
    const output = JSON.stringify({
      version: 1,
      images,
      output: results[0],
      driverHash: hash(
        await readFile(
          new URL("../../scripts/qualify-runtime.mjs", import.meta.url),
        ),
      ),
      testHash: hash(await readFile(import.meta.filename)),
    });
    for (const canary of [
      "HOST_CREDENTIAL_CANARY",
      excludedUid,
      excludedPath,
      excludedMarker,
      secret,
    ])
      assert.equal(output.includes(canary), false);
    reportOutput = output;
  },
);
