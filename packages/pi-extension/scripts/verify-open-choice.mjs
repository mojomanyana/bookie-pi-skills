// node scripts/verify-open-choice.mjs <Pi 1.4+ install>/node_modules [pi-daddy package directory]
// A local scripted provider, real packaged extensions and the same runtime transition as /new.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { findPackageJSON } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { localWorkshopProvider } from "./workshop-provider.mjs";

const [modulesArg, daddyArg] = process.argv.slice(2);
assert.ok(modulesArg, "Pass the Pi installation's node_modules directory");
const modules = resolve(modulesArg);
const daddy = resolve(daddyArg ?? join(modules, "pi-daddy"));
const bookie =
  process.env.BOOKIE_WORKSHOP_EXTENSION ??
  fileURLToPath(new URL("../src/index.ts", import.meta.url));
const root = await mkdtemp(join(tmpdir(), "bookie-open-choice-"));
const cwd = join(root, "workshop"),
  agentDir = join(root, "agent");
const witness = join(root, "dashboard-observer.ts");
const packagePath = (name) => JSON.stringify(join(daddy, name));
// Real permission owner, snapshot request and terminal renderer. No synthetic dashboard rows.
await writeFile(
  witness,
  `
import grants from ${packagePath("extensions/grants.ts")};
import {createGrantsSession} from ${packagePath("extensions/session.ts")};
import {ensureDashboardSessionServer} from ${packagePath("extensions/dashboard-session-server.ts")};
import {dashboardSessionRequest} from ${packagePath("src/products/dashboard-session-client.ts")};
import {dashboardScreenState,renderDashboardScreen} from ${packagePath("src/products/dashboard-screen.ts")};
export default function(pi) {
  const owner = createGrantsSession(undefined);
  grants(pi, owner);
  pi.registerCommand("workshop-screen", {description:"Read the connected dashboard for this test", async handler(destination, ctx) {
    const endpoint = await ensureDashboardSessionServer(owner);
    const session = await dashboardSessionRequest(endpoint.socketPath,endpoint.token,{action:"get"});
    if (session.observation?.sessionId !== ctx.sessionManager.getSessionId()) throw Error("Wrong dashboard owner");
    const frame = renderDashboardScreen({width:88,height:32,connected:true,items:[],session,screen:{...dashboardScreenState(),destination}});
    ctx.ui.notify(frame);
  }});
}
`,
);
await mkdir(cwd);
await mkdir(agentDir);
process.chdir(cwd);
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_DADDY_AUTO_MODE = "1";
process.env.PI_DADDY_HERDR = "0";
process.env.PI_DADDY_ACTIVITY_TIMELINE = "off";
let fetches = 0;
globalThis.fetch = async () => {
  fetches++;
  throw Error("Offline acceptance attempted a network call");
};
const piDir = join(modules, "@earendil-works/pi-coding-agent");
const aiPath = findPackageJSON(
  "@earendil-works/pi-ai",
  pathToFileURL(join(piDir, "package.json")),
);
const { createAssistantMessageEventStream } = await import(
  pathToFileURL(join(dirname(aiPath), "dist/index.js"))
);
const {
  createAgentSessionRuntime,
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  ProjectTrustStore,
  SettingsManager,
  SessionManager,
} = await import(pathToFileURL(join(piDir, "dist/index.js")));
new ProjectTrustStore(agentDir).set(cwd, true);
const question = "Which chart: the StarDome foldout or a local planisphere?";
const guide = "https://workshop.example.org/guide";
const delivery =
  "Share the supplied workshop guide and leave the printed-chart choice open.";
const recall = "Where did we leave off? Read the workshop note.";
const text = (content) =>
  content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
