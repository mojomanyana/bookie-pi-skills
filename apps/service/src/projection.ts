import { Worker } from "node:worker_threads";
import { types } from "node:util";
import { ownDataFields } from "./closed-data.js";

import {
  exportCanonicalJsonl,
  type CanonicalJsonlRecordV1,
  type CanonicalJsonlExportSuccess,
} from "@bookie/core";

/** Deployment-owned input, never a caller's authorization to index a vault. */
export interface ProjectionConfig {
  readonly vaultUid: string;
  readonly approvedSensitivityClasses: readonly string[];
  readonly maxChunkBytes: number;
  readonly maxChunks: number;
}

export interface ProjectionVersions {
  readonly projectionSchemaVersion: string;
  readonly parserVersion: string;
  readonly chunkerVersion: string;
  readonly preprocessingVersion: string;
}

export interface ConceptProjection {
  readonly uid: string;
  readonly path: string;
  readonly type: string;
  readonly title: string;
  readonly project: string | null;
  readonly lifecycle: string;
  readonly workflow: string | null;
  readonly sensitivity: string;
  readonly tags: readonly string[];
  readonly links: readonly string[];
  readonly trust: "unverified" | "declared" | "verified";
  readonly verifiedBy: readonly string[];
  readonly staleAfter: string | null;
  readonly relations: readonly Readonly<{
    kind: string;
    target: string;
    targetUid: string | null;
  }>[];
  readonly sourceCommit: string;
  readonly sourceHash: string;
  readonly projectionSchemaVersion: string;
  readonly contentTrust: "untrusted";
}

export interface ChunkProjection extends ConceptProjection {
  readonly ordinal: number;
  readonly heading: string | null;
  readonly headingPath: readonly string[];
  readonly text: string;
  readonly chunkerVersion: string;
  readonly embeddingGeneration: null;
}

export interface LexicalProjection {
  readonly buildId: string;
  readonly sourceCommit: string;
  readonly profile: "1.0";
  readonly manifestHash: string;
  readonly policyHash: string;
  readonly versions: ProjectionVersions;
  /** Private included-output evidence; the legacy local ID still includes its hash.
   * The v2 input recipe must not use this hash or alias that legacy ID. */
  readonly canonicalOutput: Readonly<{
    hash: string;
    bytes: number;
    records: number;
  }>;
  /** SHA-256 of ordered UTF-8 JSON lines, one line per included projection. */
  readonly conceptStreamHash: string;
  readonly chunkStreamHash: string;
  readonly concepts: readonly ConceptProjection[];
  readonly chunks: readonly ChunkProjection[];
}

export type PrepareProjectionResult =
  | Readonly<{ ok: true; projection: LexicalProjection }>
  | Readonly<{
      ok: false;
      reason:
        | "invalid-source"
        | "invalid-vault"
        | "sensitivity-policy"
        | "secret-policy"
        | "incomplete"
        | "output-error"
        | "projection-error";
    }>;

function object(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Internal deployment-input validation shared by the isolated ingestion entry point. */
export function snapshotProjectionConfig(
  config: ProjectionConfig,
): ProjectionConfig {
  try {
    const [vaultUid, approvedSensitivityClasses, maxChunkBytes, maxChunks] =
      ownDataFields(config, [
        "vaultUid",
        "approvedSensitivityClasses",
        "maxChunkBytes",
        "maxChunks",
      ]);
    if (
      typeof vaultUid !== "string" ||
      !/^VLT-[0-7][0-9A-HJKMNP-TV-Z]{25}(?![\s\S])/u.test(vaultUid) ||
      types.isProxy(approvedSensitivityClasses) ||
      !Array.isArray(approvedSensitivityClasses) ||
      typeof maxChunkBytes !== "number" ||
      !Number.isSafeInteger(maxChunkBytes) ||
      maxChunkBytes < 16 ||
      maxChunkBytes > 65_536 ||
      typeof maxChunks !== "number" ||
      !Number.isSafeInteger(maxChunks) ||
      maxChunks < 1 ||
      maxChunks > 250_000
    )
      throw new TypeError();
    // Bound the native array before taking one closed descriptor snapshot.
    const length = approvedSensitivityClasses.length;
    if (length > 64) throw new TypeError();
    const items = Object.getOwnPropertyDescriptors(approvedSensitivityClasses);
    if (Reflect.ownKeys(items).length !== length + 1) throw new TypeError();
    const classes: string[] = [];
    for (let i = 0; i < length; i++) {
      const item = items[String(i)];
      if (
        !Object.hasOwn(items, String(i)) ||
        item === undefined ||
        !Object.hasOwn(item, "value") ||
        typeof item.value !== "string" ||
        item.value.length > 63 ||
        !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?![\s\S])/u.test(item.value) ||
        item.value === "unknown" ||
        item.value === "unclassified"
      )
        throw new TypeError();
      classes.push(item.value);
    }
    if (new Set(classes).size !== classes.length) throw new TypeError();
    return Object.freeze({
      vaultUid,
      approvedSensitivityClasses: Object.freeze(classes.sort()),
      maxChunkBytes,
      maxChunks,
    });
  } catch {
    // Unsupported reflective inputs must retain the static public boundary.
    throw new TypeError("projection config is invalid");
  }
}

