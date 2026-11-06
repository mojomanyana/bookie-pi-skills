import { constants } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { withRootMutationQueue } from "./concept-mutation-filesystem.js";
import {
  computeConceptSourceHash,
  isObject,
} from "./concept-mutation-model.js";
import { containsDetectedSecret } from "./vault-secret-detection.js";
import {
  createPathTracker,
  readSafeBoundedFile,
  verifyTrackedPaths,
} from "./vault-filesystem.js";
import { throwIfAborted } from "./vault-cancellation.js";
import { inspectConcept } from "./filesystem-query.js";
import {
  RECALL_SCAN_LIMITS,
  inspectRecallScope,
  readRecallManifest,
  recallFailure,
  safeText,
  validHash,
  validRevision,
} from "./recall-scope.js";
import type {
  ConceptRevision,
  ProducerReference,
  RecallControl,
  RecallMutationOptions,
  RecallReadOptions,
  RecallResult,
  RecallState,
  RecallTarget,
  RegisterProducerOptions,
} from "./recall-model.js";

export const RECALL_STATE_FILE = "bookie-recall.json";
export const RECALL_MARKER_FILE = ".bookie-recall-initialized";
const MAX_STATE_BYTES = 1_048_576;
const MAX_RECORDS = 1024;
function keys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  return (
    Object.keys(value).length === expected.length &&
    Object.keys(value).every((key) => expected.includes(key))
  );
}
function validProject(value: unknown): boolean {
  return validRevision(value) && isObject(value) && safeText(value.uid, 64);
}
function validProducer(value: unknown): value is ProducerReference {
  if (
    !isObject(value) ||
    !keys(value, [
      "producer",
      "producerInstance",
      "owner",
      "operationId",
      "executionId",
      "kind",
      "reference",
    ])
  )
    return false;
  const owner = value.owner,
    ref = value.reference;
  return (
    safeText(value.producer, 128) &&
    safeText(value.producerInstance, 1024) &&
    safeText(value.operationId, 512) &&
    safeText(value.executionId, 512) &&
    safeText(value.kind, 128) &&
    isObject(owner) &&
    keys(owner, ["sessionId", "cwd"]) &&
    safeText(owner.sessionId, 512) &&
    safeText(owner.cwd) &&
    isObject(ref) &&
    keys(ref, ["locator", "sha256", "byteLength"]) &&
    safeText(ref.locator) &&
    typeof ref.sha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(ref.sha256) &&
    typeof ref.byteLength === "number" &&
    Number.isSafeInteger(ref.byteLength) &&
    ref.byteLength >= 0
  );
}
export function producerReferenceId(record: ProducerReference): string {
  if (!validProducer(record)) throw new TypeError("Invalid producer reference");
  return computeConceptSourceHash(
    Buffer.from(
      JSON.stringify([
        record.producer,
        record.producerInstance,
        record.owner.sessionId,
        record.owner.cwd,
        record.operationId,
        record.executionId,
        record.kind,
      ]),
    ),
  );
}
function sameProducer(
  left: ProducerReference,
  right: ProducerReference,
): boolean {
  return (
    producerReferenceId(left) === producerReferenceId(right) &&
    left.reference.locator === right.reference.locator &&
    left.reference.sha256 === right.reference.sha256 &&
    left.reference.byteLength === right.reference.byteLength
  );
}
function targetKey(target: RecallTarget): string {
  return target.kind === "concept"
    ? "concept:" + target.uid
    : "producer:" + target.registrationId;
}
function validTarget(value: unknown): value is RecallTarget {
  return (
    isObject(value) &&
    (value.kind === "concept"
      ? keys(value, ["kind", "uid"]) && safeText(value.uid, 64)
      : value.kind === "producer" &&
        keys(value, ["kind", "registrationId"]) &&
        validHash(value.registrationId))
  );
}
function validControl(value: unknown): value is RecallControl {
  if (!isObject(value) || !validTarget(value.target)) return false;
  if (value.disposition === "suppressed")
    return keys(value, ["target", "disposition"]);
  return (
    value.disposition === "superseded" &&
    keys(value, ["target", "disposition", "replacement"]) &&
    validProject(value.replacement)
  );
}
function validState(value: unknown, vaultUid: string): value is RecallState {
  if (
    !isObject(value) ||
    !keys(value, [
      "schemaVersion",
      "vaultUid",
      "sequence",
      "previousRevision",
      "controls",
      "registrations",
    ]) ||
    value.schemaVersion !== 1 ||
    value.vaultUid !== vaultUid ||
    typeof value.sequence !== "number" ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 0 ||
    (value.sequence === 0
      ? value.previousRevision !== null
      : !validHash(value.previousRevision)) ||
    !Array.isArray(value.controls) ||
    !Array.isArray(value.registrations) ||
    value.controls.length > MAX_RECORDS ||
    value.registrations.length > MAX_RECORDS
  )
    return false;
  for (const row of value.controls) {
    if (!isObject(row) || !validProject(row.project)) return false;
    const control: Record<string, unknown> = {
      target: row.target,
      disposition: row.disposition,
      ...(row.replacement === undefined
        ? {}
        : { replacement: row.replacement }),
    };
    if (
      Object.keys(row).some(
        (key) =>
          !["project", "target", "disposition", "replacement"].includes(key),
      )
    )
      return false;
    if (!validControl(control)) return false;
  }
  const ids = new Set<string>();
  for (const row of value.registrations) {
    if (
      !isObject(row) ||
      !keys(row, ["id", "project", "record", "sensitivity"]) ||
      !safeText(row.sensitivity, 128) ||
      !validProject(row.project) ||
      !validProducer(row.record) ||
      row.id !== producerReferenceId(row.record) ||
      ids.has(row.id as string)
    )
      return false;
    ids.add(row.id as string);
  }
  return true;
}
async function filePresent(root: string, name: string): Promise<boolean> {
  try {
    await lstat(join(root, name));
    return true;
  } catch (error) {
    if (isObject(error) && error.code === "ENOENT") return false;
    throw error;
  }
}
// Registration appends do not change canonical disclosure controls. Retain the
// complete ordered history (including effective no-ops), never just its final set.
function controlsRevision(state: RecallState): `sha256:${string}` {
  return computeConceptSourceHash(
    Buffer.from(
      JSON.stringify(
        {
          kind: "bookie-recall-controls/v1",
          schemaVersion: state.schemaVersion,
          vaultUid: state.vaultUid,
          controls: state.controls,
        },
        (_key: string, value: unknown) =>
          isObject(value)
            ? Object.fromEntries(
                Object.keys(value)
                  .sort()
                  .map((key) => [key, value[key]]),
              )
            : value,
      ),
    ),
  );
}
async function readStateAt(
  root: string,
  vaultUid: string,
  options: RecallReadOptions,
): Promise<
  RecallResult<{
    revision: `sha256:${string}`;
    controlsRevision: `sha256:${string}`;
    state: RecallState;
  }>
