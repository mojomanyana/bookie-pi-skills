// Run with Node 24 and an installation of Pi 1.4+ and pi-daddy 0.54+.
// node verify-workshop-recall.mjs <installation>/node_modules [offline | scout | --subscription]
// The default uses a local provider. --subscription uses openai-codex/gpt-6.1-sol
// through Pi with synthetic data. Scout uses a fixed, offline v1 tool result.
// Each scenario starts two Pi processes in one private temporary project.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [modulesArg, mode = "offline", phaseArg, inheritedRoot] =
  process.argv.slice(2);
assert(
  modulesArg && ["offline", "scout", "--subscription"].includes(mode),
  "Specify the Pi node_modules directory and optional --subscription",
);
const modules = resolve(modulesArg);
const local = mode !== "--subscription";
const scout = mode === "scout";
const authPath =
  process.env.WORKSHOP_SUBSCRIPTION_AUTH ??
  join(
    process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
    "auth.json",
  );
assert(
  !inheritedRoot || (phaseArg && ["delivery", "recall"].includes(phaseArg)),
  "Unexpected workspace path",
);
const root =
  inheritedRoot ?? (await mkdtemp(join(tmpdir(), "bookie-workshop-")));
const cwd = join(root, "workshop");
const agentDir = join(root, "agent");
const source = {
  title: "Layout field guide",
  url: "https://workshops.example.org/lessons/loom-4827",
};
const topic = "responsive typography";
const choicePrompt =
  "I chose responsive typography for the community workshop. Keep that choice for next time. I will pick the next step.";
const resourcePrompt =
  "Can you give me one beginner resource from the supplied publisher catalog and say why it helps?";
const start =
  "I have chosen responsive typography for our community workshop. Keep that choice for next time. Give me a link to one beginner resource from the supplied publisher catalog and a sentence on why it helps. I will choose the next step.";
const resume =
  "Where did we leave off with our workshop? What did we decide, what did you already give me, and what is up to me? Include the exact link if it is on record.";
const bookie =
  process.env.BOOKIE_WORKSHOP_EXTENSION ??
  fileURLToPath(new URL("../src/index.ts", import.meta.url));
const daddy = join(modules, "pi-daddy", "extensions", "grants.ts");
const fixtureProvider = "workshop-fixture";
const fixtureModel = "local";
const sourceTool = scout ? "scout_research" : "publisher_catalog";
const sourceText =
  "The original publisher provides a free guide to responsive typography.";
const sourceHash = createHash("sha256").update(sourceText).digest("hex");
const stamp = "2026-11-09T08:00:00.000Z";
function catalogResult() {
  const result = {
    type: "result",
    version: 1,
    status: "complete",
    requestId: "workshop",
    sources: [
      {
        id: "course",
        title: source.title,
        locator: source.url,
        sha256: sourceHash,
        text: sourceText,
        retrievedAt: stamp,
      },
    ],
    brief: {
      version: 1,
      findings: [
        {
          status: "supported",
          statement: sourceText,
          citations: [
            {
              sourceId: "course",
              locator: source.url,
              sha256: sourceHash,
              start: 1,
              end: 1,
              quote: sourceText,
              retrievedAt: stamp,
            },
          ],
        },
      ],
    },
  };
  return {
    content: [say(JSON.stringify(source))],
    details: scout ? { result } : {},
  };
}
const lines = (blocks) =>
  blocks
    ?.filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n") ?? "";
const tool = (name, args) => ({
  type: "toolCall",
  name,
  arguments: args,
  id: randomUUID(),
});
const say = (text) => ({ type: "text", text });
const calls = [];
const rows = [];
const decisions = [];
const sessionIds = [];
const runtimeErrors = [];

if (!phaseArg) {
  await mkdir(cwd);
  await mkdir(agentDir);
}
process.chdir(cwd);
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_DADDY_AUTO_MODE = "1";
process.env.PI_DADDY_HERDR = "0";
process.env.PI_DADDY_ACTIVITY_TIMELINE = "off";
const load = (name) =>
  import(pathToFileURL(join(modules, name, "dist/index.js")).href);
const { Type, createAssistantMessageEventStream } = await load(
  "@earendil-works/pi-ai",
);
const {
  DefaultResourceLoader,
  SettingsManager,
  SessionManager,
  ModelRuntime,
  createAgentSession,
} = await load("@earendil-works/pi-coding-agent");
const provider = local ? fixtureProvider : "openai-codex";
const model = local ? fixtureModel : "gpt-6.1-sol";

