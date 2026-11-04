// Synthetic Docker CLI scheduling only: this is not runtime qualification.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { mock } from "node:test";
import { performance } from "node:perf_hooks";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";

const [mode = "runtime", count = "1", traceConfig] = process.argv.slice(2);
const fs = createRequire(import.meta.url)("node:fs/promises");
const fsSync = createRequire(import.meta.url)("node:fs");
let workspaceParent;
if (mode.startsWith("workspace")) {
  // Real bootstrap BEFORE spawn/timer instrumentation. A synthetic CLI reply is
  // not privacy proof. Keep the exclusive absent-policy semantics of the shared
  // qualifier, but a short owned name leaves room for the unchanged socket cap.
  let failed = false;
  try {
    const repository = resolve(import.meta.dirname, "../../../..");
    const directory = join(repository, ".principal");
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    if (!(await fs.lstat(directory)).isDirectory()) throw Error();
    try {
      await fs.writeFile(join(directory, ".gitignore"), "*\n", {
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    workspaceParent = await fs.mkdtemp(join(directory, "oc-"));
    execFileSync(
      "git",
      ["-C", repository, "check-ignore", "--quiet", "--", workspaceParent],
      { stdio: "ignore", timeout: 5000 },
    );
  } catch {
    failed = true;
  }
  if (failed) {
    let message = "Synthetic workspace bootstrap failed.";
    if (workspaceParent)
      try {
        // Still empty: no fixture data, registration or setup was authorized.
        await fs.rmdir(workspaceParent);
      } catch {
        message = "Synthetic workspace bootstrap cleanup unconfirmed.";
      }
    await new Promise((done) =>
      process.send({ event: "result", ok: false, message }, done),
    );
    process.disconnect();
    process.exit(1);
  }
}

let elapsed = 0;
mock.method(performance, "now", () => elapsed);

mock.timers.enable({ apis: ["setTimeout"] });
const cp = createRequire(import.meta.url)("node:child_process");
const children = new Map();
let runLate;
let registerLate;
let finalizeWorkspace;
const parentContainers = new Set();
const remove = fs.rm;
mock.method(fs, "rm", async (path, options) => {
  if (path === workspaceParent)
    send({
      event: "parent-delete",
      recursive: options.recursive,
      force: options.force,
    });
  await remove(path, options);
  if (path === workspaceParent) send({ event: "parent-deleted" });
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
  const flood = mode.startsWith("workspace-pipe") && args[0] === "version";
  const failed = flood && args[1] === "fail";
  if (!flood)
    send({ event: "command", id, program, args, timeout: options.timeout });
  if (args.includes("PRIVATE_METADATA_DRIVER"))
    parentContainers.add(args[args.indexOf("--name") + 1]);
  // Only exact synthetic controls, parent repair and image disposal auto-complete.
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
    (workspaceParent && args[0] === "image") ||
    flood ||
    (mode === "trace-metadata" && args[0] === "version")
  )
    queueMicrotask(() => {
      child.exitCode = failed ? 1 : 0;
      child.emit("close", child.exitCode, null);
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
  runtimeWorkspaceFinalizer,
  enableQualificationTrace,
  qualificationTraceStatus,
} = await import("../../scripts/qualify-runtime.mjs");
let metadataCalls = 0;
const forbiddenMetadata = () => {
  metadataCalls++;
  throw Error("PRIVATE_METADATA_CANARY");
};
const executableMetadata = (kind, field, value) => {
  if (kind === "getter")
    return Object.defineProperty({}, field, { get: forbiddenMetadata });
  if (kind === "inherited-getter")
    return Object.create(
      Object.defineProperty({}, field, { get: forbiddenMetadata }),
    );
  if (kind === "inherited-value") return Object.create({ [field]: value });
  if (kind === "revoked-proxy") {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    return proxy;
  }
  return new Proxy(
    { [field]: value },
    {
      get: forbiddenMetadata,
      ownKeys: forbiddenMetadata,
      getOwnPropertyDescriptor: forbiddenMetadata,
      getPrototypeOf: forbiddenMetadata,
    },
  );
};
let traceEnabled = false;
if (mode === "trace-config-metadata") {
  try {
    enableQualificationTrace(executableMetadata(count, "maxRecords", 8192));
    traceEnabled = true;
    send({ event: "validation", ok: true });
  } catch (error) {
    send({ event: "validation", ok: false, message: error.message });
  }
  send({ event: "metadata-observations", calls: metadataCalls });
}
let sinkWrites = 0;
if (["trace-blocking-sink", "trace-file-sink"].includes(mode)) {
  const readFileSync = fsSync.readFileSync;
  const fstatSync = fsSync.fstatSync;
  const writeSync = fsSync.writeSync;
  if (mode === "trace-blocking-sink")
    mock.method(fsSync, "readFileSync", (path, ...args) =>
      path === `/proc/self/fdinfo/${process.stderr.fd}`
        ? "flags:\t02\n"
        : readFileSync(path, ...args),
    );
  else
    mock.method(fsSync, "fstatSync", (fd, ...args) =>
      fd === process.stderr.fd
        ? { isFIFO: () => false, isSocket: () => false }
        : fstatSync(fd, ...args),
    );
  mock.method(fsSync, "writeSync", (...args) => {
    sinkWrites++;
    return writeSync(...args);
  });
  syncBuiltinESMExports();
}
if (traceConfig && !traceEnabled)
  enableQualificationTrace(JSON.parse(traceConfig));
if (
  [
    "trace-write-error",
    "trace-write-short",
    "workspace-trace-write-error",
    "workspace-trace-unavailable",
  ].includes(mode)
) {
  const writeSync = fsSync.writeSync;
  let failed = false;
  mock.method(fsSync, "writeSync", (fd, bytes, ...args) => {
    if (!failed && String(bytes).startsWith("QUALIFICATION TRACE ")) {
      failed = true;
      if (mode === "trace-write-short")
        return writeSync(fd, Buffer.from(bytes).subarray(0, 8));
      throw Object.assign(Error("PRIVATE_TRACE_WRITE_ERROR"), {
        code: mode === "workspace-trace-unavailable" ? "EAGAIN" : "EIO",
      });
    }
    return writeSync(fd, bytes, ...args);
  });
  syncBuiltinESMExports();
}
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
const operations = [];
if (mode.startsWith("workspace")) {
  const directory = join(workspaceParent, "fixture-0");
  send({ event: "workspace", parent: workspaceParent, directory });
  finalizeWorkspace = runtimeWorkspaceFinalizer({
    parent: workspaceParent,
    images: [{ imageId: image }, { imageId: `sha256:${"b".repeat(64)}` }],
    report: () =>
      mode === "workspace-setup" ? undefined : "synthetic-workspace-record",
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
          if (mode.startsWith("workspace-pipe")) {
            // Real stderr is deliberately unconsumed. No real CLI is dispatched;
            // enough bounded static records fill the child's actual OS pipe.
            for (let n = 0; n < 2400; n++) await docker(["version"]);
            send({
              event: "pipe-filled",
              ...qualificationTraceStatus(),
              nonblocking: Boolean(
                Number.parseInt(
                  fsSync
                    .readFileSync(
                      `/proc/self/fdinfo/${process.stderr.fd}`,
                      "utf8",
                    )
                    .match(/^flags:\s+(\d+)$/mu)[1],
                  8,
                ) & fsSync.constants.O_NONBLOCK,
              ),
            });
          }
          if (mode === "workspace-pipe-failure") {
            try {
              await docker(["version", "fail"]);
            } catch (error) {
              send({
                event: "pipe-command-failure",
                message: error.message,
                category: error.category,
              });
            }
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
} else if (mode === "trace-copy-image") {
  operations.push(
    (async () => {
      await extractRuntime(image, "/PRIVATE_TARGET");
      await docker(["image", "rm", "--no-prune", "PRIVATE_IMAGE"], {
        trace: { stage: "runtime-mutation-image-remove", context: "finalizer" },
      });
    })(),
  );
} else {
  if (mode === "trace-invalid") {
    for (const trace of [
      { stage: "PRIVATE_STAGE", context: "body" },
      { stage: "runtime-execute", context: "PRIVATE_CONTEXT" },
      { stage: "runtime-execute", source: "PRIVATE_SOURCE" },
      { stage: "runtime-execute", error: "PRIVATE_ERROR" },
    ]) {
      try {
        await docker(["version", "PRIVATE_ARGUMENT"], { trace });
        send({ event: "validation", ok: true });
      } catch (error) {
        send({ event: "validation", ok: false, message: error.message });
      }
    }
  }
  if (mode === "trace-metadata") {
    const [location, kind] = count.split(":");
    const options =
      location === "outer"
        ? executableMetadata(kind, "trace", { stage: "runtime-execute" })
        : { trace: executableMetadata(kind, "stage", "runtime-execute") };
    for (const boundary of ["docker", "runRuntime"]) {
      try {
        if (boundary === "docker") await docker(["version"], options);
        else await runRuntime(image, "PRIVATE_METADATA_DRIVER", options);
        send({ event: "validation", boundary, ok: true });
      } catch (error) {
        send({
          event: "validation",
          boundary,
          ok: false,
          message: error.message,
        });
      }
    }
    send({ event: "metadata-observations", calls: metadataCalls });
  }
  for (let i = 0; i < (mode.startsWith("trace-") ? 1 : Number(count)); i++) {
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
    else
      operations.push(
        runRuntime(image, "PRIVATE_DRIVER", {
          env: ["PRIVATE_ENV=PRIVATE_CREDENTIAL"],
        }),
      );
  }
}
if (mode === "command") operations.push(docker(["version"]));
// Catch only to report the operation result, not to defer its settlement.
// Exiting here deliberately exposes a rejection beating cancellation's drain.
try {
  const values = await Promise.all(operations);
  send({ event: "result", ok: true, values });
} catch (error) {
  if (workspaceParent && traceConfig) process.exitCode = 1;
  send({
    event: "result",
    ok: false,
    message: error.message,
    ...(error.category === undefined ? {} : { category: error.category }),
    ...(error.stage === undefined ? {} : { stage: error.stage }),
  });
} finally {
  if (traceConfig) {
    await new Promise((resolve) => setImmediate(resolve));
    send({ event: "trace-status", ...qualificationTraceStatus() });
    if (["trace-blocking-sink", "trace-file-sink"].includes(mode))
      send({ event: "sink-writes", count: sinkWrites });
  }
  mock.restoreAll();
  mock.timers.reset();
  syncBuiltinESMExports();
  process.disconnect();
}
