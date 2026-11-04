import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants, fstatSync, readFileSync, writeSync } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { types } from "node:util";
import {
  qualificationCallsites,
  trustedBuilderStages,
} from "./qualification-labels.mjs";

export const repository = resolve(import.meta.dirname, "../../..");
const owned = new Map();
const active = new Map();
let cancellation;
const fixtures = [];
let fixtureRegistrationClosed = false;
let fixtureTeardown;
let drainUntil;
const drainBudget = new AbortController();
const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const hash = (bytes) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

// Opt-in, qualifier-only evidence. No JS/libuv write queue or pending callbacks:
// writeSync is nonblocking ONLY on the already-O_NONBLOCK Linux pipe/socket
// verified below. Never change its flags, close it, or fall back to blocking I/O.
// No targets, argv, exceptions, identities or data-derived labels enter records.
// Incompleteness changes qualification, NEVER individual command/owner results.
let trace;
let sequence = 0;
const traceOwner = Symbol("qualification-owner");
export function enableQualificationTrace(options = {}) {
  const settings = traceSnapshot(options);
  const { maxRecords = 8192, maxBytes = 2097152 } = settings;
  if (
    Reflect.ownKeys(settings).some(
      (key) => !["maxRecords", "maxBytes"].includes(key),
    ) ||
    trace ||
    owned.size ||
    active.size ||
    fixtures.length ||
    !Number.isSafeInteger(maxRecords) ||
    maxRecords < 2 ||
    maxRecords > 8192 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1024 ||
    maxBytes > 2097152
  )
    throw Error("Runtime trace configuration invalid.");
  trace = {
    invocation: randomBytes(8).toString("hex"),
    origin: performance.now(),
    maxRecords,
    maxBytes,
    records: 0,
    bytes: 0,
    reason: undefined,
    fd: undefined,
  };
  try {
    // Accessing stderr initializes Node's nonblocking POSIX pipe/socket. Verify
    // the actual descriptor flags; a TTY, file or unsupported host fails closed.
    const fd = process.stderr.fd;
    if (process.platform !== "linux" || !Number.isSafeInteger(fd))
      throw Error();
    const info = fstatSync(fd);
    const flags = readFileSync(`/proc/self/fdinfo/${fd}`, "utf8").match(
      /^flags:\s+([0-7]+)$/mu,
    )?.[1];
    if (
      !(info.isFIFO() || info.isSocket()) ||
      flags === undefined ||
      !(Number.parseInt(flags, 8) & constants.O_NONBLOCK)
    )
      throw Error();
    trace.fd = fd;
  } catch {
    incompleteTrace("write-error");
  }
}
export function qualificationTraceStatus() {
  return trace
    ? {
        enabled: true,
        complete: trace.reason === undefined,
        ...(trace.reason ? { reason: trace.reason } : {}),
        records: trace.records,
        bytes: trace.bytes,
      }
    : { enabled: false, complete: false };
}
function writeTrace(record) {
  const line = `QUALIFICATION TRACE ${JSON.stringify(record)}\n`;
  trace.records++;
  trace.bytes += Buffer.byteLength(line);
  try {
    if (writeSync(trace.fd, line) !== Buffer.byteLength(line))
      incompleteTrace("write-error");
  } catch (error) {
    incompleteTrace(
      error.code === "EAGAIN" || error.code === "EWOULDBLOCK"
        ? "backpressure"
        : "write-error",
    );
  }
}
function incompleteTrace(reason) {
  if (!trace || trace.reason) return;
  trace.reason = reason;
  // Reserve one record and 256 bytes for exhaustion disclosure. A blocked/dead
  // sink gets NO retry, callback or drain allowance; checked failure is retained.
  if (reason !== "exhausted") return;
  writeTrace({
    invocation: trace.invocation,
    event: "incomplete",
    outcome: reason,
  });
}
function traceSnapshot(value) {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      types.isProxy(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    )
      throw Error();
    const fields = Object.getOwnPropertyDescriptors(value);
    if (Object.values(fields).some((field) => !Object.hasOwn(field, "value")))
      throw Error();
    return Object.fromEntries(
      Reflect.ownKeys(fields).map((key) => [key, fields[key].value]),
    );
  } catch {
    throw Error("Runtime trace labels invalid.");
  }
}
function traceOptions(options, fallback) {
  const snapshot = options === undefined ? {} : traceSnapshot(options);
  return { ...snapshot, trace: traceLabels(snapshot.trace, fallback) };
}
function traceLabels(value, fallback = "engine-work", context = "body") {
  if (value === undefined) return { stage: fallback, context };
  const fields = traceSnapshot(value);
  if (
    Reflect.ownKeys(fields).some(
      (key) => !["stage", "context"].includes(key),
    ) ||
    !qualificationCallsites.includes(fields.stage) ||
    ![undefined, "body", "finalizer", "cancellation"].includes(fields.context)
  )
    throw Error("Runtime trace labels invalid.");
  return {
    stage: fields.stage,
    context: fields.context ?? context,
  };
}
function traceSpan(category, labels, capMs, owner) {
  const id = `c${++sequence}`;
  const started = performance.now();
  let settled = false;
  const note = (event, outcome) => {
    if (!trace || trace.reason) return;
    const now = performance.now();
    const record = {
      invocation: trace.invocation,
      id,
      category,
      ...labels,
      ...(owner ? { owner } : {}),
      event,
      outcome,
      atMs: Math.max(0, Math.floor(now - trace.origin)),
      elapsedMs: Math.max(0, Math.floor(now - started)),
      ...(capMs === undefined ? {} : { capMs: Math.max(0, Math.floor(capMs)) }),
    };
    const bytes = Buffer.byteLength(
      `QUALIFICATION TRACE ${JSON.stringify(record)}\n`,
    );
    if (
      trace.records >= trace.maxRecords - 1 ||
      trace.bytes + bytes > trace.maxBytes - 256
    ) {
      incompleteTrace("exhausted");
      return;
    }
    writeTrace(record);
  };
  note("start", "pending");
  return {
    id,
    note,
    get settled() {
      return settled;
    },
    settle(outcome) {
      if (!settled) {
        settled = true;
        note("settle", outcome);
      }
    },
  };
}
if (process.env.BOOKIE_QUALIFICATION_TRACE === "1") enableQualificationTrace();

