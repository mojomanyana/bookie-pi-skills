import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  computeConceptSourceHash,
  failure,
  hasErrorCode,
  isAbortError,
  mutationDiagnostic,
  reusedDiagnostic,
} from "./concept-mutation-model.js";
import type {
  ConceptMutationOptions,
  ConceptMutationResult,
  ConceptSourceHash,
  MutationDiagnostic,
  MutationLimits,
  MutationOperation,
} from "./concept-mutation-model.js";
import { throwIfAborted } from "./vault-cancellation.js";
import { bundlePath, readSafeBoundedFile } from "./vault-filesystem.js";
import type { PathTracker } from "./vault-filesystem.js";

export interface ResolvedMutationTarget {
  readonly unresolvedRoot: string;
  readonly root: string;
  readonly rootMetadata: BigIntStats;
  readonly relativePath: string;
  readonly bundlePath: string;
  readonly target: string;
}

export interface ParentSnapshot {
  readonly parent: string;
  readonly identities: readonly DirectoryIdentity[];
}

export interface TargetSource {
  readonly bytes: Uint8Array;
  readonly metadata: BigIntStats;
  readonly sourceHash: ConceptSourceHash;
}

export type TargetState = "absent" | "safe" | "unsafe" | "io";

interface DirectoryIdentity {
  readonly path: string;
  readonly metadata: BigIntStats;
}

interface StagedTemporary {
  readonly path: string;
  readonly metadata: BigIntStats;
}

const rootMutationTails = new Map<string, Promise<void>>();

function hasInvalidPathCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      "\\:%?#".includes(character) ||
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff)
    ) {
      return true;
    }
  }
  return false;
}

function canonicalRelativeConceptPath(path: unknown): string | undefined {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    hasInvalidPathCharacter(path)
  ) {
    return undefined;
  }
  const segments = path.split("/");
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    return undefined;
  }
  const name = segments.at(-1);
  if (
    name === undefined ||
    name === "index.md" ||
    name === "log.md" ||
    name.length <= 3 ||
    !name.endsWith(".md")
  ) {
    return undefined;
  }
  return path;
}

function isInside(root: string, target: string): boolean {
  const fromRoot = relative(root, target);
  return (
    fromRoot === "" || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== "..")
  );
}

export async function resolveMutationTarget(
  rootPath: string | URL,
  requestPath: unknown,
  signal: AbortSignal | undefined,
): Promise<
  | { readonly ok: true; readonly target: ResolvedMutationTarget }
  | { readonly ok: false; readonly diagnostic: MutationDiagnostic }
> {
  const relativePath = canonicalRelativeConceptPath(requestPath);
  if (relativePath === undefined) {
    return {
      ok: false,
      diagnostic: mutationDiagnostic("MUTATION-PATH", "<invalid>"),
    };
  }

  let suppliedRoot: string;
  try {
    suppliedRoot = rootPath instanceof URL ? fileURLToPath(rootPath) : rootPath;
  } catch {
    return {
      ok: false,
      diagnostic: reusedDiagnostic("VAULT-ROOT", "/"),
    };
  }
  if (typeof suppliedRoot !== "string") {
    throw new TypeError("root must be a filesystem path or file URL");
  }

  throwIfAborted(signal);
  const unresolvedRoot = resolve(suppliedRoot);
  let root: string;
  let rootMetadata: BigIntStats;
  try {
    root = await realpath(unresolvedRoot);
    rootMetadata = await lstat(root, { bigint: true });
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
      throw new Error("unsafe root");
    }
  } catch {
    throwIfAborted(signal);
    return {
      ok: false,
      diagnostic: reusedDiagnostic("VAULT-ROOT", "/"),
    };
  }
  throwIfAborted(signal);

  const target = resolve(root, ...relativePath.split("/"));
  if (!isInside(root, target)) {
    return {
      ok: false,
      diagnostic: mutationDiagnostic("MUTATION-PATH", "<invalid>"),
    };
  }
  return {
    ok: true,
    target: {
      unresolvedRoot,
      root,
      rootMetadata,
      relativePath,
      bundlePath: bundlePath(relativePath),
      target,
    },
  };
}

function sameDirectoryIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    right.isDirectory() &&
    !right.isSymbolicLink()
  );
}

export async function captureParent(
  target: ResolvedMutationTarget,
  signal: AbortSignal | undefined,
): Promise<ParentSnapshot | undefined> {
  const directories = target.relativePath.split("/").slice(0, -1);
  const paths = [target.root];
  let cursor = target.root;
  for (const segment of directories) {
    cursor = resolve(cursor, segment);
    paths.push(cursor);
  }

  const identities: DirectoryIdentity[] = [];
  try {
    if ((await realpath(target.unresolvedRoot)) !== target.root)
      return undefined;
    for (const path of paths) {
      throwIfAborted(signal);
      const metadata = await lstat(path, { bigint: true });
      if (
        !metadata.isDirectory() ||
        metadata.isSymbolicLink() ||
        (path === target.root &&
          !sameDirectoryIdentity(target.rootMetadata, metadata))
      ) {
        return undefined;
      }
      identities.push({ path, metadata });
    }
    const parent = paths.at(-1);
    if (
      parent === undefined ||
      !isInside(target.root, parent) ||
      (await realpath(parent)) !== parent
    ) {
      return undefined;
    }
    return { parent, identities };
  } catch {
    throwIfAborted(signal);
    return undefined;
  }
}

