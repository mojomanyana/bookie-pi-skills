import {
  readApprovedSourceManifest,
  resolveApprovedGitCommit,
} from "@bookie/core";
import {
  prepareLexicalProjection,
  type ProjectionConfig,
} from "./projection.js";
import { verifyPreparedProjection } from "./projection-evidence.js";
import type {
  ApprovedIngestionResult,
  SourcePreflightResult,
} from "./ingestion.js";
import {
  DeploymentRejected,
  inspectReadonlyCheckout,
} from "./readonly-checkout.js";

interface Input {
  readonly mode?: "preflight";
  readonly root: string;
  readonly sourceRef: string;
  readonly approvedRef: string;
  readonly rollbackWindow: number;
  readonly config: ProjectionConfig;
  readonly repositoryRoot?: string;
}

function stop(): never {
  // Parent death must not leave an ingestion group running without an owner.
  try {
    process.kill(-process.pid, "SIGKILL");
  } catch {
    process.exit(1);
  }
  process.exit(1);
}
process.once("disconnect", stop);

async function ingest(
  input: Input,
): Promise<ApprovedIngestionResult | SourcePreflightResult> {
  // A preflight never has a local/unguarded mode, even on the private IPC seam.
  if (input.mode === "preflight" && input.repositoryRoot === undefined)
    throw new DeploymentRejected();
  const deployment =
    input.repositoryRoot === undefined
      ? undefined
      : await inspectReadonlyCheckout(input.root, input.repositoryRoot);
  if (input.mode === "preflight") {
    const source = await readApprovedSourceManifest(input.root, {
      sourceRef: input.sourceRef,
      approvedRef: input.approvedRef,
      rollbackWindow: input.rollbackWindow,
      vaultUid: input.config.vaultUid,
    });
    if (!source.ok) return source;
    if (
      input.config.approvedSensitivityClasses.some(
        (label) => !source.manifest.sensitivityClasses.includes(label),
      )
    )
      return { ok: false, reason: "sensitivity-policy" };
    if (
      (await inspectReadonlyCheckout(input.root, input.repositoryRoot!)) !==
      deployment
    )
      throw new DeploymentRejected();
    return source;
  }
  const approval = await resolveApprovedGitCommit(input.root, {
    sourceRef: input.sourceRef,
    approvedRef: input.approvedRef,
    rollbackWindow: input.rollbackWindow,
  });
  if (!approval.ok) return approval;
  const projected = await prepareLexicalProjection(input.root, {
    sourceRef: approval.sourceCommit,
    config: input.config,
  });
  if (projected.ok && !verifyPreparedProjection(projected.projection))
    return { ok: false, reason: "projection-error" };
  if (
    projected.ok &&
    input.repositoryRoot !== undefined &&
    (await inspectReadonlyCheckout(input.root, input.repositoryRoot)) !==
      deployment
  )
    throw new DeploymentRejected();
  return projected.ok
    ? { ...projected, approvedTip: approval.approvedTip }
    : projected;
}
function send(result: ApprovedIngestionResult | SourcePreflightResult): void {
  if (process.send === undefined) stop();
  try {
    process.send(result, (error: Error | null) => {
      if (error !== null) stop();
    });
  } catch {
    stop();
  }
}
process.once("message", (input: Input) => {
  void ingest(input).then(send, (error: unknown) =>
    send({
      ok: false,
      reason:
        error instanceof DeploymentRejected
          ? "deployment-rejected"
          : "ingestion-error",
    }),
  );
});
