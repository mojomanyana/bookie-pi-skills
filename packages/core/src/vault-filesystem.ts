import { createHash } from "node:crypto";
import { constants } from "node:fs";
import type { BigIntStats, Dirent, Stats } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import { throwIfAborted } from "./vault-cancellation.js";
import {
  compareText,
  createDiagnostic,
  DiagnosticCollector,
} from "./vault-diagnostics.js";
import type { ValidationLimits, VaultEntries } from "./vault-model.js";

export type BoundedReadResult =
  | {
      readonly ok: true;
      readonly bytes: Uint8Array;
      readonly before: Stats;
      readonly after: Stats;
    }
  | {
      readonly ok: false;
      readonly reason: "io" | "size" | "unsafe";
      readonly size?: number;
    };

export type BoundedHashResult =
  | {
      readonly ok: true;
      readonly digest: string;
      readonly size: number;
      readonly after: Stats;
    }
  | {
      readonly ok: false;
      readonly reason: "io" | "size" | "unsafe";
      readonly size?: number;
      readonly bytesRead: number;
    };

interface PathIdentity {
  readonly path: string;
  readonly metadata: BigIntStats;
}

interface PathSnapshot {
  readonly identities: readonly PathIdentity[];
  readonly realPath: string;
}

declare const pathTrackerBrand: unique symbol;

export interface PathTracker {
  readonly [pathTrackerBrand]: true;
}

interface TrackedPaths {
  readonly identities: Map<string, BigIntStats>;
  readonly realPaths: Map<string, string>;
  consistent: boolean;
}

const trackedPaths = new WeakMap<PathTracker, TrackedPaths>();

export function createPathTracker(): PathTracker {
  const tracker = Object.freeze({}) as PathTracker;
  trackedPaths.set(tracker, {
    identities: new Map(),
    realPaths: new Map(),
    consistent: true,
  });
  return tracker;
}

function trackIdentity(
  tracker: PathTracker,
  path: string,
  metadata: BigIntStats,
): void {
  const tracked = trackedPaths.get(tracker);
  if (tracked === undefined) {
    throw new TypeError("Path tracker was not created by createPathTracker");
  }
  const previous = tracked.identities.get(path);
  if (previous !== undefined && !samePathIdentity(previous, metadata)) {
    tracked.consistent = false;
  } else if (previous === undefined) {
    tracked.identities.set(path, metadata);
  }
}

function trackPath(tracker: PathTracker, snapshot: PathSnapshot): void {
  const tracked = trackedPaths.get(tracker);
  if (tracked === undefined) {
    throw new TypeError("Path tracker was not created by createPathTracker");
  }
  for (const identity of snapshot.identities) {
    trackIdentity(tracker, identity.path, identity.metadata);
  }
  const terminalPath = snapshot.identities.at(-1)?.path;
  if (terminalPath === undefined) {
    tracked.consistent = false;
    return;
  }
  const previousRealPath = tracked.realPaths.get(terminalPath);
  if (
    previousRealPath !== undefined &&
    previousRealPath !== snapshot.realPath
  ) {
    tracked.consistent = false;
  } else if (previousRealPath === undefined) {
    tracked.realPaths.set(terminalPath, snapshot.realPath);
  }
}

export function bundlePath(relativePath: string): string {
  return `/${relativePath.split(sep).join("/")}`;
}

function isInside(root: string, target: string): boolean {
  const pathFromRoot = relative(root, target);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== "..")
  );
}

function samePathIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function captureSafePath(
  root: string,
  relativePath: string,
  kind: "file" | "directory" | "any",
  signal: AbortSignal | undefined,
): Promise<PathSnapshot | undefined> {
  const hostPath = resolve(root, relativePath);
  if (!isInside(root, hostPath)) return undefined;
  const identities: PathIdentity[] = [];
  let cursor = root;
  const segments = relativePath.split("/").filter(Boolean);
  const paths = [root];
  for (const segment of segments) {
    cursor = resolve(cursor, segment);
    paths.push(cursor);
  }

  try {
    for (const [index, path] of paths.entries()) {
      throwIfAborted(signal);
      const metadata = await lstat(path, { bigint: true });
      if (metadata.isSymbolicLink()) return undefined;
      const final = index === paths.length - 1;
      if (!final && !metadata.isDirectory()) return undefined;
      if (
        final &&
        ((kind === "file" &&
          (!metadata.isFile() || metadata.nlink !== BigInt(1))) ||
          (kind === "directory" && !metadata.isDirectory()))
      ) {
        return undefined;
      }
      identities.push({ path, metadata });
    }
    throwIfAborted(signal);
    const resolvedPath = await realpath(hostPath);
    return isInside(root, resolvedPath)
      ? { identities, realPath: resolvedPath }
      : undefined;
  } catch {
    throwIfAborted(signal);
    return undefined;
  }
}

