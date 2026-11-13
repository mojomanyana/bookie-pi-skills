import { recallVault, type FilesystemSearchFilters } from "pi-bookie-core";
import type { createDisclosureAuthority } from "./disclosure-authority.js";

export const RECALL_INPUT_ERROR =
  "Bookie search needs words in query, or mode=recent with no query. Limit must be an integer from 1 to 50.";

/** The host selects the vault and visibility; tool arguments cannot widen them. */
export async function managedRecall(
  ticket: Awaited<
    ReturnType<ReturnType<typeof createDisclosureAuthority>["capture"]>
  >,
  values: Record<string, unknown>,
  signal?: AbortSignal,
) {
  const recent = values.mode === "recent";
  if (
    (values.mode !== undefined && values.mode !== "search" && !recent) ||
    (recent ? values.query !== undefined : typeof values.query !== "string") ||
    (values.limit !== undefined &&
      (typeof values.limit !== "number" ||
        !Number.isSafeInteger(values.limit) ||
        values.limit < 1 ||
        values.limit > 50))
  )
    throw Error(RECALL_INPUT_ERROR);
  const filters: Record<string, string> = {};
  for (const name of [
    "type",
    "project",
    "status",
    "state",
    "sensitivity",
    "tag",
  ]) {
    if (values[name] === undefined) continue;
    if (typeof values[name] !== "string") throw Error(RECALL_INPUT_ERROR);
    filters[name] = values[name];
  }
  try {
    return await recallVault(
      ticket.root,
      recent
        ? { mode: "recent", filters: filters as FilesystemSearchFilters }
        : {
            mode: "terms",
            query: values.query as string,
            filters: filters as FilesystemSearchFilters,
          },
      {
        maxResults: values.limit === undefined ? 10 : (values.limit as number),
        maxExcerptBytes: 1024,
        maxTotalTextBytes: 32000,
        include: ticket.allows,
        ...(signal === undefined ? {} : { signal }),
      },
    );
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError)
      throw Error(RECALL_INPUT_ERROR, { cause: error });
    throw error;
  }
}
