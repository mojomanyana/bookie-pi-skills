import { types } from "node:util";
import { ownDataFields } from "./closed-data.js";
import {
  compileSourceDeployments,
  type SourceDeployment,
} from "./deployment-config.js";
import { assembleQualifiedInputRecipe } from "./build-input-assembly.js";
import type { EncodedBuildRecipe } from "./build-recipe.js";
import {
  loadBuildRuntime,
  qualifiedRuntimeHash,
} from "./runtime-qualification.js";
import {
  preflightDeploymentSource,
  type SourcePreflightResult,
} from "./source-preflight.js";
import { runIngestionProcess } from "./ingestion-isolation.js";
import type { ApprovedIngestionResult } from "./ingestion.js";
import type { LexicalProjection } from "./projection.js";
import { verifyPreparedProjection } from "./projection-evidence.js";
import {
  encodeOutputDescriptor,
  type EncodedOutputDescriptor,
} from "./output-descriptor.js";
import { createServiceAuthorizer, type TokenVerifier } from "./server.js";

export interface BuilderConfiguration {
  readonly epoch: number;
  readonly sources: readonly SourceDeployment[];
}
/** Private, process-local provenance. Its serialization/digests are not a capability. */
export interface TrustedBuildRecipe extends EncodedBuildRecipe {
  readonly sourceCommit: string;
  readonly configurationEpoch: number;
}
export type BuilderFailure =
  | Exclude<ApprovedIngestionResult, { ok: true }>
  | Exclude<SourcePreflightResult, { ok: true }>
  | Readonly<{
      ok: false;
      reason:
        | "auth-invalid"
        | "auth-forbidden"
        | "configuration-changed"
        | "runtime-rejected"
        | "recipe-mismatch";
    }>;

/** No legacy build ID is relabelled: recipe and complete output are distinct. */
export interface VerifiedLexicalOutput {
  readonly recipe: TrustedBuildRecipe;
  readonly approvedTip: string;
  readonly outputDescriptor: EncodedOutputDescriptor;
  readonly concepts: LexicalProjection["concepts"];
  readonly chunks: LexicalProjection["chunks"];
}
/** Private child transport only, never an output/receipt ingestion API. */
export type BuilderProcessResult =
  | BuilderFailure
  | Readonly<{
      ok: true;
      recipe: EncodedBuildRecipe;
      approvedTip: string;
      projection: LexicalProjection;
      outputDescriptor: EncodedOutputDescriptor;
    }>;

