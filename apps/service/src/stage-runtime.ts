import { cp, lstat, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, dirname } from "node:path";
import { hashRuntimeArtifact } from "./runtime-artifact.js";

const maxBytes = 2 * 1024 * 1024 * 1024;
const maxEntries = 100_000;
const packagePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
function invalid(): never {
  throw new TypeError("Runtime staging failed.");
}
function inside(path: string, parent: string): boolean {
  const rel = relative(parent, path);
  return (
    rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel))
  );
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Build-time only: stage compiled artifacts from a trusted, already-installed
 * workspace. This does not attest npm integrity, pin an image, seal the target,
 * or authorize a rebuild. The caller must use a private build directory.
 */
export async function stageRuntimeArtifact(
  source: string,
  destination: string,
): Promise<`sha256:${string}`> {
  let created = false;
  try {
    if (
      typeof source !== "string" ||
      typeof destination !== "string" ||
      !isAbsolute(source) ||
      !isAbsolute(destination) ||
      source !== resolve(source) ||
      destination !== resolve(destination) ||
      source === "/" ||
      destination === "/" ||
      inside(destination, source) ||
      inside(source, destination)
    )
      invalid();
    const root = await realpath(source);
    if (root !== source || !(await lstat(root)).isDirectory()) invalid();
    if ((await realpath(dirname(destination))) !== dirname(destination))
      invalid();
    await mkdir(destination);
    created = true;
    let totalBytes = 0;
    let entries = 0;
    async function copy(
      from: string,
      to: string,
      omitNestedModules = false,
    ): Promise<void> {
      // Check the entire selected path, not only its last component: an
      // intermediate node_modules symlink could otherwise escape this build root.
      if ((await realpath(from)) !== from) invalid();
      const sourceTree = from;
      await mkdir(dirname(to), { recursive: true });
      await cp(from, to, {
        recursive: true,
        force: false,
        errorOnExist: true,
        filter: async (path) => {
          const rel = relative(sourceTree, path);
          if (
            omitNestedModules &&
            (rel === "node_modules" || rel.startsWith("node_modules/"))
          )
            return false;
          const parts = rel.split("/");
          if (parts.includes(".bin")) return false;
          const entry = await lstat(path);
          if (!entry.isFile() && !entry.isDirectory()) invalid();
          if (++entries > maxEntries) invalid();
          if (entry.isFile()) {
            if (entry.size > maxBytes - totalBytes) invalid();
            totalBytes += entry.size;
          }
          return true;
        },
      });
    }
    type Dependency = Readonly<{
      identity: string;
      kind: "optional" | "required";
    }>;
    async function manifest(
      at: string,
      name?: string,
    ): Promise<Record<string, Dependency>> {
      const path = join(at, "package.json");
      if ((await realpath(path)) !== path) invalid();
      const info = await lstat(path);
      if (!info.isFile() || info.size > 65536) invalid();
      const value: unknown = JSON.parse(await readFile(path, "utf8"));
      if (!object(value) || (name !== undefined && value.name !== name))
        invalid();
      const dependencies: Record<string, Dependency> = Object.create(
        null,
      ) as Record<string, Dependency>;
      const peerMeta = value.peerDependenciesMeta;
      if (
        peerMeta !== undefined &&
        (!object(peerMeta) || Object.keys(peerMeta).length > 512)
      )
        invalid();
      for (const key of [
        "dependencies",
        "optionalDependencies",
        "peerDependencies",
      ]) {
        const section = value[key];
        if (section === undefined) continue;
        if (!object(section) || Object.keys(section).length > 512) invalid();
        for (const [dep, version] of Object.entries(section)) {
          if (
            !packagePattern.test(dep) ||
            ["__proto__", "constructor", "prototype"].includes(dep) ||
            Buffer.byteLength(dep) > 255 ||
            typeof version !== "string"
          )
            invalid();
          let identity = dep;
          if (version.startsWith("npm:")) {
            const alias = version.slice(4);
            const split = alias.lastIndexOf("@");
            identity = alias.slice(0, split);
            if (
              split <= 0 ||
              !packagePattern.test(identity) ||
              alias.length - split < 2 ||
              alias.length > 255 ||
              /[\s\\]/u.test(alias)
            )
              invalid();
          }
          const entry = object(peerMeta) ? peerMeta[dep] : undefined;
          if (
            entry !== undefined &&
            (!object(entry) ||
              (entry.optional !== undefined &&
                typeof entry.optional !== "boolean"))
          )
            invalid();
          const optional =
            key === "optionalDependencies" ||
            (key === "peerDependencies" &&
              object(entry) &&
              entry.optional === true);
          // npm's optional declaration replaces the same-name dependency,
          // including alias identity. Peers remain independent requirements.
          if (
            key === "peerDependencies" &&
            dependencies[dep] !== undefined &&
            dependencies[dep].identity !== identity
          )
            invalid();
          if (
            key !== "peerDependencies" ||
            dependencies[dep]?.kind !== "required"
          )
            dependencies[dep] = {
              identity,
              kind: optional ? "optional" : "required",
            };
        }
      }
      return dependencies;
    }
    // Copy only the compiled/runtime-owned inputs; never the canonical source or Git data.
    for (const path of [
      "package.json",
      "package-lock.json",
      "apps/service/package.json",
      "packages/core/package.json",
    ])
      await copy(join(root, path), join(destination, path));
    for (const path of ["apps/service/dist", "packages/core/dist"])
      await copy(join(root, path), join(destination, path));
    for (const path of [
      "schemas/bookie-common.schema.json",
      "schemas/service/v1/protocol.schema.json",
    ])
      await copy(join(root, path), join(destination, path));
    const coreLink = join(root, "node_modules/@bookie/core");
    if (
      !(await lstat(coreLink)).isSymbolicLink() ||
      (await realpath(coreLink)) !== join(root, "packages/core")
    )
      invalid();
    for (const path of ["package.json", "dist"])
      await copy(
        join(root, "packages/core", path),
        join(destination, "node_modules/@bookie/core", path),
      );
    const todo: {
      name: string;
      identity: string;
      from: string;
      optional: boolean;
    }[] = [];
    const enqueue = (deps: Record<string, Dependency>, from: string): void => {
      for (const [name, dependency] of Object.entries(deps)) {
        if (name !== "@bookie/core") {
          if (todo.length >= 4096) invalid();
          todo.push({
            name,
            identity: dependency.identity,
            from,
            optional: dependency.kind === "optional",
          });
        }
      }
    };
    enqueue(
      await manifest(join(root, "apps/service"), "@bookie/service"),
      join(root, "apps/service"),
    );
    enqueue(
      await manifest(join(root, "packages/core"), "@bookie/core"),
      join(root, "packages/core"),
    );
    const copied = new Set<string>();
    while (todo.length > 0) {
      const item = todo.shift()!;
      let parent = item.from;
      let found: string | undefined;
      while (inside(parent, root)) {
        const candidate = join(parent, "node_modules", item.name);
        try {
          const info = await lstat(candidate);
          if (!info.isDirectory()) invalid();
          found = candidate;
          break;
        } catch (error) {
          if (!object(error) || error.code !== "ENOENT") throw error;
        }
        if (parent === root) break;
        parent = dirname(parent);
      }
      if (found === undefined) {
        if (item.optional) continue;
        invalid();
      }
      if (copied.has(found)) continue;
      if (copied.size >= 1024) invalid();
      const dependencies = await manifest(found, item.identity);
      await copy(found, join(destination, relative(root, found)), true);
      copied.add(found);
      enqueue(dependencies, found);
    }
    // A complete inventory verifies required runtime assets, symlink freedom and bounds.
    return await hashRuntimeArtifact(destination);
  } catch {
    if (created) await rm(destination, { recursive: true, force: true });
    invalid();
  }
}