> {
  const { signal } = options;
  throwIfAborted(signal);
  try {
    const markerExists = await filePresent(root, RECALL_MARKER_FILE),
      stateExists = await filePresent(root, RECALL_STATE_FILE);
    if (!markerExists && !stateExists) return recallFailure("not-configured");
    if (!markerExists || !stateExists) return recallFailure("invalid-state");
    const tracker = createPathTracker();
    const marker = await readSafeBoundedFile(
      root,
      RECALL_MARKER_FILE,
      4096,
      signal,
      tracker,
    );
    const source = await readSafeBoundedFile(
      root,
      RECALL_STATE_FILE,
      MAX_STATE_BYTES,
      signal,
      tracker,
    );
    if (
      !marker.ok ||
      !source.ok ||
      !(await verifyTrackedPaths(tracker, signal))
    )
      return recallFailure("invalid-state");
    const decode = new TextDecoder("utf-8", { fatal: true });
    const markerValue: unknown = JSON.parse(decode.decode(marker.bytes));
    const state: unknown = JSON.parse(decode.decode(source.bytes));
    if (
      !isObject(markerValue) ||
      !keys(markerValue, ["schemaVersion", "vaultUid"]) ||
      markerValue.schemaVersion !== 1 ||
      markerValue.vaultUid !== vaultUid ||
      !validState(state, vaultUid) ||
      containsDetectedSecret(state)
    )
      return recallFailure("invalid-state");
    return {
      ok: true,
      revision: computeConceptSourceHash(source.bytes),
      controlsRevision: controlsRevision(state),
      state,
    };
  } catch {
    throwIfAborted(signal);
    return recallFailure("invalid-state");
  }
}
export async function readRecallState(
  root: string | URL,
  options: RecallReadOptions = {},
): Promise<
  RecallResult<{
    revision: `sha256:${string}`;
    controlsRevision: `sha256:${string}`;
    state: RecallState;
  }>
