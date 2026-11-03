// Synthetic Docker CLI scheduling only: this is not runtime qualification.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { mock } from "node:test";

mock.timers.enable({ apis: ["setTimeout"] });
const cp = createRequire(import.meta.url)("node:child_process");
const children = new Map();
let runLate;
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
  } else if (message.action === "late-operation") {
    runLate();
  } else if (message.action === "tick") {
    mock.timers.tick(message.ms);
  } else if (message.action === "barrier") {
    // A full turn lets close handlers and their async finalizers run first.
    setImmediate(() => send({ event: "barrier", token: message.token }));
  }
});

const { runRuntime, docker, extractRuntime, mutateRuntimeImage } =
  await import("../../scripts/qualify-runtime.mjs");
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
for (let i = 0; i < Number(count); i++) {
  if (mode === "extract") operations.push(extractRuntime(image, "/synthetic"));
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
