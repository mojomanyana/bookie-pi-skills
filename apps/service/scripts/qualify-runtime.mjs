import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repository = resolve(import.meta.dirname, "../../..");
const owned = new Set();
const active = new Map();
const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const hash = (bytes) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function command(
  program,
  args,
  { input, timeout = 300000, allowFailure = false } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      timeout,
    });
    active.set(child, new Promise((closed) => child.once("close", closed)));
    let stdout = "",
      stderr = "",
      overflow = false;
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > 4 * 1024 * 1024) {
        overflow = true;
        child.kill("SIGKILL");
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (Buffer.byteLength(stderr) > 4 * 1024 * 1024) {
        overflow = true;
        child.kill("SIGKILL");
      }
    });
    child.on("error", reject);
    child.once("close", (code, signal) => {
      active.delete(child);
      if (allowFailure && !overflow) resolve({ code, signal, stdout, stderr });
      else if (code === 0 && !overflow) resolve(stdout.trim());
      else
        reject(
          Object.defineProperties(
            new Error("Runtime qualification command failed."),
            {
              code: { value: code, enumerable: true },
              signal: { value: signal, enumerable: true },
              stdout: { value: stdout },
              stderr: { value: stderr },
            },
          ),
        );
    });
    if (input !== undefined) {
      child.stdin.on("error", reject);
      child.stdin.end(input);
    }
  });
}
export async function docker(args, options) {
  if (args[0] !== "run" || !args.includes("--rm"))
    return await command("docker", args, options);
  const name = `bookie-runtime-${process.pid}-${randomBytes(8).toString("hex")}`;
  owned.add(name);
  try {
    return await command(
      "docker",
      [
        "run",
        "--name",
        name,
        "--memory",
        "1g",
        "--cpus",
        "2",
        "--pids-limit",
        "128",
        ...args.slice(1).filter((arg) => arg !== "--rm"),
      ],
      options,
    );
  } finally {
    await removeContainer(name);
  }
}