> {
  const loaded = await readRecallManifest(root, options);
  return loaded.ok
    ? readStateAt(loaded.root, loaded.manifest.vault.uid, options)
    : loaded;
}
async function authority(options: RecallMutationOptions): Promise<boolean> {
  if (typeof options?.assertAuthority !== "function") return false;
  try {
    await options.assertAuthority();
    return true;
  } catch {
    throwIfAborted(options.signal);
    return false;
  }
}
async function writeExclusive(
  root: string,
  name: string,
  bytes: Buffer,
): Promise<void> {
  if (typeof constants.O_NOFOLLOW !== "number") throw Error("Unavailable");
  const handle = await open(
    join(root, name),
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function removeTemporary(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isObject(error) || error.code !== "ENOENT") throw error;
  }
}
async function publishState(
  root: string,
  state: RecallState,
  options: RecallMutationOptions,
  verify: () => Promise<boolean>,
): Promise<RecallResult<{ revision: `sha256:${string}` }>> {
  const bytes = Buffer.from(JSON.stringify(state) + "\n");
  if (bytes.length > MAX_STATE_BYTES) return recallFailure("bounds");
  if (!(await authority(options))) return recallFailure("authority");
  throwIfAborted(options.signal);
  const temporary = ".bookie-recall-" + randomUUID() + ".tmp";
  try {
    await writeExclusive(root, temporary, bytes);
    if (!(await authority(options))) return recallFailure("authority");
    throwIfAborted(options.signal);
    if (!(await verify())) return recallFailure("stale");
    if (!(await authority(options))) return recallFailure("authority");
    await rename(join(root, temporary), join(root, RECALL_STATE_FILE));
    const dir = await open(root, constants.O_RDONLY);
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
    return { ok: true, revision: computeConceptSourceHash(bytes) };
  } finally {
    await removeTemporary(join(root, temporary));
  }
}
export async function initializeRecallState(
  root: string | URL,
  options: RecallMutationOptions,
): Promise<
  RecallResult<{
    outcome: "initialized" | "existing";
    revision: `sha256:${string}`;
    state: RecallState;
  }>
