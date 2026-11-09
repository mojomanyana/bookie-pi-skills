import { createHash } from "node:crypto";
import { isStaticBookieErrorMessage } from "./output-guard.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** Opaque restored handles are hints only; all current authority and active-branch checks still apply. */
function referenceNotice(content: unknown) {
  const references: object[] = [];
  if (
    Array.isArray(content) &&
    content.length === 1 &&
    content[0]?.type === "text" &&
    typeof content[0].text === "string" &&
    Buffer.byteLength(content[0].text) <= 64_000
  ) {
    try {
      const value: unknown = JSON.parse(content[0].text);
      if (value && typeof value === "object") {
        const row = value as Record<string, unknown>;
        const candidates = [
          row,
          ...(Array.isArray(row.references) ? row.references.slice(0, 16) : []),
        ];
        for (const candidate of candidates) {
          if (!candidate || typeof candidate !== "object") continue;
          const item = candidate as Record<string, unknown>;
          if (
            typeof item.bundleId === "string" &&
            /^sha256:[a-f0-9]{64}$/.test(item.bundleId)
          )
            references.push({ kind: "context", bundleId: item.bundleId });
          if (
            typeof item.registrationId === "string" &&
            /^sha256:[a-f0-9]{64}$/.test(item.registrationId) &&
            ["manifest", "final", "partial"].includes(String(item.part))
          )
            references.push({
              kind: "producer",
              registrationId: item.registrationId,
              part: item.part,
            });
        }
      }
    } catch {
      /* Non-JSON history contains no usable handle. */
    }
  }
  return JSON.stringify({
    notice:
      "Bookie reference-only history: bodies and permissions are not restored. Reprepare context or resolve references with current authorization.",
    references: [...new Set(references.map((value) => JSON.stringify(value)))]
      .slice(0, 16)
      .map((value) => JSON.parse(value) as object),
  });
}
function publicFailure(message: { isError?: boolean; content: unknown }) {
  return (
    message.isError === true &&
    Array.isArray(message.content) &&
    message.content.length === 1 &&
    message.content[0]?.type === "text" &&
    isStaticBookieErrorMessage(message.content[0].text)
  );
}
/** Filters only Bookie-owned tool results; quotations in other messages are outside this boundary. */
export function createBookieContextFilter(pi: ExtensionAPI) {
  const live = new Map<
    string,
    { hash: string; assertCurrent: () => Promise<void> }
  >();
  let epoch = 0;
  const reset = () => {
    epoch++;
    live.clear();
  };
  pi.on("session_start", reset);
  pi.on("session_shutdown", reset);
  pi.on("model_select", reset);
  pi.on("session_tree", reset);
  pi.on("context", async (event) => {
    const selectedEpoch = epoch;
    const messages = [];
    const checked: {
      callId: string;
      entry: { hash: string; assertCurrent: () => Promise<void> };
    }[] = [];
    const retire = (
      callId: string,
      entry: { hash: string; assertCurrent: () => Promise<void> },
    ) => {
      // Do not erase a new observation remembered under this ID while awaiting.
      if (live.get(callId) === entry) live.delete(callId);
    };
    let invalidated = false;
    for (const message of event.messages) {
      if (
        message.role !== "toolResult" ||
        !message.toolName.startsWith("bookie_")
      ) {
        messages.push(message);
        continue;
      }
      // A fixed failure is historical status, not a returned body or permission.
      // It must remain intelligible after reset/revocation without restoring data.
      if (publicFailure(message)) {
        const { details: _details, ...rest } = message;
        void _details;
        messages.push(rest);
        continue;
      }
      const entry = live.get(message.toolCallId);
      let valid = false;
      if (
        !invalidated &&
        epoch === selectedEpoch &&
        entry &&
        digest(message.content) === entry.hash
      ) {
        try {
          await entry.assertCurrent();
          valid = true;
          checked.push({ callId: message.toolCallId, entry });
        } catch {
          retire(message.toolCallId, entry);
          invalidated = true;
        }
      }
      if (valid) {
        const { details: _details, ...rest } = message;
        void _details;
        messages.push(rest);
        continue;
      }
      const { details: _details, ...rest } = message;
      void _details;
      messages.push({
        ...rest,
        content: [
          {
            type: "text" as const,
            text: referenceNotice(message.content),
          },
        ],
      });
    }
    // A sole successful validation has no later successful read to recheck against.
    // Multiple results retain the aggregate replay; any failure or epoch change still scrubs all bodies.
    if (!invalidated && epoch === selectedEpoch && checked.length > 1) {
      for (const { callId, entry } of checked) {
        try {
          await entry.assertCurrent();
        } catch {
          retire(callId, entry);
          invalidated = true;
          break;
        }
      }
    }
    if (invalidated || epoch !== selectedEpoch) {
      return {
        messages: messages.map((message) => {
          if (
            message.role !== "toolResult" ||
            !message.toolName.startsWith("bookie_") ||
            publicFailure(message)
          )
            return message;
          return {
            ...message,
            content: [
              { type: "text" as const, text: referenceNotice(message.content) },
            ],
          };
        }),
      };
    }
    return { messages };
  });
  return {
    remember(
      callId: string,
      result: { content: unknown },
      assertCurrent: () => Promise<void>,
    ) {
      live.delete(callId);
      live.set(callId, { hash: digest(result.content), assertCurrent });
      while (live.size > 8) live.delete(live.keys().next().value!);
    },
    reset,
  };
}
