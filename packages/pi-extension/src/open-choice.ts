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
export function activitySections(
  body: string,
): Record<string, string> | undefined {
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
  return Object.fromEntries(
    names.map((name, index) => [name, parts[2 + index * 2]?.trim() ?? ""]),
  );
}

export function choiceFromActivity(body: string): string | undefined {
  const sections = activitySections(body);
  const unresolved = sections?.["Unresolved work"];
  if (unresolved === emptySection)
    return markedOpenChoice(sections?.Outcome ?? "", true);
  return validOpenChoice(unresolved) ? unresolved : undefined;
}

export type ChoiceRecommendation = {
  option: string;
  reason: string;
  evidence: string;
};
export type ChoiceGuidance = {
  options: string[];
  recommendation?: ChoiceRecommendation;
};

export const safeChoiceLine = (value: unknown, max = 240): value is string =>
  typeof value === "string" &&
  value.trim() === value &&
  value.length > 0 &&
  value.length <= max &&
  !/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(value) &&
  !containsDetectedSecret(value);

const mapping = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// Recommendations must cite text actually retained with this choice. Neither an
// option nor its position implies a recommendation.
export function choiceGuidance(
  options: unknown,
  recommendation: unknown,
  summary: string,
  deliveryUrl?: string,
): ChoiceGuidance | undefined {
  if (
    !Array.isArray(options) ||
    options.length > 8 ||
    !options.every((value) => safeChoiceLine(value, 120)) ||
    new Set(options).size !== options.length
  )
    return;
  if (recommendation === undefined) return { options: [...options] };
  if (
    !mapping(recommendation) ||
    Object.keys(recommendation).some(
      (k) => !["option", "reason", "evidence"].includes(k),
    )
  )
    return;
  const { option, reason, evidence } = recommendation;
  if (
    typeof option !== "string" ||
    !options.includes(option) ||
    !safeChoiceLine(reason) ||
    !safeChoiceLine(evidence) ||
    (!summary.includes(evidence) && evidence !== deliveryUrl)
  )
    return;
  return {
    options: [...options],
    recommendation: { option, reason, evidence },
  };
}

/** Preserve both alternatives verbatim only when an older question already separates them. */
export function statedAlternatives(label: string): string[] {
  if (!validOpenChoice(label)) return [];
  const pair =
    /^which [^:,()?!]+ \(([^()]+) vs\. ([^()]+)\)[.?]?$/iu.exec(label) ??
    /^should [^:,()?!]+? use (.+), or (.+)\?$/iu.exec(label);
  if (!pair) return [];
  const options = pair.slice(1);
  if (
    new Set(options).size !== 2 ||
    options.some(
      (value) =>
        !safeChoiceLine(value, 120) ||
        !/^[\p{L}\p{N}][\p{L}\p{M}\p{N} '\u2019/-]*$/u.test(value) ||
        /\b(?:or|versus|vs|if|unless|instead)\b/iu.test(value),
    )
  )
    return [];
  return options;
}
