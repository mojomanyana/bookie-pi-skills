import { createHash, timingSafeEqual } from "node:crypto";
import { open, readdir, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join } from "node:path";

/** Build-time inventory of a sealed, self-contained runtime tree; not source authorization. */
const required = [
  "package.json",
  "package-lock.json",
  "apps/service/package.json",
  "apps/service/dist/server.js",
  "packages/core/package.json",
  "packages/core/dist/index.js",
];
// Core reads its packaged schema copies; server.ts also reads two root schema assets.
const schemaFiles = [
  "bookie-common.schema.json",
  "service/v1/protocol.schema.json",
  "profile/1.0/bookie-config.schema.json",
  ...[
    "activity",
    "decision",
    "document",
    "evidence",
    "person",
    "project",
    "research",
    "task",
  ].map((type) => `types/${type}.schema.json`),
];
const maxInventoryBytes = 2 * 1024 * 1024 * 1024;
const maxInventoryFiles = 100_000;
function invalid(): never {
  throw new TypeError("Runtime artifact is invalid.");
}
interface InventoryOptions {
  readonly maxBytes?: number;
  readonly maxFiles?: number;
}

/**
 * Hash all bytes and executable bits under the sealed staging root, plus the
 * running Node executable and exact Node/ABI version. Nothing may be excluded.
 * No symlinks, sockets, device files or writable in-place install are supported.
 * Call during packaging and again in the isolated builder on the same staged
 * tree; never treat a user-supplied digest as a verified artifact.
 */
export async function hashRuntimeArtifact(
  root: string,
  options: InventoryOptions = {},
): Promise<`sha256:${string}`> {
  try {
    if (
      typeof root !== "string" ||
      !isAbsolute(root) ||
      root.includes("\0") ||
      options === null ||
      typeof options !== "object" ||
      Array.isArray(options) ||
      Object.keys(options).some(
        (key) => !["maxBytes", "maxFiles"].includes(key),
      )
    )
      invalid();
    const bytes = options.maxBytes ?? maxInventoryBytes;
    const files = options.maxFiles ?? maxInventoryFiles;
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 1 ||
      bytes > maxInventoryBytes ||
      !Number.isSafeInteger(files) ||
      files < 1 ||
      files > maxInventoryFiles
    )
      invalid();
    const entries: (readonly [string, ...unknown[]])[] = [];
    const seen = new Set<string>();
    const digests = new Map<string, string>();
    let totalBytes = 0;
    async function digestFile(
      path: string,
      limit: number,
      observed?: import("node:fs").Stats,
    ): Promise<string> {
      const handle = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const before = await handle.stat();
        if (
          !before.isFile() ||
          before.size > limit ||
          before.size < 0 ||
          (observed !== undefined &&
            (before.dev !== observed.dev ||
              before.ino !== observed.ino ||
              before.size !== observed.size ||
              before.mode !== observed.mode ||
              before.mtimeMs !== observed.mtimeMs ||
              before.ctimeMs !== observed.ctimeMs))
        )
          invalid();
        const digest = createHash("sha256");
        const buffer = Buffer.allocUnsafe(65536);
        let offset = 0;
        while (offset < before.size) {
          const { bytesRead } = await handle.read(
            buffer,
            0,
            Math.min(buffer.length, before.size - offset),
            offset,
          );
          if (bytesRead <= 0) invalid();
          digest.update(buffer.subarray(0, bytesRead));
          offset += bytesRead;
        }
        const after = await handle.stat();
        if (
          after.size !== before.size ||
          after.mtimeMs !== before.mtimeMs ||
          after.ino !== before.ino ||
          after.mode !== before.mode ||
          after.ctimeMs !== before.ctimeMs
        )
          invalid();
        return digest.digest("hex");
      } finally {
        await handle.close();
      }
    }
    async function visit(
      directory: string,
      relative: string,
      depth: number,
    ): Promise<void> {
      if (depth > 64) invalid();
      const stat = await lstat(directory);
      if (!stat.isDirectory() || entries.length >= files) invalid();
      entries.push(["d", relative, stat.mode & 0o777]);
      const children = (await readdir(directory)).sort();
      for (const name of children) {
        const path = join(directory, name);
        const child = relative ? `${relative}/${name}` : name;
        if (Buffer.byteLength(child) > 4096 || Buffer.byteLength(name) > 255)
          invalid();
        const info = await lstat(path);
        if (info.isDirectory()) {
          await visit(path, child, depth + 1);
        } else if (info.isFile()) {
          if (entries.length >= files || info.size > bytes - totalBytes)
            invalid();
          const digest = await digestFile(path, bytes - totalBytes, info);
          totalBytes += info.size;
          seen.add(child);
          digests.set(child, digest);
          entries.push(["f", child, digest, info.size, info.mode & 0o777]);
        } else invalid();
      }
      const after = await lstat(directory);
      if (
        !after.isDirectory() ||
        after.dev !== stat.dev ||
        after.ino !== stat.ino ||
        after.mode !== stat.mode ||
        after.mtimeMs !== stat.mtimeMs ||
        after.ctimeMs !== stat.ctimeMs
      )
        invalid();
    }
    await visit(root, "", 0);
    if (
      !required.every((path) => seen.has(path)) ||
      !schemaFiles.every((path) =>
        seen.has(`packages/core/dist/schemas/${path}`),
      ) ||
      !["bookie-common.schema.json", "service/v1/protocol.schema.json"].every(
        (path) =>
          digests.has(`schemas/${path}`) &&
          digests.get(`schemas/${path}`) ===
            digests.get(`packages/core/dist/schemas/${path}`),
      ) ||
      ![...seen].some(
        (path) => path.startsWith("node_modules/") && path.endsWith(".js"),
      )
    )
      invalid();
    // Include the *running* executable, not a caller's asserted Node version or digest.
    const nodeHash = await digestFile(process.execPath, 256 * 1024 * 1024);
    const serialization = JSON.stringify([
      "bookie-runtime-artifact",
      2,
      process.version,
      process.versions.modules,
      nodeHash,
      entries,
    ]);
    return `sha256:${createHash("sha256").update(serialization, "utf8").digest("hex")}`;
  } catch {
    invalid();
  }
}

/** Recompute from staged bytes and the running Node binary; never trust a supplied hash. */
export async function verifyRuntimeArtifact(
  root: string,
  expected: string,
): Promise<`sha256:${string}`> {
  if (typeof expected !== "string" || !/^sha256:[a-f0-9]{64}$/.test(expected))
    invalid();
  const measured = await hashRuntimeArtifact(root);
  if (!timingSafeEqual(Buffer.from(measured), Buffer.from(expected))) invalid();
  return measured;
}
