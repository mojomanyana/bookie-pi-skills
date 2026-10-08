import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
  chmod,
  chown,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";

const repository = resolve(import.meta.dirname, "../../../..");
const image =
  "node:24.19.0-bookworm@sha256:4196d66a565c6f195728d9952f161f4adfe2ad753052a08b7ec7f1c5a6bda42b";
const uid = process.getuid() || 65534;
const gid = process.getgid() || 65534;
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
function git(root, args) {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (key.startsWith("GIT_")) delete env[key];
  Object.assign(env, {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  });
  const result = spawnSync(
    "git",
    [
      "-C",
      root,
      "-c",
      "user.name=Deployment Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgSign=false",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    { encoding: "utf8", env },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
async function ownership(root) {
  if (process.getuid() !== 0) return;
  await chown(root, uid, gid);
  for (const path of await readdir(root, { recursive: true }))
    await chown(join(root, path), uid, gid);
}
function docker(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve(stdout.trim())
        : reject(new Error(`Deployment test container failed: ${stderr}`)),
    );
  });
}

test(
  "Linux read-only deployment ingestion and source preflight",
  { timeout: 180000 },
  async (t) => {
    const parent = await mkdtemp(join(tmpdir(), "bookie-deployment-"));
    t.after(() => rm(parent, { recursive: true, force: true }));
    const app = join(parent, "app");
    await mkdir(join(app, "node_modules"), { recursive: true });
    for (const pkg of ["apps/service", "packages/core"]) {
      await mkdir(join(app, pkg), { recursive: true });
      await cp(join(repository, pkg, "dist"), join(app, pkg, "dist"), {
        recursive: true,
      });
      await cp(
        join(repository, pkg, "package.json"),
        join(app, pkg, "package.json"),
      );
    }
    const base = join(parent, "base");
    await cp(join(repository, "examples/vault"), base, { recursive: true });
    git(base, ["init", "-q"]);
    git(base, ["add", "-A"]);
    git(base, ["commit", "-qm", "read-only source"]);
    const commit = git(base, ["rev-parse", "HEAD"]);
    git(base, ["update-ref", "refs/heads/approved", commit]);
    let counter = 0;
    async function fixture() {
      const root = join(parent, `fixture-${counter++}`);
      await cp(base, root, { recursive: true });
      await ownership(root);
      return root;
    }
    async function run(root, options = {}) {
      const name = `bookie-deployment-${process.pid}-${randomBytes(5).toString("hex")}`;
      const deployment = { ...config, ...options.config };
      const driver = `
      import { prepareDeploymentLexicalProjection, preflightDeploymentSource } from '/app/apps/service/dist/ingestion.js';
      const result = await ${options.preflight ? "preflightDeploymentSource" : "prepareDeploymentLexicalProjection"}(${JSON.stringify(deployment)}, { sourceRef: ${JSON.stringify(options.sourceRef ?? commit)}${options.preflight ? ", timeoutMs: 7000" : ""} });
      console.log(JSON.stringify(${options.preflight ? "result" : "result.ok ? { ok: true, approvedTip: result.approvedTip, commit: result.projection.sourceCommit, concepts: result.projection.concepts.length, chunks: result.projection.chunks.length } : result"}));
    `;
      const args = [
        "run",
        "--rm",
        "--name",
        name,
        "--network",
        "none",
        "--memory",
        "2g",
        "--cpus",
        "2",
        "--pids-limit",
        "128",
        "--user",
        options.rootUser ? "0:0" : `${uid}:${gid}`,
        "--entrypoint",
        "node",
      ];
      if (!options.writableRoot) args.push("--read-only");
      if (!options.capabilities) args.push("--cap-drop", "ALL");
      if (!options.privileges) args.push("--security-opt", "no-new-privileges");
      args.push(
        "--mount",
        `type=bind,src=${app},dst=/app,readonly`,
        "--mount",
        `type=bind,src=${join(repository, "node_modules")},dst=/app/node_modules,readonly`,
        "--mount",
        `type=bind,src=${root},dst=/vault${options.writableVault ? "" : ",readonly"}`,
      );
      for (const mount of options.mounts ?? []) args.push("--mount", mount);
      for (const environment of options.env ?? [])
        args.push("--env", environment);
      args.push(image, "--input-type=module", "-e", driver);
      const pending = docker(args);
      // Attach immediately so an early Docker failure cannot become unhandled.
      const result = pending.then((text) => JSON.parse(text));
      try {
        const [value] = await Promise.all([result, options.during?.()]);
        return value;
      } finally {
        await docker(["rm", "-f", name]).catch((error) => {
          if (!error.message.includes("No such container")) throw error;
        });
      }
    }
    const reject = async (root, options = {}) => {
      for (const preflight of [false, true]) {
        await options.before?.();
        assert.deepEqual(await run(root, { ...options, preflight }), {
          ok: false,
          reason: "deployment-rejected",
        });
      }
    };
    await t.test(
      "ordinary read-only checkout completes exact-commit ingestion",
      async () => {
        const result = await run(await fixture());
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.equal(result.approvedTip, commit);
        assert.equal(result.commit, commit);
        assert.equal(result.concepts, 8);
        assert.ok(result.chunks > 0);
      },
    );
    await t.test(
      "preflight reads only manifest content, including when the rest of the corpus cannot be read",
      async () => {
        const root = await fixture();
        const bytes = await readFile(join(root, "bookie.yaml"));
        git(root, ["rm", "-r", "-f", "."]);
        await writeFile(join(root, "bookie.yaml"), bytes);
        await writeFile(
          join(root, "broken.md"),
          "PRIVATE_CORPUS_NOT_A_CONCEPT",
        );
        git(root, ["add", "-A"]);
        git(root, ["commit", "-qm", "manifest only with missing corpus blob"]);
        const sourceRef = git(root, ["rev-parse", "HEAD"]);
        const missingBlob = git(root, ["rev-parse", `${sourceRef}:broken.md`]);
        const manifestBlob = git(root, [
          "rev-parse",
          `${sourceRef}:bookie.yaml`,
        ]);
        git(root, ["update-ref", config.approvedRef, sourceRef]);
        await rm(
          join(
            root,
            ".git/objects",
            missingBlob.slice(0, 2),
            missingBlob.slice(2),
          ),
        );
        await ownership(root);
        const signals = join(parent, "trace");
        await mkdir(signals);
        await ownership(signals);
        const bin = join(app, "trace-bin");
        await mkdir(bin);
        await writeFile(
          join(bin, "git"),
          '#!/bin/sh\nprintf "%s\\n" "---" "$@" >> /signals/trace\nexec /usr/bin/git "$@"\n',
          { mode: 0o755 },
        );
        const options = {
          preflight: true,
          sourceRef,
          mounts: [`type=bind,src=${signals},dst=/signals`],
          env: ["PATH=/app/trace-bin:/usr/local/bin:/usr/bin:/bin"],
        };
        const result = await run(root, options);
        assert.deepEqual(result, {
          ok: true,
          sourceCommit: sourceRef,
          approvedTip: sourceRef,
          objectFormat: "sha1",
          vaultScope: "",
          manifest: {
            vaultUid: config.projection.vaultUid,
            profile: "1.0",
            hash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
            sensitivityClasses: ["public", "internal", "restricted"],
          },
        });
        const trace = await readFile(join(signals, "trace"), "utf8");
        assert.equal(trace.includes(missingBlob), false);
        assert.equal(trace.includes("--batch"), false);
        assert.equal(trace.includes("\n-r\n"), false);
        assert.equal(trace.match(/\nshow-ref\n/gu)?.length, 1);
        assert.equal(trace.match(/\nls-tree\n/gu)?.length, 1);
        assert.equal(trace.match(/\nblob\n/gu)?.length, 1);
        assert.ok(trace.includes(`\ncat-file\nblob\n${manifestBlob}\n`));
        assert.equal(
          (
            await run(root, {
              ...options,
              config: {
                projection: {
                  ...config.projection,
                  approvedSensitivityClasses: [],
                },
              },
            })
          ).ok,
          true,
        );
        assert.deepEqual(
          await run(root, {
            ...options,
            config: {
              projection: {
                ...config.projection,
                approvedSensitivityClasses: ["undeclared"],
              },
            },
          }),
          { ok: false, reason: "sensitivity-policy" },
        );
        assert.deepEqual(
          await run(root, {
            ...options,
            config: {
              projection: {
                ...config.projection,
                vaultUid: "VLT-00000000000000000000000008",
              },
            },
          }),
          { ok: false, reason: "manifest-unavailable" },
        );
        assert.deepEqual(
          await run(root, { ...options, sourceRef: "a".repeat(40) }),
          { ok: false, reason: "source-not-approved" },
        );
        // Restore the intentionally missing object only after proving preflight
        // never reads it; Git requires it to construct the next fixture commit.
        assert.equal(
          git(root, ["hash-object", "-w", "broken.md"]),
          missingBlob,
        );
        await writeFile(join(root, "bookie.yaml"), "PRIVATE_INVALID_MANIFEST");
        git(root, ["add", "bookie.yaml"]);
        git(root, ["commit", "-qm", "invalid manifest"]);
        const invalid = git(root, ["rev-parse", "HEAD"]);
        git(root, ["update-ref", config.approvedRef, invalid]);
        await ownership(root);
        assert.deepEqual(await run(root, { ...options, sourceRef: invalid }), {
          ok: false,
          reason: "manifest-unavailable",
        });
      },
    );
    await t.test(
      "writable mounts, nested Git mounts and writable aliases are rejected",
      async () => {
        const root = await fixture();
        const extra = join(parent, "extra");
        await mkdir(extra);
        await mkdir(join(root, "nested"));
        await ownership(extra);
        for (const options of [
          { writableRoot: true },
          { writableVault: true },
          { mounts: [`type=bind,src=${join(root, ".git")},dst=/vault/.git`] },
          { mounts: [`type=bind,src=${extra},dst=/vault/nested`] },
          { mounts: [`type=bind,src=${root},dst=/writable-alias`] },
        ])
          await reject(root, options);
      },
    );
    await t.test(
      "root identity, retained capabilities and privilege escalation are rejected",
      async () => {
        const root = await fixture();
        for (const options of [
          { rootUser: true },
          { capabilities: true },
          { privileges: true },
        ])
          await reject(root, options);
      },
    );
    await t.test(
      "gitfiles, symlinked Git objects, alternates and config indirection fail before projection",
      async () => {
        const changes = [
          async (root) => {
            await rm(join(root, ".git"), { recursive: true });
            await writeFile(join(root, ".git"), "gitdir: /outside\n");
          },
          async (root) => {
            await rm(join(root, ".git"), { recursive: true });
            await symlink("/outside", join(root, ".git"));
          },
          async (root) => {
            await writeFile(join(root, ".git/commondir"), "/outside\n");
          },
          async (root) => {
            await writeFile(
              join(root, ".git/objects/info/alternates"),
              "/outside\n",
            );
          },
          async (root) => {
            await symlink("/outside", join(root, ".git/objects/escape"));
          },
          ...[
            "[core]\nworktree = /outside\n",
            "[include]\npath = /outside\n",
            '[includeIf "gitdir:**"]\npath = /outside\n',
            '[remote "origin"]\npromisor = true\n',
          ].map((suffix) => async (root) => {
            await writeFile(
              join(root, ".git/config"),
              `${await readFile(join(root, ".git/config"), "utf8")}\n${suffix}`,
            );
          }),
        ];
        for (const change of changes) {
          const root = await fixture();
          await change(root);
          await reject(root);
        }
      },
    );
    await t.test(
      "a nested vault is supported but a shadow repository is not",
      async () => {
        const root = join(parent, "nested-repo");
        await mkdir(root);
        await cp(base, join(root, "nested"), { recursive: true });
        await rm(join(root, "nested/.git"), { recursive: true });
        git(root, ["init", "-q"]);
        git(root, ["add", "-A"]);
        git(root, ["commit", "-qm", "nested source"]);
        const sourceRef = git(root, ["rev-parse", "HEAD"]);
        git(root, ["update-ref", "refs/heads/approved", sourceRef]);
        await ownership(root);
        const options = { sourceRef, config: { root: "/vault/nested" } };
        const result = await run(root, options);
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.equal(result.concepts, 8);
        const receipt = await run(root, { ...options, preflight: true });
        assert.equal(receipt.ok, true);
        assert.equal(receipt.vaultScope, "nested");
        assert.equal(receipt.sourceCommit, sourceRef);
        await symlink("nested", join(root, "link"));
        await reject(root, { sourceRef, config: { root: "/vault/link" } });
        await mkdir(join(root, "nested/.git"));
        await reject(root, options);
      },
    );
    await t.test(
      "Git configuration changes after the first check cannot return a projection or preflight receipt",
      async () => {
        const root = await fixture();
        const signals = join(parent, "signals");
        await mkdir(signals);
        await ownership(signals);
        const bin = join(app, "bin");
        await mkdir(bin);
        await writeFile(
          join(bin, "git"),
          `#!/bin/sh\nfor arg do\n  if [ "$arg" = show-ref ]; then\n    : > /signals/checked\n    while [ ! -f /signals/continue ]; do sleep 0.01; done\n  fi\ndone\nexec /usr/bin/git "$@"\n`,
          { mode: 0o755 },
        );
        await chmod(join(bin, "git"), 0o755);
        await reject(root, {
          mounts: [`type=bind,src=${signals},dst=/signals`],
          env: ["PATH=/app/bin:/usr/local/bin:/usr/bin:/bin"],
          before: async () => {
            await rm(join(signals, "checked"), { force: true });
            await rm(join(signals, "continue"), { force: true });
          },
          during: async () => {
            let checked = false;
            for (let n = 0; n < 500; n++) {
              try {
                await readFile(join(signals, "checked"));
                checked = true;
                break;
              } catch (error) {
                if (error.code !== "ENOENT") throw error;
                await new Promise((resolve) => setTimeout(resolve, 10));
              }
            }
            assert.equal(checked, true, "first deployment check must finish");
            await writeFile(
              join(root, ".git/config"),
              `${await readFile(join(root, ".git/config"), "utf8")}\n# deployment changed during ingestion\n`,
            );
            await writeFile(join(signals, "continue"), "");
          },
        });
      },
    );
  },
);
