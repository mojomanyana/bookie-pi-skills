import { isDeepStrictEqual } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  containsDetectedSecret,
  type RecallScope,
  type RecallState,
} from "pi-bookie-core";

export const evidenceKinds = ["research", "decision", "validation"] as const;
type EvidenceKind = (typeof evidenceKinds)[number];
export type EvidenceSelection = {
  includeEvidence?: EvidenceKind[];
  evidenceCallIds?: string[];
};
type CallLocator = {
  kind: EvidenceKind | "command";
  sessionId: string;
  callId: string;
  tool: string;
  status: "tool-returned" | "tool-error" | "partial";
  role?: "architect" | "decide" | "review" | "test-review";
  executionId?: string;
  verification?: {
    task: string;
    step: string;
    attempt: number;
    sha256: string;
  };
};
type ScoutReference = {
  version: 1;
  producer: "pi-scout-research";
  kind: "research-brief";
  session: string;
  sha256: string;
  bytes: number;
};
export type ScoutCheckpointEvidence = CallLocator & {
  kind: "research";
  reference: ScoutReference;
};
export type CheckpointEvidence = CallLocator | ScoutCheckpointEvidence;
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const id = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[A-Za-z0-9][A-Za-z0-9_.:|-]{0,191}$/u.test(v) &&
  !containsDetectedSecret(v);
const hash = (v: unknown): v is string =>
  typeof v === "string" && /^[a-f0-9]{64}$/u.test(v);
// Principal uses the full step label as part of a verification receipt's address.
const stepLabel = (v: unknown): v is string =>
  typeof v === "string" &&
  v.length <= 200 &&
  v.trim().length > 0 &&
  !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(v) &&
  !containsDetectedSecret(v);
function scoutRef(v: unknown): v is ScoutReference {
  return (
    record(v) &&
    Object.keys(v).length === 6 &&
    v.version === 1 &&
    v.producer === "pi-scout-research" &&
    v.kind === "research-brief" &&
    hash(v.session) &&
    hash(v.sha256) &&
    typeof v.bytes === "number" &&
    Number.isSafeInteger(v.bytes) &&
    v.bytes > 0 &&
    v.bytes <= 1_048_576
  );
}
export function isScoutCheckpointEvidence(
  v: unknown,
): v is ScoutCheckpointEvidence {
  return (
    record(v) &&
    v.kind === "research" &&
    (v.tool === "scout_research" || v.tool === "research_brief") &&
    id(v.sessionId) &&
    id(v.callId) &&
    scoutRef(v.reference)
  );
}
export function validEvidenceSelection(s: EvidenceSelection) {
  return (
    (s.includeEvidence === undefined ||
      (Array.isArray(s.includeEvidence) &&
        s.includeEvidence.length > 0 &&
        s.includeEvidence.length <= evidenceKinds.length &&
        s.includeEvidence.every((k) => evidenceKinds.includes(k)) &&
        new Set(s.includeEvidence).size === s.includeEvidence.length)) &&
    (s.evidenceCallIds === undefined ||
      (Array.isArray(s.evidenceCallIds) &&
        s.evidenceCallIds.length > 0 &&
        s.evidenceCallIds.length <= 6 &&
        s.evidenceCallIds.every(id) &&
        new Set(s.evidenceCallIds).size === s.evidenceCallIds.length))
  );
}

function locator(
  sessionId: string,
  callId: string,
  tool: string,
  args: unknown,
  details: unknown,
  failed: boolean,
  ownerRefs: unknown[],
): CheckpointEvidence | undefined {
  const status =
    failed || (record(details) && details.ok === false)
      ? "tool-error"
      : "tool-returned";
  const base = { sessionId, callId, tool, status } as const;
  if (tool === "scout_research" || tool === "research_brief") {
    const ref =
      record(details) &&
      (tool === "scout_research" ? details.briefReference : details.reference);
    if (
      scoutRef(ref) &&
      ownerRefs.some((original) => isDeepStrictEqual(original, ref))
    )
      return {
        ...base,
        kind: "research",
        reference: ref,
        status:
          record(details) &&
          (details.researchStatus === "incomplete" ||
            details.partialAvailable === true)
            ? "partial"
            : status,
      };
    return { ...base, kind: "research" };
  }
  if (tool === "delegate" && record(args)) {
    const identity =
      record(details) && record(details.cleanup) && details.cleanup.identity;
    const execution =
      record(identity) && id(identity.executionId)
        ? { executionId: identity.executionId }
        : {};
    if (args.agent === "architect" || args.agent === "decide")
      return { ...base, ...execution, kind: "decision", role: args.agent };
    if (args.agent === "review" || args.agent === "test-review")
      return { ...base, ...execution, kind: "validation", role: args.agent };
  }
  if (
    tool === "principal_workflow" &&
    record(args) &&
    args.action === "verification"
  ) {
    if (
      !failed &&
      record(details) &&
      details.version === 1 &&
      details.state === "recorded" &&
      id(details.task) &&
      stepLabel(details.step) &&
      typeof details.attempt === "number" &&
      Number.isSafeInteger(details.attempt) &&
      details.attempt > 0 &&
      record(details.reference) &&
      hash(details.reference.sha256)
    ) {
      return {
        ...base,
        kind: "validation",
        verification: {
          task: details.task,
          step: details.step,
          attempt: details.attempt,
          sha256: details.reference.sha256,
        },
      };
    }
    return { ...base, kind: "validation" };
  }
  if (tool === "bash" && record(args) && typeof args.command === "string") {
    // A recognized test command is discoverable. Its receipt never grants outcome credit.
    const testCommand =
      /(?:^|[;&|\n])\s*(?:npm\s+(?:run\s+)?test|node\s+--test|python(?:3)?\s+(?:-m\s+(?:unittest|pytest)|(?:[\w./-]+\/)?test_[\w.-]+\.py)|pytest|cargo\s+test|go\s+test|dotnet\s+test)(?:\s|$|[;&|])/u;
    return {
      ...base,
      kind: testCommand.test(args.command) ? "validation" : "command",
    };
  }
}

