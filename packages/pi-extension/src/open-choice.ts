import { fromMarkdown } from "mdast-util-from-markdown";
import { containsDetectedSecret } from "pi-bookie-core";

const emptySection = "No additional information recorded.";
const headings = [
  "Outcome",
  "Changed artifacts",
  "Decisions",
  "Evidence",
  "Validation",
  "Unresolved work",
  "Next action",
  "Source session",
];

export function validOpenChoice(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 240 &&
    !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) &&
    !/^(?:none|n\/a|nothing(?: recorded)?|no additional information recorded|omitted by sensitivity policy)\.?$/iu.test(
      value.trim(),
    ) &&
    !containsDetectedSecret(value)
  );
}

// Only read an explicitly labelled choice in ordinary, first-party prose. Skip
// block quotes, code, links and ambiguous multiple choices.
export function markedOpenChoice(
  text: string,
  legacySummary = false,
): string | undefined {
  if (
    text.length > 65536 ||
    !/open(?: choice)?:/iu.test(text) ||
    (text.match(/[*.#_+>\-=()[\]\x60]/gu)?.length ?? 0) > 512
  )
    return;
  const matches = new Set<string>();
  for (const block of fromMarkdown(text).children) {
    if (block.type !== "paragraph") continue;
    const content: string[] = [];
    for (const part of block.children) {
      if (part.type === "text") content.push(part.value);
      else if (
        part.type === "strong" &&
        part.children.every((x) => x.type === "text")
      ) {
        content.push(
          part.children.map((x) => (x.type === "text" ? x.value : "")).join(""),
        );
      } else content.push("\uFFFC");
    }
    for (const line of content.join("").split("\n")) {
      const match = legacySummary
        ? /(?:^|[.!?][ \t]+)Open(?: choice)?:[ \t]+(.+)$/iu.exec(line)
        : /^Open choice:[ \t]+(.+)$/iu.exec(line);
      const choice = match?.[1]?.trim();
      if (!choice) continue;
      if (choice.includes("\uFFFC") || !validOpenChoice(choice)) return;
      matches.add(choice);
    }
  }
  return matches.size === 1 ? [...matches][0] : undefined;
}

// For managed Activity bodies only. Legacy receipts kept an explicit "Open:"
// statement in Outcome. Suppressed or ambiguous sections never supply a choice.
export function choiceFromActivity(body: string): string | undefined {
  if (body.length > 16384) return;
  const parts = body.trim().split(/^# (.+)[\r\n]+/gmu);
  const names = parts.filter((_, index) => index % 2 === 1);
  if (
    parts[0] !== "" ||
    names.length < headings.length - 1 ||
    names.length > headings.length ||
    names.some((name, index) => name !== headings[index])
  )
    return;
  const unresolved = parts[2 + 2 * headings.indexOf("Unresolved work")]?.trim();
  if (unresolved === emptySection)
    return markedOpenChoice(parts[2] ?? "", true);
  return validOpenChoice(unresolved) ? unresolved : undefined;
}
