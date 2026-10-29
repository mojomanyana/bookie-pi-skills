import {
  readApprovedSourceManifest,
  resolveApprovedGitCommit,
} from "@bookie/core";
import {
  prepareLexicalProjection,
  verifyCompleteProjection,
  type ProjectionConfig,
} from "./projection.js";
import { verifyPreparedProjection } from "./projection-evidence.js";
import { ownDataFields } from "./closed-data.js";
import {
  compileSourceDeployments,
  type SourceDeployment,
} from "./deployment-config.js";
import { assembleQualifiedInputRecipe } from "./build-input-assembly.js";
import type { EncodedBuildRecipe } from "./build-recipe.js";
import { qualifyBuildRuntime } from "./runtime-qualification.js";
import { encodeOutputDescriptor } from "./output-descriptor.js";
import type { BuilderProcessResult } from "./trusted-builder.js";
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

interface BuilderInput {
  readonly mode: "builder";
  readonly deployment: SourceDeployment;
  readonly sourceRef: string;
  readonly expectedRuntimeHash: string;
  readonly claimedRecipe: EncodedBuildRecipe;
}

type Result =
  ApprovedIngestionResult | SourcePreflightResult | BuilderProcessResult;

async function buildTrusted(
  input: BuilderInput,
): Promise<BuilderProcessResult> {
  const deployment = compileSourceDeployments([input.deployment])[0]!;
  const boundary = await inspectReadonlyCheckout(
    deployment.root,
    deployment.repositoryRoot,
  );
  let runtime;
  try {
    runtime = await qualifyBuildRuntime(input.expectedRuntimeHash);
  } catch {
    return { ok: false, reason: "runtime-rejected" };
  }
  const readSource = () =>
    readApprovedSourceManifest(deployment.root, {
      sourceRef: input.sourceRef,
      approvedRef: deployment.approvedRef,
      rollbackWindow: deployment.rollbackWindow,
      vaultUid: deployment.projection.vaultUid,
    });
  const source = await readSource();
  if (!source.ok) return source;
  if (
    deployment.projection.approvedSensitivityClasses.some(
      (label) => !source.manifest.sensitivityClasses.includes(label),
    )
  )
    return { ok: false, reason: "sensitivity-policy" };
  const recipe = assembleQualifiedInputRecipe(deployment, source, runtime);
  try {
    const keys = [
      "serialized",
      "scopeHash",
      "policyHash",
      "recipeHash",
      "buildId",
    ] as const;
    const claimed = ownDataFields(input.claimedRecipe, keys);
    if (claimed.some((value, i) => value !== recipe[keys[i]!]))
      return { ok: false, reason: "recipe-mismatch" };
  } catch {
    return { ok: false, reason: "recipe-mismatch" };
  }
  const projected = await prepareLexicalProjection(deployment.root, {
    sourceRef: input.sourceRef,
    config: deployment.projection,
  });
  if (!projected.ok) return projected;
  const p = projected.projection;
  // The witness was privately produced over the actual validated export sink;
  // no asserted canonical receipt or reconstruction from projections suffices.
  if (!verifyCompleteProjection(p) || p.manifestHash !== source.manifest.hash)
    return { ok: false, reason: "projection-error" };
  const current = await readSource();
  if (!current.ok) return current;
  if (
    assembleQualifiedInputRecipe(deployment, current, runtime).serialized !==
    recipe.serialized
  )
    return { ok: false, reason: "recipe-mismatch" };
  if (
    (await inspectReadonlyCheckout(
      deployment.root,
      deployment.repositoryRoot,
    )) !== boundary
  )
    throw new DeploymentRejected();
  try {
    await qualifyBuildRuntime(input.expectedRuntimeHash);
  } catch {
    return { ok: false, reason: "runtime-rejected" };
  }
  const outputDescriptor = encodeOutputDescriptor({
    recipeHash: recipe.recipeHash,
    canonical: p.canonicalOutput,
    concepts: { count: p.concepts.length, hash: p.conceptStreamHash },
    chunks: { count: p.chunks.length, hash: p.chunkStreamHash },
  });
  return {
    ok: true,
    recipe,
    approvedTip: current.approvedTip,
    projection: p,
    outputDescriptor,
  };
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

async function ingest(input: Input | BuilderInput): Promise<Result> {
  if (input.mode === "builder") return await buildTrusted(input);
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
function send(result: Result): void {
  if (process.send === undefined) stop();
  try {
    process.send(result, (error: Error | null) => {
      if (error !== null) stop();
    });
  } catch {
    stop();
  }
}
process.once("message", (input: Input | BuilderInput) => {
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
