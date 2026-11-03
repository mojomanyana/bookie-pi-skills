// Synthetic Docker CLI scheduling only: this is not runtime qualification.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { mock } from "node:test";
import { performance } from "node:perf_hooks";
let elapsed = 0;
mock.method(performance, "now", () => elapsed);

mock.timers.enable({ apis: ["setTimeout"] });
const cp = createRequire(import.meta.url)("node:child_process");
const children = new Map();
let runLate;
let registerLate;
let finalizeWorkspace;
let workspaceParent;
const parentContainers = new Set();
const fs = createRequire(import.meta.url)("node:fs/promises");
const remove = fs.rm;
mock.method(fs, "rm", async (path, options) => {
  if (path === workspaceParent)
    send({
      event: "parent-delete",
      recursive: options.recursive,
      force: options.force,
    });
  await remove(path, options);
});
const callbacks = new Map();
let next = 0;
const send = (message) => {
  // Completion disconnects IPC; a queued observation must not obscure early exit.
  if (process.connected) process.send(message);
};
mock.method(cp, "spawn", (program, args, options) => {
  const id = ++next;
  const child = new EventEmitter();
  Object.assign(child, {
    pid: 800000 + id,
    exitCode: null,
    signalCode: null,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: (signal) => {
      send({ event: "kill", id, signal });
      return true;
    },
  });
  children.set(id, child);
  send({ event: "command", id, program, args, timeout: options.timeout });
  // Only the enclosing parent repair and failure-image disposal auto-complete.
  // They remain synthetic CLI replies; fs.rm below really deletes owned state.
  if (
    workspaceParent &&
    args[0] === "run" &&
    args.at(-1).startsWith("chown -R")
  )
    parentContainers.add(args[args.indexOf("--name") + 1]);
  if (
    (args[0] === "run" &&
      parentContainers.has(args[args.indexOf("--name") + 1])) ||
    (args[0] === "rm" && parentContainers.has(args[2])) ||
    (args[0] === "ps" &&
      [...parentContainers].some((name) => args.includes(`name=^/${name}$`))) ||
    (workspaceParent && args[0] === "image")
  )
    queueMicrotask(() => {
      child.exitCode = 0;
      child.emit("close", 0, null);
    });
  return child;
});
mock.method(process, "kill", (pid, signal) => {
  const entry = [...children].find(([, child]) => child.pid === -pid);
  if (!entry)
    throw Object.assign(Error("PRIVATE_KILL_ERROR"), { code: "ESRCH" });
  send({ event: "kill", id: entry[0], signal });
  return true;
});
syncBuiltinESMExports();

process.on("message", (message) => {
  if (message.action === "close") {
    const child = children.get(message.id);
    child.stdout.end(message.stdout ?? "");
    child.stderr.end(message.stderr ?? "");
    child.exitCode = message.code ?? null;
    child.signalCode = message.signal ?? null;
    child.emit("close", child.exitCode, child.signalCode);
  } else if (message.action === "stderr") {
    children.get(message.id).stderr.write(message.stderr);
  } else if (message.action === "error") {
    children.get(message.id).emit("error", Error("PRIVATE_CLI_ERROR"));
  } else if (message.action === "callback") {
    const pending = callbacks.get(message.id);
    if (message.fail) pending.reject(Error("PRIVATE_CALLBACK_ERROR"));
    else pending.resolve();
  } else if (message.action === "late-registration") {
    registerLate();
  } else if (message.action === "late-operation") {
    runLate();
  } else if (message.action === "finalize-workspace") {
    void finalizeWorkspace().then(
      () => send({ event: "workspace-reentry", ok: true }),
      (error) =>
        send({ event: "workspace-reentry", ok: false, message: error.message }),
    );
  } else if (message.action === "tick") {
    elapsed += message.ms;
    mock.timers.tick(message.ms);
  } else if (message.action === "barrier") {
    // A full turn lets close handlers and their async finalizers run first.
    setImmediate(() => send({ event: "barrier", token: message.token }));
  }
});

const {
  runRuntime,
  docker,
  extractRuntime,
  mutateRuntimeImage,
  registerFixture,
  repository,
  runtimeWorkspaceFinalizer,
} = await import("../../scripts/qualify-runtime.mjs");
const callback = (kind, index) => () =>
  new Promise((resolve, reject) => {
    const id = `${kind}-${index}`;
    callbacks.set(id, { resolve, reject });
    send({ event: "callback", kind, id });
  });