export async function privateWorkspace() {
  const directory = join(repository, ".principal");
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(join(directory, ".gitignore"), "*\n", { flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const path = await mkdtemp(join(directory, "runtime-qualification-"));
  await command("git", ["-C", repository, "check-ignore", path]);
  return path;
}

async function removeContainer(name) {
  const result = await docker(["rm", "-f", name], {
    allowFailure: true,
    timeout: 15000,
  });
  if (result.code !== 0 && !/no such container/iu.test(result.stderr))
    throw Error("Runtime container teardown unconfirmed.");
  const remaining = await docker(
    ["ps", "-a", "--filter", `name=^/${name}$`, "--format", "{{.ID}}"],
    { timeout: 15000 },
  );
  if (remaining !== "") throw Error("Runtime container teardown unconfirmed.");
  owned.delete(name);
}
// Cancellation never treats a killed Docker client as proof of container cleanup.
if (!isMain)
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => {
      const children = [...active];
      void (async () => {
        await Promise.all([...owned].map(removeContainer));
        for (const [child] of children) {
          if (child.exitCode !== null || child.signalCode !== null) continue;
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch (error) {
            if (error.code !== "ESRCH") throw error;
          }
        }
        let timer;
        try {
          await Promise.race([
            Promise.all(children.map(([, closed]) => closed)),
            new Promise((_, reject) => {
              timer = setTimeout(
                () => reject(Error("Runtime child teardown unconfirmed.")),
                1000,
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      })().then(
        () => process.exit(1),
        () => {
          console.error("Runtime container/child teardown unconfirmed.");
          process.exit(1);
        },
      );
    });

export async function runRuntime(imageId, driver, options = {}) {
  if (!/^sha256:[a-f0-9]{64}(?![\s\S])/u.test(imageId))
    throw Error("Immutable runtime image ID required.");
  const name = `bookie-runtime-${process.pid}-${randomBytes(8).toString("hex")}`;
  const args = [
    "run",
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
    options.rootUser ? "0:0" : "65534:65534",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=64m",
    "--entrypoint",
    "/usr/local/bin/node",
  ];
  if (!options.writableRoot) args.push("--read-only");
  if (!options.capabilities) args.push("--cap-drop", "ALL");
  if (!options.privileges) args.push("--security-opt", "no-new-privileges");
  if (options.source)
    args.push(
      "--mount",
      `type=bind,src=${options.source},dst=/vault${options.writableSource ? "" : ",readonly"}`,
    );
  for (const mount of options.mounts ?? []) args.push("--mount", mount);
  for (const variable of options.env ?? []) args.push("--env", variable);
  args.push(imageId, "--input-type=module", "-e", driver);
  owned.add(name);
  try {
    return await docker(args, { timeout: 45000 });
  } finally {
    await removeContainer(name);
  }
}

async function inputHash(context) {
  const inputs = [];
  for (const name of [
    "package.json",
    "package-lock.json",
    "apps/service/package.json",
    "apps/service/tsconfig.json",
    "apps/service/Dockerfile",
    "apps/service/Dockerfile.dockerignore",
    "packages/core/package.json",
    "packages/core/tsconfig.json",
    "packages/core/scripts/copy-schemas.mjs",
    "packages/cli/package.json",
    "packages/pi-extension/package.json",
  ])
    inputs.push(name);
  for (const directory of ["apps/service/src", "packages/core/src", "schemas"])
    for (const name of await readdir(join(context, directory), {
      recursive: true,
    })) {
      const path = `${directory}/${name}`;
      const info = await lstat(join(context, path));
      if (info.isFile() && (path.endsWith(".ts") || path.endsWith(".json")))
        inputs.push(path);
    }
  const entries = [];
  for (const path of inputs.sort())
    entries.push([path, hash(await readFile(join(context, path)))]);
  return hash(JSON.stringify(entries));
}

/** A build result is only candidate evidence; the command's integration tests
 * must succeed before publishing its qualification record. No registry/Git writes.
 */
export async function buildRuntime(context) {
  const lockBefore = await readFile(join(context, "package-lock.json"));
  const inputs = await inputHash(context);
  const result = await docker(
    [
      "build",
      "--no-cache",
      "--pull",
      "--platform",
      "linux/amd64",
      "-q",
      "-f",
      join(context, "apps/service/Dockerfile"),
      context,
    ],
    { allowFailure: true },
  );
  if (result.code !== 0)
    throw Object.defineProperty(
      new Error("Runtime image build failed."),
      "diagnostic",
      { value: result.stderr },
    );
  const imageId = result.stdout.trim();
  if (!/^sha256:[a-f0-9]{64}(?![\s\S])/u.test(imageId))
    throw Error("Runtime image build failed.");
  try {
    if (
      !(await readFile(join(context, "package-lock.json"))).equals(lockBefore)
    )
      throw Error("Runtime lockfile changed.");
    const artifactHash = await runRuntime(
      imageId,
      `import {hashRuntimeArtifact} from '/opt/bookie/apps/service/dist/runtime-artifact.js'; console.log(await hashRuntimeArtifact('/opt/bookie'));`,
    );
    const profile = JSON.parse(
      await runRuntime(
        imageId,
        `import {readFileSync,readdirSync} from 'node:fs'; import {createHash} from 'node:crypto'; import assert from 'node:assert/strict'; assert.equal('sha256:'+createHash('sha256').update(readFileSync('/opt/bookie/package-lock.json')).digest('hex'),${JSON.stringify(hash(lockBefore))}); import {qualifyRuntime} from '/opt/bookie/apps/service/dist/runtime-qualification.js'; await qualifyRuntime(${JSON.stringify(artifactHash)}); for(const name of ['typescript','@earendil-works','@bookie/cli','@bookie/pi-extension']) assert.equal(readdirSync('/opt/bookie/node_modules').includes(name),false); const paths=readdirSync('/opt/bookie',{recursive:true}); for(const path of paths) { assert.equal(path.includes('stale.js'),false); assert.equal(path.includes('.env'),false); if(!path.endsWith('/')) { try { const bytes=readFileSync('/opt/bookie/'+path); assert.equal(bytes.includes('HOST_CREDENTIAL_CANARY'),false); } catch(e) { if(e.code !== 'EISDIR') throw e; } } } console.log(readFileSync('/opt/bookie/runtime-profile.json','utf8'));`,
      ),
    );
    return {
      imageId,
      artifactHash,
      lockHash: hash(lockBefore),
      inputHash: inputs,
      profile,
    };
  } catch (error) {
    await docker(["image", "rm", "--no-prune", imageId]);
    throw error;
  }
}

export async function mutateRuntimeImage(
  imageId,
  path,
  parent,
  kind = "append",
) {
  const name = `bookie-runtime-${process.pid}-${randomBytes(8).toString("hex")}`;
  const file = join(parent, `mutation-${randomBytes(8).toString("hex")}`);
  owned.add(name);
  try {
    if (kind === "append") {
      await docker(["create", "--name", name, imageId]);
      await docker(["cp", `${name}:/opt/bookie/${path}`, file]);
      await writeFile(
        file,
        Buffer.concat([await readFile(file), Buffer.from("\n ")]),
      );
      await docker(["cp", file, `${name}:/opt/bookie/${path}`]);
    } else {
      const commands = {
        hardlink: "ln /opt/bookie/package.json /opt/bookie/alias",
        symlink: "ln -s /etc/passwd /opt/bookie/alias",
        special: "mkfifo /opt/bookie/alias",
      };
      if (!Object.hasOwn(commands, kind))
        throw Error("Runtime mutation fixture invalid.");
      await docker([
        "create",
        "--name",
        name,
        "--network",
        "none",
        "--user",
        "0:0",
        "--entrypoint",
        "/bin/sh",
        imageId,
        "-c",
        commands[kind],
      ]);
      await docker(["start", "-a", name]);
    }
    return await docker(["commit", "--change", "USER 65534:65534", name]);
  } finally {
    await removeContainer(name);
  }
}

export async function extractRuntime(imageId, destination) {
  const name = `bookie-runtime-${process.pid}-${randomBytes(8).toString("hex")}`;
  owned.add(name);
  try {
    await docker(["create", "--name", name, imageId]);
    await docker(["cp", `${name}:/opt/bookie`, destination]);
  } finally {
    await removeContainer(name);
  }
}

if (isMain) {
  const child = spawn(
    process.execPath,
    [
      "--test",
      join(repository, "apps/service/test/deployment/runtime.test.mjs"),
    ],
    { stdio: "inherit" },
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => {
      child.kill(signal);
    });
  child.on("error", () => {
    console.error("Runtime qualification failed.");
    process.exitCode = 1;
  });
  child.once("close", (code) => {
    process.exitCode = code ?? 1;
  });
}