> {
  if (!(await authority(options))) return recallFailure("authority");
  const loaded = await readRecallManifest(root, options);
  if (!loaded.ok) return loaded;
  try {
    return await withRootMutationQueue(
      loaded.root,
      options.signal,
      async () => {
        if (!(await authority(options))) return recallFailure("authority");
        const lockedManifest = await readRecallManifest(loaded.root, options);
        if (
          !lockedManifest.ok ||
          lockedManifest.manifestRevision !== loaded.manifestRevision
        )
          return recallFailure("stale");
        const current = await readStateAt(
          loaded.root,
          loaded.manifest.vault.uid,
          options,
        );
        if (current.ok) return { ...current, outcome: "existing" as const };
        if (current.reason !== "not-configured") return current;
        const state: RecallState = {
          schemaVersion: 1,
          vaultUid: loaded.manifest.vault.uid,
          sequence: 0,
          previousRevision: null,
          controls: [],
          registrations: [],
        };
        await writeExclusive(
          loaded.root,
          RECALL_MARKER_FILE,
          Buffer.from(
            JSON.stringify({ schemaVersion: 1, vaultUid: state.vaultUid }) +
              "\n",
          ),
        );
        const published = await publishState(
          loaded.root,
          state,
          options,
          async () => {
            const latest = await readRecallManifest(loaded.root, options);
            return (
              latest.ok &&
              latest.manifestRevision === loaded.manifestRevision &&
              !(await filePresent(loaded.root, RECALL_STATE_FILE))
            );
          },
        );
        return published.ok
          ? { ...published, outcome: "initialized" as const, state }
          : published;
      },
    );
  } catch {
    throwIfAborted(options.signal);
    return recallFailure("io");
  }
}
export function isRecallSuppressed(
  state: RecallState,
  projectUid: string,
  target: RecallTarget,
): boolean {
  return state.controls.some(
    (row) =>
      row.project.uid === projectUid &&
      targetKey(row.target) === targetKey(target),
  );
}
export async function updateRecallControl(
  root: string | URL,
  request: {
    readonly project: ConceptRevision;
    readonly expectedRevision: string;
    readonly control: RecallControl;
  },
  options: RecallMutationOptions,
): Promise<RecallResult<{ revision: `sha256:${string}`; outcome: "updated" }>> {
  if (
    !validRevision(request?.project) ||
    !validHash(request.expectedRevision) ||
    !validControl(request.control)
  )
    return recallFailure("input");
  const captured = structuredClone(request);
  if (!(await authority(options))) return recallFailure("authority");
  const initial = await inspectRecallScope(root, captured.project, options);
  if (!initial.ok) return initial;
  try {
    return await withRootMutationQueue(
      initial.scope.root,
      options.signal,
      async () => {
        if (!(await authority(options))) return recallFailure("authority");
        const checked = await inspectRecallScope(
          initial.scope.root,
          captured.project,
          options,
        );
        if (!checked.ok) return checked;
        const current = await readStateAt(
          checked.scope.root,
          checked.scope.vaultUid,
          options,
        );
        if (!current.ok) return current;
        if (current.revision !== captured.expectedRevision)
          return recallFailure("conflict");
        if (current.state.controls.length >= MAX_RECORDS)
          return recallFailure("bounds");
        const target = captured.control.target;
        if (target.kind === "concept") {
          const concept = await inspectConcept(
            checked.scope.root,
            { uid: target.uid },
            { ...RECALL_SCAN_LIMITS, maxContentBytes: 1, ...options },
          );
          if (
            !concept.ok ||
            concept.handling === "excluded" ||
            (concept.project !== checked.scope.project.path &&
              concept.uid !== checked.scope.project.uid)
          )
            return recallFailure("scope");
        } else if (
          !current.state.registrations.some(
            (row) =>
              row.id === target.registrationId &&
              row.project.uid === checked.scope.project.uid,
          )
        )
          return recallFailure("scope");
        const replacement = captured.control.replacement;
        if (replacement) {
          const concept = await inspectConcept(
            checked.scope.root,
            { path: replacement.path },
            { ...RECALL_SCAN_LIMITS, maxContentBytes: 1, ...options },
          );
          if (
            !concept.ok ||
            concept.handling === "excluded" ||
            concept.project !== checked.scope.project.path ||
            concept.uid !== replacement.uid ||
            concept.source.sourceHash !== replacement.sourceHash ||
            (target.kind === "concept" && target.uid === replacement.uid) ||
            isRecallSuppressed(current.state, checked.scope.project.uid, {
              kind: "concept",
              uid: replacement.uid,
            })
          )
            return recallFailure("scope");
        }
        const state: RecallState = {
          ...current.state,
          sequence: current.state.sequence + 1,
          previousRevision: current.revision,
          controls: [
            ...current.state.controls,
            { ...captured.control, project: checked.scope.project },
          ],
        };
        const published = await publishState(
          checked.scope.root,
          state,
          options,
          async () => {
            const latestScope = await inspectRecallScope(
              checked.scope.root,
              captured.project,
              options,
            );
            const latestState = await readStateAt(
              checked.scope.root,
              checked.scope.vaultUid,
              options,
            );
            return (
              latestScope.ok &&
              latestScope.scope.manifestRevision ===
                checked.scope.manifestRevision &&
              latestState.ok &&
              latestState.revision === current.revision
            );
          },
        );
        return published.ok
          ? { ...published, outcome: "updated" as const }
          : published;
      },
    );
  } catch {
    throwIfAborted(options.signal);
    return recallFailure("io");
  }
}
export async function registerProducerReference(
  root: string | URL,
  request: {
    readonly project: ConceptRevision;
    readonly record: ProducerReference;
    readonly sensitivity: string;
    readonly expectedRevision: string;
  },
  options: RegisterProducerOptions,
): Promise<
  RecallResult<{
    outcome: "registered" | "reused";
    revision: `sha256:${string}`;
    registrationId: string;
  }>
