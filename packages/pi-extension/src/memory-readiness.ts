// Only these fixed diagnostics may leave the project memory boundary.
const messages = {
  interactive:
    "Bookie recall withheld. Automatic project memory needs an interactive parent Pi session.",
  trust:
    "Bookie recall withheld. Pi has not trusted this folder in this session. If you trust it, use /trust for this folder and restart Pi.",
  owner:
    "Bookie recall withheld. The current session has no active Pi Daddy Auto connection for this folder. Check Auto in the parent Pi session. For standalone Bookie, select a project with /bookie-context.",
  storage:
    "Bookie recall withheld. Bookie could not verify this folder’s private memory and current session. Existing notes may still be present.",
  destination:
    "Bookie recall withheld. Bookie could not verify the current Pi model destination for these notes. Check the selected model in Pi.",
  disabled:
    "Bookie recall withheld. There is no current authorization for manually selected project notes. Use /bookie-context if you want to select and authorize a project.",
} as const;
const unknownHistory = " Previous project history is unknown.";
export class ProjectMemoryUnavailable extends Error {
  constructor(reason: keyof typeof messages) {
    super(messages[reason] + unknownHistory);
  }
}
export function isProjectMemoryUnavailableMessage(
  value: unknown,
): value is string {
  return Object.values(messages).some(
    (message) => message + unknownHistory === value,
  );
}
