# ADR-0005: Use yaml v2 Document AST with retained source bytes

## Status

Accepted

## Context

Bookie must parse YAML 1.2 frontmatter in Node.js while preserving unknown fields, comments, key order, scalar styles, and untouched Markdown body bytes. It must also report bounded, source-located diagnostics for malformed or hostile input. Converting YAML directly to plain objects and stringifying those objects loses source structure and weakens REQ-004.

OQ-002 required a maintained TypeScript implementation and an update strategy before lossless core loading could begin. A fixture-corpus benchmark found that `yaml` v2 parsed every profile frontmatter document. Its Document API preserved comments, ordering, quoting, and literal/folded scalar styles in a synthetic mutation, but `Document#toString()` was not byte-identical for any of the 16 existing example/valid-vault frontmatter documents because it normalized flow spacing or layout. Therefore an AST alone is insufficient for lossless no-op round trips.

## Decision

Use the maintained `yaml` v2 major line in `@bookie/core` with strict YAML 1.2 `parseDocument()` behavior and source-location support.

The loader retains the original validated UTF-8 source and separates frontmatter from the Markdown body without normalizing line endings. A no-op serialization returns the original bytes. Future mutations will edit the parsed Document AST rather than reconstructing mappings from typed plain objects, then serialize only changed frontmatter while appending the original body bytes.

The loader retains the parsed Document, envelope offsets, and original bytes in private state keyed by the loader-owned concept object. The public core API exposes decoded frontmatter values and Bookie-owned diagnostic types, not `yaml` AST types. Parser exceptions, duplicate/non-string keys, unsupported YAML features, non-mapping roots, unsafe integers, non-finite numbers, aliases, configured byte/depth limits, and malformed envelopes map to stable Bookie diagnostics. Input is decoded fatally as UTF-8 before YAML values are trusted.

Synchronous single-concept loading is protected by a 1 MiB default byte limit, a YAML depth limit of 64, and a near-limit hostile-input regression budget of five seconds on the supported Node baseline. Bulk/untrusted CLI and service ingestion must run parsing in a cancellable worker or process with a caller deadline; the synchronous library cannot honestly claim mid-parse cancellation.

Pin the supported major, update through the repository dependency procedure, and rerun golden no-op, mutation-fidelity, malformed-input, security-boundary, and performance tests on parser upgrades.

## Consequences

### Positive

- One maintained TypeScript library supplies YAML 1.2 parsing, a mutable document model, comments, ranges, and line/column support.
- Raw-source passthrough makes unchanged concepts byte-identical, including CRLF and Markdown bodies.
- AST mutation can preserve unknown nodes, order, comments, and scalar styles without exposing a parser-specific public contract.
- The choice fits the shared Node.js core from ADR-0004.

### Negative

- Changed frontmatter may have whitespace or wrapping normalized by the serializer even when its semantic content and source metadata are preserved.
- Retaining source plus AST/value views increases per-document memory.
- `yaml` parses synchronously, so Bookie must enforce input bounds and catch parser failures; a library alone does not provide a wall-clock deadline.
- `@bookie/core` gains a runtime dependency and must track its security and compatibility updates.

## Alternatives considered

- **`js-yaml` value load/dump:** simpler and faster, but its ordinary API discards comments, source ranges, ordering metadata, and scalar presentation, so it fails the preservation driver.
- **Custom CST/source-range patching:** can minimize changed bytes, but safe insertion, deletion, flow collections, comments, block scalars, and Unicode offsets would make Bookie maintain a YAML editor. This is not justified by the current contract.
- **A wrapper such as `enhanced-yaml`:** adds another dependency and a smaller maintenance surface on top of the selected parser without eliminating the need to retain raw body/source bytes.
- **Do nothing:** avoids a dependency but leaves BK-006 blocked and cannot satisfy REQ-004 or REQ-010.

## Validation

The original selection experiment parsed all 16 example/valid-vault concepts; direct Document serialization was exact for 0 of 16 frontmatter sources. Its synthetic mutation retained comments, ordering, quoting, unknown nodes and scalar styles. BK-025 retired that dependency-only experiment after production coverage was established. [Core loader tests](../../../packages/core/test/concept-loader.test.mjs) pin byte-identical LF/CRLF/no-final-newline serialization, malformed/security boundaries, source ranges and hostile-input bounds. [Core mutation tests](../../../packages/core/test/concept-mutation.test.mjs) preserve comments, unknown fields, body bytes, quoting, literal/folded styles and their decoded values through the real API.

## Revisit triggers

Reconsider CST/range patching or another maintained parser if a golden mutation drops or relocates protected comments, order, unknown fields, or multiline scalar style; if byte-stable untouched frontmatter within a changed concept becomes a requirement; if `yaml` v2 is no longer maintained; or if bounded corpus benchmarks exceed the core's accepted ingestion limits. Raw source retention keeps replacement reversible.
