// Test-only parser fault injection via Node's ordinary preload facility. No product bypass.
import { createRequire, syncBuiltinESMExports } from "node:module";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import childProcess, { spawn } from "node:child_process";
import { join } from "node:path";

if (process.env.BOOKIE_TEST_FAULT === "start") {
  childProcess.fork = () => {
    throw new Error("PRIVATE-START-ERROR");
  };
  syncBuiltinESMExports();
}
if (process.env.BOOKIE_TEST_FAULT === "kill-denied") {
  const kill = process.kill;
  process.kill = function (pid, signal) {
    if (pid < 0 && signal === "SIGKILL")
      throw Object.assign(new Error("PRIVATE-KILL-REFUSAL"), { code: "EPERM" });
    return Reflect.apply(kill, this, [pid, signal]);
  };
}
if (process.env.BOOKIE_TEST_FAULT === "no-close") {
  const fork = childProcess.fork;
  childProcess.fork = function (...args) {
    const child = Reflect.apply(fork, this, args);
    const emit = child.emit;
    child.emit = function (event, ...values) {
      if (event === "close") return true;
      return Reflect.apply(emit, this, [event, ...values]);
    };
    return child;
  };
  syncBuiltinESMExports();
}
if (process.env.BOOKIE_TEST_FAULT === "protocol" && process.send) {
  const send = process.send;
  process.send = function (message, ...args) {
    return Reflect.apply(send, this, [
      message?.kind === "result"
        ? JSON.parse(process.env.BOOKIE_TEST_REPLY)
        : message,
      ...args,
    ]);
  };
}
const requireCore = createRequire(
  join(process.env.BOOKIE_TEST_CORE, "package.json"),
);
const yaml = requireCore("yaml");
const parseDocument = yaml.parseDocument;
yaml.parseDocument = function (source, ...args) {
  if (source.includes("BOOKIE-PARSER-CONTROL")) {
    const acknowledgement = `${process.env.BOOKIE_TEST_MARKER}.descendant`;
    const descendant = spawn(
      process.execPath,
      [
        "-e",
        `
      const { spawn } = require('node:child_process');
      const git = spawn('git', ['hash-object', '--stdin'], { stdio: ['pipe', 'ignore', 'ignore'] });
      git.once('spawn', () => require('node:fs').writeFileSync(${JSON.stringify(acknowledgement)}, JSON.stringify({ descendant: process.pid, git: git.pid })));
      setInterval(() => {}, 1000);
    `,
      ],
      { stdio: "ignore", env: { PATH: process.env.PATH } },
    );
    const until = Date.now() + 5000;
    while (!existsSync(acknowledgement)) {
      if (Date.now() > until)
        throw new Error("fixture descendant did not start");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
    const owned = JSON.parse(readFileSync(acknowledgement, "utf8"));
    if (owned.descendant !== descendant.pid)
      throw new Error("fixture identity mismatch");
    writeFileSync(
      process.env.BOOKIE_TEST_MARKER,
      JSON.stringify({ parser: process.pid, ...owned }),
    );
    if (process.env.BOOKIE_TEST_FAULT === "crash") process.exit(17);
    // Synchronous and deliberately uninterruptible on this JS event loop.
    while (true)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  }
  return parseDocument.call(this, source, ...args);
};
