/** Optional trusted in-process producer adapter; no dependency on Daddy and no dispatch API. */
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import {
  readRecallState,
  registerProducerReference,
  type ProducerReference,
} from "pi-bookie-core";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type {
  createCaptureAuthority,
  ReferenceCaptureGrant,
} from "./capture-authority.js";
import { readEcosystemConfig } from "./ecosystem-config.js";
const EVENT = "pi-daddy:operation-artifacts:v1",
  READY = "pi-daddy:operation-artifact-ready:v1";
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
export class ProducerReadError extends Error {
  constructor(
    readonly code:
      | "owner-unavailable"
      | "authority"
      | "source-changed"
      | "invalid-range"
      | "not-found"
      | "unavailable",
  ) {
    super("Producer reference unavailable.");
  }
}
export function requestProducer(
  pi: ExtensionAPI,
  owner: { sessionId: string; cwd: string },
  args: Record<string, unknown>,
  channel = EVENT,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const requestId = randomUUID();
    let done = false;
    let unbound = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        reject(
          new ProducerReadError(unbound ? "owner-unavailable" : "unavailable"),
        );
      }
    }, 1500);
    timer.unref?.();
    try {
      pi.events?.emit?.(channel, {
        version: 1,
        requestId,
        ...owner,
        ...args,
        reply: (reply: unknown) => {
          if (done) return;
          const identityMatches =
            object(reply) &&
            reply.version === 1 &&
            reply.requestId === requestId &&
            reply.sessionId === owner.sessionId &&
            reply.cwd === owner.cwd;
          // Older trust-pass copies can answer before the selected Daddy instance.
          // Only an explicit lack of ownership is provisional; all other refusals are final.
          if (
            identityMatches &&
            channel === EVENT &&
            reply.ok === false &&
            reply.code === "owner-unavailable"
          ) {
            unbound = true;
            return;
          }
          done = true;
          clearTimeout(timer);
          if (
            identityMatches &&
            channel === "scout:resolve:v1" &&
            reply.ok === false
          ) {
            const code =
              reply.status === "denied"
                ? "authority"
                : reply.status === "stale"
                  ? "source-changed"
                  : reply.status === "missing"
                    ? "not-found"
                    : "unavailable";
            reject(new ProducerReadError(code));
            return;
          }
          if (!identityMatches || reply.ok !== true) {
            reject(
              new ProducerReadError(
                identityMatches &&
                  reply.ok === false &&
                  [
                    "owner-unavailable",
                    "authority",
                    "source-changed",
                    "not-found",
                  ].includes(String(reply.code))
                  ? (reply.code as
                      | "owner-unavailable"
                      | "authority"
                      | "source-changed"
                      | "not-found")
                  : "unavailable",
              ),
            );
            return;
          }
          resolve(reply);
        },
      });
    } catch {
      if (!done) {
        done = true;
        clearTimeout(timer);
        reject(new ProducerReadError("unavailable"));
      }
    }
  });
}
function record(
  reference: unknown,
  producerInstance: unknown,
): ProducerReference {
  if (
    !object(reference) ||
    reference.version !== 1 ||
    reference.producer !== "pi-daddy" ||
    typeof producerInstance !== "string" ||
    !object(reference.manifest) ||
    !object(reference.owner) ||
    typeof reference.owner.sessionId !== "string" ||
    typeof reference.owner.cwd !== "string" ||
    typeof reference.operationId !== "string" ||
    typeof reference.executionId !== "string" ||
    typeof reference.manifest.path !== "string" ||
    typeof reference.manifest.sha256 !== "string" ||
    typeof reference.manifest.bytes !== "number"
  )
    throw Error("Invalid producer reference.");
  return {
    producer: "pi-daddy",
    producerInstance,
    owner: { sessionId: reference.owner.sessionId, cwd: reference.owner.cwd },
    operationId: reference.operationId,
    executionId: reference.executionId,
    kind: "operation-result",
    reference: {
      locator: reference.manifest.path,
      sha256: reference.manifest.sha256,
      byteLength: reference.manifest.bytes,
    },
  };
}
const nativeReference = (value: ProducerReference) => ({
  version: 1,
  producer: value.producer,
  owner: value.owner,
  operationId: value.operationId,
  executionId: value.executionId,
  manifest: {
    path: value.reference.locator,
    sha256: value.reference.sha256,
    bytes: value.reference.byteLength,
  },
});
export async function readProducerReference(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  value: ProducerReference,
  authorize: () => Promise<void>,
) {
  await authorize();
  const owner = {
    sessionId: ctx.sessionManager.getSessionId(),
    cwd: await realpath(ctx.cwd),
  };
  const reply = await requestProducer(pi, owner, {
    action: "read",
    reference: nativeReference(value),
    producerInstance: value.producerInstance,
    authorize,
  });
  await authorize();
  if (reply.producerInstance !== value.producerInstance)
    throw new ProducerReadError("source-changed");
  const manifest = reply.manifest;
  if (
    !object(manifest) ||
    manifest.version !== 1 ||
    manifest.producer !== value.producer ||
    !object(manifest.owner) ||
    !object(manifest.operation)
  )
    throw new ProducerReadError("unavailable");
  if (
    manifest.owner.sessionId !== value.owner.sessionId ||
    manifest.owner.cwd !== value.owner.cwd ||
    manifest.operation.operationId !== value.operationId ||
    manifest.operation.executionId !== value.executionId
  )
    throw new ProducerReadError("source-changed");
  if (
    !["admitting", "running", "settled", "not-started", "uncertain"].includes(
      String(manifest.operation.state),
    )
  )
    throw new ProducerReadError("unavailable");
  return reply;
}
export function registerProducerBridge(
  pi: ExtensionAPI,
  capture: ReturnType<typeof createCaptureAuthority>,
) {
  let context: ExtensionContext | undefined,
    epoch = 0,
    tail: Promise<unknown> = Promise.resolve();
  let continuation: { key: string; cursor: string } | undefined;
  const serial = <T>(action: () => Promise<T>): Promise<T> => {
    const next = tail.then(action, action);
    tail = next.catch(() => undefined);
    return next;
  };
  async function owner(ctx: ExtensionContext) {
    return {
      sessionId: ctx.sessionManager.getSessionId(),
      cwd: await realpath(ctx.cwd),
    };
  }
  async function register(
    grant: ReferenceCaptureGrant,
    ctx: ExtensionContext,
    reference: unknown,
    instance: string,
    guard?: () => Promise<void>,
  ) {
    const selectedEpoch = epoch,
      currentOwner = await owner(ctx);
    const authority = async () => {
      if (epoch !== selectedEpoch || (!guard && context !== ctx))
        throw Error("Producer capture owner changed.");
      await guard?.();
      await grant.assertCurrent();
    };
    await authority();
    const value = record(reference, instance),
      state = await readRecallState(grant.vault.root);
    if (!state.ok) throw Error("Bookie recall controls unavailable.");
    const result = await registerProducerReference(
      grant.vault.root,
      {
        project: grant.project,
        record: value,
        expectedRevision: state.revision,
        sensitivity: grant.sensitivity,
      },
      {
        assertAuthority: authority,
        resolveReference: async (selected) => {
          await authority();
          const reply = await requestProducer(pi, currentOwner, {
            action: "read",
            reference: nativeReference(selected),
            producerInstance: selected.producerInstance,
            authorize: authority,
          });
          await authority();
          if (reply.producerInstance !== selected.producerInstance)
            throw Error("Producer source changed.");
          return {
            sha256: selected.reference.sha256,
            byteLength: selected.reference.byteLength,
          };
        },
      },
    );
    if (!result.ok) throw Error("Bookie reference registration refused.");
    return result.outcome;
  }
  function enabled() {
    try {
      return readEcosystemConfig()?.bookie?.autoSyncReviews !== false;
    } catch {
      return false;
    }
  }
  async function sync(
    ctx: ExtensionContext,
    guard?: () => Promise<void>,
    seenCursors?: Set<string>,
  ) {
    await guard?.();
    const grant = await capture.referenceGrant();
    if (!grant) {
      if (guard) return false;
      throw Error("Select producer reference capture first.");
    }
    const selectedEpoch = epoch,
      currentOwner = await owner(ctx),
      key = JSON.stringify([
        epoch,
        currentOwner,
        grant.project,
        grant.sensitivity,
      ]);
    let cursor = continuation?.key === key ? continuation.cursor : undefined,
      registered = 0,
      reused = 0,
      uncertain = 0,
      issues = 0,
      complete = false;
    // Bound each serial batch so new results and manual requests can run between batches.
    for (let page = 0; page < 8 && !complete; page++) {
      await guard?.();
      await grant.assertCurrent();
      if (epoch !== selectedEpoch || context !== ctx)
        throw Error("Capture owner changed.");
      const result = await requestProducer(pi, currentOwner, {
        action: "list",
        limit: 32,
        ...(cursor ? { cursor } : {}),
      });
      if (
        !Array.isArray(result.references) ||
        result.references.length > 32 ||
        typeof result.producerInstance !== "string"
      )
        throw Error("Producer page invalid.");
      for (const ref of result.references) {
        const outcome = await register(
          grant,
          ctx,
          ref,
          result.producerInstance,
          guard,
        );
        if (outcome === "registered") registered++;
        else reused++;
      }
      if (
        !Number.isSafeInteger(result.uncertain) ||
        !Number.isSafeInteger(result.issues) ||
        typeof result.uncertain !== "number" ||
        typeof result.issues !== "number" ||
        result.uncertain < 0 ||
        result.issues < 0
      )
        throw Error("Invalid producer page counts.");
      uncertain += result.uncertain;
      issues += result.issues;
      complete = result.complete === true;
      if (
        !complete &&
        (!Number.isSafeInteger(result.scanned) || Number(result.scanned) < 1)
      )
        throw Error("Producer scan did not advance.");
      cursor = typeof result.cursor === "string" ? result.cursor : undefined;
      if (!complete && typeof cursor !== "string")
        throw Error("Producer cursor unavailable.");
      if (!complete && cursor && seenCursors) {
        if (seenCursors.has(cursor))
          throw Error("Producer cursor repeated without advancing.");
        seenCursors.add(cursor);
      }
      continuation = complete ? undefined : { key, cursor: cursor! };
    }
    await grant.assertCurrent();
    await guard?.();
    if (!guard || registered || reused || issues || uncertain || !complete)
      ctx.ui.notify(
        `Bookie ${guard ? "automatic review" : "producer"} sync ${complete && issues === 0 ? "complete" : "partial"}: ${registered} registered, ${reused} reused, ${uncertain} unfinished admissions, ${issues} unavailable entries. No children launched.`,
        "info",
      );
    return !complete;
  }
  const MAX_AUTO_BATCHES = 16;
  let generation = 0;
  let pendingManagedSync = false;
  function schedule() {
    const ctx = context,
      run = ++generation;
    if (!ctx) {
      pendingManagedSync = true;
      return;
    }
    pendingManagedSync = false;
    if (!enabled()) return;
    const current = () => context === ctx && run === generation && enabled();
    const guard = async () => {
      if (!current()) throw Error("Automatic sync stopped.");
    };
    const seenCursors = new Set<string>();
    void (async () => {
      for (let batch = 0; batch < MAX_AUTO_BATCHES && current(); batch++) {
        if (!(await serial(() => sync(ctx, guard, seenCursors)))) break;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    })().catch(() => {
      if (current()) {
        continuation = undefined;
        try {
          ctx.ui.notify(
            "Bookie could not finish automatic review sync. Check capture settings or use /bookie-capture sync.",
            "warning",
          );
        } catch {
          /* The session UI may have closed. */
        }
      }
    });
  }
  capture.setReferenceSync(async (ctx) => {
    const selectedEpoch = epoch;
    await serial(async () => {
      if (epoch !== selectedEpoch) throw Error("Capture owner changed.");
      context = ctx;
      try {
        await sync(ctx);
      } catch (error) {
        continuation = undefined;
        throw error;
      }
    });
  }, schedule);
  const unsubscribeSettings = pi.events?.on?.(
    "bookie:review-sync-settings:v1",
    (input: unknown) => {
      if (!context || !object(input)) return;
      if (input.action === "status" && typeof input.report === "function")
        input.report();
      if (input.action === "changed") schedule();
    },
  );
  const unsubscribe = pi.events?.on?.(READY, (hint: unknown) => {
    const ctx = context;
    if (!ctx || !object(hint) || hint.version !== 1) return;
    void serial(async () => {
      if (context !== ctx || !enabled()) return;
      const grant = await capture.referenceGrant();
      if (!grant) return;
      const currentOwner = await owner(ctx);
      if (
        !object(hint.reference) ||
        !object(hint.reference.owner) ||
        hint.reference.owner.sessionId !== currentOwner.sessionId ||
        hint.reference.owner.cwd !== currentOwner.cwd
      )
        return;
      const reply = await requestProducer(pi, currentOwner, {
        action: "read",
        reference: hint.reference,
        authorize: grant.assertCurrent,
      });
      if (typeof reply.producerInstance !== "string")
        throw Error("Invalid producer identity.");
      await register(
        grant,
        ctx,
        hint.reference,
        reply.producerInstance,
        async () => {
          if (context !== ctx || !enabled())
            throw Error("Automatic capture stopped.");
        },
      );
    }).catch(() => {
      if (context !== ctx) return;
      // A missed hint is recoverable by enumerating the selected owner's durable records.
      if (enabled()) {
        schedule();
        return;
      }
      try {
        ctx.ui.notify(
          "Bookie reference capture incomplete; use /bookie-capture sync to retry without dispatch.",
          "warning",
        );
      } catch {
        /* Optional notification cannot reject producer completion. */
      }
    });
  });
  const bind = (_event: unknown, ctx: ExtensionContext) => {
    epoch++;
    generation++;
    continuation = undefined;
    context = ctx;
    if (pendingManagedSync) {
      pendingManagedSync = false;
      schedule();
    }
  };
  pi.on("session_start", bind);
  pi.on("session_shutdown", () => {
    epoch++;
    generation++;
    pendingManagedSync = false;
    continuation = undefined;
    context = undefined;
  });
  return {
    captureCheckpointResult(
      ctx: ExtensionContext,
      grant: ReferenceCaptureGrant,
      callId: string,
      executionId: string,
      guard: () => Promise<void>,
    ) {
      return serial(async () => {
        await guard();
        const currentOwner = await owner(ctx);
        const matches = ctx.sessionManager
          .getBranch()
          .slice(-2048)
          .filter(
            (e) =>
              e.type === "message" &&
              e.message.role === "toolResult" &&
              e.message.toolName === "delegate" &&
              e.message.toolCallId === callId,
          );
        const entry = matches.length === 1 && matches[0];
        if (
          !entry ||
          entry.type !== "message" ||
          entry.message.role !== "toolResult"
        )
          return;
        const details: unknown = entry.message.details;
        const ref =
          object(details) &&
          object(details.operation) &&
          details.operation.artifact;
        if (
          !object(ref) ||
          !object(ref.owner) ||
          ref.executionId !== executionId ||
          ref.owner.sessionId !== currentOwner.sessionId ||
          ref.owner.cwd !== currentOwner.cwd
        )
          return;
        const check = async () => {
          await guard();
          await grant.assertCurrent();
        };
        await check();
        const reply = await requestProducer(pi, currentOwner, {
          action: "read",
          reference: ref,
          authorize: check,
        });
        await check();
        if (typeof reply.producerInstance !== "string") return;
        await register(grant, ctx, ref, reply.producerInstance, guard);
      });
    },
    close() {
      epoch++;
      generation++;
      pendingManagedSync = false;
      continuation = undefined;
      context = undefined;
      unsubscribe?.();
      unsubscribeSettings?.();
    },
  };
}