export async function verifyParent(
  target: ResolvedMutationTarget,
  snapshot: ParentSnapshot,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  try {
    throwIfAborted(signal);
    if ((await realpath(target.unresolvedRoot)) !== target.root) return false;
    for (const identity of snapshot.identities) {
      throwIfAborted(signal);
      const metadata = await lstat(identity.path, { bigint: true });
      if (!sameDirectoryIdentity(identity.metadata, metadata)) return false;
    }
    throwIfAborted(signal);
    return (await realpath(snapshot.parent)) === snapshot.parent;
  } catch {
    throwIfAborted(signal);
    return false;
  }
}

export async function targetState(target: string): Promise<TargetState> {
  try {
    const metadata = await lstat(target, { bigint: true });
    return !metadata.isSymbolicLink() &&
      metadata.isFile() &&
      metadata.nlink === BigInt(1)
      ? "safe"
      : "unsafe";
  } catch (error) {
    return hasErrorCode(error, "ENOENT") ? "absent" : "io";
  }
}

export async function readTargetSource(
  target: ResolvedMutationTarget,
  limits: MutationLimits,
  signal: AbortSignal | undefined,
  tracker: PathTracker,
): Promise<
  | { readonly ok: true; readonly source: TargetSource }
  | {
      readonly ok: false;
      readonly reason: "missing" | "unsafe" | "size" | "io";
    }
> {
  let metadata: BigIntStats;
  try {
    metadata = await lstat(target.target, { bigint: true });
  } catch (error) {
    throwIfAborted(signal);
    return {
      ok: false,
      reason: hasErrorCode(error, "ENOENT") ? "missing" : "io",
    };
  }
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.nlink !== BigInt(1)
  ) {
    return { ok: false, reason: "unsafe" };
  }

  const read = await readSafeBoundedFile(
    target.root,
    target.relativePath,
    limits.maxConceptBytes,
    signal,
    tracker,
  );
  if (!read.ok) {
    return {
      ok: false,
      reason:
        read.reason === "size"
          ? "size"
          : read.reason === "unsafe"
            ? "unsafe"
            : "io",
    };
  }
  return {
    ok: true,
    source: {
      bytes: read.bytes,
      metadata,
      sourceHash: computeConceptSourceHash(read.bytes),
    },
  };
}

export function sameTargetIdentity(
  left: BigIntStats,
  right: BigIntStats,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    right.isFile() &&
    !right.isSymbolicLink() &&
    right.nlink === BigInt(1)
  );
}

function sameStagedIdentity(
  expected: BigIntStats,
  actual: BigIntStats,
): boolean {
  return (
    actual.isFile() &&
    !actual.isSymbolicLink() &&
    actual.dev === expected.dev &&
    actual.ino === expected.ino &&
    actual.mode === expected.mode &&
    actual.nlink === expected.nlink &&
    actual.size === expected.size &&
    actual.mtimeNs === expected.mtimeNs &&
    actual.ctimeNs === expected.ctimeNs
  );
}

async function cleanupTemporary(
  temporary: StagedTemporary | undefined,
  target: ResolvedMutationTarget,
  parent: ParentSnapshot,
): Promise<boolean> {
  if (temporary === undefined) return true;
  if (!(await verifyParent(target, parent, undefined))) return false;
  try {
    const metadata = await lstat(temporary.path, { bigint: true });
    if (!sameStagedIdentity(temporary.metadata, metadata)) return false;
    await unlink(temporary.path);
    return true;
  } catch (error) {
    return hasErrorCode(error, "ENOENT");
  }
}

