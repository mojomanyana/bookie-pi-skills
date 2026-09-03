import { dirname, relative, resolve, sep } from "node:path";
import { Worker } from "node:worker_threads";

import { throwIfAborted } from "./vault-cancellation.js";
import {
  analyzeMarkdown,
  type MarkdownAnalysis,
} from "./vault-markdown-analysis.js";
import { createDiagnostic, DiagnosticCollector } from "./vault-diagnostics.js";
import type { VaultEntries } from "./vault-model.js";

const MAX_MARKDOWN_CONTAINER_DEPTH = 256;
const MARKDOWN_WORKER_DEADLINE_MILLISECONDS = 5_000;

function hasSuspiciousContainerComplexity(body: string): boolean {
  let markerCount = 0;
  for (const line of body.split("\n")) {
    let indentationIndex = 0;
    let indentationColumns = 0;
    while (indentationIndex < line.length) {
      if (line[indentationIndex] === " ") indentationColumns += 1;
      else if (line[indentationIndex] === "\t") {
        indentationColumns += 4 - (indentationColumns % 4);
      } else break;
      indentationIndex += 1;
    }
    const indented = line.slice(indentationIndex);
    if (
      indentationColumns > MAX_MARKDOWN_CONTAINER_DEPTH * 2 &&
      /^(?:>|[+*-](?:[ \t]|$)|\d{1,9}[.)](?:[ \t]|$))/u.test(indented)
    ) {
      return true;
    }
    for (const _match of line.matchAll(
      /(?:^|[ \t])(?:>|[+*-](?=[ \t]|$)|\d{1,9}[.)](?=[ \t]|$))/gu,
    )) {
      void _match;
      markerCount += 1;
      if (markerCount > 1_024) return true;
    }
  }
  return false;
}

async function analyzeMarkdownInWorker(
  body: string,
  signal: AbortSignal | undefined,
): Promise<MarkdownAnalysis | undefined> {
  throwIfAborted(signal);
  const worker = new Worker(
    new URL("./vault-markdown-worker.js", import.meta.url),
  );
  return await new Promise<MarkdownAnalysis | undefined>((resolve, reject) => {
    let settled = false;
    const finish = (
      result: MarkdownAnalysis | undefined,
      error?: unknown,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      void worker.terminate();
      if (error === undefined) resolve(result);
      else reject(error);
    };
    const onAbort = (): void => {
      try {
        throwIfAborted(signal);
      } catch (error) {
        finish(undefined, error);
      }
    };
    const timer = setTimeout(
      () => finish(undefined),
      MARKDOWN_WORKER_DEADLINE_MILLISECONDS,
    );
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.once("message", (message: unknown) => {
      if (
        message !== null &&
        typeof message === "object" &&
        "ok" in message &&
        message.ok === true &&
        "analysis" in message
      ) {
        finish(message.analysis as MarkdownAnalysis);
      } else {
        finish(undefined);
      }
    });
    worker.once("error", () => finish(undefined));
    worker.once("exit", (code) => {
      if (code !== 0) finish(undefined);
    });
    worker.postMessage(body);
  });
}

function isInside(root: string, target: string): boolean {
  const pathFromRoot = relative(root, target);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== "..")
  );
}

function localLinkTarget(
  destination: string,
  sourceHostPath: string,
  root: string,
): string | undefined | null {
  if (
    destination === "" ||
    destination.startsWith("#") ||
    destination.startsWith("?") ||
    destination.startsWith("//") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(destination)
  ) {
    return undefined;
  }

  const encodedPath = destination.split(/[?#]/u, 1)[0] ?? "";
  if (encodedPath === "") return undefined;
  if (/%(?:2f|5c)/iu.test(encodedPath)) return null;
  let path: string;
  try {
    path = decodeURIComponent(encodedPath);
  } catch {
    return null;
  }
  if (path.includes("\0") || path.includes("\\")) return null;

  const target = path.startsWith("/")
    ? resolve(root, `.${path}`)
    : resolve(dirname(sourceHostPath), path);
  if (!isInside(root, target)) return null;
  return relative(root, target).split(sep).join("/").replace(/\/$/u, "");
}

export async function analyzeBoundedMarkdown(
  body: string,
  signal: AbortSignal | undefined,
): Promise<MarkdownAnalysis | undefined> {
  let analysis: MarkdownAnalysis | undefined;
  try {
    analysis = hasSuspiciousContainerComplexity(body)
      ? await analyzeMarkdownInWorker(body, signal)
      : analyzeMarkdown(body);
  } catch (error) {
    throwIfAborted(signal);
    void error;
  }
  throwIfAborted(signal);
  return analysis !== undefined &&
    analysis.maximumContainerDepth <= MAX_MARKDOWN_CONTAINER_DEPTH
    ? analysis
    : undefined;
}

export async function validateMarkdownLinks(
  body: string,
  sourceHostPath: string,
  displayFile: string,
  root: string,
  entries: VaultEntries,
  collector: DiagnosticCollector,
  signal: AbortSignal | undefined,
  onLocalTarget?: (target: string) => void,
): Promise<void> {
  const analysis = await analyzeBoundedMarkdown(body, signal);
  if (analysis === undefined) {
    collector.add(createDiagnostic("MARKDOWN-LINK", displayFile));
    collector.markIncomplete();
    return;
  }

  for (const destination of analysis.destinations) {
    const target = localLinkTarget(destination, sourceHostPath, root);
    if (target === undefined) continue;
    if (typeof target === "string") onLocalTarget?.(`/${target}`);
    if (
      target === null ||
      (!entries.regularFiles.has(target) && !entries.directories.has(target))
    ) {
      collector.add(createDiagnostic("MARKDOWN-LINK", displayFile));
    }
  }
}
