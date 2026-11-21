import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import {
  containsDetectedSecret,
  readRecallState,
  registerProducerReference,
  type ProducerReference,
} from "pi-bookie-core";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { ReferenceCaptureGrant } from "./capture-authority.js";
import type { ScoutCheckpointEvidence } from "./checkpoint-evidence.js";
import { ProducerReadError, requestProducer } from "./producer-bridge.js";

const channel = "scout:resolve:v1";
const maxPageBytes = 24_000;
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const sha = (s: string | Buffer) =>
  createHash("sha256").update(s).digest("hex");

function nativeReference(record: ProducerReference) {
  if (
    record.producer !== "pi-scout-research" ||
    record.kind !== "research-brief" ||
    record.producerInstance !== channel ||
    record.reference.locator !== sha(record.owner.sessionId) ||
    !/^[a-f0-9]{64}$/u.test(record.reference.sha256) ||
    record.reference.byteLength < 1 ||
    record.reference.byteLength > 96_001
  )
    throw new ProducerReadError("source-changed");
  return {
    version: 1,
    producer: record.producer,
    kind: record.kind,
    session: record.reference.locator,
    sha256: record.reference.sha256,
    bytes: record.reference.byteLength,
  };
}
function sameRef(ref: ReturnType<typeof nativeReference>, value: unknown) {
  return (
    object(value) &&
    Object.keys(value).length === 6 &&
    Object.entries(ref).every(([k, v]) => value[k] === v)
  );
}
async function currentDestination(ctx: ExtensionContext, value: unknown) {
  const model = ctx.model;
  if (
    !model ||
    !object(value) ||
    value.model !== model.id ||
    value.api !== model.api ||
    value.provider !== model.provider
  )
    return false;
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) return false;
  const endpoint = new URL(auth.baseUrl ?? model.baseUrl);
  return (
    ["http:", "https:"].includes(endpoint.protocol) &&
    !endpoint.username &&
    !endpoint.password &&
    !endpoint.search &&
    !endpoint.hash &&
    value.endpoint === sha(endpoint.href)
  );
}

async function page(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  record: ProducerReference,
  offset: number,
  maxBytes: number,
  assertCurrent: () => Promise<void>,
  body: boolean,
) {
  const ref = nativeReference(record);
  const owner = {
    sessionId: ctx.sessionManager.getSessionId(),
    cwd: await realpath(ctx.cwd),
  };
  if (record.owner.cwd !== owner.cwd) throw new ProducerReadError("authority");
  await assertCurrent();
  // Registration deliberately supplies no callback: Scout must find the reference and
  // its original disclosure destination on the active branch itself.
  const authorize = async (request: unknown) => {
    await assertCurrent();
    return (
      object(request) &&
      sameRef(ref, request.reference) &&
      (await currentDestination(ctx, request.destination))
    );
  };
  const reply = await requestProducer(
    pi,
    owner,
    { reference: ref, offset, maxBytes, ...(body ? { authorize } : {}) },
    channel,
  );
  const result = reply.result,
    revalidate = reply.assertCurrent;
  if (
    !object(result) ||
    result.status !== "resolved" ||
    result.ok !== true ||
    !sameRef(ref, result.reference) ||
    result.offset !== offset ||
    typeof result.excerpt !== "string" ||
    typeof revalidate !== "function" ||
    result.untrusted !== true ||
    result.semanticApproval !== false
  )
    throw new ProducerReadError("unavailable");
  const length = Buffer.byteLength(result.excerpt);
  const end = offset + length;
  if (
    length > maxBytes ||
    end > ref.bytes ||
    (length === 0 && offset !== ref.bytes) ||
    result.nextOffset !== (end === ref.bytes ? null : end) ||
    result.complete !== (offset === 0 && end === ref.bytes) ||
    result.truncated !== end < ref.bytes
  )
    throw new ProducerReadError("source-changed");
  await assertCurrent();
  return {
    excerpt: result.excerpt,
    end,
    assertCurrent: async () => {
      await assertCurrent();
      await revalidate();
      await assertCurrent();
    },
  };
}

export async function registerCheckpointScout(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  evidence: ScoutCheckpointEvidence,
  grant: ReferenceCaptureGrant,
  guard: () => Promise<void>,
  signal?: AbortSignal,
) {
  const { sessionId, callId, reference } = evidence;
  if (
    ctx.sessionManager.getSessionId() !== sessionId ||
    sha(sessionId) !== reference.session
  )
    return;
  const record: ProducerReference = {
    producer: "pi-scout-research",
    producerInstance: channel,
    owner: { sessionId, cwd: await realpath(ctx.cwd) },
    operationId: callId,
    executionId: callId,
    kind: "research-brief",
    reference: {
      locator: reference.session,
      sha256: reference.sha256,
      byteLength: reference.bytes,
    },
  };
  const check = async () => {
    signal?.throwIfAborted();
    await guard();
    await grant.assertCurrent();
    if (ctx.sessionManager.getSessionId() !== sessionId)
      throw new ProducerReadError("authority");
  };
  await check();
  const state = await readRecallState(grant.vault.root);
  if (!state.ok) return;
  const result = await registerProducerReference(
    grant.vault.root,
    {
      project: grant.project,
      record,
      sensitivity: grant.sensitivity,
      expectedRevision: state.revision,
    },
    {
      ...(signal ? { signal } : {}),
      assertAuthority: check,
      resolveReference: async (selected) => {
        // An empty excerpt at EOF verifies the entire owner-held digest without transferring a body.
        const valid = await page(
          pi,
          ctx,
          selected,
          reference.bytes,
          4,
          check,
          false,
        );
        await valid.assertCurrent();
        return { sha256: reference.sha256, byteLength: reference.bytes };
      },
    },
  );
  await check();
  if (result.ok) return { registrationId: result.registrationId };
}

export async function readScoutBrief(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  record: ProducerReference,
  maxBytes: number,
  offset: number,
  check: () => Promise<void>,
) {
  const ref = nativeReference(record);
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > ref.bytes ||
    maxBytes < 4
  )
    throw new ProducerReadError("invalid-range");
  // Scan complete bounded content before slicing, so paging cannot split a secret across requests.
  let part = await page(pi, ctx, record, 0, maxPageBytes, check, true);
  let text = part.excerpt;
  while (part.end < ref.bytes) {
    part = await page(pi, ctx, record, part.end, maxPageBytes, check, true);
    text += part.excerpt;
  }
  const bytes = Buffer.from(text, "utf8");
  if (sha(bytes) !== ref.sha256) throw new ProducerReadError("source-changed");
  if (containsDetectedSecret(text)) throw new ProducerReadError("authority");
  if (offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80)
    throw new ProducerReadError("invalid-range");
  let end = Math.min(offset + maxBytes, bytes.length);
  while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  await part.assertCurrent();
  return {
    excerpt: bytes.subarray(offset, end).toString("utf8"),
    offset,
    nextOffset: end < bytes.length ? end : null,
    complete: offset === 0 && end === bytes.length,
    truncated: end < bytes.length,
    assertCurrent: part.assertCurrent,
  };
}