> {
  if (
    !validRevision(request?.project) ||
    !validProducer(request.record) ||
    !safeText(request.sensitivity, 128) ||
    !validHash(request.expectedRevision) ||
    typeof options?.resolveReference !== "function"
  )
    return recallFailure("input");
  const captured = structuredClone(request);
  if (!(await authority(options))) return recallFailure("authority");
  const initial = await inspectRecallScope(root, captured.project, options);
  if (!initial.ok) return initial;
  try {
    return await withRootMutationQueue(
      initial.scope.root,
      options.signal,
      async () => {
        if (!(await authority(options))) return recallFailure("authority");
        const checked = await inspectRecallScope(
          initial.scope.root,
          captured.project,
          options,
        );
        if (!checked.ok) return checked;
        const current = await readStateAt(
          checked.scope.root,
          checked.scope.vaultUid,
          options,
        );
        if (!current.ok) return current;
        if (
          !checked.scope.sensitivityClasses.includes(captured.sensitivity) ||
          checked.scope.excludedClasses.includes(captured.sensitivity)
        )
          return recallFailure("policy");
        const registrationId = producerReferenceId(captured.record);
        if (
          isRecallSuppressed(current.state, checked.scope.project.uid, {
            kind: "producer",
            registrationId,
          })
        )
          return recallFailure("suppressed");
        const existing = current.state.registrations.find(
          (row) => row.id === registrationId,
        );
        if (
          existing &&
          (existing.project.uid !== checked.scope.project.uid ||
            existing.sensitivity !== captured.sensitivity ||
            !sameProducer(existing.record, captured.record))
        )
          return recallFailure("conflict");
        let resolved;
        try {
          resolved = await options.resolveReference(
            structuredClone(captured.record),
          );
        } catch {
          throwIfAborted(options.signal);
          return recallFailure("unavailable");
        }
        if (
          resolved.sha256 !== captured.record.reference.sha256 ||
          resolved.byteLength !== captured.record.reference.byteLength
        )
          return recallFailure("source-changed");
        if (!(await authority(options))) return recallFailure("authority");
        const finalScope = await inspectRecallScope(
          checked.scope.root,
          captured.project,
          options,
        );
        const finalState = await readStateAt(
          checked.scope.root,
          checked.scope.vaultUid,
          options,
        );
        if (
          !finalScope.ok ||
          finalScope.scope.manifestRevision !==
            checked.scope.manifestRevision ||
          !finalState.ok ||
          finalState.revision !== current.revision
        )
          return recallFailure("stale");
        if (existing)
          return {
            ok: true,
            outcome: "reused" as const,
            revision: current.revision,
            registrationId,
          };
        if (current.revision !== captured.expectedRevision)
          return recallFailure("conflict");
        if (current.state.registrations.length >= MAX_RECORDS)
          return recallFailure("bounds");
        const state: RecallState = {
          ...current.state,
          sequence: current.state.sequence + 1,
          previousRevision: current.revision,
          registrations: [
            ...current.state.registrations,
            {
              id: registrationId,
              project: checked.scope.project,
              record: captured.record,
              sensitivity: captured.sensitivity,
            },
          ],
        };
        const published = await publishState(
          checked.scope.root,
          state,
          options,
          async () => {
            const latestScope = await inspectRecallScope(
              checked.scope.root,
              captured.project,
              options,
            );
            const latestState = await readStateAt(
              checked.scope.root,
              checked.scope.vaultUid,
              options,
            );
            return (
              latestScope.ok &&
              latestScope.scope.manifestRevision ===
                checked.scope.manifestRevision &&
              latestState.ok &&
              latestState.revision === current.revision
            );
          },
        );
        return published.ok
          ? { ...published, outcome: "registered" as const, registrationId }
          : published;
      },
    );
  } catch {
    throwIfAborted(options.signal);
    return recallFailure("io");
  }
}