const failed = Object.freeze({ ok: false, reason: "ingestion-error" } as const);
const configurationChanged = Object.freeze({
  ok: false,
  reason: "configuration-changed",
} as const);
const runtimeRejected = Object.freeze({
  ok: false,
  reason: "runtime-rejected",
} as const);
const recipeMismatch = Object.freeze({
  ok: false,
  reason: "recipe-mismatch",
} as const);
const reasons = new Set([
  "source-not-approved",
  "manifest-unavailable",
  "deployment-rejected",
  "sensitivity-policy",
  "invalid-source",
  "invalid-vault",
  "secret-policy",
  "incomplete",
  "output-error",
  "projection-error",
  "ingestion-error",
  "runtime-rejected",
  "recipe-mismatch",
]);
function invalid(): never {
  throw new TypeError("Trusted builder configuration is invalid.");
}
function snapshot(
  configuration: () => BuilderConfiguration,
): BuilderConfiguration {
  const [epoch, sources] = ownDataFields(configuration(), ["epoch", "sources"]);
  if (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch < 1)
    invalid();
  return Object.freeze({
    epoch,
    sources: compileSourceDeployments(sources as readonly SourceDeployment[]),
  });
}
function requestFields(
  value: unknown,
  fields: readonly string[],
): readonly unknown[] {
  try {
    if (value === null || typeof value !== "object" || types.isProxy(value))
      throw new TypeError();
    return ownDataFields(value, [
      ...fields,
      ...(Object.hasOwn(value, "signal") ? ["signal"] : []),
    ]);
  } catch {
    throw new TypeError("Trusted builder request is invalid.");
  }
}
function checkSignal(
  signal: unknown,
): asserts signal is AbortSignal | undefined {
  if (signal !== undefined && !(signal instanceof AbortSignal))
    throw new TypeError("Trusted builder request is invalid.");
  if (signal?.aborted)
    throw new DOMException("Ingestion cancelled.", "AbortError");
}
function freezeRows<T>(value: T): T {
  // Only trusted child JSON data reaches this function, never caller objects.
  if (value !== null && typeof value === "object") {
    for (const field of Object.values(value)) freezeRows(field);
    Object.freeze(value);
  }
  return value;
}
function decode(
  value: unknown,
  recipe: TrustedBuildRecipe,
): BuilderProcessResult {
  try {
    if (value === null || typeof value !== "object") return failed;
    const v = value as BuilderProcessResult;
    if (v.ok === false) {
      const [ok, reason] = ownDataFields(v, ["ok", "reason"]);
      return ok === false && typeof reason === "string" && reasons.has(reason)
        ? v
        : failed;
    }
    if (v.ok !== true) return failed;
    ownDataFields(v, [
      "ok",
      "recipe",
      "approvedTip",
      "projection",
      "outputDescriptor",
    ]);
    const claimed = ownDataFields(v.recipe, [
      "serialized",
      "scopeHash",
      "policyHash",
      "recipeHash",
      "buildId",
    ]);
    if (
      claimed.some(
        (field, i) =>
          field !==
          [
            recipe.serialized,
            recipe.scopeHash,
            recipe.policyHash,
            recipe.recipeHash,
            recipe.buildId,
          ][i],
      ) ||
      typeof v.approvedTip !== "string" ||
      !new RegExp(
        `^[a-f0-9]{${recipe.sourceCommit.length}}$(?![\\s\\S])`,
        "u",
      ).test(v.approvedTip) ||
      v.projection.sourceCommit !== recipe.sourceCommit ||
      !verifyPreparedProjection(v.projection)
    )
      return failed;
    const expected = encodeOutputDescriptor({
      recipeHash: recipe.recipeHash,
      canonical: v.projection.canonicalOutput,
      concepts: {
        count: v.projection.concepts.length,
        hash: v.projection.conceptStreamHash,
      },
      chunks: {
        count: v.projection.chunks.length,
        hash: v.projection.chunkStreamHash,
      },
    });
    const [serialized, hash] = ownDataFields(v.outputDescriptor, [
      "serialized",
      "hash",
    ]);
    if (serialized !== expected.serialized || hash !== expected.hash)
      return failed;
    return v;
  } catch {
    return failed;
  }
}

/** Startup outside admission. The deployment owner supplies current configuration,
 * including its monotonic authorization epoch; S7 owns publication interlocking,
 * capacity and durable jobs. This module owns only private preflight provenance
 * and complete isolated output. No route, provider or Redis operation is enabled.
 */