async function verifySafePath(
  snapshot: PathSnapshot,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  try {
    for (const identity of snapshot.identities) {
      throwIfAborted(signal);
      const metadata = await lstat(identity.path, { bigint: true });
      if (
        metadata.isSymbolicLink() ||
        !samePathIdentity(identity.metadata, metadata)
      ) {
        return false;
      }
    }
    throwIfAborted(signal);
    return (
      (await realpath(snapshot.identities.at(-1)?.path ?? "")) ===
      snapshot.realPath
    );
  } catch {
    throwIfAborted(signal);
    return false;
  }
}

async function readBoundedFile(
  path: string,
  maximumBytes: number,
  signal: AbortSignal | undefined,
): Promise<BoundedReadResult> {
  throwIfAborted(signal);
  let handle;
  if (constants.O_NOFOLLOW === undefined) {
    return { ok: false, reason: "unsafe" };
  }
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return { ok: false, reason: "io" };
  }

  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1) {
      return { ok: false, reason: "unsafe" };
    }
    if (before.size > maximumBytes) {
      return { ok: false, reason: "size", size: before.size };
    }

    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      throwIfAborted(signal);
      const remaining = maximumBytes + 1 - total;
      if (remaining <= 0) {
        return { ok: false, reason: "size", size: total };
      }
      const chunk = new Uint8Array(Math.min(65_536, remaining));
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > maximumBytes) {
      return { ok: false, reason: "size", size: total };
    }

    const after = await handle.stat();
    if (
      !after.isFile() ||
      after.nlink !== 1 ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      return { ok: false, reason: "unsafe" };
    }

    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { ok: true, bytes, before, after };
  } catch {
    throwIfAborted(signal);
    return { ok: false, reason: "io" };
  } finally {
    await handle.close();
  }
}

async function hashBoundedFile(
  path: string,
  maximumBytes: number,
  signal: AbortSignal | undefined,
): Promise<BoundedHashResult> {
  throwIfAborted(signal);
  let handle;
  let total = 0;
  if (constants.O_NOFOLLOW === undefined) {
    return { ok: false, reason: "unsafe", bytesRead: total };
  }
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return { ok: false, reason: "io", bytesRead: total };
  }

  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1) {
      return { ok: false, reason: "unsafe", bytesRead: total };
    }
    if (before.size > maximumBytes) {
      return {
        ok: false,
        reason: "size",
        size: before.size,
        bytesRead: total,
      };
    }

    const hash = createHash("sha256");
    while (true) {
      throwIfAborted(signal);
      const remaining = maximumBytes + 1 - total;
      if (remaining <= 0) {
        return { ok: false, reason: "size", size: total, bytesRead: total };
      }
      const chunk = new Uint8Array(Math.min(65_536, remaining));
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maximumBytes) {
        return { ok: false, reason: "size", size: total, bytesRead: total };
      }
      hash.update(chunk.subarray(0, bytesRead));
    }

    const after = await handle.stat();
    if (
      !after.isFile() ||
      after.nlink !== 1 ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      total !== after.size
    ) {
      return { ok: false, reason: "unsafe", bytesRead: total };
    }
    return { ok: true, digest: hash.digest("hex"), size: total, after };
  } catch {
    throwIfAborted(signal);
    return { ok: false, reason: "io", bytesRead: total };
  } finally {
    await handle.close();
  }
}

export async function readSafeBoundedFile(
  root: string,
  relativePath: string,
  maximumBytes: number,
  signal: AbortSignal | undefined,
  tracker: PathTracker,
): Promise<BoundedReadResult> {
  const snapshot = await captureSafePath(root, relativePath, "file", signal);
  if (snapshot === undefined) return { ok: false, reason: "unsafe" };
  const read = await readBoundedFile(
    resolve(root, relativePath),
    maximumBytes,
    signal,
  );
  if (read.ok && !(await verifySafePath(snapshot, signal))) {
    return { ok: false, reason: "unsafe" };
  }
  if (read.ok) trackPath(tracker, snapshot);
  return read;
}

export async function hashSafeBoundedFile(
  root: string,
  relativePath: string,
  maximumBytes: number,
  signal: AbortSignal | undefined,
  tracker: PathTracker,
): Promise<BoundedHashResult> {
  const snapshot = await captureSafePath(root, relativePath, "file", signal);
  if (snapshot === undefined) {
    return { ok: false, reason: "unsafe", bytesRead: 0 };
  }
  const hashed = await hashBoundedFile(
    resolve(root, relativePath),
    maximumBytes,
    signal,
  );
  if (hashed.ok && !(await verifySafePath(snapshot, signal))) {
    return { ok: false, reason: "unsafe", bytesRead: hashed.size };
  }
  if (hashed.ok) trackPath(tracker, snapshot);
  return hashed;
}