// Classic diagnostics must not reintroduce an async write after the trace sink
// stops. The failed command/drain retains its own category and error outcome.
function qualificationDiagnostic(message, context = "body") {
  if (trace)
    traceSpan("diagnostic", { stage: "engine-work", context }).settle("failed");
  else console.error(message);
}

// Cleanup uses the raw runner; ordinary work must join shutdown before settling.
async function cancelled() {
  await cancellation;
  throw Error("Runtime qualification cancelled.");
}
async function command(program, args, options) {
  if (cancellation) await cancelled();
  try {
    return await executeCommand(program, args, options);
  } finally {
    if (cancellation) await cancelled();
  }
}
function commandCategory(program, args) {
  if (program === "git") return "repository-check";
  if (args[0] === "run" && args.includes("--input-type=module"))
    return "runtime-driver";
  const categories = {
    run: "container-run",
    build: "image-build",
    create: "container-create",
    cp: "container-copy",
    start: "container-start",
    commit: "image-commit",
    rm: "container-remove",
    ps: "container-observe",
    image: "image-command",
  };
  return Object.hasOwn(categories, args[0])
    ? categories[args[0]]
    : "engine-command";
}
function executeCommand(
  program,
  args,
  {
    input,
    timeout = 300000,
    allowFailure = false,
    trace: labels,
    [traceOwner]: owner,
  } = {},
) {
  const category = commandCategory(program, args);
  const span = traceSpan(category, traceLabels(labels), timeout, owner);
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      timeout,
      killSignal: "SIGKILL",
    });
    active.set(child, new Promise((closed) => child.once("close", closed)));
    let stdout = "",
      stderr = "",
      overflow = false,
      diagnosed = false;
    const failure = (code, signal) => {
      // Accept only complete static fixture markers. Never print CLI output,
      // argv, driver text, source/runtime identity or a dependency exception.
      const stages =
        category === "runtime-driver"
          ? [
              ...stderr.matchAll(
                /^QUALIFICATION trusted-builder stage=([a-z-]+)$/gmu,
              ),
            ]
              .map((match) => match[1])
              .filter((stage) => trustedBuilderStages.includes(stage))
          : [];
      const stage = stages.at(-1);
      if (!diagnosed) {
        diagnosed = true;
        qualificationDiagnostic(
          `QUALIFICATION category=${category}${stage === undefined ? "" : ` stage=${stage}`}`,
          traceLabels(labels).context,
        );
      }
      return Object.defineProperties(
        new Error("Runtime qualification command failed."),
        {
          category: { value: category, enumerable: true },
          ...(stage === undefined
            ? {}
            : { stage: { value: stage, enumerable: true } }),
          ...(code === undefined
            ? {}
            : { code: { value: code, enumerable: true } }),
          ...(signal === undefined
            ? {}
            : { signal: { value: signal, enumerable: true } }),
          stdout: { value: stdout },
          stderr: { value: stderr },
        },
      );
    };
    // A lost close callback must not turn the CLI cap into an unbounded wait.
    // Keep tracking the client until close, even after this result is rejected.
    const timer = setTimeout(() => {
      span.note("deadline", "deadline");
      span.settle("deadline");
      child.kill("SIGKILL");
      reject(failure());
    }, timeout);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > 4 * 1024 * 1024) {
        overflow = true;
        child.kill("SIGKILL");
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (Buffer.byteLength(stderr) > 4 * 1024 * 1024) {
        overflow = true;
        child.kill("SIGKILL");
      }
    });
    child.on("error", () => {
      span.note("error", "child-error");
      span.settle("child-error");
      reject(failure());
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      active.delete(child);
      const outcome = overflow ? "overflow" : code === 0 ? "ok" : "failed";
      span.note(span.settled ? "late-close" : "close", outcome);
      span.settle(outcome);
      if (allowFailure && !overflow) resolve({ code, signal, stdout, stderr });
      else if (code === 0 && !overflow) resolve(stdout.trim());
      else reject(failure(code, signal));
    });
    if (input !== undefined) {
      child.stdin.on("error", () => {
        span.note("error", "input-error");
        span.settle("input-error");
        reject(failure());
      });
      child.stdin.end(input);
    }
  }).catch((error) => {
    // Also pair a synchronous spawn/setup rejection without logging its value.
    span.settle("setup-error");
    throw error;
  });
}
function ownContainer(labels = traceLabels(undefined, "owned-container")) {
  const container = {
    name: `bookie-runtime-${process.pid}-${randomBytes(8).toString("hex")}`,
    teardown: undefined,
    trace: traceSpan("ownership", labels),
  };
  owned.set(container.name, container);
  return container;
}
export async function docker(args, options) {
  if (cancellation) await cancelled();
  // Validate before ownership/possible dispatch; never echo rejected metadata.
  options = traceOptions(options);
  const labels = options.trace;
  if (args[0] !== "run" || !args.includes("--rm"))
    return await command("docker", args, options);
  const container = ownContainer({ ...labels, stage: "owned-container" });
  const { name } = container;
  try {
    return await command(
      "docker",
      [
        "run",
        "--name",
        name,
        "--memory",
        "1g",
        "--cpus",
        "2",
        "--pids-limit",
        "128",
        ...args.slice(1).filter((arg) => arg !== "--rm"),
      ],
      { ...options, [traceOwner]: container.trace.id },
    );
  } finally {
    await finishContainer(container);
  }
}

