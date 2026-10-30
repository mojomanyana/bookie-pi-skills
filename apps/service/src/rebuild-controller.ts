import { performance } from "node:perf_hooks";
import { ownDataFields } from "./closed-data.js";
import {
  compileSourceDeployments,
  type SourceDeployment,
} from "./deployment-config.js";
import {
  createServiceAuthentication,
  type ServiceIdentity,
  type ServiceScope,
  type TokenVerifier,
} from "./server.js";
import {
  createTrustedLexicalBuilder,
  type TrustedBuildRecipe,
} from "./trusted-builder.js";
import {
  CandidateStoreError,
  createCandidateJobId,
  type CandidateFailureCode,
  type CandidateInputLease,
  type CandidateInspection,
  type CandidateJob,
  type RedisCandidateStore,
} from "./redis-candidate-store.js";

export interface ControllerConfiguration {
  readonly epoch: number;
  readonly sources: readonly SourceDeployment[];
  readonly tokens: readonly TokenVerifier[];
}
export type TrustedLexicalBuilder = Awaited<
  ReturnType<typeof createTrustedLexicalBuilder>
>;
export type ControllerStore = Pick<
  RedisCandidateStore,
  | "namespace"
  | "isForVault"
  | "startProcess"
  | "setConfigurationEpoch"
  | "readCurrentJob"
  | "inspectInput"
  | "readJob"
  | "claimInput"
  | "beginBuilding"
  | "attachOutput"
  | "renew"
  | "requestCancel"
  | "acknowledgeCancel"
  | "fail"
  | "cleanup"
>;
export type ControllerErrorCode =
  | "AUTH_INVALID"
  | "AUTH_FORBIDDEN"
  | "RATE_LIMITED"
  | "BUILD_CONFLICT"
  | "BUILD_NOT_FOUND"
  | "DEPENDENCY_UNAVAILABLE"
  | "REQUEST_INVALID";
export class RebuildControllerError extends Error {
  constructor(readonly code: ControllerErrorCode) {
    super(code);
    this.name = "RebuildControllerError";
  }
}
function unavailable(): never {
  throw new RebuildControllerError("DEPENDENCY_UNAVAILABLE");
}
class BeforeDispatchError extends Error {}
function beforeDispatch(error: unknown): boolean {
  return (
    error instanceof BeforeDispatchError ||
    (error instanceof DOMException &&
      error.name === "AbortError" &&
      !("outcome" in error))
  );
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const field of Object.values(value)) freeze(field);
    Object.freeze(value);
  }
  return value;
}
function snapshot(value: ControllerConfiguration): ControllerConfiguration {
  try {
    const [epoch, sources, tokens] = ownDataFields(value, [
      "epoch",
      "sources",
      "tokens",
    ]);
    if (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch < 1)
      throw new TypeError();
    const copied = structuredClone(tokens) as readonly TokenVerifier[];
    createServiceAuthentication(copied);
    return Object.freeze({
      epoch,
      sources: compileSourceDeployments(sources as readonly SourceDeployment[]),
      tokens: freeze(copied),
    });
  } catch {
    throw new TypeError("Controller configuration is invalid.");
  }
}
const terminal = (job: CandidateJob): boolean =>
  ["failed", "cancelled", "complete"].includes(job.state);
const sameLease = (a: CandidateInputLease, b: CandidateInputLease): boolean =>
  a.jobId === b.jobId &&
  a.buildId === b.buildId &&
  a.ownerEpoch === b.ownerEpoch &&
  a.fence === b.fence &&
  a.configurationEpoch === b.configurationEpoch;
const SIX_HOURS = 21_600_000;
const SUBMISSION = 10_000;
const RECOVERY_READS = 3;
interface Attempt {
  readonly id: string;
  readonly vault: string;
  readonly recipe: TrustedBuildRecipe;
  readonly anchor: number;
  readonly abort: AbortController;
  /** Fixed lifetime history, set before possible dispatch, never reset on re-entry. */
  readonly retirementDispatched: Set<"failure" | "cancellation" | "fence">;
  lease?: CandidateInputLease;
  launched: boolean;
  stopped: boolean;
  terminal: boolean;
  fenced: boolean;
  teardownUnknown: boolean;
  cancelConfirmed: boolean;
  stopCode?: CandidateFailureCode;
  worker?: Promise<void>;
  finishing?: Promise<void>;
  deadline?: ReturnType<typeof setTimeout>;
  renewal?: ReturnType<typeof setTimeout>;
}

/** Single-process component boundary. Supply the genuine S5 builder and configured
 * S6 stores here; HTTP cannot inject recipes, runtime proofs, processes or stores.
 * The deployment factory below performs that composition outside admission.
 */