export function matchesExcludedPath(
  path: string,
  patterns: readonly string[],
): boolean {
  const pathSegments = path.split("/").filter(Boolean);
  return patterns.some((pattern) => {
    let reachable = new Uint8Array(pathSegments.length + 1);
    reachable[0] = 1;
    for (const patternSegment of pattern.split("/")) {
      const next = new Uint8Array(pathSegments.length + 1);
      if (patternSegment === "**") {
        next[0] = reachable[0] ?? 0;
        for (let index = 1; index <= pathSegments.length; index += 1) {
          next[index] = reachable[index] === 1 || next[index - 1] === 1 ? 1 : 0;
        }
      } else {
        for (let index = 0; index < pathSegments.length; index += 1) {
          if (
            reachable[index] === 1 &&
            (patternSegment === "*" || patternSegment === pathSegments[index])
          ) {
            next[index + 1] = 1;
          }
        }
      }
      reachable = next;
    }
    return reachable[pathSegments.length] === 1;
  });
}

export async function enumerateVault(
  root: string,
  excludes: readonly string[],
  limits: ValidationLimits,
  collector: DiagnosticCollector,
  signal: AbortSignal | undefined,
  tracker: PathTracker,
): Promise<VaultEntries> {
  const regularFiles = new Set<string>();
  const directories = new Set<string>([""]);
  const markdownFiles: string[] = [];
  let entries = 0;
  let incomplete = false;

  const walk = async (relativeDirectory: string): Promise<void> => {
    if (incomplete) return;
    throwIfAborted(signal);
    const hostDirectory = resolve(root, relativeDirectory);
    const snapshot = await captureSafePath(
      root,
      relativeDirectory,
      "directory",
      signal,
    );
    if (snapshot === undefined) {
      collector.add(
        createDiagnostic("VAULT-IO", bundlePath(relativeDirectory)),
      );
      collector.markIncomplete();
      return;
    }
    const children: Dirent[] = [];
    try {
      const directory = await opendir(hostDirectory);
      for await (const child of directory) {
        throwIfAborted(signal);
        if (child.name === ".git") continue;
        const relativePath = relativeDirectory
          ? `${relativeDirectory}/${child.name}`
          : child.name;
        entries += 1;
        if (entries > limits.maxEntries) {
          collector.add(createDiagnostic("VAULT-BOUNDS", "/bookie.yaml"));
          collector.markIncomplete();
          incomplete = true;
          break;
        }
        if (matchesExcludedPath(relativePath, excludes)) continue;
        children.push(child);
      }
    } catch {
      throwIfAborted(signal);
      collector.add(
        createDiagnostic("VAULT-IO", bundlePath(relativeDirectory)),
      );
      collector.markIncomplete();
      return;
    }
    if (incomplete) return;
    if (!(await verifySafePath(snapshot, signal))) {
      collector.add(
        createDiagnostic("VAULT-IO", bundlePath(relativeDirectory)),
      );
      collector.markIncomplete();
      return;
    }
    trackPath(tracker, snapshot);
    children.sort((left, right) => compareText(left.name, right.name));

    for (const child of children) {
      throwIfAborted(signal);
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${child.name}`
        : child.name;

      if (child.isSymbolicLink()) {
        collector.add(createDiagnostic("VAULT-IO", bundlePath(relativePath)));
      } else if (child.isDirectory()) {
        directories.add(relativePath);
        await walk(relativePath);
      } else if (child.isFile()) {
        let metadata: BigIntStats;
        try {
          metadata = await lstat(resolve(root, relativePath), { bigint: true });
        } catch {
          throwIfAborted(signal);
          collector.add(createDiagnostic("VAULT-IO", bundlePath(relativePath)));
          collector.markIncomplete();
          continue;
        }
        if (
          !metadata.isFile() ||
          metadata.isSymbolicLink() ||
          metadata.nlink !== BigInt(1)
        ) {
          collector.add(createDiagnostic("VAULT-IO", bundlePath(relativePath)));
        } else {
          trackIdentity(tracker, resolve(root, relativePath), metadata);
          regularFiles.add(relativePath);
          if (relativePath.endsWith(".md")) markdownFiles.push(relativePath);
        }
      } else {
        collector.add(createDiagnostic("VAULT-IO", bundlePath(relativePath)));
      }
      if (incomplete) return;
    }
  };

  await walk("");
  markdownFiles.sort(compareText);
  return { regularFiles, directories, markdownFiles, incomplete };
}

export async function verifyTrackedPaths(
  tracker: PathTracker,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  const tracked = trackedPaths.get(tracker);
  if (tracked === undefined || !tracked.consistent) return false;
  try {
    for (const [path, expected] of tracked.identities) {
      throwIfAborted(signal);
      const metadata = await lstat(path, { bigint: true });
      if (metadata.isSymbolicLink() || !samePathIdentity(expected, metadata)) {
        return false;
      }
    }
    for (const [path, expected] of tracked.realPaths) {
      throwIfAborted(signal);
      const actual = await realpath(path);
      throwIfAborted(signal);
      if (actual !== expected) return false;
    }
    return true;
  } catch {
    throwIfAborted(signal);
    return false;
  }
}
