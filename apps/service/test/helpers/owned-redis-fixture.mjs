// Exact disposable fixture only. Owner registration precedes directory/setup/run
// dispatch; permissions are provisioned before use, never repaired after signal.
import { connect } from "node:net";
import { watch } from "node:fs";
import { lstat, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { docker, registerFixture } from "../../scripts/qualify-runtime.mjs";
import { socketExecutor } from "./redis-socket.mjs";

export const redisImage =
  "redis:8.2.1-alpine@sha256:987c376c727652f99625c7d205a1cba3cb2c53b92b0b62aade2bd48ee1593232";
const nodeImage =
  "node:24.19.0-bookworm@sha256:4196d66a565c6f195728d9952f161f4adfe2ad753052a08b7ec7f1c5a6bda42b";
export async function ownedRedisFixture(parent) {
  const directory = join(parent, `r-${randomBytes(8).toString("hex")}`);
  // Linux sockaddr_un includes the terminating NUL; fail before allocation.
  if (Buffer.byteLength(join(directory, "redis.sock")) > 107)
    throw Error("Redis fixture socket path invalid.");
  let transport;
  const owner = registerFixture({
    closeClients: async () => {
      await transport?.close();
    },
    removeDirectory: async (signal) => {
      if (signal.aborted) throw Error("Redis fixture teardown unconfirmed.");
      await rm(directory, { recursive: true });
    },
  });
  let watcher, timer;
  try {
    await mkdir(directory, { mode: 0o770 });
    await docker([
      "run",
      "--rm",
      "--network",
      "none",
      "--mount",
      `type=bind,src=${directory},dst=/fixture`,
      "--entrypoint",
      "/bin/sh",
      nodeImage,
      "-c",
      `chown 65534:${process.getgid()} /fixture; chmod 770 /fixture`,
    ]);
    const socket = join(directory, "redis.sock");
    const ready = new Promise((resolve, reject) => {
      const inspect = () => {
        void lstat(socket).then(
          (info) => {
            if (info.isSocket()) resolve();
            else reject(Error("Redis fixture setup failed."));
          },
          (error) => {
            if (error.code !== "ENOENT")
              reject(Error("Redis fixture setup failed."));
          },
        );
      };
      watcher = watch(directory, inspect);
      watcher.on("error", () => reject(Error("Redis fixture setup failed.")));
      timer = setTimeout(
        () => reject(Error("Redis fixture setup failed.")),
        2000,
      );
      inspect();
    });
    // Keep readiness rejection handled while the bounded engine client settles.
    void ready.catch(() => undefined);
    await docker([
      "run",
      "-d",
      "--name",
      owner.name,
      "--network",
      "none",
      "--read-only",
      "--user",
      `65534:${process.getgid()}`,
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--memory",
      "256m",
      "--cpus",
      "2",
      "--pids-limit",
      "64",
      "--tmpfs",
      "/data:rw,noexec,nosuid,size=16m",
      "--mount",
      `type=bind,src=${directory},dst=/fixture`,
      redisImage,
      "redis-server",
      "--port",
      "0",
      "--unixsocket",
      "/fixture/redis.sock",
      "--unixsocketperm",
      "770",
      "--save",
      "",
      "--appendonly",
      "no",
    ]);
    await ready;
    transport = socketExecutor(connect, socket);
    if ((await transport.execute(["PING"])) !== "PONG")
      throw Error("Redis fixture setup failed.");
    return {
      name: owner.name,
      directory,
      mount: `type=bind,src=${directory},dst=/redis-fixture`,
      execute: transport.execute,
      finish: owner.finish,
    };
  } catch {
    await owner.finish();
    throw Error("Redis fixture setup failed.");
  } finally {
    watcher?.close();
    clearTimeout(timer);
  }
}