export async function privateWorkspace() {
  if (cancellation) await cancelled();
  try {
    const directory = join(repository, ".principal");
    await mkdir(directory, { recursive: true });
    try {
      await writeFile(join(directory, ".gitignore"), "*\n", { flag: "wx" });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const path = await mkdtemp(join(directory, "runtime-qualification-"));
    await command("git", ["-C", repository, "check-ignore", path], {
      trace: { stage: "private-workspace-check", context: "body" },
    });
    return path;
  } finally {
    if (cancellation) await cancelled();
  }
}

/** The actual enclosing qualification finalizer, shared with synthetic controls. */
export function runtimeWorkspaceFinalizer({
  parent,
  images,
  report,
  diagnostic,
}) {
  let settlement;
  return () =>
    (settlement ??= (async () => {
      let output = report();
      let failure;
      try {
        // Join the registered owner even when setup never returned a fixture.
        // Retained rejection/uncertainty withholds BOTH enclosing mutations.
        await finishFixtures();
        await docker(
          [
            "run",
            "--rm",
            "--network",
            "none",
            "--mount",
            `type=bind,src=${parent},dst=/work`,
            "--entrypoint",
            "/bin/sh",
            "node:24.19.0-bookworm@sha256:4196d66a565c6f195728d9952f161f4adfe2ad753052a08b7ec7f1c5a6bda42b",
            "-c",
            `chown -R ${process.getuid()}:${process.getgid()} /work`,
          ],
          {
            trace: { stage: "runtime-workspace-repair", context: "finalizer" },
          },
        );
        const directory = traceSpan(
          "workspace-directory",
          traceLabels(undefined, "runtime-workspace-directory", "finalizer"),
        );
        try {
          await rm(parent, { recursive: true, force: true });
          directory.settle("confirmed");
        } catch (error) {
          directory.settle("unconfirmed");
          throw error;
        }
      } catch (error) {
        output = undefined;
        failure = error;
      }
      if (output !== undefined && trace) {
        // No asynchronous writer remains to drain or later upgrade settlement.
        // Retain failure, then dispose independent images before rejecting.
        if (!qualificationTraceStatus().complete) {
          failure = Error(
            "Runtime qualification trace incomplete; record withheld.",
          );
          output = undefined;
        }
      }
      if (output === undefined) {
        const results = await Promise.allSettled(
          [...new Set(images.map((record) => record.imageId))].map((imageId) =>
            docker(["image", "rm", "--no-prune", imageId], {
              trace: {
                stage: "runtime-workspace-image-remove",
                context: "finalizer",
              },
            }),
          ),
        );
        if (results.some((result) => result.status === "rejected"))
          failure ??= Error("Runtime container/child teardown unconfirmed.");
      }
      if (failure) throw failure;
      if (output !== undefined) diagnostic(output);
    })());
}

async function finishContainer(container) {
  try {
    await removeContainer(container);
  } finally {
    if (cancellation) await cancelled();
  }
}
function removeContainer(container, context = "finalizer") {
  if (container.teardown) container.trace.note("join", "cached");
  // Retain the promise, including failure, for finalizers and reentrant signals.
  // A failed/unknown mutation is never replayed, nor is "No such" an ack.
  return (container.teardown ??= (async () => {
    const { name } = container;
    try {
      const result = await executeCommand("docker", ["rm", "-f", name], {
        allowFailure: true,
        timeout: 15000,
        trace: { stage: "owned-remove", context },
        [traceOwner]: container.trace.id,
      });
      if (result.code !== 0) throw Error();
      container.trace.note("proof", "ack");
      const remaining = await executeCommand(
        "docker",
        ["ps", "-a", "--filter", `name=^/${name}$`, "--format", "{{.ID}}"],
        {
          timeout: 15000,
          trace: { stage: "owned-absence", context },
          [traceOwner]: container.trace.id,
        },
      );
      if (remaining !== "") throw Error();
      container.trace.note("proof", "absent");
      owned.delete(name);
      container.trace.settle("confirmed");
    } catch {
      container.trace.settle("unconfirmed");
      throw Error("Runtime container teardown unconfirmed.");
    }
  })());
}
/** Trusted test-fixture registration only. The callbacks close exact clients and
 * delete their dependent private directory; neither grants raw command authority.
 * Register before setup dispatch. Normal finalizers/signals retain one outcome.
 */
export function registerFixture({ closeClients, removeDirectory }) {
  if (cancellation || fixtureRegistrationClosed)
    throw Error("Runtime fixture registration closed.");
  if (
    fixtures.length === 4 ||
    typeof closeClients !== "function" ||
    typeof removeDirectory !== "function"
  )
    throw Error("Runtime fixture registration invalid.");
  const container = ownContainer();
  fixtures.push({ container, closeClients, removeDirectory });
  return Object.freeze({
    name: container.name,
    finish: async () => {
      try {
        await finishFixtures();
      } finally {
        if (cancellation) await cancelled();
      }
    },
  });
}
function finishFixtures() {
  fixtureRegistrationClosed = true;
  return (fixtureTeardown ??= (async () => {
    const results = await Promise.allSettled(
      fixtures.map((f) => removeContainer(f.container)),
    );
    await drainClientsAndFixtures(results);
  })());
}
async function drainClientsAndFixtures(removals, context = "finalizer") {
  drainUntil ??= performance.now() + 1000;
  const span = traceSpan(
    "client-drain",
    traceLabels(undefined, "client-drain", context),
    Math.max(0, drainUntil - performance.now()),
  );
  let unconfirmed = removals.some((result) => result.status === "rejected");
  // Include cleanup clients too, even if their command result already failed.
  const children = [...active];
  for (const [child] of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    try {
      if (process.platform === "win32") child.kill("SIGKILL");
      else process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") unconfirmed = true;
    }
  }
  let timer;
  const budget = drainBudget;
  // ONE shared allowance for CLI/client/socket settlement and directory work.
  // Expiry is failure, never evidence an ignored callback or I/O has stopped.
  const closed = Promise.all(children.map(([, settled]) => settled)).then(
    () => {
      span.note("proof", "clients-closed");
    },
  );
  const resources = fixtures.map(
    (fixture) =>
      (fixture.externalTeardown ??= (async () => {
        const removed = await fixture.container.teardown.then(
          () => true,
          () => false,
        );
        let clients = false;
        const clientsTrace = traceSpan(
          "fixture-clients",
          traceLabels(undefined, "fixture-clients", context),
          Math.max(0, drainUntil - performance.now()),
          fixture.container.trace.id,
        );
        try {
          await fixture.closeClients(budget.signal);
          clients = true;
          clientsTrace.settle(
            budget.signal.aborted || performance.now() >= drainUntil
              ? "unconfirmed"
              : "confirmed",
          );
        } catch {
          clientsTrace.settle("unconfirmed");
        }
        await closed;
        if (
          !removed ||
          !clients ||
          budget.signal.aborted ||
          performance.now() >= drainUntil
        )
          throw Error("Runtime fixture teardown unconfirmed.");
        const directory = traceSpan(
          "fixture-directory",
          traceLabels(undefined, "fixture-directory", context),
          Math.max(0, drainUntil - performance.now()),
          fixture.container.trace.id,
        );
        try {
          await fixture.removeDirectory(budget.signal);
          if (budget.signal.aborted || performance.now() >= drainUntil)
            throw Error("Runtime fixture teardown unconfirmed.");
          directory.settle("confirmed");
        } catch {
          directory.settle("unconfirmed");
          throw Error("Runtime fixture teardown unconfirmed.");
        }
      })()),
  );
  try {
    await Promise.race([
      Promise.allSettled([closed, ...resources]).then((results) => {
        if (results.some((r) => r.status === "rejected")) unconfirmed = true;
      }),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => {
            span.note("deadline", "deadline");
            budget.abort();
            reject(Error("Runtime fixture teardown unconfirmed."));
          },
          Math.max(0, drainUntil - performance.now()),
        );
      }),
    ]);
  } catch {
    unconfirmed = true;
  } finally {
    clearTimeout(timer);
  }
  span.settle(unconfirmed ? "unconfirmed" : "confirmed");
  if (unconfirmed) throw Error("Runtime container/child teardown unconfirmed.");
}
async function drainCancellation() {
  fixtureRegistrationClosed = true;
  const span = traceSpan(
    "cancellation",
    traceLabels(undefined, "cancellation-drain", "cancellation"),
  );
  const results = await Promise.allSettled(
    [...owned.values()].map((container) =>
      removeContainer(container, "cancellation"),
    ),
  );
  let unconfirmed = results.some((result) => result.status === "rejected");
  try {
    await drainClientsAndFixtures(results, "cancellation");
  } catch {
    unconfirmed = true;
  }
  span.settle(unconfirmed ? "unconfirmed" : "confirmed");
  if (unconfirmed) throw Error("Runtime container/child teardown unconfirmed.");
}
// Client/leader exit is not resource teardown. Stop dispatch, drain every known
// owned teardown and client (also after failures), then settle cancellation.
if (!isMain)
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => {
      if (cancellation) return;
      cancellation = drainCancellation();
      void cancellation.then(
        () => process.exit(1),
        () => {
          qualificationDiagnostic(
            "Runtime container/child teardown unconfirmed.",
            "cancellation",
          );
          process.exit(1);
        },
      );
    });