registerLate = () => {
  try {
    registerFixture({
      closeClients: callback("forbidden", 0),
      removeDirectory: callback("forbidden", 1),
    });
    send({ event: "registration", ok: true });
  } catch (error) {
    send({ event: "registration", ok: false, message: error.message });
  }
};
const image = `sha256:${"a".repeat(64)}`;
runLate = () => {
  void runRuntime(image, "late-synthetic").then(
    () => send({ event: "late-result", ok: true }),
    (error) =>
      send({ event: "late-result", ok: false, message: error.message }),
  );
};
const [mode = "runtime", count = "1"] = process.argv.slice(2);
const operations = [];
if (mode === "workspace" || mode === "workspace-setup") {
  const { join } = await import("node:path");
  workspaceParent = await fs.mkdtemp(
    join(repository, ".principal/outer-cleanup-"),
  );
  const directory = join(workspaceParent, "fixture-0");
  send({ event: "workspace", parent: workspaceParent, directory });
  finalizeWorkspace = runtimeWorkspaceFinalizer({
    parent: workspaceParent,
    images: [{ imageId: image }, { imageId: `sha256:${"b".repeat(64)}` }],
    report: () =>
      mode === "workspace" ? "synthetic-workspace-record" : undefined,
    diagnostic: () => send({ event: "workspace-record" }),
  });
  operations.push(
    (async () => {
      try {
        if (mode === "workspace-setup") {
          // Actual registration followed by rejecting setup, with no returned owner.
          const { ownedRedisFixture } =
            await import("./owned-redis-fixture.mjs");
          let fixture;
          try {
            fixture = await ownedRedisFixture(workspaceParent);
          } finally {
            send({
              event: "setup-settled",
              fixtureReturned: fixture !== undefined,
            });
          }
        } else {
          const fixtures = [];
          for (let i = 0; i < Number(count); i++) {
            const path = join(workspaceParent, `fixture-${i}`);
            await fs.mkdir(path);
            await fs.writeFile(
              join(path, "socket-placeholder"),
              "synthetic-owned",
            );
            fixtures.push(
              registerFixture({
                closeClients: callback("clients", i),
                removeDirectory: async () => {
                  await callback("directory", i)();
                  await fs.rm(path, { recursive: true });
                },
              }),
            );
          }
          await Promise.all(
            fixtures.map(async (fixture) => {
              try {
                await docker(["run", "--name", fixture.name, "-d", image]);
              } finally {
                await fixture.finish();
              }
            }),
          );
        }
      } finally {
        await finalizeWorkspace();
      }
    })(),
  );
} else
  for (let i = 0; i < Number(count); i++) {
    if (mode === "fixture" || mode === "fixture-later") {
      operations.push(
        (async () => {
          const fixture = registerFixture({
            closeClients: callback("clients", i),
            removeDirectory: callback("directory", i),
          });
          try {
            await docker(["run", "--name", fixture.name, "-d", image]);
          } finally {
            await fixture.finish();
          }
          if (mode === "fixture-later")
            await runRuntime(image, "later-synthetic");
        })(),
      );
    } else if (mode === "extract")
      operations.push(extractRuntime(image, "/synthetic"));
    else if (mode === "mutate")
      operations.push(mutateRuntimeImage(image, "", "/synthetic", "symlink"));
    else if (mode === "docker")
      operations.push(docker(["run", "--rm", image, "synthetic"]));
    else operations.push(runRuntime(image, "synthetic"));
  }
if (mode === "command") operations.push(docker(["version"]));
// Catch only to report the operation result, not to defer its settlement.
// Exiting here deliberately exposes a rejection beating cancellation's drain.
try {
  const values = await Promise.all(operations);
  send({ event: "result", ok: true, values });
} catch (error) {
  send({
    event: "result",
    ok: false,
    message: error.message,
    ...(error.category === undefined ? {} : { category: error.category }),
    ...(error.stage === undefined ? {} : { stage: error.stage }),
  });
} finally {
  mock.restoreAll();
  mock.timers.reset();
  syncBuiltinESMExports();
  process.disconnect();
}