// Resolve only existing authorized registrations. A delegate call ID identifies a
// Pi message, while the runtime execution ID identifies the producer artifact.
export function registeredDelegate(
  evidence: CheckpointEvidence,
  cwd: string,
  ticket: {
    scope: RecallScope;
    controls: RecallState;
    classes: readonly string[];
  },
): string | undefined {
  if (evidence.tool !== "delegate" || !evidence.role || !evidence.executionId)
    return;
  const matches = ticket.controls.registrations.filter(
    ({ record, project }) =>
      project.uid === ticket.scope.project.uid &&
      record.producer === "pi-daddy" &&
      record.kind === "operation-result" &&
      record.owner.sessionId === evidence.sessionId &&
      record.owner.cwd === cwd &&
      record.executionId === evidence.executionId,
  );
  const row = matches.length === 1 ? matches[0] : undefined;
  if (
    !row ||
    !ticket.classes.includes(row.sensitivity) ||
    ticket.controls.controls.some(
      (control) =>
        control.project.uid === row.project.uid &&
        control.target.kind === "producer" &&
        control.target.registrationId === row.id,
    )
  )
    return;
  return row.id;
}

type SelectionResult =
  | {
      status: "selected";
      sources: CheckpointEvidence[];
      missing: EvidenceKind[];
    }
  | {
      status: "evidence-selection-needed";
      candidates: CallLocator[];
      reason: string;
    };