export class OwnedRebuildController {
  #configuration: ControllerConfiguration;
  #authenticate: ReturnType<typeof createServiceAuthentication>;
  readonly #builder: TrustedLexicalBuilder;
  readonly #stores: ReadonlyMap<string, ControllerStore>;
  readonly #epochs = new Map<string, number>();
  readonly #rates = new Map<string, { start: number; count: number }>();
  #active: Attempt | undefined;
  #preflight = false;
  #preflightTask: Promise<unknown> | undefined;
  #claimTask: Promise<unknown> | undefined;
  #generation = new AbortController();
  #started = false;
  #admitting = false;
  #disabled = false;
  #publishing = false;
  #closing = false;
  #shutdown: Promise<void> | undefined;
  constructor(
    options: Readonly<{
      configuration: ControllerConfiguration;
      builder: TrustedLexicalBuilder;
      stores: ReadonlyMap<string, ControllerStore>;
    }>,
  ) {
    this.#configuration = snapshot(options.configuration);
    this.#authenticate = createServiceAuthentication(
      this.#configuration.tokens,
    );
    this.#builder = options.builder;
    this.#stores = new Map(options.stores);
    if (
      this.#stores.size !== this.#configuration.sources.length ||
      this.#configuration.sources.some(
        (s) => !this.#stores.get(s.handle)?.isForVault(s.projection.vaultUid),
      ) ||
      new Set([...this.#stores.values()].map((s) => s.namespace)).size !==
        this.#stores.size
    )
      throw new TypeError("Controller configuration is invalid.");
  }
  get configuration(): ControllerConfiguration {
    return this.#configuration;
  }
  get ready(): boolean {
    return (
      this.#admitting && !this.#disabled && !this.#closing && !this.#publishing
    );
  }
  authenticate(header: string | undefined): ServiceIdentity {
    try {
      const identity = this.#authenticate(header);
      const vaults = identity.vaults.filter((vault) =>
        this.#configuration.sources.some((source) => source.handle === vault),
      );
      return Object.freeze({
        principal: identity.principal,
        vaults: Object.freeze(vaults),
        grants: new Map(
          vaults.map((vault) => [vault, new Set(identity.grants.get(vault))]),
        ),
      });
    } catch {
      throw new RebuildControllerError("AUTH_INVALID");
    }
  }
  #authorize(
    header: string | undefined,
    scope: ServiceScope,
    vault?: string,
  ): ServiceIdentity {
    const identity = this.authenticate(header);
    const configured = this.#configuration.sources;
    if (
      vault === undefined
        ? !configured.some((s) => identity.grants.get(s.handle)?.has(scope))
        : !configured.some((s) => s.handle === vault) ||
          !identity.grants.get(vault)?.has(scope)
    )
      throw new RebuildControllerError("AUTH_FORBIDDEN");
    return identity;
  }
  #store(vault: string): ControllerStore {
    return this.#stores.get(vault)!;
  }

  /** S6 owns bounded dispatch and late replies, even if its Redis executor ignores
   * cancellation. Preserve its checked pre-dispatch/unknown distinction rather
   * than racing it with a second, less-informed dispatch oracle. */
  async #call<T>(
    action: (signal: AbortSignal) => Promise<T>,
    options: { signal?: AbortSignal; until?: number } = {},
  ): Promise<T> {
    const remaining = Math.floor(
      (options.until ?? Infinity) - performance.now(),
    );
    if (remaining < 1 || options.signal?.aborted)
      throw new BeforeDispatchError();
    const timeout = new AbortController();
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeout.signal])
      : timeout.signal;
    const timer = setTimeout(() => timeout.abort(), Math.min(2000, remaining));
    try {
      return await action(signal);
    } finally {
      clearTimeout(timer);
    }
  }
  async #initialize(configuration: ControllerConfiguration): Promise<void> {
    for (const source of configuration.sources) {
      const store = this.#store(source.handle);
      const epoch = await this.#call((signal) => store.startProcess(signal));
      this.#epochs.set(source.handle, epoch);
      await this.#call((signal) =>
        store.setConfigurationEpoch(configuration.epoch, signal),
      );
    }
  }
  /** Required deployment supervision, not a boolean/mount assertion and never an
   * HTTP option. Redis fencing alone does not qualify old process-group death.
   * No production supervisor is implemented or defaulted by this S7 component. */
  async start(
    confirmPreviousWorkersStopped: () => Promise<void>,
  ): Promise<void> {
    if (this.#started || typeof confirmPreviousWorkersStopped !== "function")
      throw new TypeError("Controller startup is invalid.");
    this.#started = true;
    try {
      await this.#initialize(this.#configuration);
      await confirmPreviousWorkersStopped();
      await this.#cleanupRetained(this.#configuration);
      if (!this.#closing) this.#admitting = true;
    } catch {
      this.#disabled = true;
      unavailable();
    }
  }
  #rate(identity: ServiceIdentity, vault: string): void {
    const key = `${identity.principal}:${vault}`;
    const now = performance.now();
    let rate = this.#rates.get(key);
    if (rate === undefined || now - rate.start >= 60_000) {
      rate = { start: now, count: 0 };
      this.#rates.set(key, rate);
    }
    if (rate.count >= 2) throw new RebuildControllerError("RATE_LIMITED");
    rate.count++;
  }
  #quarantine(attempt?: Attempt): void {
    if (attempt !== undefined && this.#active !== attempt) return;
    this.#disabled = true;
    this.#admitting = false;
    if (attempt) {
      attempt.abort.abort();
      clearTimeout(attempt.renewal);
    }
  }
  async submit(
    request: Readonly<{
      authorization: string | undefined;
      vault: string;
      sourceRef: string;
      signal?: AbortSignal;
    }>,
  ): Promise<CandidateJob> {
    const until = performance.now() + SUBMISSION;
    const identity = this.#authorize(
      request.authorization,
      "rebuild:create",
      request.vault,
    );
    this.#rate(identity, request.vault);
    if (!this.ready) unavailable();
    if (this.#preflight) throw new RebuildControllerError("RATE_LIMITED");
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})(?![\s\S])/u.test(request.sourceRef))
      throw new RebuildControllerError("REQUEST_INVALID");
    const configuration = this.#configuration;
    const timeout = new AbortController();
    const signal = AbortSignal.any([
      this.#generation.signal,
      timeout.signal,
      ...(request.signal ? [request.signal] : []),
    ]);
    const timer = setTimeout(() => timeout.abort(), SUBMISSION);
    try {
      if (signal.aborted) unavailable();
      this.#preflight = true;
      let prepared: Awaited<ReturnType<TrustedLexicalBuilder["preflight"]>>;
      const preflightMs = Math.min(
        7000,
        Math.floor(until - performance.now() - 3000),
      );
      if (preflightMs < 1) {
        this.#preflight = false;
        unavailable();
      }
      const preflight = this.#builder.preflight({
        authorization: request.authorization,
        vault: request.vault,
        sourceRef: request.sourceRef,
        timeoutMs: preflightMs,
        signal,
      });
      this.#preflightTask = preflight;
      try {
        prepared = await preflight;
        if (!prepared.ok && prepared.reason === "ingestion-error") {
          this.#quarantine();
          unavailable();
        }
        this.#preflight = false; // all other S5 settlements confirm teardown/no spawn
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError")
          this.#preflight = false;
        else this.#quarantine();
        unavailable();
      } finally {
        this.#preflightTask = undefined;
      }
      if (
        !prepared.ok ||
        signal.aborted ||
        configuration !== this.#configuration ||
        !this.ready
      )
        unavailable();
      const recipe = prepared.recipe;
      if (
        recipe.configurationEpoch !== configuration.epoch ||
        recipe.sourceCommit !== request.sourceRef
      ) {
        this.#quarantine();
        unavailable();
      }
      const store = this.#store(request.vault);
      const existing = await this.#call((s) => store.readCurrentJob(s), {
        until,
        signal,
      });
      if (
        signal.aborted ||
        configuration !== this.#configuration ||
        !this.ready
      )
        unavailable();
      const active = this.#active;
      if (existing && !terminal(existing)) {
        if (
          existing.buildId !== recipe.buildId ||
          existing.state === "cancelling"
        )
          throw new RebuildControllerError("BUILD_CONFLICT");
        if (
          !active ||
          active.id !== existing.jobId ||
          active.vault !== request.vault
        ) {
          this.#quarantine();
          unavailable();
        }
      }
      if (active)
        return await this.#duplicate(
          active,
          recipe,
          request.vault,
          configuration,
          until,
          signal,
        );
      // One explicit bounded cleanup step, never a submission-side work queue.
      // Large retained S6 candidates can require subsequent authorized submissions.
      if (existing && existing.state !== "complete") {
        const cleaned = await this.#call(
          (s) => store.cleanup(existing.jobId, s),
          { until, signal },
        );
        if (!cleaned.done) throw new RebuildControllerError("BUILD_CONFLICT");
      }
      if (
        signal.aborted ||
        configuration !== this.#configuration ||
        !this.ready
      )
        unavailable();
      // Cleanup yielded: another submission may now own the slot. Never replace
      // its reservation with this handler's late acknowledgement.
      if (this.#active)
        return await this.#duplicate(
          this.#active,
          recipe,
          request.vault,
          configuration,
          until,
          signal,
        );
      const attempt: Attempt = {
        id: createCandidateJobId(),
        vault: request.vault,
        recipe,
        anchor: performance.now(),
        abort: new AbortController(),
        retirementDispatched: new Set(),
        launched: false,
        stopped: true,
        terminal: false,
        fenced: false,
        teardownUnknown: false,
        cancelConfirmed: false,
      };
      this.#active = attempt; // NEW only; retained identity precedes possible dispatch
      attempt.deadline = setTimeout(
        () => this.#stop(attempt, "LIMIT_EXCEEDED"),
        SIX_HOURS,
      );
      const claiming = this.#claim(attempt, until, signal);
      this.#claimTask = claiming;
      try {
        return await claiming;
      } finally {
        if (this.#claimTask === claiming) this.#claimTask = undefined;
      }
    } catch (error) {
      if (error instanceof RebuildControllerError) throw error;
      if (
        error instanceof CandidateStoreError &&
        error.code === "BUILD_CONFLICT"
      )
        throw new RebuildControllerError("BUILD_CONFLICT");
      unavailable();
    } finally {
      clearTimeout(timer);
    }
  }
  async #duplicate(
    active: Attempt,
    recipe: TrustedBuildRecipe,
    vault: string,
    configuration: ControllerConfiguration,
    until: number,
    signal: AbortSignal,
  ): Promise<CandidateJob> {
    if (active.vault !== vault)
      throw new RebuildControllerError("RATE_LIMITED");
    if (active.recipe.buildId !== recipe.buildId || active.abort.signal.aborted)
      throw new RebuildControllerError("BUILD_CONFLICT");
    // Current-job lookup can precede the original claim's commit. Only read the
    // retained original identity; duplicates never reserve, mutate or launch.
    const observed = await this.#call(
      (s) => this.#store(vault).inspectInput(active.id, s),
      { until, signal },
    );
    if (
      !this.#matches(active, observed) ||
      !observed.live ||
      terminal(observed.job) ||
      this.#active !== active ||
      configuration !== this.#configuration ||
      !this.ready ||
      signal.aborted
    )
      unavailable();
    return observed.job;
  }
  async #claim(
    attempt: Attempt,
    until: number,
    signal: AbortSignal,
  ): Promise<CandidateJob> {
    try {
      const claimed = await this.#call(
        (s) =>
          this.#store(attempt.vault).claimInput(attempt.recipe, attempt.id, s),
        { until, signal },
      );
      if (!claimed.created) {
        // Definitively non-mutating; never release the existing job's capacity.
        this.#release(attempt);
        this.#quarantine(); // a live controller not owned by this process is unsupported
        unavailable();
      }
      if (
        claimed.lease.jobId !== attempt.id ||
        claimed.lease.ownerEpoch !== this.#epochs.get(attempt.vault) ||
        claimed.lease.buildId !== attempt.recipe.buildId ||
        claimed.lease.configurationEpoch !== attempt.recipe.configurationEpoch
      ) {
        this.#quarantine(attempt);
        unavailable();
      }
      attempt.lease = claimed.lease;
      void this.#drive(attempt);
      return Object.freeze({
        jobId: attempt.id,
        buildId: attempt.recipe.buildId,
        sourceCommit: attempt.recipe.sourceCommit,
        state: "queued",
        failureCode: null,
      });
    } catch (error) {
      if (beforeDispatch(error)) {
        this.#release(attempt);
      } else if (
        error instanceof CandidateStoreError &&
        error.outcome !== "unknown" &&
        ["BUILD_CONFLICT", "FENCED", "NOT_FOUND"].includes(error.code)
      ) {
        this.#release(attempt); // confirmed non-mutating claim rejection; no worker
        if (error.code === "BUILD_CONFLICT")
          throw new RebuildControllerError("BUILD_CONFLICT");
        if (error.code === "FENCED") this.#quarantine();
      } else {
        // A dispatched/unusable response cannot call drive/release later: only
        // original-ID owner-epoch reads may resolve its unknown outcome.
        void this.#recoverClaim(attempt);
      }
      unavailable();
    }
  }
  #matches(attempt: Attempt, observed: CandidateInspection): boolean {
    const { job, manifest } = observed;
    return (
      job.jobId === attempt.id &&
      job.buildId === attempt.recipe.buildId &&
      job.sourceCommit === attempt.recipe.sourceCommit &&
      (manifest === null
        ? terminal(job)
        : manifest.recipeHash === attempt.recipe.recipeHash &&
          manifest.policyHash === attempt.recipe.policyHash &&
          manifest.manifestHash ===
            (JSON.parse(attempt.recipe.serialized) as unknown[])[7] &&
          manifest.lease.ownerEpoch === this.#epochs.get(attempt.vault) &&
          manifest.lease.configurationEpoch ===
            attempt.recipe.configurationEpoch &&
          (attempt.lease === undefined ||
            sameLease(manifest.lease, attempt.lease)))
    );
  }
  async #observe(
    attempt: Attempt,
    accepts: (value: CandidateInspection) => boolean,
  ): Promise<CandidateInspection | undefined> {
    for (let n = 0; n < RECOVERY_READS; n++) {
      if (this.#active !== attempt || this.#publishing) return undefined;
      try {
        const observed = await this.#call((s) =>
          this.#store(attempt.vault).inspectInput(attempt.id, s),
        );
        if (this.#active !== attempt || this.#publishing) return undefined;
        if (!this.#matches(attempt, observed)) break;
        if (terminal(observed.job)) {
          attempt.terminal = true;
          attempt.abort.abort();
          return observed;
        }
        if (
          observed.live &&
          observed.manifest &&
          observed.job.state === "cancelling"
        ) {
          // Cancellation is a conclusive live state advancement, not an unknown
          // claim/begin/failure. Retain its original lease without launching.
          attempt.lease ??= observed.manifest.lease;
          attempt.cancelConfirmed = true;
          attempt.abort.abort();
          return observed;
        }
        if (accepts(observed)) return observed;
      } catch (error) {
        if (this.#publishing || this.#active !== attempt) return undefined;
        // inspect has no lease assertion: FENCED proves this process epoch was
        // superseded, not merely that a lease TTL elapsed.
        if (error instanceof CandidateStoreError && error.code === "FENCED") {
          attempt.fenced = true;
          this.#quarantine(attempt);
          return undefined;
        }
      }
    }
    this.#quarantine(attempt);
    return undefined;
  }
  async #recoverClaim(attempt: Attempt): Promise<void> {
    const observed = await this.#observe(
      attempt,
      (o) => o.live && o.manifest?.state === "queued",
    );
    if (observed && !attempt.terminal && observed.manifest) {
      attempt.lease = observed.manifest.lease;
      if (attempt.cancelConfirmed) await this.#finish(attempt);
      else await this.#drive(attempt);
    } else if (attempt.terminal || attempt.fenced) await this.#finish(attempt);
  }
  async #drive(attempt: Attempt): Promise<void> {
    if (!attempt.lease || this.#active !== attempt || attempt.launched) return;
    if (
      attempt.abort.signal.aborted ||
      this.#publishing ||
      this.#closing ||
      attempt.recipe.configurationEpoch !== this.#configuration.epoch ||
      performance.now() - attempt.anchor >= SIX_HOURS
    ) {
      this.#stop(attempt, "INTERRUPTED");
      return;
    }
    try {
      await this.#call((s) =>
        this.#store(attempt.vault).beginBuilding(attempt.lease!, s),
      );
    } catch {
      const observed = await this.#observe(
        attempt,
        (o) =>
          o.live &&
          o.manifest?.state === "building" &&
          o.manifest.outputDescriptor === undefined,
      );
      if (!observed || attempt.terminal || attempt.cancelConfirmed) {
        if (attempt.terminal || attempt.fenced || attempt.cancelConfirmed)
          await this.#finish(attempt);
        return;
      }
    }
    if (
      attempt.abort.signal.aborted ||
      this.#publishing ||
      this.#closing ||
      this.#disabled
    ) {
      this.#stop(attempt, "INTERRUPTED");
      return;
    }
    if (attempt.launched) return;
    attempt.launched = true; // BEFORE invoking/spawning the S5 component
    attempt.stopped = false;
    this.#renewLater(attempt);
    attempt.worker = this.#work(attempt);
  }
  async #work(attempt: Attempt): Promise<void> {
    try {
      const result = await this.#builder.build(attempt.recipe, {
        signal: attempt.abort.signal,
      });
      if (!result.ok && result.reason === "ingestion-error") {
        attempt.teardownUnknown = true;
        this.#quarantine(attempt);
        return;
      }
      attempt.stopped = true;
      if (attempt.abort.signal.aborted || this.#closing || this.#publishing) {
        void this.#finish(attempt);
        return;
      }
      if (!result.ok) {
        this.#stop(
          attempt,
          result.reason === "secret-policy"
            ? "SECRET_DETECTED"
            : result.reason === "configuration-changed"
              ? "INTERRUPTED"
              : "VALIDATION_FAILED",
        );
        return;
      }
      if (
        result.output.recipe !== attempt.recipe ||
        attempt.recipe.configurationEpoch !== this.#configuration.epoch
      ) {
        this.#stop(attempt, "INTERNAL");
        return;
      }
      const output = result.output.outputDescriptor;
      try {
        await this.#call((s) =>
          this.#store(attempt.vault).attachOutput(attempt.lease!, output, s),
        );
      } catch (error) {
        if (
          error instanceof CandidateStoreError &&
          error.code === "BUILD_CONFLICT"
        ) {
          this.#stop(attempt, "INTERNAL");
          return;
        }
        const observed = await this.#observe(
          attempt,
          (o) =>
            o.live &&
            o.manifest?.state === "building" &&
            o.manifest.outputDescriptor?.serialized === output.serialized,
        );
        if (!observed || attempt.terminal || attempt.cancelConfirmed) {
          if (attempt.terminal || attempt.fenced || attempt.cancelConfirmed)
            void this.#finish(attempt);
          return;
        }
      }
      // S8 boundary: NO payload/index/verification/evaluation/complete/activation.
      // Computation has stopped, but the accepted reservation/lease stays owned
      // until downstream completion or explicit cancellation/failure/shutdown.
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        attempt.stopped = true;
        void this.#finish(attempt);
      } else {
        attempt.teardownUnknown = true;
        this.#quarantine(attempt);
      }
    }
  }
  #renewLater(attempt: Attempt): void {
    if (this.#active !== attempt || attempt.abort.signal.aborted) return;
    attempt.renewal = setTimeout(() => {
      void (async () => {
        try {
          await this.#call((s) =>
            this.#store(attempt.vault).renew(attempt.lease!, s),
          );
          this.#renewLater(attempt);
        } catch {
          this.#stop(attempt, "INTERRUPTED");
        }
      })();
    }, 10_000);
  }
  #stop(attempt: Attempt, code: CandidateFailureCode): void {
    attempt.stopCode ??= code;
    attempt.abort.abort();
    clearTimeout(attempt.renewal);
    void this.#finish(attempt);
  }
  async #finish(attempt: Attempt): Promise<void> {
    if (this.#active !== attempt || this.#publishing) return;
    if (attempt.finishing) return await attempt.finishing;
    const finishing = this.#finishOwned(attempt);
    attempt.finishing = finishing;
    try {
      await finishing;
    } finally {
      if (attempt.finishing === finishing) delete attempt.finishing;
    }
  }
  async #finishOwned(attempt: Attempt): Promise<void> {
    if (!attempt.stopped && attempt.worker)
      await this.#boundedWait(attempt.worker, 2500);
    if (!attempt.stopped || attempt.teardownUnknown) {
      this.#quarantine(attempt);
      return;
    }
    if (attempt.terminal || attempt.fenced) {
      await this.#retire(attempt);
      return;
    }
    if (!attempt.lease) return; // claim reconciliation owns this seam
    let acknowledging = attempt.cancelConfirmed;
    // One failure may advance to one distinct cancellation acknowledgement.
    // Re-entry (including shutdown) observes prior dispatches, never replays them.
    for (let transition = 0; transition < 2; transition++) {
      const operation = acknowledging ? "cancellation" : "failure";
      if (!attempt.retirementDispatched.has(operation)) {
        attempt.retirementDispatched.add(operation);
        try {
          const job = await this.#call((s) =>
            acknowledging
              ? this.#store(attempt.vault).acknowledgeCancel(attempt.lease!, s)
              : this.#store(attempt.vault).fail(
                  attempt.lease!,
                  attempt.stopCode ?? "INTERRUPTED",
                  s,
                ),
          );
          if (
            !terminal(job) ||
            job.jobId !== attempt.id ||
            job.buildId !== attempt.recipe.buildId ||
            job.sourceCommit !== attempt.recipe.sourceCommit
          ) {
            this.#quarantine(attempt);
            return;
          }
          attempt.terminal = true;
          break;
        } catch {
          // Failed replies and earlier dispatches require the same bounded proof
          // below. The lifetime history prevents a later callback sending again.
        }
      }
      const observed = await this.#observe(attempt, (o) => !o.live);
      // Publication owns fencing/retirement while it is in progress; an old
      // terminal reply cannot quarantine its conclusively stopped reservation.
      if (this.#active !== attempt || this.#publishing) return;
      if (attempt.terminal || attempt.fenced) break;
      if (
        !acknowledging &&
        observed?.live &&
        observed.job.state === "cancelling"
      ) {
        acknowledging = true;
        continue;
      }
      if (observed && !observed.live) {
        if (attempt.retirementDispatched.has("fence")) {
          this.#quarantine(attempt);
          break;
        }
        // Teardown was proved above. This distinct recovery fence may interrupt
        // expired ownership once; an unknown fence is never dispatched again.
        attempt.retirementDispatched.add("fence");
        try {
          const store = this.#store(attempt.vault);
          this.#epochs.set(
            attempt.vault,
            await this.#call((s) => store.startProcess(s)),
          );
          attempt.fenced = true;
          await this.#call((s) =>
            store.setConfigurationEpoch(this.#configuration.epoch, s),
          );
        } catch {
          this.#quarantine(attempt);
        }
      } else this.#quarantine(attempt);
      break;
    }
    if (attempt.terminal || attempt.fenced) await this.#retire(attempt);
  }
  async #drainCleanup(
    vault: string,
    id: string,
    duringPublication = false,
  ): Promise<void> {
    // Full declared ranges, at most 128 ordinals per confirmed operation. This
    // is bounded off the submission path; an uncertain operation is NOT retried.
    for (let n = 0; n < Math.ceil(300_000 / 128) && !this.#closing; n++) {
      if (this.#publishing && !duringPublication) return;
      const result = await this.#call((s) => this.#store(vault).cleanup(id, s));
      if (result.done) return;
    }
    if (!this.#closing) unavailable();
  }
  async #cleanupRetained(
    configuration: ControllerConfiguration,
  ): Promise<void> {
    for (const source of configuration.sources) {
      if (this.#closing) return;
      const job = await this.#call((s) =>
        this.#store(source.handle).readCurrentJob(s),
      );
      if (job && (job.state === "failed" || job.state === "cancelled"))
        await this.#drainCleanup(source.handle, job.jobId, true);
    }
  }
  async #retire(attempt: Attempt): Promise<void> {
    if (this.#active !== attempt || this.#publishing) return;
    try {
      if (!this.#disabled && !this.#closing)
        await this.#drainCleanup(attempt.vault, attempt.id);
      if (!this.#publishing) this.#release(attempt);
    } catch {
      if (!this.#publishing) this.#quarantine(attempt);
    }
  }
  #release(attempt: Attempt): void {
    if (!attempt.stopped || attempt.teardownUnknown || this.#active !== attempt)
      return;
    clearTimeout(attempt.deadline);
    clearTimeout(attempt.renewal);
    this.#active = undefined;
  }
  async #find(
    header: string | undefined,
    id: string,
    scope: "rebuild:read" | "rebuild:cancel",
    signal?: AbortSignal,
  ): Promise<{ vault: string; job: CandidateJob }> {
    const identity = this.#authorize(header, scope);
    const configuration = this.#configuration;
    if (this.#publishing) unavailable();
    if (!/^job_[0-9A-HJKMNP-TV-Z]{26}(?![\s\S])/u.test(id))
      throw new RebuildControllerError("BUILD_NOT_FOUND");
    const until = performance.now() + SUBMISSION;
    // v1 has no caller-selected vault: only configured, currently granted
    // namespaces are visited, never a cross-vault/raw-key global lookup.
    for (const source of configuration.sources) {
      if (configuration !== this.#configuration || this.#publishing)
        unavailable();
      if (!identity.grants.get(source.handle)?.has(scope)) continue;
      try {
        const job = await this.#call(
          (s) => {
            if (configuration !== this.#configuration || this.#publishing)
              unavailable();
            return this.#store(source.handle).readJob(id, s);
          },
          { until, ...(signal ? { signal } : {}) },
        );
        if (
          configuration !== this.#configuration ||
          this.#publishing ||
          job.jobId !== id
        )
          unavailable();
        return { vault: source.handle, job };
      } catch (error) {
        if (
          !(error instanceof CandidateStoreError) ||
          error.code !== "NOT_FOUND"
        )
          unavailable();
      }
    }
    throw new RebuildControllerError("BUILD_NOT_FOUND");
  }
  async status(
    request: Readonly<{
      authorization: string | undefined;
      jobId: string;
      signal?: AbortSignal;
    }>,
  ): Promise<{ vault: string; job: CandidateJob }> {
    return await this.#find(
      request.authorization,
      request.jobId,
      "rebuild:read",
      request.signal,
    );
  }
  async cancel(
    request: Readonly<{
      authorization: string | undefined;
      jobId: string;
      signal?: AbortSignal;
    }>,
  ): Promise<CandidateJob> {
    const until = performance.now() + SUBMISSION;
    const configuration = this.#configuration;
    const found = await this.#find(
      request.authorization,
      request.jobId,
      "rebuild:cancel",
      request.signal,
    );
    this.#authorize(request.authorization, "rebuild:cancel", found.vault);
    if (
      this.#publishing ||
      this.#closing ||
      configuration !== this.#configuration
    )
      unavailable();
    if (found.job.state === "cancelled") return found.job;
    if (terminal(found.job)) throw new RebuildControllerError("BUILD_CONFLICT");
    const attempt = this.#active;
    if (
      !attempt ||
      attempt.id !== request.jobId ||
      attempt.vault !== found.vault
    )
      unavailable();
    let job: CandidateJob;
    try {
      job = await this.#call(
        (s) => {
          if (configuration !== this.#configuration || this.#publishing)
            throw new BeforeDispatchError();
          return this.#store(found.vault).requestCancel(attempt.id, s);
        },
        {
          until,
          ...(request.signal ? { signal: request.signal } : {}),
        },
      );
    } catch (error) {
      if (beforeDispatch(error)) unavailable();
      const observed = await this.#observe(
        attempt,
        (o) => o.job.state === "cancelling",
      );
      if (!observed) {
        attempt.abort.abort();
        unavailable();
      }
      job = observed.job;
    }
    if (
      job.jobId !== attempt.id ||
      job.buildId !== attempt.recipe.buildId ||
      job.sourceCommit !== attempt.recipe.sourceCommit
    ) {
      this.#quarantine(attempt);
      unavailable();
    }
    if (job.state === "cancelling") attempt.cancelConfirmed = true;
    else if (terminal(job)) attempt.terminal = true;
    else {
      this.#quarantine(attempt);
      unavailable();
    }
    this.#stop(attempt, "INTERRUPTED");
    if (job.state !== "cancelling" && job.state !== "cancelled")
      throw new RebuildControllerError("BUILD_CONFLICT");
    return job;
  }
  async #boundedWait(
    task: Promise<unknown>,
    milliseconds: number,
  ): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        task.catch(() => undefined),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, milliseconds);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  /** Publication interlock: close admission before waiting for the one claim,
   * fence all namespaces before publishing a new immutable auth/source snapshot.
   * Namespace additions/removals require replacement startup/supervision. */
  async reload(value: ControllerConfiguration): Promise<void> {
    const next = snapshot(value);
    if (
      next.epoch <= this.#configuration.epoch ||
      next.sources.length !== this.#configuration.sources.length ||
      next.sources.some(
        (s) =>
          this.#configuration.sources.find((old) => old.handle === s.handle)
            ?.projection.vaultUid !== s.projection.vaultUid,
      )
    )
      throw new TypeError("Controller configuration is invalid.");
    if (this.#publishing || this.#closing || !this.#started) unavailable();
    this.#publishing = true;
    this.#generation.abort();
    const attempt = this.#active;
    if (attempt) {
      attempt.abort.abort();
      clearTimeout(attempt.renewal);
    }
    try {
      if (this.#preflightTask)
        await this.#boundedWait(this.#preflightTask, 9000);
      if (this.#claimTask) await this.#boundedWait(this.#claimTask, 2500);
      if (attempt?.worker) await this.#boundedWait(attempt.worker, 2500);
      await this.#initialize(next); // interrupts queued too, never resumes
      if (attempt) {
        attempt.fenced = true;
        if (!attempt.stopped || attempt.teardownUnknown)
          this.#quarantine(attempt);
        else this.#release(attempt);
      }
      if (this.#preflight) this.#quarantine();
      if (!this.#disabled) await this.#cleanupRetained(next);
      this.#configuration = next;
      this.#authenticate = createServiceAuthentication(next.tokens);
      this.#rates.clear();
      this.#generation = new AbortController();
    } catch {
      // Publication failure disables the controller even if a pre-dispatch claim
      // already released the captured attempt. Stale-worker guards stay local.
      this.#quarantine();
      unavailable();
    } finally {
      this.#publishing = false;
    }
  }
  shutdown(): Promise<void> {
    this.#shutdown ??= this.#shutdownOwned();
    return this.#shutdown;
  }
  async #shutdownOwned(): Promise<void> {
    this.#closing = true;
    this.#admitting = false;
    this.#generation.abort();
    const attempt = this.#active;
    if (attempt) {
      attempt.abort.abort();
      clearTimeout(attempt.deadline);
      clearTimeout(attempt.renewal);
    }
    if (this.#preflightTask) await this.#boundedWait(this.#preflightTask, 9000);
    if (this.#claimTask) await this.#boundedWait(this.#claimTask, 2500);
    if (attempt) {
      attempt.stopCode ??= "INTERRUPTED";
      await this.#finish(attempt);
    }
  }
}

/** Deployment composition only. Startup/runtime qualification never occurs in a
 * handler and there is no default/structural process-death confirmation. */
export async function createOwnedRebuildController(
  options: Readonly<{
    runtimeIdentityFile: string;
    configuration: ControllerConfiguration;
    stores: ReadonlyMap<string, RedisCandidateStore>;
    confirmPreviousWorkersStopped: () => Promise<void>;
  }>,
): Promise<OwnedRebuildController> {
  const initial = snapshot(options.configuration);
  let current = () => initial;
  const builder = await createTrustedLexicalBuilder({
    runtimeIdentityFile: options.runtimeIdentityFile,
    tokens: () => current().tokens,
    configuration: () => {
      const { epoch, sources } = current();
      return { epoch, sources };
    },
  });
  const controller = new OwnedRebuildController({
    configuration: initial,
    stores: options.stores,
    builder,
  });
  current = () => controller.configuration;
  await controller.start(options.confirmPreviousWorkersStopped);
  return controller;
}