export async function createTrustedLexicalBuilder(
  options: Readonly<{
    runtimeIdentityFile: string;
    tokens: readonly TokenVerifier[];
    configuration: () => BuilderConfiguration;
  }>,
): Promise<
  Readonly<{
    preflight(
      request: Readonly<{
        authorization: string | undefined;
        vault: string;
        sourceRef: string;
        timeoutMs: number;
        signal?: AbortSignal;
      }>,
    ): Promise<
      BuilderFailure | Readonly<{ ok: true; recipe: TrustedBuildRecipe }>
    >;
    build(
      recipe: TrustedBuildRecipe,
      request?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<
      BuilderFailure | Readonly<{ ok: true; output: VerifiedLexicalOutput }>
    >;
  }>
> {
  let runtimeIdentityFile: string;
  let configuration: () => BuilderConfiguration;
  let authorize: ReturnType<typeof createServiceAuthorizer>;
  try {
    if (arguments.length !== 1) invalid();
    const [file, tokens, current] = ownDataFields(options, [
      "runtimeIdentityFile",
      "tokens",
      "configuration",
    ]);
    if (typeof file !== "string" || typeof current !== "function") invalid();
    runtimeIdentityFile = file;
    configuration = current as () => BuilderConfiguration;
    snapshot(configuration);
    authorize = createServiceAuthorizer(tokens as readonly TokenVerifier[]);
  } catch {
    invalid();
  }
  const runtime = await loadBuildRuntime(runtimeIdentityFile);
  const runtimePath = process.env.PATH;
  const provenance = new WeakMap<
    TrustedBuildRecipe,
    Readonly<{ deployment: SourceDeployment; epoch: number }>
  >();
  function unchanged(deployment: SourceDeployment, epoch: number): boolean {
    try {
      const current = snapshot(configuration);
      return (
        current.epoch === epoch &&
        JSON.stringify(
          current.sources.find((s) => s.handle === deployment.handle),
        ) === JSON.stringify(deployment)
      );
    } catch {
      return false;
    }
  }
  return Object.freeze({
    async preflight(request) {
      const [authorization, vault, sourceRef, timeoutMs, signal] =
        requestFields(request, [
          "authorization",
          "vault",
          "sourceRef",
          "timeoutMs",
        ]);
      if (
        (authorization !== undefined && typeof authorization !== "string") ||
        typeof vault !== "string" ||
        typeof sourceRef !== "string" ||
        typeof timeoutMs !== "number" ||
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs < 1 ||
        timeoutMs > 7000
      )
        throw new TypeError("Trusted builder request is invalid.");
      checkSignal(signal);
      const allowed = authorize(authorization, vault, "rebuild:create");
      if (!allowed.ok) return Object.freeze(allowed);
      let current: BuilderConfiguration;
      try {
        current = snapshot(configuration);
      } catch {
        return configurationChanged;
      }
      const deployment = current.sources.find((s) => s.handle === vault);
      if (deployment === undefined)
        return { ok: false, reason: "auth-forbidden" };
      if (process.env.PATH !== runtimePath) return runtimeRejected;
      const source = await preflightDeploymentSource(deployment, {
        sourceRef,
        timeoutMs,
        ...(signal === undefined ? {} : { signal }),
      });
      if (!source.ok) return Object.freeze(source);
      checkSignal(signal);
      if (!unchanged(deployment, current.epoch)) return configurationChanged;
      if (process.env.PATH !== runtimePath) return runtimeRejected;
      const encoded = assembleQualifiedInputRecipe(deployment, source, runtime);
      const recipe = Object.freeze({
        ...encoded,
        sourceCommit: source.sourceCommit,
        configurationEpoch: current.epoch,
      });
      provenance.set(recipe, { deployment, epoch: current.epoch });
      return Object.freeze({ ok: true, recipe });
    },
    async build(recipe, request = {}) {
      const [signal] = requestFields(request, []);
      checkSignal(signal);
      // Identity/digests/shape alone never confer provenance, even on a clone of
      // a genuine receipt or a receipt obtained by another startup instance.
      const source = provenance.get(recipe);
      if (source === undefined) return recipeMismatch;
      if (!unchanged(source.deployment, source.epoch))
        return configurationChanged;
      if (process.env.PATH !== runtimePath) return runtimeRejected;
      const deployment = source.deployment;
      const result = await runIngestionProcess(
        {
          mode: "builder",
          deployment,
          sourceRef: recipe.sourceCommit,
          expectedRuntimeHash: qualifiedRuntimeHash(runtime),
          claimedRecipe: {
            serialized: recipe.serialized,
            scopeHash: recipe.scopeHash,
            policyHash: recipe.policyHash,
            recipeHash: recipe.recipeHash,
            buildId: recipe.buildId,
          },
        },
        {
          timeoutMs: deployment.timeoutMs,
          ...(signal === undefined ? {} : { signal }),
          decode: (value) => decode(value, recipe),
        },
      );
      if (!result.ok) return Object.freeze(result);
      checkSignal(signal);
      if (!unchanged(deployment, source.epoch)) return configurationChanged;
      if (process.env.PATH !== runtimePath) return runtimeRejected;
      return Object.freeze({
        ok: true,
        output: Object.freeze({
          recipe,
          approvedTip: result.approvedTip,
          outputDescriptor: Object.freeze(result.outputDescriptor),
          concepts: freezeRows(result.projection.concepts),
          chunks: freezeRows(result.projection.chunks),
        }),
      });
    },
  });
}