export async function runRuntime(imageId, driver, options = {}) {
  if (cancellation) await cancelled();
  if (!/^sha256:[a-f0-9]{64}(?![\s\S])/u.test(imageId))
    throw Error("Immutable runtime image ID required.");
  options = traceOptions(options, "runtime-execute");
  const labels = options.trace;
  const container = ownContainer();
  const { name } = container;
  const args = [
    "run",
    "--name",
    name,
    "--network",
    "none",
    "--memory",
    "2g",
    "--cpus",
    "2",
    "--pids-limit",
    "128",
    "--user",
    options.rootUser ? "0:0" : "65534:65534",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=64m",
    "--entrypoint",
    "/usr/local/bin/node",
  ];
  if (!options.writableRoot) args.push("--read-only");
  if (!options.capabilities) args.push("--cap-drop", "ALL");
  if (!options.privileges) args.push("--security-opt", "no-new-privileges");
  if (options.source)
    args.push(
      "--mount",
      `type=bind,src=${options.source},dst=/vault${options.writableSource ? "" : ",readonly"}`,
    );
  for (const mount of options.mounts ?? []) args.push("--mount", mount);
  for (const variable of options.env ?? []) args.push("--env", variable);
  args.push(imageId, "--input-type=module", "-e", driver);
  try {
    return await docker(args, {
      timeout: 45000,
      trace: labels,
      [traceOwner]: container.trace.id,
    });
  } finally {
    await finishContainer(container);
  }
}

