import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { Buffer } from "node:buffer";

import { loadConcept } from "./concept-loader.js";
import { throwIfAborted } from "./vault-cancellation.js";
import { createDiagnostic, DiagnosticCollector } from "./vault-diagnostics.js";
import {
  hashSafeBoundedFile,
  isBeneathLiteralPath,
  matchesExcludedPath,
} from "./vault-filesystem.js";
import type { PathTracker } from "./vault-filesystem.js";
import type {
  BookieData,
  BookieRecord,
  Manifest,
  SchemaValidators,
  ValidationLimits,
  VaultEntries,
} from "./vault-model.js";
import { parseStrictYamlMapping } from "./strict-yaml.js";

interface GitEntry {
  readonly path: string;
  readonly mode: string;
  readonly type: "blob" | "tree" | "commit";
  readonly oid: string;
  readonly size?: number;
}

interface BaseRecord extends BookieRecord {
  readonly sourceDigest: string;
}

interface ResolvedGitBase {
  readonly commit: string;
  readonly prefix: string;
}

export interface ValidateGitBaseInput {
  readonly root: string;
  readonly baseRef: string;
  readonly currentManifest?: Manifest;
  readonly currentExcludedSensitivityClasses: readonly string[];
  readonly currentRecords: readonly BookieRecord[];
  readonly currentSourceDigests: ReadonlyMap<string, string>;
  readonly entries: VaultEntries;
  readonly limits: ValidationLimits;
  readonly validators: SchemaValidators;
  readonly collector: DiagnosticCollector;
  readonly redactedEntryPaths: Set<string>;
  readonly signal?: AbortSignal;
  readonly tracker: PathTracker;
}

export interface ValidateGitBaseResult {
  readonly baseCommit?: string;
}

const MAX_GIT_PATH_BYTES = 4_096;
const MAX_GIT_RECORD_BYTES = MAX_GIT_PATH_BYTES + 256;
const MAX_BASE_REF_BYTES = 255;
const ordinaryModes = new Set(["100644", "100755"]);

class GitFailure extends Error {}

function gitEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (name.startsWith("GIT_")) delete environment[name];
  }
  return {
    ...environment,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
  };
}

