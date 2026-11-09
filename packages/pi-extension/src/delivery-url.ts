import type { Nodes } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { containsDetectedSecret } from "pi-bookie-core";

const domainLabel = /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/iu;
const localSuffix =
  /\.(?:alt|arpa|corp|example|home|internal|intranet|invalid|lan|local|localdomain|localhost|onion|private|test)$/iu;
const restrictedSegment =
  /^(?:auth|invite|invites|join|magic-link|password-reset|private|reset-password|secret|share-token|signin|token|tokens)$/iu;
const opaqueSegment =
  /(?:[a-f\d]{24,}|[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}|(?=[a-z\d]{24})(?=[a-z]*\d)[a-z\d]{24,})/iu;

// This is a conservative format for a model-selected public reference, not a
// network reachability or sensitivity classifier. Never resolve or fetch it.
export function isDeliveryUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  const parts = /^https:\/\/([A-Za-z\d.-]+)(\/[A-Za-z\d._~/-]*)?$/u.exec(value);
  if (!parts || !value.startsWith("https://")) return false;
  const host = parts[1]!;
  const labels = host.split(".");
  if (
    host.length > 253 ||
    labels.length < 2 ||
    labels.some(
      (label) =>
        !domainLabel.test(label) ||
        restrictedSegment.test(label) ||
        opaqueSegment.test(label),
    ) ||
    !/^[a-z]{2,63}$/iu.test(labels.at(-1)!) ||
    localSuffix.test(host)
  )
    return false;
  const path = parts[2] || "";
  return (
    !path.includes("//") &&
    !path
      .split("/")
      .some(
        (segment) =>
          segment.startsWith(".") ||
          restrictedSegment.test(segment) ||
          opaqueSegment.test(segment),
      ) &&
    !containsDetectedSecret(value)
  );
}

function hasBareLink(value: string, url: string) {
  for (const match of value.matchAll(
    /(?:^|[\s("'“‘])(https:\/\/[^\s<>"“”‘’']+)/gu,
  )) {
    if (match[1]!.replace(/[.,;:!?)\]}]+$/u, "") === url) return true;
  }
  return false;
}

export function mentionsDeliveryUrl(text: string, url: string): boolean {
  if (!isDeliveryUrl(url) || text.length > 65536 || !text.includes(url))
    return false;
  // Limit parser work on pathological nesting (a short string can contain
  // thousands of list markers). A normal handoff usually has a few links.
  if ((text.match(/[*.#_+>\-=()[\]\x60]/gu)?.length ?? 0) > 512) return false;
  const references = new Set<string>();
  const definitions = new Map<string, string>();
  let found = false;
  function inspect(node: Nodes): string {
    switch (node.type) {
      case "definition":
        if (!definitions.has(node.identifier))
          definitions.set(node.identifier, node.url);
        break;
      case "linkReference":
        references.add(node.identifier);
        break;
      case "link":
        if (node.url === url) found = true;
        break;
      case "text":
        return node.value;
      case "break":
        return "\n";
      default:
        if (
          "children" in node &&
          !node.children.some((child) => child.type === "html")
        ) {
          const plain = node.children.map(inspect).join("");
          if (node.type === "paragraph" || node.type === "heading") {
            if (hasBareLink(plain, url)) found = true;
          } else return plain;
        }
    }
    // A bare link must not continue through excluded or non-text content.
    return "\uFFFC";
  }
  try {
    inspect(fromMarkdown(text));
    return found || [...references].some((id) => definitions.get(id) === url);
  } catch {
    return false;
  }
}