async function inputHash(context) {
  const inputs = [];
  for (const name of [
    "package.json",
    "package-lock.json",
    "apps/service/package.json",
    "apps/service/tsconfig.json",
    "apps/service/Dockerfile",
    "apps/service/Dockerfile.dockerignore",
    "packages/core/package.json",
    "packages/core/tsconfig.json",
    "packages/core/scripts/copy-schemas.mjs",
    "packages/cli/package.json",
    "packages/pi-extension/package.json",
  ])
    inputs.push(name);
  for (const directory of ["apps/service/src", "packages/core/src", "schemas"])
    for (const name of await readdir(join(context, directory), {
      recursive: true,
    })) {
      const path = `${directory}/${name}`;
      const info = await lstat(join(context, path));
      if (info.isFile() && (path.endsWith(".ts") || path.endsWith(".json")))
        inputs.push(path);
    }
  const entries = [];
  for (const path of inputs.sort())
    entries.push([path, hash(await readFile(join(context, path)))]);
  return hash(JSON.stringify(entries));
}

/** A build result is only candidate evidence; the command's integration tests
 * must succeed before publishing its qualification record. No registry/Git writes.
 */
export async function buildRuntime(context) {
  if (cancellation) await cancelled();
  try {
    const lockBefore = await readFile(join(context, "package-lock.json"));
    const inputs = await inputHash(context);
    const result = await docker(
      [
        "build",
        "--no-cache",
        "--pull",
        "--platform",
        "linux/amd64",
        "-q",
        "-f",
        join(context, "apps/service/Dockerfile"),
        context,
      ],
      {
        allowFailure: true,
        trace: { stage: "runtime-build", context: "body" },
      },
    );
    if (result.code !== 0)
      throw Object.defineProperty(
        new Error("Runtime image build failed."),
        "diagnostic",
        { value: result.stderr },
      );
    const imageId = result.stdout.trim();
    if (!/^sha256:[a-f0-9]{64}(?![\s\S])/u.test(imageId))
      throw Error("Runtime image build failed.");
    try {
      if (
        !(await readFile(join(context, "package-lock.json"))).equals(lockBefore)
      )
        throw Error("Runtime lockfile changed.");
      const artifactHash = await runRuntime(
        imageId,
        `import {hashRuntimeArtifact} from '/opt/bookie/apps/service/dist/runtime-artifact.js'; console.log(await hashRuntimeArtifact('/opt/bookie'));`,
        { trace: { stage: "runtime-artifact-measure", context: "body" } },
      );
      const profile = JSON.parse(
        await runRuntime(
          imageId,
          `import {readFileSync,readdirSync} from 'node:fs'; import {createHash} from 'node:crypto'; import assert from 'node:assert/strict'; assert.equal('sha256:'+createHash('sha256').update(readFileSync('/opt/bookie/package-lock.json')).digest('hex'),${JSON.stringify(hash(lockBefore))}); import {qualifyRuntime} from '/opt/bookie/apps/service/dist/runtime-qualification.js'; await qualifyRuntime(${JSON.stringify(artifactHash)}); for(const name of ['typescript','@earendil-works','@bookie/cli','@bookie/pi-extension']) assert.equal(readdirSync('/opt/bookie/node_modules').includes(name),false); const paths=readdirSync('/opt/bookie',{recursive:true}); for(const path of paths) { assert.equal(path.includes('stale.js'),false); assert.equal(path.includes('.env'),false); if(!path.endsWith('/')) { try { const bytes=readFileSync('/opt/bookie/'+path); assert.equal(bytes.includes('HOST_CREDENTIAL_CANARY'),false); } catch(e) { if(e.code !== 'EISDIR') throw e; } } } console.log(readFileSync('/opt/bookie/runtime-profile.json','utf8'));`,
          { trace: { stage: "runtime-profile-check", context: "body" } },
        ),
      );
      return {
        imageId,
        artifactHash,
        lockHash: hash(lockBefore),
        inputHash: inputs,
        profile,
      };
    } catch (error) {
      await docker(["image", "rm", "--no-prune", imageId], {
        trace: {
          stage: "runtime-build-failure-image-remove",
          context: "finalizer",
        },
      });
      throw error;
    }
  } finally {
    if (cancellation) await cancelled();
  }
}

