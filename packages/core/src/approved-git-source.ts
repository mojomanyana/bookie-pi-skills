import { resolveApprovedGitCommit as resolveCommit } from "./vault-git-base.js";

export interface ApprovedGitCommitRequest {
  readonly sourceRef: string;
  readonly approvedRef: string;
  /** Maximum first-parent edges from the tip, inclusive; 0 accepts only the tip. */
  readonly rollbackWindow: number;
  readonly signal?: AbortSignal;
}
export type ApprovedGitCommitResult =
  | Readonly<{ ok: true; sourceCommit: string; approvedTip: string }>
  | Readonly<{ ok: false; reason: "source-not-approved" }>;

/** History proof only; keeps private Git/filesystem types out of public declarations. */
export function resolveApprovedGitCommit(
  root: string | URL,
  request: ApprovedGitCommitRequest,
): Promise<ApprovedGitCommitResult> {
  return resolveCommit(root, request);
}
