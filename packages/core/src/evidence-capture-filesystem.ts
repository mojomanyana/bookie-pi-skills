import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { lstat, open, realpath, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ParentSnapshot,
  ResolvedMutationTarget,
  StagedTemporary,
} from "./concept-mutation-filesystem.js";
import { verifyParent } from "./concept-mutation-filesystem.js";
import { hasErrorCode, isAbortError } from "./concept-mutation-model.js";
import { throwIfAborted } from "./vault-cancellation.js";

interface SourceSnapshot {
  readonly path: string;
  readonly realPath: string;
  readonly metadata: BigIntStats;
}

export interface StagedEvidenceResource {
  readonly temporary: StagedTemporary;
  readonly source: SourceSnapshot;
  readonly sha256: string;
  readonly byteLength: number;
}

export interface PublishedEvidenceResource {
  readonly metadata: BigIntStats;
  readonly sha256: string;
  readonly byteLength: number;
}

export type StageEvidenceResourceResult =
  | { readonly ok: true; readonly staged: StagedEvidenceResource }
  | {
      readonly ok: false;
      readonly reason: "target" | "bounds" | "conflict" | "io";
    };

class StageFailure extends Error {
  readonly reason: "bounds" | "conflict";

  constructor(reason: "bounds" | "conflict") {
    super("Evidence resource staging failed.");
    this.reason = reason;
  }
}

function sameCompleteIdentity(left: BigIntStats, right: BigIntStats): boolean {
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

function sameRegularInode(left: BigIntStats, right: BigIntStats): boolean {
  return (
    right.isFile() &&
    !right.isSymbolicLink() &&
    right.nlink === BigInt(1) &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size
  );
}

function resolveSourcePath(source: unknown): string | undefined {
  try {
    const path = source instanceof URL ? fileURLToPath(source) : source;
    return typeof path === "string" && path.length > 0
      ? resolve(path)
      : undefined;
  } catch {
    return undefined;
  }
}

async function captureSource(
  source: unknown,
  maximumBytes: number,
  signal: AbortSignal | undefined,
): Promise<
  | { readonly ok: true; readonly snapshot: SourceSnapshot }
  | { readonly ok: false; readonly reason: "target" | "bounds" | "io" }
> {
  const path = resolveSourcePath(source);
  if (path === undefined || constants.O_NOFOLLOW === undefined) {
    return { ok: false, reason: "target" };
  }
  try {
    throwIfAborted(signal);
    const metadata = await lstat(path, { bigint: true });
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      return { ok: false, reason: "target" };
    }
    if (metadata.size > BigInt(maximumBytes)) {
      return { ok: false, reason: "bounds" };
    }
    const resolved = await realpath(path);
    throwIfAborted(signal);
    return { ok: true, snapshot: { path, realPath: resolved, metadata } };
  } catch (error) {
    throwIfAborted(signal);
    return {
      ok: false,
      reason: hasErrorCode(error, "ENOENT") ? "target" : "io",
    };
  }
}

export async function verifyEvidenceSource(
  snapshot: SourceSnapshot,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  try {
    throwIfAborted(signal);
    const metadata = await lstat(snapshot.path, { bigint: true });
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      !sameCompleteIdentity(snapshot.metadata, metadata)
    ) {
      return false;
    }
    throwIfAborted(signal);
    return (await realpath(snapshot.path)) === snapshot.realPath;
  } catch {
    throwIfAborted(signal);
    return false;
  }
}

async function cleanupOwnedTemporary(
  path: string | undefined,
  expected: BigIntStats | undefined,
  target: ResolvedMutationTarget,
  parent: ParentSnapshot,
): Promise<boolean> {
  if (path === undefined || expected === undefined) return true;
  if (!(await verifyParent(target, parent, undefined))) return false;
  try {
    const actual = await lstat(path, { bigint: true });
    if (
      !actual.isFile() ||
      actual.isSymbolicLink() ||
      actual.nlink !== BigInt(1) ||
      actual.dev !== expected.dev ||
      actual.ino !== expected.ino
    ) {
      return false;
    }
    await unlink(path);
    return true;
  } catch (error) {
    return hasErrorCode(error, "ENOENT");
  }
}

async function hashStagedResource(
  path: string,
  expected: BigIntStats,
  maximumBytes: number,
  signal: AbortSignal | undefined,
): Promise<
  { readonly digest: string; readonly metadata: BigIntStats } | undefined
