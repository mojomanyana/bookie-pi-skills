#!/usr/bin/env node

import { inspectConcept, searchVault, validateVault } from "@bookie/core";
import type { VaultDiagnostic } from "@bookie/core";

const invocationMessage = "CLI-INVOCATION: Invalid command invocation.\n";
const cancelledMessage = "CLI-CANCELLED: Operation cancelled.\n";
const operationMessage =
  "CLI-OPERATION: Operation could not complete safely.\n";
const deferredCommands = new Set([
  "init",
  "create",
  "amend",
  "evidence",
  "export",
]);

class InvocationError extends Error {}

function requirePair(
  args: readonly string[],
  offset: number,
  name: string,
): string {
  if (args[offset] !== `--${name}`) throw new InvocationError();
  const value = args[offset + 1];
  if (value === undefined || value.length === 0 || value.startsWith("--")) {
    throw new InvocationError();
  }
  return value;
}

function parseOrderedOptions(
  args: readonly string[],
  offset: number,
  names: readonly string[],
): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  let previous = -1;
  for (let index = offset; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (
      flag === undefined ||
      value === undefined ||
      !flag.startsWith("--") ||
      value.length === 0 ||
      value.startsWith("--")
    ) {
      throw new InvocationError();
    }
    const name = flag.slice(2);
    const order = names.indexOf(name);
    if (order <= previous || values.has(name)) throw new InvocationError();
    values.set(name, value);
    previous = order;
  }
  return values;
}

function json(command: string, result: object): void {
  process.stdout.write(`${JSON.stringify({ command, ...result })}\n`);
}

function diagnostics(values: readonly VaultDiagnostic[]): void {
  for (const diagnostic of values) {
    process.stderr.write(
      `${diagnostic.code} ${diagnostic.file}: ${diagnostic.message}\n`,
    );
  }
}

async function validateCommand(
  args: readonly string[],
  signal: AbortSignal,
): Promise<number> {
  const vault = requirePair(args, 0, "vault");
  const options = parseOrderedOptions(args, 2, ["base", "format"]);
  const format = options.get("format") ?? "text";
  if (format !== "text" && format !== "json") throw new InvocationError();
  const baseRef = options.get("base");
  const result = await validateVault(vault, {
    signal,
    ...(baseRef === undefined ? {} : { baseRef }),
  });
  if (format === "json") json("validate", result);
  else if (result.valid) process.stdout.write("Vault is valid.\n");
  if (!result.valid) diagnostics(result.diagnostics);
  if (result.valid) return 0;
  return result.immutablePolicyViolation ? 3 : 1;
}

function inertTextField(value: string): string {
  return JSON.stringify(value)
    .slice(1, -1)
    .replace(
      /[\u007f-\u009f\u2028\u2029]/gu,
      (character) =>
        `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
}

async function searchCommand(
  args: readonly string[],
  signal: AbortSignal,
): Promise<number> {
  const vault = requirePair(args, 0, "vault");
  const separator = args[2] === "--";
  const query = args[separator ? 3 : 2];
  if (
    query === undefined ||
    query.length === 0 ||
    (separator && args.length < 4) ||
    (!separator && query.startsWith("--"))
  ) {
    throw new InvocationError();
  }
  const filterNames = [
    "type",
    "project",
    "status",
    "state",
    "sensitivity",
    "tag",
    "format",
  ] as const;
  const options = parseOrderedOptions(args, separator ? 4 : 3, filterNames);
  const format = options.get("format") ?? "text";
  if (format !== "text" && format !== "json") throw new InvocationError();
  const filters: Record<string, string> = {};
  for (const name of filterNames.slice(0, -1)) {
    const value = options.get(name);
    if (value !== undefined) filters[name] = value;
  }
  const result = await searchVault(
    vault,
    {
      query,
      ...(Object.keys(filters).length === 0 ? {} : { filters }),
    },
    { signal },
  );
  if (format === "json") json("search", result);
  else {
    for (const hit of result.results) {
      process.stdout.write(
        `${hit.source.path}\t${inertTextField(hit.title)}\n`,
      );
    }
    if (result.results.length === 0 && result.complete) {
      process.stdout.write("No matches.\n");
    }
  }
  if (format === "text" && result.resultsTruncated) {
    process.stderr.write("CLI-TRUNCATED: Search result limit reached.\n");
  }
  if (format === "text" && result.outputTruncated) {
    process.stderr.write("CLI-TRUNCATED: Search text limit reached.\n");
  }
  if (!result.complete || result.diagnostics.length > 0) {
    diagnostics(result.diagnostics);
  }
  return result.complete ? 0 : 1;
}

async function inspectCommand(
  args: readonly string[],
  signal: AbortSignal,
): Promise<number> {
  const vault = requirePair(args, 0, "vault");
  const selectorName = args[2];
  if (selectorName !== "--uid" && selectorName !== "--path") {
    throw new InvocationError();
  }
  const selectorValue = args[3];
  if (
    selectorValue === undefined ||
    selectorValue.length === 0 ||
    selectorValue.startsWith("--")
  ) {
    throw new InvocationError();
  }
  const options = parseOrderedOptions(args, 4, ["format"]);
  const format = options.get("format") ?? "yaml";
  if (format !== "yaml" && format !== "json") throw new InvocationError();
  const result = await inspectConcept(
    vault,
    selectorName === "--uid" ? { uid: selectorValue } : { path: selectorValue },
    { signal },
  );
  if (format === "json") json("inspect", result);
  else if (result.ok) process.stdout.write(result.sourceText);
  if (!result.ok) diagnostics(result.diagnostics);
  return result.ok ? 0 : 1;
}

async function run(
  args: readonly string[],
  signal: AbortSignal,
): Promise<number> {
  const command = args[0];
  if (command === undefined || deferredCommands.has(command)) {
    throw new InvocationError();
  }
  if (command === "validate") return validateCommand(args.slice(1), signal);
  if (command === "search") return searchCommand(args.slice(1), signal);
  if (command === "inspect") return inspectCommand(args.slice(1), signal);
  throw new InvocationError();
}

const controller = new AbortController();
for (const event of ["SIGINT", "SIGTERM"] as const) {
  process.once(event, () => controller.abort(new Error("cancelled")));
}

try {
  process.exitCode = await run(process.argv.slice(2), controller.signal);
} catch (error) {
  if (controller.signal.aborted) {
    process.stderr.write(cancelledMessage);
    process.exitCode = 1;
  } else if (error instanceof InvocationError || error instanceof TypeError) {
    process.stderr.write(invocationMessage);
    process.exitCode = 2;
  } else {
    process.stderr.write(operationMessage);
    process.exitCode = 1;
  }
}
