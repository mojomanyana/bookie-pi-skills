// Run with Node 24 and an installation of Pi 1.4+ and pi-daddy 0.54+.
// node verify-workshop-recall.mjs <installation>/node_modules [offline | scout | auto-toggle | --subscription]
// The default uses a local provider. --subscription uses openai-codex/gpt-6.1-sol
// through Pi with synthetic data. Scout uses a fixed, offline v1 tool result.
// Each scenario starts two Pi processes in one private temporary project.
import assert from "node:assert/strict";
import { localWorkshopProvider } from "./workshop-provider.mjs";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { findPackageJSON } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [modulesArg, mode = "offline", phaseArg, inheritedRoot] =
  process.argv.slice(2);
assert(
  modulesArg &&
    ["offline", "scout", "auto-toggle", "--subscription"].includes(mode),
  "Specify the Pi node_modules directory and optional --subscription",
);
const modules = resolve(modulesArg);
const local = mode !== "--subscription";
const scout = mode === "scout";
const toggle = mode === "auto-toggle";
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
const project = join(root, "workshop");
const cwd = toggle ? join(project, "tmp-test") : project;
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
const fixtureModel = toggle
  ? "accounts/fireworks/models/deepseek-v4p1-flash-1017"
  : "local";
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
const accessChecks = [];
const repeatWorkshop =
  "I am planning a workshop on responsive typography. Check the project notes. If we already discussed it, tell me the exact resource I received and what I still need to choose. If there is no record, share one beginner guide from the supplied publisher catalog and leave the next step to me.";
const unavailableWorkshop =
  "I cannot check the project notes. Our earlier workshop decisions are unknown.";
const lookupProbe =
  "Check project notes now for the deliberately absent smoke-test marker.";

if (!phaseArg) {
  await mkdir(cwd, { recursive: true });
  if (toggle) {
    const git = spawnSync("git", ["init", "-q", project], { encoding: "utf8" });
    assert.equal(git.status, 0, git.stderr);
  }
  await mkdir(agentDir);
}
process.chdir(cwd);
process.env.PI_CODING_AGENT_DIR = agentDir;
if (toggle) delete process.env.PI_DADDY_AUTO_MODE;
else process.env.PI_DADDY_AUTO_MODE = "1";
process.env.PI_DADDY_HERDR = "0";
process.env.PI_DADDY_ACTIVITY_TIMELINE = "off";
const piPackage = join(modules, "@earendil-works/pi-coding-agent/package.json");
// A fresh npm install can hoist a different pi-ai version for a peer package.
const aiPackage = findPackageJSON(
  "@earendil-works/pi-ai",
  pathToFileURL(piPackage),
);
const loadRuntime = (manifest) =>
  import(pathToFileURL(join(dirname(manifest), "dist/index.js")).href);
const { Type, createAssistantMessageEventStream } =
  await loadRuntime(aiPackage);
const {
  DefaultResourceLoader,
  SettingsManager,
  ProjectTrustStore,
  SessionManager,
  ModelRuntime,
  createAgentSession,
} = await loadRuntime(piPackage);
const provider = local ? fixtureProvider : "openai-codex";
const model = local ? fixtureModel : "gpt-6.1-sol";

