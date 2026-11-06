import { randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, unlink, type FileHandle } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { hasErrorCode } from "./concept-mutation-model.js";
import { throwIfAborted } from "./vault-cancellation.js";

export class VaultMutationLocked extends Error {
  constructor() {
    super(
      "Bookie vault writer ownership is unavailable; stop writers and inspect the retained lock before recovery.",
    );
    this.name = "VaultMutationLocked";
  }
}

// All cooperating writers use this same canonical-root location. Never steal
// ownership on a timeout: a paused or interrupted writer may still own it.
export async function withVaultMutationLock<T>(
  root: string,
  signal: AbortSignal | undefined,
  work: () => Promise<T>,
): Promise<T> {
  if (constants.O_NOFOLLOW === undefined) throw new VaultMutationLocked();
  const path = join(root, ".bookie-write.lock");
  const deadline = performance.now() + 5_000;
  let handle;
  while (handle === undefined) {
    throwIfAborted(signal);
    try {
      handle = await open(
        path,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) throw error;
      if (performance.now() >= deadline) throw new VaultMutationLocked();
      try {
        await delay(25, undefined, signal === undefined ? {} : { signal });
      } catch {
        throwIfAborted(signal);
        throw new VaultMutationLocked();
      }
    }
  }
  let identity: BigIntStats | undefined;
  try {
    identity = await handle.stat({ bigint: true });
    await handle.writeFile(
      JSON.stringify({
        schema: 1,
        token: randomUUID(),
        pid: process.pid,
        host: hostname(),
        startedAt: new Date().toISOString(),
      }) + "\n",
    );
    await handle.sync();
    throwIfAborted(signal);
    return await work();
  } finally {
    await releaseOwnedLock(handle, path, identity);
  }
}

async function releaseOwnedLock(
  handle: FileHandle,
  path: string,
  identity: BigIntStats | undefined,
): Promise<void> {
  await handle.close();
  if (identity === undefined) throw new VaultMutationLocked();
  const current = await lstat(path, { bigint: true });
  if (
    !current.isFile() ||
    current.isSymbolicLink() ||
    current.dev !== identity.dev ||
    current.ino !== identity.ino
  ) {
    throw new VaultMutationLocked();
  }
  await unlink(path);
}
