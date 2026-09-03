# Retrieval architecture

## Principle

Retrieval is a projection of an approved Git commit. Deleting every Redis key must lose no canonical information.

## Indexed units

The indexer parses each concept, validates it, and emits:

- one concept projection for metadata and whole-document lookup;
- heading-aware body chunks for lexical and semantic retrieval;
- explicit outgoing typed relations and Markdown links;
- a build manifest identifying Git commit, profile, parser, chunker, and embedding generation.

Each chunk contains concept UID/path/type/project, title, heading path, bounded text, tags, lifecycle/workflow state, trust tier, stale date, source hash, source commit, chunker version, and embedding generation.

## Generation identity

An embedding generation is immutable and includes:

```text
provider + model + provider model revision + dimensions + distance metric
+ document/query input mode + normalization + chunker version + preprocessing version
```

The generation ID is stored in configuration, index names, documents, query logs, and evaluation reports. Query vectors search only their matching generation.

## Provider contract

The first contract separates document and query modes:

```ts
interface EmbeddingProvider {
  identity(): Promise<EmbeddingIdentity>;
  embedDocuments(texts: string[], signal?: AbortSignal): Promise<number[][]>;
  embedQuery(text: string, signal?: AbortSignal): Promise<number[]>;
}
```

Initial implementation planning must support deployment selection among Voyage AI, an OpenAI-compatible service, and Ollama/local models. Credentials and model details are service configuration, never canonical record fields.

## Query pipeline

1. Authenticate and authorize the requested vault.
2. Normalize query and apply project/type/status/sensitivity filters.
3. Run Redis full-text retrieval.
4. Generate a query embedding and run same-generation vector retrieval when available.
5. Retrieve directly linked concepts when requested, with a strict depth and result budget.
6. Fuse independent rankings with reciprocal-rank fusion.
7. Apply deterministic lifecycle, freshness, and trust adjustments.
8. Deduplicate chunks by concept while preserving the best passages.
9. Return bounded excerpts and score explanations.

Semantic failure falls back to lexical retrieval with an explicit degradation field. Empty results are distinguishable from infrastructure failure.

## Local overlay

Core's filesystem query is deliberately simpler than shared retrieval: it scans one bounded safe working-tree snapshot, performs case-sensitive literal title/body matching plus exact metadata filters, omits vault-global sensitivity exclusions, and returns deterministic path order with bounded text and explicit truncation. It reports filesystem/working-tree mode and `commit: null`; without invoking Git it cannot claim the bytes are merged or name a source commit. Missing and undeclared sensitivity values are labelled but gain no indexing or provider approval. Exact inspect is a direct canonical read and may return an excluded record only with restrictive handling metadata.

The Pi extension searches unmerged local files directly and merges those results with shared service results. Local overlay results:

- identify themselves as unmerged;
- do not claim semantic ranking unless a local index exists;
- override a shared result with the same UID only when the local file is modified;
- never enter the shared Redis index before merge.

## Context-safety envelope

Every result presented to a model includes a machine-generated boundary containing source path, commit or local state, trust tier, lifecycle, freshness, and an instruction that the enclosed text is untrusted reference material. Record text cannot modify tool policy or system instructions.

## Index build and cutover

1. Resolve and verify a complete canonical commit.
2. Build into a new namespaced generation.
3. Validate counts, source hashes, dimensions, and required filters.
4. Run the retrieval evaluation set.
5. Mark the generation complete.
6. Atomically change the service's active-generation pointer.
7. Retain the prior generation for rollback.

A partial generation is never served as current.

## Embedding migration

Use expand/migrate/contract:

1. Create a generation for the new provider/model.
2. Continue serving the old complete generation.
3. Backfill every source chunk from canonical text.
4. Shadow-read both generations against a curated query set.
5. Compare recall at ten, result quality, latency, and cost.
6. Cut over through configuration.
7. Keep the old generation for at least seven days or the agreed stabilization window.
8. Remove it only after rollback expiry.

Changing provider and chunking simultaneously is a retrieval redesign and must be evaluated as such.

## Initial index choices

- Use Redis JSON for nested projection metadata.
- Run lexical and vector queries separately and fuse in the service, avoiding a hard dependency on one server-side hybrid command version.
- Begin with exact `FLAT` vector search below 100,000 chunks where measured latency permits it.
- Move to HNSW when corpus size or p95 latency crosses an agreed threshold.
- Traverse direct relations application-side; do not introduce a graph database without a multi-hop benchmark.

## Observability

Return or emit:

- active generation and source Git commit;
- index lag from approved `main`;
- lexical, semantic, and fused result counts;
- per-stage latency and external provider latency;
- degraded-mode reason;
- stale and unverified result counts;
- truncation and result-budget flags;
- rebuild status and rejected concept count.

No query log may contain excluded or secret content. Logging defaults to normalized metadata and hashes rather than full query/result bodies.

## Evaluation gate

The repository shall maintain a small, versioned set of queries, relevant UIDs, and expected filters. A generation is eligible for cutover only when it is complete, passes isolation tests, meets latency budget, and achieves the agreed retrieval threshold. Newer models are not presumed better.