async function stageTemporary(
  target: ResolvedMutationTarget,
  parent: ParentSnapshot,
  bytes: Uint8Array,
  mode: number | undefined,
  signal: AbortSignal | undefined,
): Promise<StagedTemporary> {
  if (constants.O_NOFOLLOW === undefined) {
    throw new Error("no no-follow support");
  }
  const parentPath = dirname(target.target);
  let temporary: string | undefined;
  let staged: StagedTemporary | undefined;
  let handle;
  try {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      throwIfAborted(signal);
      temporary = resolve(parentPath, `.bookie-${randomUUID()}.tmp`);
      try {
        handle = await open(
          temporary,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          mode ?? 0o666,
        );
        const openedMetadata = await handle.stat({ bigint: true });
        staged = { path: temporary, metadata: openedMetadata };
        break;
      } catch (error) {
        if (!hasErrorCode(error, "EEXIST")) throw error;
      }
    }
    if (handle === undefined || temporary === undefined) {
      throw new Error("temporary file collision");
    }
    throwIfAborted(signal);
    await handle.writeFile(bytes);
    if (mode !== undefined) await handle.chmod(mode);
    await handle.sync();
    const metadata = await handle.stat({ bigint: true });
    staged = { path: temporary, metadata };
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.nlink !== BigInt(1) ||
      metadata.size !== BigInt(bytes.byteLength)
    ) {
      throw new Error("unsafe temporary file");
    }
    await handle.close();
    handle = undefined;
    throwIfAborted(signal);
    return staged;
  } catch (error) {
    let closeSucceeded = true;
    if (handle !== undefined) {
      try {
        if (temporary !== undefined) {
          staged = {
            path: temporary,
            metadata: await handle.stat({ bigint: true }),
          };
        }
      } catch {
        staged = undefined;
      }
      try {
        await handle.close();
      } catch {
        closeSucceeded = false;
      }
    }
    const cleanupSucceeded = await cleanupTemporary(staged, target, parent);
    if (isAbortError(error) && closeSucceeded && cleanupSucceeded) throw error;
    throw new Error("temporary staging failed", { cause: error });
  }
}

async function verifyStagedTemporary(
  temporary: StagedTemporary,
  snapshot: ParentSnapshot,
  expectedBytes: number,
): Promise<boolean> {
  try {
    const metadata = await lstat(temporary.path, { bigint: true });
    return (
      sameStagedIdentity(temporary.metadata, metadata) &&
      metadata.nlink === BigInt(1) &&
      metadata.size === BigInt(expectedBytes) &&
      metadata.dev === snapshot.identities.at(-1)?.metadata.dev
    );
  } catch {
    return false;
  }
}

export async function publishCandidate(
  target: ResolvedMutationTarget,
  parent: ParentSnapshot,
  bytes: Uint8Array,
  mode: number | undefined,
  signal: AbortSignal | undefined,
  finalCheck: () => Promise<"publish" | "conflict" | "io">,
): Promise<"published" | "conflict" | "io"> {
  let temporary: StagedTemporary | undefined;
  try {
    temporary = await stageTemporary(target, parent, bytes, mode, signal);
    throwIfAborted(signal);
    if (
      !(await verifyParent(target, parent, signal)) ||
      !(await verifyStagedTemporary(temporary, parent, bytes.byteLength))
    ) {
      await cleanupTemporary(temporary, target, parent);
      return "io";
    }
    const final = await finalCheck();
    throwIfAborted(signal);
    if (final !== "publish") {
      const cleaned = await cleanupTemporary(temporary, target, parent);
      return cleaned ? final : "io";
    }
    if (
      !(await verifyParent(target, parent, signal)) ||
      !(await verifyStagedTemporary(temporary, parent, bytes.byteLength))
    ) {
      await cleanupTemporary(temporary, target, parent);
      return "io";
    }
    throwIfAborted(signal);
    await rename(temporary.path, target.target);
    temporary = undefined;
    return "published";
  } catch (error) {
    const cleaned = await cleanupTemporary(temporary, target, parent);
    if (isAbortError(error) && cleaned) throw error;
    return "io";
  }
}

async function withRootMutationQueue<T>(
  root: string,
  signal: AbortSignal | undefined,
  mutation: () => Promise<T>,
): Promise<T> {
  const previous = rootMutationTails.get(root) ?? Promise.resolve();
  let release = (): void => undefined;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  const tail = previous.then(() => gate);
  rootMutationTails.set(root, tail);
  await previous;
  try {
    throwIfAborted(signal);
    return await mutation();
  } finally {
    release();
    if (rootMutationTails.get(root) === tail) rootMutationTails.delete(root);
  }
}

export async function runCoordinatedMutation(
  operation: MutationOperation,
  target: ResolvedMutationTarget,
  options: ConceptMutationOptions,
  mutation: () => Promise<ConceptMutationResult>,
): Promise<ConceptMutationResult> {
  const runExclusive =
    options.runExclusive ??
    (async <T>(_path: string, work: () => Promise<T>): Promise<T> => work());
  let invoked = false;
  let completed: ConceptMutationResult | undefined;
  try {
    await runExclusive(target.target, async () => {
      if (invoked) throw new TypeError("mutation callback may run only once");
      invoked = true;
      completed = await withRootMutationQueue(
        target.root,
        options.signal,
        mutation,
      );
      return completed;
    });
    if (completed !== undefined) return completed;
    return failure(operation, [
      mutationDiagnostic("MUTATION-IO", target.bundlePath),
    ]);
  } catch (error) {
    if (completed !== undefined) {
      throw new Error(
        "runExclusive failed after the concept mutation completed.",
        { cause: error },
      );
    }
    if (isAbortError(error)) throw error;
    return failure(operation, [
      mutationDiagnostic("MUTATION-IO", target.bundlePath),
    ]);
  }
}
