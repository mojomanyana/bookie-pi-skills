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
      | "not-found"
      | "unavailable",
  ) {
    super("Producer reference unavailable.");
  }
}
function request(
  pi: ExtensionAPI,
  owner: { sessionId: string; cwd: string },
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const requestId = randomUUID();
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        reject(new ProducerReadError("unavailable"));
      }
    }, 1500);
    try {
      pi.events?.emit?.(EVENT, {
        version: 1,
        requestId,
        ...owner,
        ...args,
        reply: (reply: unknown) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          const identityMatches =
            object(reply) &&
            reply.version === 1 &&
            reply.requestId === requestId &&
            reply.sessionId === owner.sessionId &&
            reply.cwd === owner.cwd;
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
  const reply = await request(pi, owner, {
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
  ) {
    const selectedEpoch = epoch,
      currentOwner = await owner(ctx);
    const authority = async () => {
      if (epoch !== selectedEpoch || context !== ctx)
        throw Error("Producer capture owner changed.");
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
          const reply = await request(pi, currentOwner, {
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
  capture.setReferenceSync((ctx) =>
    serial(async () => {
      context = ctx;
      const grant = await capture.referenceGrant();
      if (!grant) throw Error("Select producer reference capture first.");
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
      // At most 8 pages / 256 directory entries per explicit command. Repeat sync for idempotent recovery.
      for (let page = 0; page < 8 && !complete; page++) {
        await grant.assertCurrent();
        if (epoch !== selectedEpoch || context !== ctx)
          throw Error("Capture owner changed.");
        const result = await request(pi, currentOwner, {
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
        cursor = typeof result.cursor === "string" ? result.cursor : undefined;
        if (!complete && typeof cursor !== "string")
          throw Error("Producer cursor unavailable.");
        continuation = complete ? undefined : { key, cursor: cursor! };
      }
      await grant.assertCurrent();
      ctx.ui.notify(
        `Bookie producer sync ${complete && issues === 0 ? "complete" : "partial"}: ${registered} registered, ${reused} reused, ${uncertain} unfinished admissions, ${issues} unavailable entries. No children launched.`,
        "info",
      );
    }).catch((error) => {
      continuation = undefined;
      throw error;
    }),
  );
  const unsubscribe = pi.events?.on?.(READY, (hint: unknown) => {
    const ctx = context;
    if (!ctx || !object(hint) || hint.version !== 1) return;
    void serial(async () => {
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
      const reply = await request(pi, currentOwner, {
        action: "read",
        reference: hint.reference,
        authorize: grant.assertCurrent,
      });
      if (typeof reply.producerInstance !== "string")
        throw Error("Invalid producer identity.");
      await register(grant, ctx, hint.reference, reply.producerInstance);
    }).catch(() => {
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
    continuation = undefined;
    context = ctx;
  };
  pi.on("session_start", bind);
  pi.on("session_shutdown", () => {
    epoch++;
    continuation = undefined;
    context = undefined;
  });
  return {
    close() {
      epoch++;
      continuation = undefined;
      context = undefined;
      unsubscribe?.();
    },
  };
}