function fixture(phase, context) {
  const responses = context.messages.filter(
    (message) => message.role === "toolResult",
  );
  if (phase === "delivery") {
    const users = context.messages.filter((message) => message.role === "user");
    if (scout && users.length === 1 && responses.length)
      return say("You chose responsive typography for your workshop.");
    switch (responses.length) {
      case 0:
        return tool("bookie_remember", {
          title: "Community workshop decision",
          summary:
            "User chose responsive typography. The user will choose the next step.",
        });
      case 1:
        return tool(sourceTool, {});
      case 2:
        if (!scout)
          return tool("bookie_remember", {
            title: "Workshop learning resource",
            summary:
              "Shared the publisher's layout field guide for the responsive typography workshop. The user will choose the next step.",
            deliveryUrl: source.url,
          });
    }
    return say(
      "Your workshop is about responsive typography. The publisher’s layout field guide helps beginners try responsive text: " +
        source.url +
        ". You choose the next step.",
    );
  }
  if (!responses.length) return tool("bookie_search", { query: "workshop" });
  assert(!responses[0].isError, "Fresh session could not search memory");
  if (scout && responses.length === 1)
    return tool("bookie_search", { query: "shared resource" });
  const hits = new Set();
  for (const response of responses.filter(
    (message) => message.toolName === "bookie_search",
  )) {
    for (const hit of JSON.parse(lines(response.content)).result.results) {
      if (hit.type === "Activity") hits.add(hit.uid);
    }
  }
  const reads = responses.filter(
    (message) => message.toolName === "bookie_read",
  );
  const next = [...hits][reads.length];
  if (next) return tool("bookie_read", { selector: "uid", value: next });
  const recordsText = reads.map((message) => lines(message.content)).join("\n");
  const recalled = recordsText.match(
    /https:\/\/workshops\.example\.org\/[\w/-]+/u,
  )?.[0];
  return say(
    (recordsText.includes(topic)
      ? "You chose responsive typography."
      : "I cannot find a topic.") +
      (recalled
        ? " I shared " + recalled + "."
        : " I have no link on record.") +
      " You choose the next step.",
  );
}