function fixture(phase, context) {
  const received = toggle
    ? context.messages.slice(
        context.messages.findLastIndex((m) => m.role === "user"),
      )
    : context.messages;
  const responses = received.filter((message) => message.role === "toolResult");
  if (toggle && lines(received[0]?.content) === lookupProbe) {
    if (!responses.length)
      return tool("bookie_search", { query: "absent-smoke-test-marker" });
    assert.equal(responses[0].isError, false);
    const search = JSON.parse(lines(responses[0].content)).result;
    assert.equal(search.complete, true);
    assert.deepEqual(search.results, []);
    return say("Project notes searched; no matching note.");
  }
  if (toggle) {
    // Both sessions receive the identical workshop request. Only the search
    // result determines which path the local provider exercises.
    assert.equal(lines(received[0]?.content), repeatWorkshop);
    if (!responses.length) return tool("bookie_search", { query: "workshop" });
    assert.equal(responses[0].toolName, "bookie_search");
    if (responses[0].isError) return say(unavailableWorkshop);
    const search = JSON.parse(lines(responses[0].content)).result;
    if (!search.results.length && search.complete !== true)
      return say(unavailableWorkshop);
    phase = search.results.length ? "recall" : "delivery";
    if (phase === "delivery") responses.shift();
  }
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

async function run(phase, prompt) {
  let trusted = true;
  if (toggle) {
    const store = new ProjectTrustStore(agentDir);
    if (phase === "delivery") store.set(project, true);
    assert.deepEqual(store.getEntry(cwd), { path: project, decision: true });
    trusted = store.get(cwd) === true;
  }
  const settingsManager = SettingsManager.inMemory(
    { cacheWarming: "off", retry: { enabled: false }, enableAnalytics: false },
    { projectTrusted: trusted },
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
  const config =
    local &&
    localWorkshopProvider(
      fixtureModel,
      createAssistantMessageEventStream,
      (context) => fixture(phase, context),
    );
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
  const notices = [];
  const ui = new Proxy(
    {
      notify(text) {
        notices.push(text);
      },
    },
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
    if (toggle) {
      // Exercise the parent operator command. The dashboard uses the same
      // owner-scoped setAutoApproval operation. Never synthesize a memory lease.
      async function auto(target) {
        notices.length = 0;
        await session.prompt(
          target ? "/grants auto " + target : "/grants auto",
        );
        assert.match(
          notices.at(-1) ?? "",
          new RegExp(
            "permission Auto " + (target ?? "off").toUpperCase() + "\\b",
          ),
        );
      }
      async function checkLookup(expected) {
        const before = rows.length;
        const withheld = expected === "withheld";
        await session.prompt(withheld ? repeatWorkshop : lookupProbe);
        const observed = rows.slice(before);
        assert.equal(observed.length, 1);
        assert.equal(observed[0].tool, "bookie_search");
        if (withheld) {
          const reply = session.messages.at(-1);
          assert.equal(reply.stopReason, "stop");
          assert.equal(lines(reply.content), unavailableWorkshop);
          assert.equal(observed[0].error, true);
          assert.match(observed[0].text, /no active Pi Daddy Auto connection/i);
          assert.match(observed[0].text, /project history is unknown/i);
          assert.doesNotMatch(observed[0].text, /"results"\s*:/);
        } else {
          assert.equal(observed[0].error, false);
          const search = JSON.parse(observed[0].text).result;
          assert.equal(search.complete, true);
          assert.deepEqual(search.results, []);
        }
        observed[0].expectedRefusal = withheld;
        accessChecks.push({
          phase,
          outcome: expected,
          prompt: withheld ? "same-workshop-request" : "known-absent-marker",
          toolCount: observed.length,
          toolError: observed[0].error,
        });
      }
      await auto();
      await checkLookup("withheld");
      await auto("on");
      await checkLookup("confirmed-empty");
      if (phase === "recall") {
        await auto("off");
        await checkLookup("withheld");
        await auto("on");
      }
    }
    if (phase === "delivery" && scout) {
      await session.prompt(choicePrompt);
      await session.prompt(resourcePrompt);
    } else {
      await session.prompt(toggle ? repeatWorkshop : prompt);
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
      accessChecks,
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
    if (toggle) {
      assert.deepEqual(
        delivery.accessChecks.map((x) => x.outcome),
        ["withheld", "confirmed-empty"],
      );
      assert.deepEqual(
        recall.accessChecks.map((x) => x.outcome),
        ["withheld", "confirmed-empty", "withheld"],
      );
      assert.ok(
        recall.calls.every((x) =>
          ["bookie_search", "bookie_read"].includes(x.tool),
        ),
      );
    }
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
        result.rows
          .filter((row) => row.error && !row.expectedRefusal)
          .map((row) => row.tool),
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
          ...(toggle && {
            operatorCommand: "/grants auto on|off",
            accessChecks: results.flatMap((r) => r.accessChecks),
          }),
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
