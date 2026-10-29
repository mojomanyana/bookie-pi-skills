import { fork } from "node:child_process";
import { opendir, readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

export type IsolationFailure = Readonly<{
  ok: false;
  reason: "ingestion-error" | "deadline-exceeded";
}>;
const failed = { ok: false, reason: "ingestion-error" } as const;
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// A leader's close event does not acknowledge its descendants. SIGKILL prevents new
// user-space work; on the supported Linux profile, exclude only dead/zombie members.
async function groupIsRunning(
  group: number,
  stopped: () => boolean,
): Promise<boolean> {
  try {
    process.kill(-group, 0);
  } catch (error) {
    if (object(error) && error.code === "ESRCH") return false;
    throw error;
  }
  if (process.platform !== "linux") return true; // No unproved teardown claim.
  let entries = 0;
  let observed = false;
  for await (const entry of await opendir("/proc")) {
    if (stopped() || ++entries > 100_000)
      throw new Error("Teardown unconfirmed.");
    if (!/^[0-9]+$/u.test(entry.name)) continue;
    let stat: string;
    try {
      stat = await readFile(`/proc/${entry.name}/stat`, "utf8");
    } catch (error) {
      if (object(error) && (error.code === "ENOENT" || error.code === "ESRCH"))
        continue;
      throw error;
    }
    const end = stat.lastIndexOf(")");
    const [state, , processGroup] = stat.slice(end + 2).split(" ");
    if (
      end < 0 ||
      state === undefined ||
      processGroup === undefined ||
      !/^[0-9]+$/u.test(processGroup)
    )
      throw new Error("Teardown unconfirmed.");
    if (Number(processGroup) === group) {
      observed = true;
      if (state !== "Z" && state !== "X") return true;
    }
  }
  if (observed) return false;
  // No visible member is not proof of disappearance (e.g. an opaque procfs view).
  try {
    process.kill(-group, 0);
  } catch (error) {
    if (object(error) && error.code === "ESRCH") return false;
    throw error;
  }
  throw new Error("Teardown unconfirmed.");
}

/** Internal transport for trusted ingestion/preflight/builder modes. Callers snapshot inputs. */
export async function runIngestionProcess<Result>(
  input: Readonly<Record<string, unknown>>,
  options: Readonly<{
    timeoutMs: number;
    signal?: AbortSignal;
    decode: (value: unknown) => Result;
  }>,
): Promise<Result | IsolationFailure> {
  const { signal, timeoutMs, decode } = options;
  if (signal?.aborted)
    throw new DOMException("Ingestion cancelled.", "AbortError");
  if (process.platform === "win32") return failed;
  const environment = { ...process.env };
  delete environment.NODE_OPTIONS;
  delete environment.NODE_PATH;
  let child: ReturnType<typeof fork>;
  try {
    child = fork(new URL("./ingestion-process.js", import.meta.url), [], {
      detached: true,
      execArgv: ["--max-old-space-size=1024"],
      env: environment,
      serialization: "advanced",
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
  } catch {
    return failed;
  }
  return await new Promise((resolve, reject) => {
    let finishing = false;
    let settled = false;
    let checking = false;
    let closed = false;
    let aborted = false;
    let result: Result | IsolationFailure = failed;
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    const settle = async (): Promise<void> => {
      if (settled || checking) return;
      checking = true;
      try {
        while (
          !settled &&
          child.pid !== undefined &&
          (await groupIsRunning(child.pid, () => settled))
        )
          await delay(10);
        if (settled) return;
        settled = true;
        clearTimeout(stopTimer);
        if (aborted)
          reject(new DOMException("Ingestion cancelled.", "AbortError"));
        else resolve(result);
      } catch {
        if (settled) return;
        settled = true;
        clearTimeout(stopTimer);
        resolve(failed);
      }
    };
    const finish = (
      value: Result | IsolationFailure,
      cancellation = false,
    ): void => {
      if (finishing) return;
      finishing = true;
      result = value;
      aborted = cancellation;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      // A missing teardown acknowledgement is uncertainty, never cleanup success.
      stopTimer = setTimeout(() => {
        settled = true;
        resolve(failed);
      }, 1000);
      // The detached group owns parsing and all non-detached Git descendants.
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if (!object(error) || error.code !== "ESRCH") {
            result = failed;
            aborted = false;
            try {
              child.kill("SIGKILL");
            } catch {
              /* Already reported as ingestion-error. */
            }
          }
        }
      }
      if (closed) void settle();
    };
    const onAbort = (): void => finish(failed, true);
    const timer = setTimeout(
      () => finish({ ok: false, reason: "deadline-exceeded" }),
      timeoutMs,
    );
    child.once("error", () => finish(failed));
    child.once("message", (value: unknown) => finish(decode(value)));
    child.once("close", () => {
      closed = true;
      if (!finishing) finish(failed);
      else void settle();
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    else {
      try {
        child.send(input, (error) => {
          if (error !== null) finish(failed);
        });
      } catch {
        finish(failed);
      }
    }
  });
}