function localProvider(phase) {
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
      const block = fixture(phase, context);
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

async function run(phase, prompt) {
  const settingsManager = SettingsManager.inMemory(
    { cacheWarming: "off", retry: { enabled: false }, enableAnalytics: false },
    { projectTrusted: true },
  );
  const runtime = await ModelRuntime.create({
    ...(local
      ? {
          credentials: {
            async list() {
              return [];
            },
            async read() {},
            async modify(_key, fn) {
              return fn(undefined);
            },
            async delete() {},
          },
        }
      : { authPath }),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const config = local && localProvider(phase);
  if (local) runtime.registerProvider(provider, config);
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noMcp: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: [daddy, bookie],
    extensionFactories: [
      (pi) => {
        if (local) pi.registerProvider(provider, config);
        if (phase === "delivery")
          pi.registerTool({
            name: sourceTool,
            label: "Publisher catalog",
            description:
              "Look up the supplied original publisher’s beginner resource on responsive typography.",
            parameters: Type.Object({}),
            async execute() {
              return catalogResult();
            },
          });
      },
    ],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    resourceLoader: loader,
    settingsManager,
    modelRuntime: runtime,
    model: runtime.getModel(provider, model),
    sessionManager: SessionManager.inMemory(cwd),
    noTools: "builtin",
    thinkingLevel: "low",
  });
  assert.deepEqual(session.messages, []);
  sessionIds.push(session.sessionManager.getSessionId());
  const ui = new Proxy(
    { notify() {} },
    {
      get(target, key) {
        if (key in target) return target[key];
        if (["confirm", "input", "custom", "select", "editor"].includes(key))
          return async () => {
            throw Error("Unexpected operator setup dialog: " + key);
          };
        return () => {};
      },
    },
  );
  const timer = setTimeout(() => void session.abort(), 120000);
  try {
    await session.bindExtensions({
      mode: "tui",
      uiContext: ui,
      onError: (error) => runtimeErrors.push(error.error),
    });
    assert.equal(session.model?.id, model);
    const allowed = session
      .getAllTools()
      .map((item) => item.name)
      .filter((name) =>
        [
          "bookie_remember",
          "bookie_search",
          "bookie_read",
          sourceTool,
        ].includes(name),
      );
    session.setActiveToolsByName(allowed);
    session.subscribe((event) => {
      if (event.type === "tool_execution_start")
        calls.push({ phase, tool: event.toolName });
      if (event.type === "tool_execution_end") {
        rows.push({
          phase,
          tool: event.toolName,
          error: event.isError,
          text: lines(event.result.content),
        });
      }
    });
    if (phase === "delivery" && scout) {
      await session.prompt(choicePrompt);
      await session.prompt(resourcePrompt);
    } else {
      await session.prompt(prompt);
    }
    const last = session.messages.at(-1);
    assert.equal(
      last?.stopReason,
      "stop",
      last?.errorMessage ?? "Incomplete model turn",
    );
    decisions.push(lines(last.content));
  } finally {
    clearTimeout(timer);
    await session.extensionRunner.emit({
      type: "session_shutdown",
      reason: "quit",
    });
    session.dispose();
  }
}

if (phaseArg) {
  assert(inheritedRoot && ["delivery", "recall"].includes(phaseArg));
  if (local)
    globalThis.fetch = async () => {
      throw Error("Offline fixture cannot use the network");
    };
  await run(phaseArg, phaseArg === "delivery" ? start : resume);
  console.log(
    JSON.stringify({
      sessionId: sessionIds[0],
      calls,
      rows,
      answer: decisions[0],
      runtimeErrors,
    }),
  );
} else {
  try {
    const results = [];
    for (const phase of ["delivery", "recall"]) {
      const child = spawnSync(
        process.execPath,
        [fileURLToPath(import.meta.url), modules, mode, phase, root],
        {
          encoding: "utf8",
          timeout: 140000,
          env: { ...process.env, WORKSHOP_SUBSCRIPTION_AUTH: authPath },
          maxBuffer: 1024 * 1024,
        },
      );
      assert.equal(child.status, 0, child.stderr || child.error?.message);
      results.push(JSON.parse(child.stdout));
    }
    const [delivery, recall] = results;
    assert.notEqual(delivery.sessionId, recall.sessionId);
    assert.deepEqual(await readdir(cwd), []);
    assert.deepEqual(
      results.flatMap((result) => result.runtimeErrors),
      [],
    );
    assert(
      delivery.calls.some((call) => call.tool === sourceTool),
      "First session did not consult the fixture",
    );
    assert(
      delivery.answer.includes(source.url),
      "First session did not share the catalog URL",
    );
    assert(
      recall.rows.some(
        (row) => !row.error && row.text.toLowerCase().includes(topic),
      ),
      "Fresh session could not retrieve the workshop decision from memory",
    );
    assert(
      recall.rows.some((row) => !row.error && row.text.includes(source.url)),
      "Fresh session could not retrieve the delivered URL from project memory",
    );
    assert(
      recall.answer.includes(source.url),
      "Fresh answer omitted the delivered URL",
    );
    assert(
      recall.answer.toLowerCase().includes(topic),
      "Fresh answer omitted the workshop decision",
    );
    assert.match(
      recall.answer,
      /cho(?:ose|ice)|up to you|your (?:call|decision)|you (?:decide|pick)|for you to (?:decide|pick)|(?:you|your).*next step/i,
    );
    assert.deepEqual(
      results.flatMap((result) =>
        result.rows.filter((row) => row.error).map((row) => row.tool),
      ),
      [],
    );
    console.log(
      JSON.stringify(
        {
          status: "passed",
          mode,
          provider,
          model,
          pi: JSON.parse(
            await readFile(
              join(modules, "@earendil-works/pi-coding-agent/package.json"),
            ),
          ).version,
          sessionIds: results.map((result) => result.sessionId),
          initiallyEmptySessionHistory: true,
          calls: results.flatMap((result) => result.calls),
          memorySaves: results.flatMap((result) =>
            result.rows
              .filter((row) => row.tool === "bookie_remember")
              .map((row) => ({
                phase: row.phase,
                status: JSON.parse(row.text).status,
              })),
          ),
          answers: results.map((result) => result.answer),
        },
        null,
        2,
      ),
    );
  } finally {
    process.chdir(tmpdir());
    await rm(root, { recursive: true, force: true });
  }
}