export async function mutateRuntimeImage(
  imageId,
  path,
  parent,
  kind = "append",
) {
  if (cancellation) await cancelled();
  const container = ownContainer();
  const { name } = container;
  const file = join(parent, `mutation-${randomBytes(8).toString("hex")}`);
  try {
    if (kind === "append") {
      await docker(["create", "--name", name, imageId], {
        trace: { stage: "runtime-mutation-create", context: "body" },
        [traceOwner]: container.trace.id,
      });
      await docker(["cp", `${name}:/opt/bookie/${path}`, file], {
        trace: { stage: "runtime-mutation-read", context: "body" },
        [traceOwner]: container.trace.id,
      });
      await writeFile(
        file,
        Buffer.concat([await readFile(file), Buffer.from("\n ")]),
      );
      await docker(["cp", file, `${name}:/opt/bookie/${path}`], {
        trace: { stage: "runtime-mutation-write", context: "body" },
        [traceOwner]: container.trace.id,
      });
    } else {
      const commands = {
        hardlink: "ln /opt/bookie/package.json /opt/bookie/alias",
        symlink: "ln -s /etc/passwd /opt/bookie/alias",
        special: "mkfifo /opt/bookie/alias",
      };
      if (!Object.hasOwn(commands, kind))
        throw Error("Runtime mutation fixture invalid.");
      await docker(
        [
          "create",
          "--name",
          name,
          "--network",
          "none",
          "--user",
          "0:0",
          "--entrypoint",
          "/bin/sh",
          imageId,
          "-c",
          commands[kind],
        ],
        {
          trace: { stage: "runtime-mutation-create", context: "body" },
          [traceOwner]: container.trace.id,
        },
      );
      await docker(["start", "-a", name], {
        trace: { stage: "runtime-mutation-start", context: "body" },
        [traceOwner]: container.trace.id,
      });
    }
    return await docker(["commit", "--change", "USER 65534:65534", name], {
      trace: { stage: "runtime-mutation-commit", context: "body" },
      [traceOwner]: container.trace.id,
    });
  } finally {
    await finishContainer(container);
  }
}

export async function extractRuntime(imageId, destination) {
  if (cancellation) await cancelled();
  const container = ownContainer();
  const { name } = container;
  try {
    await docker(["create", "--name", name, imageId], {
      trace: { stage: "runtime-extract-create", context: "body" },
      [traceOwner]: container.trace.id,
    });
    await docker(["cp", `${name}:/opt/bookie`, destination], {
      trace: { stage: "runtime-extract-copy", context: "body" },
      [traceOwner]: container.trace.id,
    });
  } finally {
    await finishContainer(container);
  }
}

if (isMain) {
  const child = spawn(
    process.execPath,
    [
      "--test",
      join(repository, "apps/service/test/deployment/runtime.test.mjs"),
    ],
    { stdio: "inherit" },
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => {
      child.kill(signal);
    });
  child.on("error", () => {
    qualificationDiagnostic("Runtime qualification failed.");
    process.exitCode = 1;
  });
  child.once("close", (code) => {
    process.exitCode = code ?? 1;
  });
}