export function selectCheckpointEvidence(
  ctx: ExtensionContext,
  selection: EvidenceSelection,
  automatic = false,
): SelectionResult {
  const requested =
    selection.includeEvidence ?? (automatic ? evidenceKinds : []);
  const exact = selection.evidenceCallIds ?? [];
  if (!requested.length && !exact.length)
    return { status: "selected", sources: [], missing: [] };
  const sessionId = ctx.sessionManager.getSessionId();
  const branch = ctx.sessionManager.getBranch();
  const start = branch.findLastIndex(
    (e) => e.type === "message" && e.message.role === "user",
  );
  const ambiguous = (
    reason: string,
    candidates: CheckpointEvidence[] = [],
  ): SelectionResult => ({
    status: "evidence-selection-needed",
    reason,
    candidates: candidates
      .slice(-12)
      .map(({ kind, sessionId, callId, tool, status, role, verification }) => ({
        kind,
        sessionId,
        callId,
        tool,
        status,
        ...(role ? { role } : {}),
        ...(verification ? { verification } : {}),
      })),
  });
  if (!id(sessionId) || start < 0 || branch.length - start > 2048)
    return ambiguous(
      "The current request cannot be identified in the bounded history. Reuse an existing checkpoint or save a summary with this evidence limit.",
    );
  const calls = new Map<string, { name: string; args: unknown }>();
  const ownerRefs: unknown[] = [];
  const candidates: CheckpointEvidence[] = [];
  const operations = new Map<CheckpointEvidence, string>();
  let current: CheckpointEvidence[] = [];
  let previous: CheckpointEvidence[] = [];
  // Automatic matches use the current request only. The immediately preceding
  // request can offer candidates for an explicit follow-up. Older exact IDs
  // must still have their call and result on this permitted active branch.
  for (const entry of branch.slice(-2048)) {
    if (
      entry.type === "custom" &&
      ["scout-brief-v2", "scout-worker-brief-v2"].includes(entry.customType) &&
      record(entry.data)
    )
      ownerRefs.push(entry.data.reference);
    if (entry.type !== "message") continue;
    const m = entry.message;
    if (m.role === "user") {
      previous = current;
      current = [];
      calls.clear();
      ownerRefs.length = 0;
    } else if (m.role === "assistant") {
      if (
        !ctx.model ||
        m.provider !== ctx.model.provider ||
        m.model !== ctx.model.id
      )
        continue;
      for (const t of m.content)
        if (t.type === "toolCall" && id(t.id))
          calls.set(t.id, { name: t.name, args: t.arguments });
    } else if (m.role === "toolResult") {
      const call = calls.get(m.toolCallId);
      if (call?.name !== m.toolName || !call) continue;
      const observed = locator(
        sessionId,
        m.toolCallId,
        m.toolName,
        call.args,
        m.details,
        m.isError,
        ownerRefs,
      );
      if (observed) {
        candidates.push(observed);
        current.push(observed);
        if (
          observed.role &&
          record(m.details) &&
          record(m.details.operation) &&
          m.details.operation.state === "settled" &&
          id(m.details.operation.operationId)
        ) {
          operations.set(observed, m.details.operation.operationId);
        }
      }
    }
  }
  const sources: CheckpointEvidence[] = [];
  const missing: EvidenceKind[] = [];
  for (const callId of exact) {
    const matches = candidates.filter(
      (c) =>
        c.callId === callId ||
        (current.includes(c) && operations.get(c) === callId),
    );
    if (matches.length !== 1)
      return ambiguous(
        "A selected call has no unique eligible result on this active branch.",
      );
    if (!sources.includes(matches[0]!)) sources.push(matches[0]!);
  }
  for (const kind of requested) {
    if (!automatic && sources.some((s) => s.kind === kind)) continue;
    const matches = current.filter((c) => c.kind === kind);
    if (automatic) {
      sources.push(...matches.filter((c) => !sources.includes(c)));
      if (!matches.length) missing.push(kind);
      continue;
    }
    if (matches.length > 1)
      return ambiguous(
        "Multiple results match. Resubmit with the exact applicable evidenceCallIds.",
        matches,
      );
    if (matches.length === 1) sources.push(matches[0]!);
    else {
      const earlier = previous.filter((c) => c.kind === kind);
      if (earlier.length)
        return ambiguous(
          "Only an earlier request has matching sources. Select exact applicable call IDs or omit that evidence category.",
          earlier,
        );
      missing.push(kind);
    }
  }
  if (sources.length > 6)
    return ambiguous("Select up to six source receipts.", sources);
  return {
    status: "selected",
    sources: sources.sort((a, b) => a.callId.localeCompare(b.callId)),
    missing: missing.sort(),
  };
}

export function deliveryForCheckpoint(ctx: ExtensionContext, title: string) {
  const branch = ctx.sessionManager.getBranch?.() ?? [];
  const start = branch.findLastIndex(
    (e) => e.type === "message" && e.message.role === "user",
  );
  if (start < 0) return;
  const rows = branch
    .slice(start + 1)
    .filter(
      (e) => e.type === "custom" && e.customType === "principal-delivery-v1",
    );
  const entry = rows.at(-1);
  if (entry?.type !== "custom" || !record(entry.data)) return;
  const row = entry.data;
  if (
    row.version !== 1 ||
    row.ended ||
    row.cwd !== ctx.cwd ||
    row.sessionId !== ctx.sessionManager.getSessionId() ||
    typeof row.sessionId !== "string" ||
    !/^[a-z0-9-]{8,80}$/iu.test(row.sessionId) ||
    typeof row.deliveryId !== "string" ||
    !/^principal-delivery:[a-f0-9]{32}$/u.test(row.deliveryId) ||
    !Array.isArray(row.criteria) ||
    !row.criteria.length
  )
    return;
  const named = row.criteria.filter(
    (c) => record(c) && c.kind === "checkpoint",
  );
  if (
    named.length
      ? !named.some((c) => c.title === title)
      : rows.some(
          (e) =>
            e.type !== "custom" ||
            !record(e.data) ||
            e.data.deliveryId !== row.deliveryId,
        )
  )
    return;
  return { sourceSessionId: row.sessionId, deliveryId: row.deliveryId };
}

// Older activity notes can name their original delivery in prose. This is
// a read-only hint; Principal verifies the owner, task and active branch.
export function legacyDeliveryStatus(generated: unknown, body: string) {
  if (!record(generated) || typeof generated.by !== "string") return;
  const sourceSessionId = /^process:pi:([a-z0-9-]{8,80})$/iu.exec(
    generated.by,
  )?.[1];
  const ids = new Set(body.match(/\bprincipal-delivery:[a-f0-9]{32}\b/gu));
  if (sourceSessionId && ids.size === 1) {
    return { sourceSessionId, deliveryId: [...ids][0]! };
  }
}