function checkAbort(signal: AbortSignal | undefined): void {
  if (signal?.aborted)
    throw new DOMException("Projection cancelled.", "AbortError");
}

/** Only validated, policy-filtered export records reach this private worker. */
async function projectInWorker(
  records: readonly CanonicalJsonlRecordV1[],
  source: CanonicalJsonlExportSuccess,
  config: ProjectionConfig,
  signal: AbortSignal | undefined,
): Promise<PrepareProjectionResult> {
  checkAbort(signal);
  let worker: Worker;
  try {
    worker = new Worker(new URL("./projection-worker.js", import.meta.url), {
      // The worker runs compiled code; caller eval/loader/inspector flags do not apply.
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 1024 },
    });
  } catch {
    return { ok: false, reason: "projection-error" };
  }
  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (result: PrepareProjectionResult, aborted = false): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      void Promise.resolve()
        .then(() => worker.terminate())
        .then(
          () => {
            if (aborted)
              reject(new DOMException("Projection cancelled.", "AbortError"));
            else resolve(result);
          },
          () => resolve({ ok: false, reason: "projection-error" }),
        );
    };
    const onAbort = (): void =>
      finish({ ok: false, reason: "incomplete" }, true);
    // Matches the asynchronous build ceiling; the HTTP request deadline is separate.
    const timer = setTimeout(
      () => finish({ ok: false, reason: "incomplete" }),
      6 * 60 * 60 * 1000,
    );
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.once("message", (result: PrepareProjectionResult) => finish(result));
    worker.once("error", () =>
      finish({ ok: false, reason: "projection-error" }),
    );
    worker.once("exit", () =>
      finish({ ok: false, reason: "projection-error" }),
    );
    if (signal?.aborted) onAbort();
    else {
      try {
        worker.postMessage({ records, source, config });
      } catch {
        finish({ ok: false, reason: "projection-error" });
      }
    }
  });
}

/**
 * Prepares disposable data, never writes Redis or approves/activates a build.
 * The future controller must authorize the vault, enforce approved-ref history,
 * and recheck policy at activation. No unchecked record projection API is exposed.
 */
export async function prepareLexicalProjection(
  root: string | URL,
  request: Readonly<{
    sourceRef: string;
    config: ProjectionConfig;
    signal?: AbortSignal;
  }>,
): Promise<PrepareProjectionResult> {
  if (
    !object(request) ||
    typeof request.sourceRef !== "string" ||
    Object.keys(request).some(
      (key) => !["sourceRef", "config", "signal"].includes(key),
    ) ||
    (request.signal !== undefined && !(request.signal instanceof AbortSignal))
  ) {
    throw new TypeError("projection request is invalid");
  }
  const config = snapshotProjectionConfig(request.config);
  const { sourceRef, signal } = request;
  checkAbort(signal);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(sourceRef)) {
    return { ok: false, reason: "invalid-source" };
  }
  const records: CanonicalJsonlRecordV1[] = [];
  const exported = await exportCanonicalJsonl(
    root,
    {
      sourceRef,
      write(line) {
        records.push(
          JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(line),
          ) as CanonicalJsonlRecordV1,
        );
      },
    },
    { maxConcepts: 50_000, ...(signal === undefined ? {} : { signal }) },
  );
  checkAbort(signal);
  if (!exported.ok) return { ok: false, reason: exported.reason };
  if (exported.sourceManifest.vaultUid !== config.vaultUid)
    return { ok: false, reason: "invalid-vault" };
  if (
    config.approvedSensitivityClasses.some(
      (value) => !exported.sourceManifest.sensitivityClasses.includes(value),
    ) ||
    records.some((record) => {
      const bookie = record.frontmatter.bookie;
      return (
        !object(bookie) ||
        typeof bookie.sensitivity !== "string" ||
        !config.approvedSensitivityClasses.includes(bookie.sensitivity)
      );
    })
  ) {
    return { ok: false, reason: "sensitivity-policy" };
  }
  return await projectInWorker(records, exported, config, signal);
}
