// Test component, also serialized into immutable-image drivers. Mutations commit
// BEFORE the reply boundary; losing a reply never erases its side effects.
// It retains S6's checked cancellation contract, not merely its happy-path API.
// No runtime/source approval is supplied by this fake.
export function memoryCandidateStore(
  CandidateStoreError,
  parseOutputDescriptor,
) {
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
    payloads = new Map();
    active = null;
    previous = null;
    readers = new Set();
    calls = [];
    preflight(signal) {
      if (signal?.aborted)
        throw new DOMException("Candidate operation cancelled.", "AbortError");
    }
    protect(build) {
      if (
        this.active === build ||
        this.previous === build ||
        this.readers.has(build)
      )
        throw new CandidateStoreError("BUILD_CONFLICT");
    }
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
        !["current", "inspect", "read", "verify", "verifyPage"].includes(op),
      );
    }
    async startProcess(signal) {
      this.preflight(signal);
      this.epoch++;
      for (const [id, job] of this.jobs)
        if (!["failed", "cancelled", "complete"].includes(job.state))
          this.terminal(id, "failed", "INTERRUPTED");
      return await this.result("start", this.epoch, signal);
    }
    async setConfigurationEpoch(epoch, signal) {
      this.preflight(signal);
      if (epoch < this.configurationEpoch)
        throw new CandidateStoreError("FENCED");
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
      if (manifest)
        this.manifests.set(id, {
          ...manifest,
          state,
          ...(["failed", "cancelled"].includes(state) ? { live: false } : {}),
        });
    }
    owned(lease) {
      const m = this.manifests.get(lease.jobId);
      if (
        !m ||
        this.current !== lease.jobId ||
        this.jobs.get(lease.jobId)?.state !== m.state ||
        lease.ownerEpoch !== this.epoch ||
        lease.configurationEpoch !== this.configurationEpoch ||
        ["jobId", "buildId", "ownerEpoch", "fence", "configurationEpoch"].some(
          (k) => m.lease[k] !== lease[k],
        ) ||
        !m.live
      )
        throw new CandidateStoreError("FENCED");
      this.protect(lease.buildId);
      return m;
    }
    async claimInput(recipe, jobId, signal) {
      this.preflight(signal);
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
      this.protect(recipe.buildId);
      if (
        [...this.manifests.values()].some(
          (m) => m.lease.buildId === recipe.buildId,
        )
      )
        throw new CandidateStoreError("BUILD_CONFLICT");
      const lease = Object.freeze({
        ownerEpoch: this.epoch,
        fence: this.jobs.size + 1,
        configurationEpoch: recipe.configurationEpoch,
        jobId,
        buildId: recipe.buildId,
      });
      this.current = jobId;
      this.payloads.set(jobId, { concept: new Map(), chunk: new Map() });
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
            this.current === id &&
            !["failed", "cancelled", "complete"].includes(m.state) &&
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
      this.preflight(signal);
      const m = this.owned(lease);
      if (!["queued", "building"].includes(m.state))
        throw new CandidateStoreError("FENCED");
      this.terminal(lease.jobId, "building", null);
      await this.result("begin", undefined, signal);
    }
    async attachOutput(lease, descriptor, signal) {
      this.preflight(signal);
      const m = this.owned(lease);
      if (m.state !== "building") throw new CandidateStoreError("FENCED");
      const parsed = parseOutputDescriptor(descriptor.serialized);
      if (parsed.hash !== descriptor.hash)
        throw new TypeError("Candidate input is invalid.");
      if (
        m.outputDescriptor &&
        m.outputDescriptor.serialized !== descriptor.serialized
      )
        throw new CandidateStoreError("BUILD_CONFLICT");
      if (JSON.parse(descriptor.serialized)[2] !== m.recipeHash)
        throw new CandidateStoreError("BUILD_CONFLICT");
      this.manifests.set(lease.jobId, {
        ...m,
        outputDescriptor: Object.freeze({ ...descriptor }),
      });
      await this.result("attach", undefined, signal);
    }
    async append(lease, kind, offset, records, signal) {
      this.preflight(signal);
      const m = this.owned(lease);
      if (m.state !== "building" || !m.outputDescriptor)
        throw new CandidateStoreError("FENCED");
      const d = JSON.parse(m.outputDescriptor.serialized);
      const field = kind === "concept" ? "nextConcept" : "nextChunk";
      const rows = records.map((row) => JSON.stringify(row));
      if (
        !["concept", "chunk"].includes(kind) ||
        !Number.isSafeInteger(offset) ||
        records.length < 1 ||
        records.length > 128 ||
        rows.reduce((n, s) => n + Buffer.byteLength(s), 0) > 1048576
      )
        throw new TypeError("Candidate input is invalid.");
      if (
        offset !== m[field] ||
        offset + rows.length > d[kind === "concept" ? 6 : 8]
      )
        throw new CandidateStoreError("BUILD_CONFLICT");
      const stored = this.payloads.get(lease.jobId)[kind];
      if (rows.some((_, i) => stored.has(offset + i)))
        throw new CandidateStoreError("BUILD_CONFLICT");
      rows.forEach((row, i) => stored.set(offset + i, JSON.parse(row)));
      m[field] += rows.length;
      return await this.result("append", m[field], signal);
    }
    async verifyStoredOutput(lease, recipe, descriptor, { signal, timeoutMs }) {
      this.preflight(signal);
      const { createHash } = await import("node:crypto");
      const until = performance.now() + timeoutMs;
      const check = () => {
        this.preflight(signal);
        if (performance.now() >= until)
          throw new CandidateStoreError("INDEX_UNAVAILABLE");
        const m = this.owned(lease);
        if (m.state !== "building") throw new CandidateStoreError("FENCED");
        if (
          m.recipeHash !== recipe.recipeHash ||
          m.outputDescriptor?.serialized !== descriptor.serialized
        )
          throw new CandidateStoreError("BUILD_CONFLICT");
        const d = JSON.parse(descriptor.serialized);
        if (
          m.nextConcept !== d[6] ||
          m.nextChunk !== d[8] ||
          m.cleanupConcept ||
          m.cleanupChunk
        )
          throw new CandidateStoreError("INDEX_UNAVAILABLE");
        return d;
      };
      const d = check(),
        measured = [];
      for (const [kind, count, expected] of [
        ["concept", d[6], d[7]],
        ["chunk", d[8], d[9]],
      ]) {
        const rows = this.payloads.get(lease.jobId)[kind],
          hash = createHash("sha256");
        if (rows.size !== count)
          throw new CandidateStoreError("INDEX_UNAVAILABLE");
        for (let i = 0; i < count; i++) {
          check();
          const row = rows.get(i);
          if (
            !row ||
            row.sourceCommit !== recipe.sourceCommit ||
            row.contentTrust !== "untrusted" ||
            (kind === "chunk" && row.ordinal !== i)
          )
            throw new CandidateStoreError("INDEX_UNAVAILABLE");
          hash.update(JSON.stringify(row)).update("\n");
          if ((i + 1) % 128 === 0) {
            await this.result("verifyPage", undefined, signal);
            check();
          }
        }
        const actual = `sha256:${hash.digest("hex")}`;
        if (actual !== expected)
          throw new CandidateStoreError("INDEX_UNAVAILABLE");
        measured.push(Object.freeze({ count, hash: actual }));
      }
      const result = await this.result(
        "verify",
        Object.freeze({
          lease,
          sourceCommit: recipe.sourceCommit,
          descriptorHash: descriptor.hash,
          concepts: measured[0],
          chunks: measured[1],
        }),
        signal,
      );
      check();
      return result;
    }
    async renew(lease, signal) {
      this.preflight(signal);
      this.owned(lease);
      await this.result("renew", undefined, signal);
    }
    async fail(lease, code, signal) {
      this.preflight(signal);
      const manifest = this.owned(lease);
      if (manifest.state !== "queued" && manifest.state !== "building")
        throw new CandidateStoreError("FENCED");
      this.terminal(lease.jobId, "failed", code);
      return await this.result("fail", this.jobs.get(lease.jobId), signal);
    }
    async requestCancel(id, signal) {
      this.preflight(signal);
      const job = this.jobs.get(id);
      if (!job) throw new CandidateStoreError("NOT_FOUND");
      this.protect(job.buildId);
      if (["failed", "cancelled", "complete"].includes(job.state))
        throw new CandidateStoreError("BUILD_CONFLICT");
      this.terminal(id, "cancelling", null);
      return await this.result("cancel", this.jobs.get(id), signal);
    }
    async acknowledgeCancel(lease, signal) {
      this.preflight(signal);
      if (this.owned(lease).state !== "cancelling")
        throw new CandidateStoreError("FENCED");
      this.terminal(lease.jobId, "cancelled", "CANCELLED");
      return await this.result("ack", this.jobs.get(lease.jobId), signal);
    }
    async cleanup(id, signal) {
      this.preflight(signal);
      const m = this.manifests.get(id);
      if (!m)
        return await this.result("cleanup", { done: true, removed: 0 }, signal);
      this.protect(m.lease.buildId);
      if (!["failed", "cancelled"].includes(m.state))
        throw new CandidateStoreError("BUILD_CONFLICT");
      const d = m.outputDescriptor
        ? JSON.parse(m.outputDescriptor.serialized)
        : null;
      if (
        !d &&
        (m.nextConcept || m.nextChunk || m.cleanupConcept || m.cleanupChunk)
      )
        throw new CandidateStoreError("INDEX_UNAVAILABLE");
      let removed = 0;
      for (const [kind, total, field] of [
        ["concept", d?.[6] ?? 0, "cleanupConcept"],
        ["chunk", d?.[8] ?? 0, "cleanupChunk"],
      ])
        while (m[field] < total && removed < 128) {
          this.payloads.get(id)?.[kind].delete(m[field]++);
          removed++;
        }
      const done =
        m.cleanupConcept === (d?.[6] ?? 0) && m.cleanupChunk === (d?.[8] ?? 0);
      if (done) {
        this.manifests.delete(id);
        const rows = this.payloads.get(id);
        if (!rows?.concept.size && !rows?.chunk.size) this.payloads.delete(id);
        if (this.current === id) this.current = null;
      }
      return await this.result("cleanup", { done, removed }, signal);
    }
  };
}
