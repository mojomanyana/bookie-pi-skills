export function localWorkshopProvider(
  fixtureModel,
  createAssistantMessageEventStream,
  respond,
) {
  return {
    baseUrl: "http://workshop.invalid",
    apiKey: "local-fixture",
    api: "workshop-fixture-api",
    models: [
      {
        id: fixtureModel,
        name: "Workshop local fixture",
        input: ["text"],
        reasoning: false,
        contextWindow: 64000,
        maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    streamSimple(selected, context) {
      const stream = createAssistantMessageEventStream();
      const block = respond(context);
      const message = {
        role: "assistant",
        content: [block],
        api: selected.api,
        provider: selected.provider,
        model: selected.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: block.type === "toolCall" ? "toolUse" : "stop",
        timestamp: Date.now(),
      };
      stream.push({
        type: "start",
        partial: { ...message, content: [], stopReason: "pending" },
      });
      if (block.type === "toolCall") {
        stream.push({
          type: "toolcall_start",
          contentIndex: 0,
          partial: message,
        });
        stream.push({
          type: "toolcall_end",
          contentIndex: 0,
          toolCall: block,
          partial: message,
        });
      } else {
        stream.push({ type: "text_start", contentIndex: 0, partial: message });
        stream.push({
          type: "text_delta",
          contentIndex: 0,
          delta: block.text,
          partial: message,
        });
        stream.push({
          type: "text_end",
          contentIndex: 0,
          content: block.text,
          partial: message,
        });
      }
      stream.push({ type: "done", reason: message.stopReason, message });
      stream.end();
      return stream;
    },
  };
}
