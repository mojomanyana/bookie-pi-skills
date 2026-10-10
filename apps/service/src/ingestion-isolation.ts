import { fork } from "node:child_process";

export type IsolationFailure = Readonly<{
  ok: false;
  reason: "ingestion-error" | "deadline-exceeded";
}>;
const failed = { ok: false, reason: "ingestion-error" } as const;
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Internal transport for the two trusted child modes. Callers validate/snapshot inputs. */
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
    let closed = false;
    let aborted = false;
    let result: Result | IsolationFailure = failed;
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    const settle = (): void => {
      clearTimeout(stopTimer);
      if (aborted)
        reject(new DOMException("Ingestion cancelled.", "AbortError"));
      else resolve(result);
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
      stopTimer = setTimeout(() => resolve(failed), 1000);
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
      if (closed) settle();
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
      else settle();
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