function spawnGit(
  root: string,
  args: readonly string[],
): ChildProcessWithoutNullStreams {
  return spawn(
    "git",
    [
      "--no-pager",
      "--no-replace-objects",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=/dev/null",
      "-C",
      root,
      ...args,
    ],
    {
      env: gitEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
}

function monitorChild(
  child: ChildProcessWithoutNullStreams,
  signal: AbortSignal | undefined,
): {
  readonly completion: Promise<boolean>;
  readonly dispose: () => void;
} {
  let spawnFailed = false;
  child.once("error", () => {
    spawnFailed = true;
  });
  child.stderr.on("data", () => undefined);
  const abort = (): void => {
    child.kill("SIGKILL");
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted === true) abort();
  const completion = new Promise<boolean>((resolveCompletion) => {
    child.once("close", (code) =>
      resolveCompletion(!spawnFailed && code === 0),
    );
  });
  return {
    completion,
    dispose: () => signal?.removeEventListener("abort", abort),
  };
}

async function runGitBuffered(
  root: string,
  args: readonly string[],
  signal: AbortSignal | undefined,
  maximumBytes: number,
): Promise<Uint8Array> {
  throwIfAborted(signal);
  const child = spawnGit(root, args);
  const monitored = monitorChild(child, signal);
  child.stdin.end();
  const chunks: Buffer[] = [];
  let total = 0;
  let overflow = false;
  try {
    for await (const value of child.stdout) {
      const chunk = Buffer.from(value as Uint8Array);
      total += chunk.byteLength;
      if (total > maximumBytes) {
        overflow = true;
        child.kill("SIGKILL");
        break;
      }
      chunks.push(chunk);
    }
    const completed = await monitored.completion;
    throwIfAborted(signal);
    if (!completed || overflow) throw new GitFailure();
    return Buffer.concat(chunks, total);
  } catch (error) {
    child.kill("SIGKILL");
    await monitored.completion;
    throwIfAborted(signal);
    if (error instanceof GitFailure) throw error;
    throw new GitFailure();
  } finally {
    monitored.dispose();
  }
}

async function runGitRecords(
  root: string,
  args: readonly string[],
  signal: AbortSignal | undefined,
  maximumRecords: number,
): Promise<readonly string[]> {
  throwIfAborted(signal);
  const child = spawnGit(root, args);
  const monitored = monitorChild(child, signal);
  child.stdin.end();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const records: string[] = [];
  let pending = Buffer.alloc(0);
  let overflow = false;
  try {
    for await (const value of child.stdout) {
      const chunk = Buffer.from(value as Uint8Array);
      pending =
        pending.byteLength === 0 ? chunk : Buffer.concat([pending, chunk]);
      while (true) {
        const delimiter = pending.indexOf(0);
        if (delimiter === -1) break;
        const raw = pending.subarray(0, delimiter);
        pending = pending.subarray(delimiter + 1);
        if (
          raw.byteLength > MAX_GIT_RECORD_BYTES ||
          records.length >= maximumRecords
        ) {
          overflow = true;
          child.kill("SIGKILL");
          break;
        }
        records.push(decoder.decode(raw));
      }
      if (overflow || pending.byteLength > MAX_GIT_RECORD_BYTES) {
        overflow = true;
        child.kill("SIGKILL");
        break;
      }
    }
    const completed = await monitored.completion;
    throwIfAborted(signal);
    if (!completed || overflow || pending.byteLength !== 0)
      throw new GitFailure();
    return records;
  } catch (error) {
    child.kill("SIGKILL");
    await monitored.completion;
    throwIfAborted(signal);
    if (error instanceof GitFailure) throw error;
    throw new GitFailure();
  } finally {
    monitored.dispose();
  }
}

class GitByteReader {
  readonly #iterator: AsyncIterator<unknown>;
  #pending = Buffer.alloc(0);

  constructor(stream: NodeJS.ReadableStream) {
    this.#iterator = stream[Symbol.asyncIterator]();
  }

  async #fill(): Promise<void> {
    const next = await this.#iterator.next();
    if (next.done) throw new GitFailure();
    const chunk = Buffer.from(next.value as Uint8Array);
    this.#pending =
      this.#pending.byteLength === 0
        ? chunk
        : Buffer.concat([this.#pending, chunk]);
  }

  async line(maximumBytes: number): Promise<string> {
    while (true) {
      const newline = this.#pending.indexOf(0x0a);
      if (newline !== -1) {
        if (newline > maximumBytes) throw new GitFailure();
        const line = this.#pending.subarray(0, newline).toString("ascii");
        this.#pending = this.#pending.subarray(newline + 1);
        return line;
      }
      if (this.#pending.byteLength > maximumBytes) throw new GitFailure();
      await this.#fill();
    }
  }

  async consume(
    byteLength: number,
    consumeChunk: (chunk: Uint8Array) => void,
  ): Promise<void> {
    let remaining = byteLength;
    while (remaining > 0) {
      if (this.#pending.byteLength === 0) await this.#fill();
      const length = Math.min(remaining, this.#pending.byteLength);
      const chunk = this.#pending.subarray(0, length);
      consumeChunk(chunk);
      this.#pending = this.#pending.subarray(length);
      remaining -= length;
    }
  }

  async byte(): Promise<number> {
    if (this.#pending.byteLength === 0) await this.#fill();
    const value = this.#pending[0];
    this.#pending = this.#pending.subarray(1);
    if (value === undefined) throw new GitFailure();
    return value;
  }
}

class GitBatchReader {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #reader: GitByteReader;
  readonly #completion: Promise<boolean>;
  readonly #disposeMonitor: () => void;
  readonly #signal: AbortSignal | undefined;
  #finished = false;

  constructor(root: string, signal: AbortSignal | undefined) {
    this.#child = spawnGit(root, ["cat-file", "--batch"]);
    const monitored = monitorChild(this.#child, signal);
    this.#completion = monitored.completion;
    this.#disposeMonitor = monitored.dispose;
    this.#reader = new GitByteReader(this.#child.stdout);
    this.#signal = signal;
  }

  async #request(oid: string): Promise<number> {
    throwIfAborted(this.#signal);
    if (!this.#child.stdin.write(`${oid}\n`)) {
      await once(this.#child.stdin, "drain");
    }
    const header = await this.#reader.line(256);
    const match = /^([a-f0-9]{40,64}) blob ([0-9]+)$/u.exec(header);
    if (match === null || match[1] !== oid) throw new GitFailure();
    const size = Number(match[2]);
    if (!Number.isSafeInteger(size) || size < 0) throw new GitFailure();
    return size;
  }

  async bytes(
    oid: string,
    expectedSize: number,
    maximumBytes: number,
  ): Promise<Uint8Array> {
    const size = await this.#request(oid);
    if (size !== expectedSize || size > maximumBytes) throw new GitFailure();
    const chunks: Buffer[] = [];
    await this.#reader.consume(size, (chunk) =>
      chunks.push(Buffer.from(chunk)),
    );
    if ((await this.#reader.byte()) !== 0x0a) throw new GitFailure();
    throwIfAborted(this.#signal);
    return Buffer.concat(chunks, size);
  }

  async hash(
    oid: string,
    expectedSize: number,
    maximumBytes: number,
  ): Promise<string> {
    const size = await this.#request(oid);
    if (size !== expectedSize || size > maximumBytes) throw new GitFailure();
    const hash = createHash("sha256");
    await this.#reader.consume(size, (chunk) => hash.update(chunk));
    if ((await this.#reader.byte()) !== 0x0a) throw new GitFailure();
    throwIfAborted(this.#signal);
    return hash.digest("hex");
  }

  async finish(): Promise<void> {
    if (this.#finished) return;
    this.#finished = true;
    this.#child.stdin.end();
    const completed = await this.#completion;
    this.#disposeMonitor();
    throwIfAborted(this.#signal);
    if (!completed) throw new GitFailure();
  }

  async abort(): Promise<void> {
    if (this.#finished) return;
    this.#finished = true;
    this.#child.kill("SIGKILL");
    await this.#completion;
    this.#disposeMonitor();
  }
}

function hasUnsafeBaseRefCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      codePoint <= 0x20 ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
      /\p{White_Space}/u.test(character) ||
      "~^:?*[\\".includes(character)
    ) {
      return true;
    }
  }
  return false;
}

function hasUnsafeGitPathCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      character === "\\" ||
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f)
    ) {
      return true;
    }
  }
  return false;
}

function validBaseRef(value: string): boolean {
  if (/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(value)) return true;
  if (
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_BASE_REF_BYTES ||
    value === "@" ||
    value.startsWith("-") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.includes("..") ||
    value.includes("@{") ||
    value.includes("//") ||
    hasUnsafeBaseRefCharacter(value)
  ) {
    return false;
  }
  return value
    .split("/")
    .every(
      (segment) =>
        segment.length > 0 &&
        !segment.startsWith(".") &&
        !segment.endsWith(".lock"),
    );
}

function validGitPath(path: string): boolean {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    Buffer.byteLength(path, "utf8") > MAX_GIT_PATH_BYTES ||
    hasUnsafeGitPathCharacter(path)
  ) {
    return false;
  }
  return path
    .split("/")
    .every(
      (segment) =>
        segment.length > 0 &&
        segment !== "." &&
        segment !== ".." &&
        Buffer.byteLength(segment, "utf8") <= 255,
    );
}

function hasGitMetadataSegment(path: string): boolean {
  return path.split("/").some((segment) => segment === ".git");
}

function parseTreeEntries(records: readonly string[]): readonly GitEntry[] {
  return records.map((record) => {
    const match =
      /^([0-7]{6}) (blob|tree|commit) ([a-f0-9]{40,64}) +(-|[0-9]+)\t([\s\S]+)$/u.exec(
        record,
      );
    if (match === null) throw new GitFailure();
    const [, mode, type, oid, rawSize, path] = match;
    if (
      mode === undefined ||
      type === undefined ||
      oid === undefined ||
      rawSize === undefined ||
      path === undefined ||
      !validGitPath(path)
    ) {
      throw new GitFailure();
    }
    const size = rawSize === "-" ? undefined : Number(rawSize);
    if (size !== undefined && (!Number.isSafeInteger(size) || size < 0)) {
      throw new GitFailure();
    }
    return {
      path,
      mode,
      type: type as GitEntry["type"],
      oid,
      ...(size === undefined ? {} : { size }),
    };
  });
}

function parseTrackedDebugEntries(
  bytes: Uint8Array,
  maximumRecords: number,
): ReadonlyMap<string, string> {
  const input = Buffer.from(bytes);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const tracked = new Map<string, string>();
  let offset = 0;
  while (offset < input.byteLength) {
    if (tracked.size >= maximumRecords) throw new GitFailure();
    const tab = input.indexOf(0x09, offset);
    const nul = tab === -1 ? -1 : input.indexOf(0, tab + 1);
    if (
      tab === -1 ||
      nul === -1 ||
      tab - offset > 128 ||
      nul - tab - 1 > MAX_GIT_PATH_BYTES
    ) {
      throw new GitFailure();
    }
    const header = input.subarray(offset, tab).toString("ascii");
    const match = /^([0-7]{6}) ([a-f0-9]{40,64}) ([0-3])$/u.exec(header);
    const path = decoder.decode(input.subarray(tab + 1, nul));
    if (match === null || !validGitPath(path) || tracked.has(path)) {
      throw new GitFailure();
    }
    const [, mode, oid, stage] = match;
    if (
      mode === undefined ||
      oid === undefined ||
      stage !== "0" ||
      /^0+$/u.test(oid)
    ) {
      throw new GitFailure();
    }
    offset = nul + 1;
    let flagsLine = "";
    for (let lineIndex = 0; lineIndex < 5; lineIndex += 1) {
      const newline = input.indexOf(0x0a, offset);
      if (newline === -1 || newline - offset > 256) throw new GitFailure();
      const line = input.subarray(offset, newline).toString("ascii");
      offset = newline + 1;
      if (lineIndex === 4) flagsLine = line;
    }
    const flagsMatch = /\bflags: ([0-9a-f]+)$/u.exec(flagsLine);
    if (flagsMatch?.[1] === undefined) throw new GitFailure();
    const flags = Number.parseInt(flagsMatch[1], 16);
    if (!Number.isSafeInteger(flags) || (flags & 0x20000000) !== 0) {
      throw new GitFailure();
    }
    tracked.set(path, mode);
  }
  return tracked;
}

async function readTrackedEntries(
  root: string,
  limits: ValidationLimits,
  signal: AbortSignal | undefined,
): Promise<ReadonlyMap<string, string>> {
  const maximumBytes = Math.min(
    Number.MAX_SAFE_INTEGER,
    limits.maxEntries * (MAX_GIT_RECORD_BYTES + 256),
  );
  return parseTrackedDebugEntries(
    await runGitBuffered(
      root,
      ["ls-files", "--stage", "--debug", "-z", "--", "."],
      signal,
      maximumBytes,
    ),
    limits.maxEntries,
  );
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseManifest(
  bytes: Uint8Array,
  limits: ValidationLimits,
  validators: SchemaValidators,
): Manifest | undefined {
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    return undefined;
  }
  const parsed = parseStrictYamlMapping(source, limits.maxYamlDepth);
  return parsed.ok && validators.manifest(parsed.value)
    ? (parsed.value as unknown as Manifest)
    : undefined;
}

function baseDisplayFile(
  path: string,
  frontmatter: Readonly<Record<string, unknown>>,
  excluded: ReadonlySet<string>,
): string {
  const bookie = isObject(frontmatter.bookie) ? frontmatter.bookie : undefined;
  return typeof bookie?.sensitivity === "string" &&
    excluded.has(bookie.sensitivity)
    ? "<excluded>"
    : path;
}

function toBookieData(
  frontmatter: Readonly<Record<string, unknown>>,
): BookieData {
  return frontmatter.bookie as unknown as BookieData;
}

function baseInvalid(collector: DiagnosticCollector): void {
  collector.add(createDiagnostic("GIT-BASE", "/bookie.yaml"));
  collector.markIncomplete();
}

function redactBaseContentPaths(
  entries: readonly GitEntry[],
  redactedEntryPaths: Set<string>,
): void {
  for (const entry of entries) {
    if (
      entry.type === "blob" &&
      entry.path !== "bookie.yaml" &&
      entry.path !== "index.md"
    ) {
      redactedEntryPaths.add(`/${entry.path}`);
    }
  }
}

function decodeGitLine(bytes: Uint8Array, maximumBytes: number): string {
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > maximumBytes + 1 ||
    bytes.at(-1) !== 0x0a
  ) {
    throw new GitFailure();
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(0, bytes.byteLength - 1),
    );
  } catch {
    throw new GitFailure();
  }
}

async function resolveGitBase(
  root: string,
  baseRef: string,
  signal: AbortSignal | undefined,
): Promise<ResolvedGitBase> {
  if (!validBaseRef(baseRef)) throw new GitFailure();
  const inside = Buffer.from(
    await runGitBuffered(
      root,
      ["rev-parse", "--is-inside-work-tree"],
      signal,
      32,
    ),
  )
    .toString("ascii")
    .trim();
  if (inside !== "true") throw new GitFailure();
  const objectFormat = decodeGitLine(
    await runGitBuffered(
      root,
      ["rev-parse", "--show-object-format"],
      signal,
      16,
    ),
    16,
  );
  if (objectFormat !== "sha1" && objectFormat !== "sha256") {
    throw new GitFailure();
  }
  const objectIdLength = objectFormat === "sha1" ? 40 : 64;
  if (/^[A-Fa-f0-9]+$/u.test(baseRef) && baseRef.length < objectIdLength) {
    throw new GitFailure();
  }
  const exactOid = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(baseRef);
  if (exactOid) {
    if (baseRef.length !== objectIdLength) throw new GitFailure();
  } else {
    const symbolic = decodeGitLine(
      await runGitBuffered(
        root,
        [
          "rev-parse",
          "--symbolic-full-name",
          "--verify",
          "--end-of-options",
          baseRef,
        ],
        signal,
        512,
      ),
      512,
    );
    if (
      symbolic === "" ||
      (symbolic !== "HEAD" &&
        (!symbolic.startsWith("refs/") || !validBaseRef(symbolic)))
    ) {
      throw new GitFailure();
    }
  }
  const commit = decodeGitLine(
    await runGitBuffered(
      root,
      ["rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`],
      signal,
      128,
    ),
    128,
  );
  if (
    !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(commit) ||
    commit.length !== objectIdLength
  ) {
    throw new GitFailure();
  }
  const rawPrefix = decodeGitLine(
    await runGitBuffered(
      root,
      ["rev-parse", "--show-prefix"],
      signal,
      MAX_GIT_PATH_BYTES + 1,
    ),
    MAX_GIT_PATH_BYTES + 1,
  );
  const prefix = rawPrefix.endsWith("/") ? rawPrefix.slice(0, -1) : rawPrefix;
  if (prefix !== "" && !validGitPath(prefix)) throw new GitFailure();
  return { commit, prefix };
}

function normalizeTreeEntries(
  entries: readonly GitEntry[],
  prefix: string,
): readonly GitEntry[] {
  if (prefix === "") return entries;
  const normalized: GitEntry[] = [];
  for (const entry of entries) {
    if (
      entry.type === "tree" &&
      (entry.path === prefix || prefix.startsWith(`${entry.path}/`))
    ) {
      continue;
    }
    if (!entry.path.startsWith(`${prefix}/`)) throw new GitFailure();
    const path = entry.path.slice(prefix.length + 1);
    if (!validGitPath(path)) throw new GitFailure();
    normalized.push({ ...entry, path });
  }
  return normalized;
}

function trackingMatches(
  left: ReadonlyMap<string, string>,
  right: ReadonlyMap<string, string>,
): boolean {
  return (
    left.size === right.size &&
    [...left].every(([path, mode]) => right.get(path) === mode)
  );
}

function currentTrackingIsComplete(
  entries: VaultEntries,
  tracked: ReadonlyMap<string, string>,
): boolean {
  if ([...tracked.values()].some((mode) => !ordinaryModes.has(mode))) {
    return false;
  }
  for (const path of entries.regularFiles) {
    const mode = tracked.get(path);
    if (mode === undefined || !ordinaryModes.has(mode)) return false;
  }
  return true;
}

function sourceDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function validateGitBase(
  input: ValidateGitBaseInput,
): Promise<ValidateGitBaseResult> {
  const {
    root,
    baseRef,
    currentManifest,
    currentExcludedSensitivityClasses,
    currentRecords,
    currentSourceDigests,
    entries,
    limits,
    validators,
    collector,
    redactedEntryPaths,
    signal,
    tracker,
  } = input;
  throwIfAborted(signal);

  let baseCommit: string | undefined;
  let treeEntries: readonly GitEntry[] = [];
  let initialTracking: ReadonlyMap<string, string>;
  try {
    const resolvedBase = await resolveGitBase(root, baseRef, signal);
    baseCommit = resolvedBase.commit;
    const treeRecords = await runGitRecords(
      root,
      ["ls-tree", "-r", "-t", "-z", "-l", "--full-tree", baseCommit, "--", "."],
      signal,
      limits.maxEntries + 65,
    );
    treeEntries = normalizeTreeEntries(
      parseTreeEntries(treeRecords),
      resolvedBase.prefix,
    ).filter((entry) => !hasGitMetadataSegment(entry.path));
    if (treeEntries.length > limits.maxEntries) throw new GitFailure();
    if (
      treeEntries.some(
        (entry) =>
          (entry.type === "blob" &&
            !ordinaryModes.has(entry.mode) &&
            entry.mode !== "040000") ||
          entry.type === "commit" ||
          (entry.type === "tree" && entry.mode !== "040000"),
      )
    ) {
      throw new GitFailure();
    }
    initialTracking = await readTrackedEntries(root, limits, signal);
    if (!currentTrackingIsComplete(entries, initialTracking)) {
      throw new GitFailure();
    }
  } catch {
    throwIfAborted(signal);
    redactBaseContentPaths(treeEntries, redactedEntryPaths);
    baseInvalid(collector);
    return baseCommit === undefined ? {} : { baseCommit };
  }

  const blobs = new Map(
    treeEntries
      .filter((entry) => entry.type === "blob")
      .map((entry) => [entry.path, entry]),
  );
  const manifestEntry = blobs.get("bookie.yaml");
  const indexEntry = blobs.get("index.md");
  if (
    manifestEntry?.size === undefined ||
    indexEntry?.size === undefined ||
    manifestEntry.size > limits.maxManifestBytes ||
    indexEntry.size > limits.maxConceptBytes
  ) {
    redactBaseContentPaths(treeEntries, redactedEntryPaths);
    baseInvalid(collector);
    return { baseCommit };
  }

  const batch = new GitBatchReader(root, signal);
  try {
    const baseManifest = parseManifest(
      await batch.bytes(
        manifestEntry.oid,
        manifestEntry.size,
        limits.maxManifestBytes,
      ),
      limits,
      validators,
    );
    const index = loadConcept(
      await batch.bytes(
        indexEntry.oid,
        indexEntry.size,
        limits.maxConceptBytes,
      ),
      {
        file: "/index.md",
        maxBytes: limits.maxConceptBytes,
        maxDepth: limits.maxYamlDepth,
      },
    );
    if (
      baseManifest === undefined ||
      !index.ok ||
      index.concept.frontmatter.okf_version !== "0.2"
    ) {
      throw new GitFailure();
    }

    const excluded = new Set([
      ...baseManifest.policy.sensitivity.excluded_classes,
      ...currentExcludedSensitivityClasses,
    ]);
    const baseRecords: BaseRecord[] = [];
    const baseByUid = new Map<string, BaseRecord>();
    const evidenceResourceFiles = new Set<string>();
    let conceptCount = 0;
    let totalConceptBytes = indexEntry.size;
    const allMarkdownEntries = treeEntries
      .filter(
        (entry) =>
          entry.type === "blob" &&
          entry.path.endsWith(".md") &&
          entry.path !== "index.md" &&
          !matchesExcludedPath(entry.path, baseManifest.policy.exclude),
      )
      .sort((left, right) =>
        left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
      );
    const markdownEntries = [
      ...allMarkdownEntries.filter(
        (entry) =>
          !isBeneathLiteralPath(entry.path, baseManifest.policy.evidence_roots),
      ),
      ...allMarkdownEntries.filter((entry) =>
        isBeneathLiteralPath(entry.path, baseManifest.policy.evidence_roots),
      ),
    ];

    for (const entry of markdownEntries) {
      throwIfAborted(signal);
      const insideEvidenceRoot = isBeneathLiteralPath(
        entry.path,
        baseManifest.policy.evidence_roots,
      );
      if (insideEvidenceRoot && evidenceResourceFiles.has(entry.path)) {
        continue;
      }
      if (entry.size === undefined || entry.size > limits.maxConceptBytes)
        throw new GitFailure();
      totalConceptBytes += entry.size;
      if (totalConceptBytes > limits.maxTotalConceptBytes)
        throw new GitFailure();
      const name = entry.path.split("/").at(-1);
      const bytes = await batch.bytes(
        entry.oid,
        entry.size,
        limits.maxConceptBytes,
      );
      if (name === "index.md" || name === "log.md") continue;
      conceptCount += 1;
      if (conceptCount > limits.maxConcepts) throw new GitFailure();
      const loaded = loadConcept(bytes, {
        file: `/${entry.path}`,
        maxBytes: limits.maxConceptBytes,
        maxDepth: limits.maxYamlDepth,
      });
      if (!loaded.ok) throw new GitFailure();
      const frontmatter = loaded.concept.frontmatter;
      if (
        frontmatter.type === "Evidence" &&
        typeof frontmatter.resource === "string" &&
        frontmatter.resource.startsWith("/")
      ) {
        evidenceResourceFiles.add(frontmatter.resource.slice(1));
      }
      if (insideEvidenceRoot) throw new GitFailure();
      const type = frontmatter.type;
      const rawBookie = isObject(frontmatter.bookie)
        ? frontmatter.bookie
        : undefined;
      if (rawBookie === undefined) {
        if (typeof type !== "string" || type.length === 0)
          throw new GitFailure();
        continue;
      }
      if (typeof type !== "string") throw new GitFailure();
      const validate = validators.byType.get(type);
      if (
        validate === undefined ||
        !validate(frontmatter) ||
        !baseManifest.allowed_concept_types.includes(type)
      ) {
        throw new GitFailure();
      }
      const bookie = toBookieData(frontmatter);
      if (baseByUid.has(bookie.uid)) throw new GitFailure();
      const record: BaseRecord = {
        path: `/${entry.path}`,
        displayFile: baseDisplayFile(`/${entry.path}`, frontmatter, excluded),
        type,
        status: frontmatter.status as string,
        frontmatter,
        bookie,
        sourceDigest: sourceDigest(bytes),
      };
      baseByUid.set(bookie.uid, record);
      baseRecords.push(record);
      if (record.displayFile === "<excluded>") {
        redactedEntryPaths.add(record.path);
        const addSensitivePath = (value: unknown): void => {
          if (typeof value === "string" && value.startsWith("/")) {
            redactedEntryPaths.add(value);
          }
        };
        addSensitivePath(frontmatter.resource);
        addSensitivePath(bookie.project);
        for (const relation of bookie.relations ?? []) {
          addSensitivePath(relation.target);
        }
        for (const support of bookie.supports ?? []) addSensitivePath(support);
      }
    }

    const baseByPath = new Map(
      baseRecords.map((record) => [record.path, record]),
    );
    const currentByPath = new Map(
      currentRecords.map((record) => [record.path, record]),
    );
    const currentByUid = new Map(
      currentRecords.map((record) => [record.bookie.uid, record]),
    );

    for (const original of baseRecords) {
      throwIfAborted(signal);
      if (original.type === "Decision") {
        const retained = currentByUid.get(original.bookie.uid);
        if (retained === undefined || retained.type !== "Decision") {
          collector.add(
            createDiagnostic("DECISION-SUPERSESSION", original.displayFile),
          );
        }
      }
      if (original.type !== "Activity" && original.type !== "Evidence")
        continue;

      const candidate = currentByPath.get(original.path);
      if (
        candidate === undefined ||
        candidate.type !== original.type ||
        candidate.bookie.uid !== original.bookie.uid ||
        currentSourceDigests.get(original.path) !== original.sourceDigest
      ) {
        collector.add(
          createDiagnostic(
            original.type === "Activity"
              ? "ACTIVITY-IMMUTABLE"
              : "EVIDENCE-IMMUTABLE",
            original.displayFile,
          ),
        );
      }

      const comparePinned = (
        path: string | undefined,
        code: "PROJECT-TARGET" | "RELATION-TARGET" | "EVIDENCE-SUPPORT",
      ): void => {
        if (path === undefined) return;
        const before = baseByPath.get(path);
        if (before === undefined) throw new GitFailure();
        const after = currentByPath.get(path);
        if (after === undefined || after.bookie.uid !== before.bookie.uid) {
          collector.add(createDiagnostic(code, original.displayFile));
        }
      };
      comparePinned(original.bookie.project, "PROJECT-TARGET");
      for (const relation of original.bookie.relations ?? []) {
        comparePinned(relation.target, "RELATION-TARGET");
      }
      if (original.type === "Evidence") {
        for (const support of original.bookie.supports ?? []) {
          comparePinned(support, "EVIDENCE-SUPPORT");
        }
      }
    }

    let baseResourceBytes = 0;
    let currentResourceBytes = 0;
    const baseResourceHashes = new Map<
      string,
      { readonly digest: string; readonly size: number }
    >();
    const currentResourceHashes = new Map<
      string,
      { readonly digest: string; readonly size: number }
    >();
    for (const evidence of baseRecords.filter(
      (record) => record.type === "Evidence",
    )) {
      throwIfAborted(signal);
      const resource = evidence.frontmatter.resource;
      if (typeof resource !== "string" || !resource.startsWith("/"))
        throw new GitFailure();
      const relativeResource = resource.slice(1);
      const baseEntry = blobs.get(relativeResource);
      if (
        baseEntry?.size === undefined ||
        !ordinaryModes.has(baseEntry.mode) ||
        !isBeneathLiteralPath(
          relativeResource,
          baseManifest.policy.evidence_roots,
        ) ||
        baseEntry.size > baseManifest.policy.attachment_max_bytes
      ) {
        throw new GitFailure();
      }
      let baseHash = baseResourceHashes.get(relativeResource);
      if (baseHash === undefined) {
        baseResourceBytes += baseEntry.size;
        if (baseResourceBytes > limits.maxTotalResourceBytes)
          throw new GitFailure();
        baseHash = {
          digest: await batch.hash(
            baseEntry.oid,
            baseEntry.size,
            baseManifest.policy.attachment_max_bytes,
          ),
          size: baseEntry.size,
        };
        baseResourceHashes.set(relativeResource, baseHash);
      }
      if (baseHash.digest !== evidence.bookie.sha256) throw new GitFailure();

      let currentHash = currentResourceHashes.get(relativeResource);
      if (currentHash === undefined) {
        const remaining = limits.maxTotalResourceBytes - currentResourceBytes;
        if (remaining <= 0) throw new GitFailure();
        const hashed = await hashSafeBoundedFile(
          root,
          relativeResource,
          Math.min(
            currentManifest?.policy.attachment_max_bytes ??
              baseManifest.policy.attachment_max_bytes,
            remaining,
          ),
          signal,
          tracker,
        );
        if (hashed.ok) {
          currentResourceBytes += hashed.size;
          currentHash = { digest: hashed.digest, size: hashed.size };
          currentResourceHashes.set(relativeResource, currentHash);
        } else {
          currentResourceBytes += hashed.bytesRead;
        }
      }
      if (
        currentHash === undefined ||
        currentHash.size !== baseHash.size ||
        currentHash.digest !== baseHash.digest
      ) {
        collector.add(
          createDiagnostic("EVIDENCE-RESOURCE", evidence.displayFile),
        );
      }
    }

    const finalTracking = await readTrackedEntries(root, limits, signal);
    if (
      !trackingMatches(initialTracking, finalTracking) ||
      !currentTrackingIsComplete(entries, finalTracking)
    ) {
      throw new GitFailure();
    }
    await batch.finish();
    return { baseCommit };
  } catch {
    await batch.abort();
    throwIfAborted(signal);
    redactBaseContentPaths(treeEntries, redactedEntryPaths);
    baseInvalid(collector);
    return { baseCommit };
  }
}
