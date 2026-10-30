// Test component, also serialized into immutable-image drivers. Mutations commit
// BEFORE the reply boundary; losing a reply never erases its side effects.
// It retains S6's checked cancellation contract, not merely its happy-path API.
// No runtime/source approval is supplied by this fake.
export function memoryCandidateStore(CandidateStoreError) {
  return class MemoryCandidateStore {
    constructor(vaultUid) {
      this.vaultUid = vaultUid;
    }
    get namespace() {
      return `fixture:${this.vaultUid}`;
    }
    isForVault(uid) {
      return uid === this.vaultUid;
    }
    epoch = 0;
    configurationEpoch = 0;
    current = null;
    jobs = new Map();
    manifests = new Map();
    calls = [];
    reply = async (_op, value) => value;
    async wait(pending, signal, mutating = true) {
      let onAbort = () => {};
      try {
        return await Promise.race([
          pending,
          new Promise((_resolve, reject) => {
            onAbort = () =>
              reject(
                mutating
                  ? new CandidateStoreError("INDEX_UNAVAILABLE", "unknown")
                  : new DOMException(
                      "Candidate operation cancelled.",
                      "AbortError",
                    ),
              );
            signal?.addEventListener("abort", onAbort, { once: true });
            if (signal?.aborted) onAbort();
          }),
        ]);
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
    }
    async result(op, value, signal) {
      this.calls.push(op);
      return await this.wait(
        this.reply(op, value),
        signal,
        !["current", "inspect", "read"].includes(op),
      );
    }
    async startProcess(signal) {
      this.epoch++;
      for (const [id, job] of this.jobs)
        if (!["failed", "cancelled", "complete"].includes(job.state))
          this.terminal(id, "failed", "INTERRUPTED");
      return await this.result("start", this.epoch, signal);
    }
    async setConfigurationEpoch(epoch, signal) {
      this.configurationEpoch = epoch;
      await this.result("configure", undefined, signal);
    }
    async readCurrentJob(signal) {
      return await this.result(
        "current",
        this.current && this.jobs.get(this.current),
        signal,
      );
    }
    terminal(id, state, failureCode) {
      this.jobs.set(id, { ...this.jobs.get(id), state, failureCode });
      const manifest = this.manifests.get(id);
      if (manifest) this.manifests.set(id, { ...manifest, state });
    }
    owned(lease) {
      const m = this.manifests.get(lease.jobId);
      if (
        !m ||
        lease.ownerEpoch !== this.epoch ||
        lease.configurationEpoch !== this.configurationEpoch ||
        JSON.stringify(m.lease) !== JSON.stringify(lease) ||
        !m.live
      )
        throw new CandidateStoreError("FENCED");
      return m;
    }
    async claimInput(recipe, jobId, signal) {
      if (recipe.configurationEpoch !== this.configurationEpoch)
        throw new CandidateStoreError("FENCED");
      const prior = this.current && this.manifests.get(this.current);
      if (prior && !["failed", "cancelled"].includes(prior.state)) {
        if (prior.lease.buildId !== recipe.buildId)
          throw new CandidateStoreError("BUILD_CONFLICT");
        return await this.result(
          "claim",
          { created: false, lease: prior.lease },
          signal,
        );
      }
      const lease = Object.freeze({
        ownerEpoch: this.epoch,
        fence: this.jobs.size + 1,
        configurationEpoch: recipe.configurationEpoch,
        jobId,
        buildId: recipe.buildId,
      });
      this.current = jobId;
      this.jobs.set(jobId, {
        jobId,
        buildId: recipe.buildId,
        sourceCommit: recipe.sourceCommit,
        state: "queued",
        failureCode: null,
      });
      this.manifests.set(jobId, {
        manifestVersion: 2,
        lease,
        recipeHash: recipe.recipeHash,
        sourceCommit: recipe.sourceCommit,
        manifestHash: JSON.parse(recipe.serialized)[7],
        policyHash: recipe.policyHash,
        state: "queued",
        nextConcept: 0,
        nextChunk: 0,
        cleanupConcept: 0,
        cleanupChunk: 0,
        live: true,
      });
      return await this.result("claim", { created: true, lease }, signal);
    }
    async inspectInput(id, signal) {
      const job = this.jobs.get(id);
      if (!job) throw new CandidateStoreError("NOT_FOUND");
      const m = this.manifests.get(id);
      const manifest = m ? { ...m } : null;
      if (manifest) delete manifest.live;
      return await this.result(
        "inspect",
        {
          job,
          manifest,
          live:
            !!m &&
            m.live &&
            m.lease.ownerEpoch === this.epoch &&
            m.lease.configurationEpoch === this.configurationEpoch,
        },
        signal,
      );
    }
    async readJob(id, signal) {
      const job = this.jobs.get(id);
      if (!job) throw new CandidateStoreError("NOT_FOUND");
      return await this.result("read", job, signal);
    }
    async beginBuilding(lease, signal) {
      this.owned(lease);
      this.terminal(lease.jobId, "building", null);
      await this.result("begin", undefined, signal);
    }
    async attachOutput(lease, descriptor, signal) {
      const m = this.owned(lease);
      if (m.state !== "building") throw new CandidateStoreError("FENCED");
      this.manifests.set(lease.jobId, { ...m, outputDescriptor: descriptor });
      await this.result("attach", undefined, signal);
    }
    async renew(lease, signal) {
      this.owned(lease);
      await this.result("renew", undefined, signal);
    }
    async fail(lease, code, signal) {
      const manifest = this.owned(lease);
      if (manifest.state !== "queued" && manifest.state !== "building")
        throw new CandidateStoreError("FENCED");
      this.terminal(lease.jobId, "failed", code);
      return await this.result("fail", this.jobs.get(lease.jobId), signal);
    }
    async requestCancel(id, signal) {
      if (!this.jobs.has(id)) throw new CandidateStoreError("NOT_FOUND");
      this.terminal(id, "cancelling", null);
      return await this.result("cancel", this.jobs.get(id), signal);
    }
    async acknowledgeCancel(lease, signal) {
      this.owned(lease);
      this.terminal(lease.jobId, "cancelled", "CANCELLED");
      return await this.result("ack", this.jobs.get(lease.jobId), signal);
    }
    async cleanup(id, signal) {
      this.manifests.delete(id);
      if (this.current === id) this.current = null;
      return await this.result("cleanup", { done: true, removed: 0 }, signal);
    }
  };
}