const call = (name, args) => ({
  type: "toolCall",
  name,
  arguments: args,
  id: randomUUID(),
});
const say = (value) => ({ type: "text", text: value });
const modelId = "local";
const provider = "workshop-fixture";
function answer(context) {
  const lastUser = context.messages.findLastIndex((m) => m.role === "user");
  const prompt = text(context.messages[lastUser].content);
  const results = context.messages
    .slice(lastUser + 1)
    .filter((m) => m.role === "toolResult");
  for (const result of results)
    assert.equal(result.isError, false, text(result.content));
  if (prompt === delivery) {
    if (!results.length)
      return call("bookie_remember", {
        title: "Workshop guide",
        summary: "Shared the printed chart guide.",
        deliveryUrl: guide,
      });
    assert.equal(
      JSON.parse(text(results[0].content)).status,
      "pending final reply",
    );
    // The specific choice first appears in the delivered final response.
    return say(
      "Your printed-chart guide is " + guide + "\n\nOpen choice: " + question,
    );
  }
  assert.equal(prompt, recall);
  if (!results.length)
    return call("bookie_search", { query: "Workshop guide" });
  const search = JSON.parse(text(results[0].content)).result;
  assert.equal(search.complete, true);
  assert.equal(search.results.length, 1);
  if (results.length === 1)
    return call("bookie_read", {
      selector: "uid",
      value: search.results[0].uid,
    });
  const source = JSON.parse(text(results[1].content)).result.sourceText;
  const unresolved = source
    .match(/^# Unresolved work\s*\n([\s\S]*?)(?=^# |(?![\s\S]))/m)?.[1]
    .trim();
  return say(unresolved ?? "Missing unresolved-work section");
}
const config = localWorkshopProvider(
  modelId,
  createAssistantMessageEventStream,
  answer,
);
const notifications = [],
  errors = [],
  calls = [];
const ui = new Proxy(
  { notify: (msg) => notifications.push(msg) },
  {
    get(target, key) {
      return key in target ? target[key] : () => {};
    },
  },
);
const host = await createAgentSessionRuntime(
  async ({ sessionManager, sessionStartEvent }) => {
    const settingsManager = SettingsManager.inMemory(
      {
        cacheWarming: "off",
        retry: { enabled: false },
        enableAnalytics: false,
      },
      { projectTrusted: true },
    );
    const modelRuntime = await ModelRuntime.create({
      modelsPath: null,
      authPath: join(agentDir, "auth.json"),
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    modelRuntime.registerProvider(provider, config);
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      noMcp: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      additionalExtensionPaths: [witness, bookie],
      extensionFactories: [(pi) => pi.registerProvider(provider, config)],
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    const result = await createAgentSession({
      cwd,
      agentDir,
      modelRuntime,
      model: modelRuntime.getModel(provider, modelId),
      settingsManager,
      resourceLoader,
      sessionManager,
      sessionStartEvent,
      noTools: "builtin",
      thinkingLevel: "low",
    });
    return { ...result, services: { cwd, agentDir }, diagnostics: [] };
  },
  {
    cwd,
    agentDir,
    sessionManager: SessionManager.create(cwd, join(root, "sessions")),
  },
);
async function bind(session) {
  await session.bindExtensions({
    mode: "tui",
    uiContext: ui,
    onError: (e) => errors.push(e.error),
  });
  session.setActiveToolsByName([
    "bookie_remember",
    "bookie_search",
    "bookie_read",
  ]);
  session.subscribe((e) => {
    if (e.type === "tool_execution_start") calls.push(e.toolName);
  });
}
host.setRebindSession(bind);
async function frame(destination, expected) {
  // Registering or refreshing a producer may finish asynchronously.
  let value;
  const until = Date.now() + 6000;
  do {
    notifications.length = 0;
    await host.session.prompt("/workshop-screen " + destination);
    value = notifications.at(-1) ?? "";
    if (value.includes(expected)) return value;
    await new Promise((resolve) => setTimeout(resolve, 75));
  } while (Date.now() < until);
  return value;
}
const timer = setTimeout(() => void host.session.abort(), 90000);
try {
  await bind(host.session);
  await host.session.prompt(delivery);
  assert.match(text(host.session.messages.at(-1).content), /Open choice:/);
  const old = host.session.sessionManager.getSessionId();
  assert.deepEqual(await host.newSession(), { cancelled: false });
  assert.notEqual(host.session.sessionManager.getSessionId(), old);
  assert.deepEqual(host.session.messages, []);
  // Take the dashboard observations before the first question in the new chat.
  const frames = {};
  for (const destination of ["now", "work"]) {
    frames[destination] = await frame(destination, "Open choices");
  }
  await host.session.prompt(recall);
  const structured = text(host.session.messages.at(-1).content);
  const observed = { structured, dashboard: {} };
  for (const [destination, rendered] of Object.entries(frames)) {
    const lines = rendered.split("\n");
    const heading = lines.findIndex((line) => /^Open choices\s/.test(line));
    const nextRow = heading < 0 ? "" : (lines[heading + 1] ?? "");
    observed.dashboard[destination] = {
      openRow: nextRow.trim().replace(/^> /, ""),
      attention:
        /Needs attention|Needs your (?:decision|permission|input)/i.test(
          rendered,
        ),
    };
  }
  const expectedRow = { openRow: question + " · Open", attention: false };
  assert.deepEqual(observed, {
    structured: question,
    dashboard: { now: expectedRow, work: expectedRow },
  });
  assert.match(frames.now, /No pending dashboard requests/);
  assert.deepEqual(calls, ["bookie_remember", "bookie_search", "bookie_read"]);
  assert.deepEqual(errors, []);
  assert.equal(fetches, 0);
  console.log(
    JSON.stringify(
      {
        status: "passed",
        newSession: true,
        structuredUnresolvedWork: structured,
        dashboard: ["Overview: Open choices", "Tasks: Open choices"],
        attentionRequests: 0,
        calls,
        externalFetches: fetches,
      },
      null,
      2,
    ),
  );
} finally {
  clearTimeout(timer);
  await host.dispose();
  process.chdir(tmpdir());
  await rm(root, { recursive: true, force: true });
}
