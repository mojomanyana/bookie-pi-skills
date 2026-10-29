import { execFile, fork } from "node:child_process";
import { opendir, readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type {
  FilesystemSearchFilters,
  InspectConceptResult,
  InspectConceptSelector,
  SearchVaultResult,
  ValidateVaultResult,
} from "@bookie/core";

export type ReadOperation =
  | {
      readonly command: "validate";
      readonly vault: string;
      readonly baseRef?: string;
    }
  | {
      readonly command: "search";
      readonly vault: string;
      readonly request: {
        readonly query: string;
        readonly filters?: FilesystemSearchFilters;
      };
    }
  | {
      readonly command: "inspect";
      readonly vault: string;
      readonly selector: InspectConceptSelector;
    };
interface OperationResults {
  validate: ValidateVaultResult;
  search: SearchVaultResult;
  inspect: InspectConceptResult;
}
export class OperationError extends Error {}

function data(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function count(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function nullableText(value: unknown): boolean {
  return value === null || typeof value === "string";
}
function source(value: unknown): boolean {
  return (
    data(value) &&
    typeof value.path === "string" &&
    value.state === "working-tree" &&
    value.commit === null &&
    typeof value.sourceHash === "string"
  );
}
function signals(value: Record<string, unknown>): boolean {
  return (
    ["type", "uid", "status"].every((key) => typeof value[key] === "string") &&
    nullableText(value.project) &&
    nullableText(value.state) &&
    nullableText(value.staleAfter) &&
    data(value.sensitivity) &&
    nullableText(value.sensitivity.value) &&
    ["missing", "declared", "undeclared", "excluded"].includes(
      String(value.sensitivity.classification),
    ) &&
    ["present", "absent"].includes(String(value.verification)) &&
    value.untrusted === true
  );
}

// Decode the private transport before formatting. Canonical policy remains in core.
function readResult<C extends ReadOperation["command"]>(
  command: C,
  value: unknown,
): OperationResults[C] {
  if (
    !data(value) ||
    typeof value.root !== "string" ||
    typeof value.complete !== "boolean" ||
    typeof value.diagnosticsTruncated !== "boolean" ||
    !Array.isArray(value.diagnostics) ||
    !value.diagnostics.every(
      (diagnostic: unknown) =>
        data(diagnostic) &&
        diagnostic.severity === "error" &&
        ["code", "file", "message", "remediation"].every(
          (key) => typeof diagnostic[key] === "string",
        ),
    )
  )
    throw new OperationError();
  let valid: boolean;
  if (command === "validate") {
    valid =
      typeof value.valid === "boolean" &&
      typeof value.immutablePolicyViolation === "boolean" &&
      (value.baseCommit === undefined || typeof value.baseCommit === "string");
  } else if (command === "search") {
    valid =
      value.mode === "filesystem" &&
      count(value.matchedCount) &&
      count(value.rejectedConcepts) &&
      typeof value.resultsTruncated === "boolean" &&
      typeof value.outputTruncated === "boolean" &&
      Array.isArray(value.results) &&
      value.results.every(
        (hit: unknown) =>
          data(hit) &&
          signals(hit) &&
          source(hit.source) &&
          typeof hit.title === "string" &&
          typeof hit.excerpt === "string" &&
          typeof hit.titleTruncated === "boolean" &&
          typeof hit.excerptTruncated === "boolean" &&
          (hit.matchedField === "title" || hit.matchedField === "body"),
      );
  } else {
    valid =
      value.mode === "filesystem" &&
      count(value.rejectedConcepts) &&
      (value.ok === false
        ? [
            "invalid-selector",
            "not-found",
            "ambiguous",
            "invalid-concept",
            "incomplete",
          ].includes(String(value.reason))
        : value.ok === true &&
          value.complete === true &&
          value.diagnosticsTruncated === false &&
          signals(value) &&
          source(value.source) &&
          typeof value.sourceText === "string" &&
          count(value.sourceByteLength) &&
          count(value.returnedByteLength) &&
          typeof value.sourceTruncated === "boolean" &&
          (value.handling === "ordinary" || value.handling === "excluded"));
  }
  if (!valid) throw new OperationError();
  // IPC can represent cycles/BigInts, but the CLI's public machine output cannot.
  try {
    JSON.stringify(value);
  } catch {
    throw new OperationError();
  }
  return value as unknown as OperationResults[C];
}

function hasCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === code
  );
}

// POSIX group disappearance proves cleanup. Linux also distinguishes dead zombies
// from executing descendants; a leader's close event alone never proves teardown.
async function groupIsRunning(
  group: number,
  expired: () => boolean,
): Promise<boolean> {
  try {
    process.kill(-group, 0);
  } catch (error) {
    if (hasCode(error, "ESRCH")) return false;
    throw error;
  }
  if (process.platform !== "linux") return true;
  let entries = 0;
  let observed = false;
  for await (const entry of await opendir("/proc")) {
    if (expired() || ++entries > 100_000) throw new OperationError();
    if (!/^[0-9]+$/u.test(entry.name)) continue;
    let stat: string;
    try {
      stat = await readFile(`/proc/${entry.name}/stat`, "utf8");
    } catch (error) {
      if (hasCode(error, "ENOENT") || hasCode(error, "ESRCH")) continue;
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
      throw new OperationError();
    if (Number(processGroup) === group) {
      observed = true;
      if (state !== "Z" && state !== "X") return true;
    }
  }
  if (observed) return false;
  try {
    process.kill(-group, 0);
  } catch (error) {
    if (hasCode(error, "ESRCH")) return false;
    throw error;
  }
  throw new OperationError(); // Opaque /proc is not proof of disappearance.
}

export async function runReadOperation<C extends ReadOperation["command"]>(
  input: Extract<ReadOperation, { readonly command: C }>,
  options: { readonly signal: AbortSignal; readonly timeoutMs: number },
): Promise<OperationResults[C]> {
  const { signal, timeoutMs } = options;
  signal.throwIfAborted();
  let child: ReturnType<typeof fork>;
  try {
    child = fork(new URL("./operation-worker.js", import.meta.url), [], {
      detached: process.platform !== "win32",
      execArgv: [],
      serialization: "advanced",
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
  } catch {
    throw new OperationError();
  }
  return new Promise((resolve, reject) => {
    let finishing = false;
    let settled = false;
    let closed = false;
    let checking = false;
    let treeKilled = process.platform !== "win32";
    let failure: Error | undefined;
    let result: OperationResults[C] | undefined;
    let teardownTimer: ReturnType<typeof setTimeout> | undefined;
    const settle = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(teardownTimer);
      if (error !== undefined || failure !== undefined) {
        // Terminal uncertainty must not pin the CLI alive. This releases only parent
        // references; it does not assert that an unkillable descendant was stopped.
        child.channel?.unref();
        child.unref();
        try {
          if (child.connected) child.disconnect();
        } catch {
          // Failure is already explicit; a late/broken IPC close cannot replace it.
        }
      }
      if (error !== undefined) reject(error);
      else if (failure !== undefined) reject(failure);
      else if (result === undefined) reject(new OperationError());
      else resolve(result);
    };
    const confirm = async (): Promise<void> => {
      if (settled || checking || !closed || !treeKilled) return;
      checking = true;
      try {
        while (
          !settled &&
          child.pid !== undefined &&
          process.platform !== "win32" &&
          (await groupIsRunning(child.pid, () => settled))
        )
          await delay(10);
        if (!settled) settle();
      } catch {
        settle(new OperationError());
      }
    };
    const finish = (error?: Error): void => {
      if (finishing) return;
      finishing = true;
      failure = error;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      teardownTimer = setTimeout(() => settle(new OperationError()), 1000);
      if (child.pid !== undefined) {
        if (process.platform === "win32") {
          // Fixed OS teardown command only; never shell or caller-derived commands.
          execFile(
            "taskkill",
            ["/PID", String(child.pid), "/T", "/F"],
            { timeout: 1000, windowsHide: true },
            (error) => {
              if (error !== null) settle(new OperationError());
              else {
                treeKilled = true;
                void confirm();
              }
            },
          );
        } else {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch (error) {
            if (!hasCode(error, "ESRCH")) {
              settle(new OperationError());
              return;
            }
          }
        }
      } else treeKilled = true;
      void confirm();
    };
    const onAbort = (): void =>
      finish(new DOMException("CLI operation cancelled.", "AbortError"));
    const timer = setTimeout(() => finish(new OperationError()), timeoutMs);
    child.once("error", () => finish(new OperationError()));
    child.once("close", () => {
      closed = true;
      if (!finishing) finish(new OperationError());
      else void confirm();
    });
    child.once("message", (value: unknown) => {
      if (
        !data(value) ||
        value.command !== input.command ||
        Object.keys(value).some(
          (key) =>
            ![
              "kind",
              "command",
              ...(value.kind === "result" ? ["result"] : []),
            ].includes(key),
        )
      ) {
        finish(new OperationError());
        return;
      }
      if (value.kind === "invocation") {
        finish(new TypeError("Invalid operation options."));
        return;
      }
      if (value.kind !== "result") {
        finish(new OperationError());
        return;
      }
      try {
        result = readResult(input.command, value.result);
        finish();
      } catch {
        finish(new OperationError());
      }
    });
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    else {
      try {
        child.send(input, (error) => {
          if (error !== null) finish(new OperationError());
        });
      } catch {
        finish(new OperationError());
      }
    }
  });
}
