import { inspectConcept, searchVault, validateVault } from "@bookie/core";
import type { ReadOperation } from "./operation-process.js";

// One private read-only operation per process. No raw errors or progress cross IPC.
process.once("message", async (input: ReadOperation) => {
  try {
    const result =
      input.command === "validate"
        ? await validateVault(
            input.vault,
            input.baseRef === undefined ? {} : { baseRef: input.baseRef },
          )
        : input.command === "search"
          ? await searchVault(input.vault, input.request)
          : await inspectConcept(input.vault, input.selector);
    process.send?.({ kind: "result", command: input.command, result });
  } catch (error) {
    process.send?.({
      kind: error instanceof TypeError ? "invocation" : "failure",
      command: input.command,
    });
  }
});