> {
  let handle;
  let total = 0;
  try {
    throwIfAborted(signal);
    const pathMetadata = await lstat(path, { bigint: true });
    if (!sameCompleteIdentity(expected, pathMetadata)) return undefined;
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat({ bigint: true });
    if (!sameCompleteIdentity(expected, before)) return undefined;
    const hash = createHash("sha256");
    while (true) {
      throwIfAborted(signal);
      const remaining = maximumBytes + 1 - total;
      if (remaining <= 0) return undefined;
      const buffer = Buffer.allocUnsafe(Math.min(65_536, remaining));
      const read = await handle.read(buffer, 0, buffer.byteLength, null);
      if (read.bytesRead === 0) break;
      total += read.bytesRead;
      if (total > maximumBytes) return undefined;
      hash.update(buffer.subarray(0, read.bytesRead));
    }
    const after = await handle.stat({ bigint: true });
    if (
      total !== Number(after.size) ||
      !sameCompleteIdentity(before, after) ||
      !sameCompleteIdentity(expected, after)
    ) {
      return undefined;
    }
    await handle.close();
    handle = undefined;
    const finalPath = await lstat(path, { bigint: true });
    if (!sameCompleteIdentity(after, finalPath)) return undefined;
    return { digest: hash.digest("hex"), metadata: finalPath };
  } catch {
    throwIfAborted(signal);
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function stageEvidenceResource(
  source: unknown,
  target: ResolvedMutationTarget,
  parent: ParentSnapshot,
  maximumBytes: number,
  signal: AbortSignal | undefined,
): Promise<StageEvidenceResourceResult> {
  const captured = await captureSource(source, maximumBytes, signal);
  if (!captured.ok) return captured;
  const sourceSnapshot = captured.snapshot;
  let temporaryPath: string | undefined;
  let temporaryMetadata: BigIntStats | undefined;
  let sourceHandle;
  let targetHandle;
  let total = 0;
  const hash = createHash("sha256");
  try {
    sourceHandle = await open(
      sourceSnapshot.path,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const openedSource = await sourceHandle.stat({ bigint: true });
    if (
      !openedSource.isFile() ||
      openedSource.isSymbolicLink() ||
      !sameCompleteIdentity(sourceSnapshot.metadata, openedSource)
    ) {
      throw new StageFailure("conflict");
    }

    for (let attempt = 0; attempt < 8; attempt += 1) {
      throwIfAborted(signal);
      temporaryPath = resolve(
        dirname(target.target),
        `.bookie-${randomUUID()}.tmp`,
      );
      try {
        targetHandle = await open(
          temporaryPath,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o666,
        );
        temporaryMetadata = await targetHandle.stat({ bigint: true });
        if (
          temporaryMetadata.dev !== parent.identities.at(-1)?.metadata.dev ||
          !(await verifyParent(target, parent, signal))
        ) {
          throw new Error("unsafe resource parent");
        }
        break;
      } catch (error) {
        if (!hasErrorCode(error, "EEXIST")) throw error;
      }
    }
    if (
      targetHandle === undefined ||
      temporaryPath === undefined ||
      temporaryMetadata === undefined
    ) {
      throw new Error("temporary file collision");
    }

    while (true) {
      throwIfAborted(signal);
      const remaining = maximumBytes + 1 - total;
      if (remaining <= 0) throw new StageFailure("bounds");
      const buffer = Buffer.allocUnsafe(Math.min(65_536, remaining));
      const read = await sourceHandle.read(buffer, 0, buffer.byteLength, null);
      if (read.bytesRead === 0) break;
      total += read.bytesRead;
      if (total > maximumBytes) throw new StageFailure("bounds");
      hash.update(buffer.subarray(0, read.bytesRead));
      let offset = 0;
      while (offset < read.bytesRead) {
        const written = await targetHandle.write(
          buffer,
          offset,
          read.bytesRead - offset,
          null,
        );
        if (written.bytesWritten <= 0) throw new Error("short write");
        offset += written.bytesWritten;
      }
    }
    const sourceAfter = await sourceHandle.stat({ bigint: true });
    if (
      total !== Number(sourceAfter.size) ||
      !sameCompleteIdentity(sourceSnapshot.metadata, sourceAfter) ||
      !(await verifyEvidenceSource(sourceSnapshot, signal))
    ) {
      throw new StageFailure("conflict");
    }

    await targetHandle.sync();
    const stagedMetadata = await targetHandle.stat({ bigint: true });
    temporaryMetadata = stagedMetadata;
    if (
      !stagedMetadata.isFile() ||
      stagedMetadata.isSymbolicLink() ||
      stagedMetadata.nlink !== BigInt(1) ||
      stagedMetadata.size !== BigInt(total)
    ) {
      throw new Error("unsafe staged resource");
    }
    await targetHandle.close();
    targetHandle = undefined;
    await sourceHandle.close();
    sourceHandle = undefined;

    const expectedDigest = hash.digest("hex");
    const verified = await hashStagedResource(
      temporaryPath,
      stagedMetadata,
      maximumBytes,
      signal,
    );
    if (
      verified === undefined ||
      verified.digest !== expectedDigest ||
      !(await verifyEvidenceSource(sourceSnapshot, signal))
    ) {
      throw new Error("staged digest verification failed");
    }
    temporaryMetadata = verified.metadata;
    return {
      ok: true,
      staged: {
        temporary: { path: temporaryPath, metadata: verified.metadata },
        source: sourceSnapshot,
        sha256: verified.digest,
        byteLength: total,
      },
    };
  } catch (error) {
    let closeSucceeded = true;
    for (const handle of [sourceHandle, targetHandle]) {
      if (handle === undefined) continue;
      try {
        await handle.close();
      } catch {
        closeSucceeded = false;
      }
    }
    const cleaned = await cleanupOwnedTemporary(
      temporaryPath,
      temporaryMetadata,
      target,
      parent,
    );
    if (isAbortError(error) && closeSucceeded && cleaned) throw error;
    return {
      ok: false,
      reason:
        error instanceof StageFailure && closeSucceeded && cleaned
          ? error.reason
          : "io",
    };
  }
}

export async function capturePublishedEvidenceResource(
  target: ResolvedMutationTarget,
  staged: StagedEvidenceResource,
): Promise<PublishedEvidenceResource | undefined> {
  try {
    const metadata = await lstat(target.target, { bigint: true });
    return sameRegularInode(staged.temporary.metadata, metadata)
      ? {
          metadata,
          sha256: staged.sha256,
          byteLength: staged.byteLength,
        }
      : undefined;
  } catch {
    return undefined;
  }
}

export async function verifyPublishedEvidenceResource(
  target: ResolvedMutationTarget,
  published: PublishedEvidenceResource,
): Promise<boolean> {
  try {
    const metadata = await lstat(target.target, { bigint: true });
    return sameCompleteIdentity(published.metadata, metadata);
  } catch {
    return false;
  }
}
