import { isDeliveryUrl } from "./delivery-url.js";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Scout 0.2 exposes validated citation metadata alongside private brief and
// source bodies. Only match locator metadata; do not open or copy those bodies.
export function scoutDeliveryUrls(details: unknown): string[] {
  if (!record(details) || details.outputWithheld || !record(details.result))
    return [];
  const result = details.result;
  if (
    result.type !== "result" ||
    result.version !== 1 ||
    result.status !== "complete" ||
    !record(result.brief) ||
    result.brief.version !== 1 ||
    !Array.isArray(result.brief.findings) ||
    result.brief.findings.length > 20 ||
    !Array.isArray(result.sources) ||
    result.sources.length > 64
  )
    return [];

  const sources = new Map<string, { locator: string; sha256: string }>();
  for (const source of result.sources) {
    if (
      !record(source) ||
      typeof source.id !== "string" ||
      !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(source.id) ||
      sources.has(source.id) ||
      typeof source.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(source.sha256) ||
      typeof source.locator !== "string" ||
      source.locator.length > 2000
    )
      return [];
    sources.set(source.id, { locator: source.locator, sha256: source.sha256 });
  }
  const urls = new Set<string>();
  for (const finding of result.brief.findings) {
    if (
      !record(finding) ||
      !Array.isArray(finding.citations) ||
      finding.citations.length > 4
    )
      return [];
    for (const citation of finding.citations) {
      if (
        !record(citation) ||
        typeof citation.sourceId !== "string" ||
        citation.sourceId.length > 64
      )
        continue;
      const source = sources.get(citation.sourceId);
      if (
        source &&
        citation.locator === source.locator &&
        citation.sha256 === source.sha256 &&
        isDeliveryUrl(source.locator)
      ) {
        urls.add(source.locator);
      }
    }
  }
  return [...urls];
}
