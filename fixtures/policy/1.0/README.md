# Profile 1.0 cross-file policy fixtures

These fixtures define base/proposed tree cases for the named rules in [SPEC-001](../../../docs/specs/001-canonical-ledger.md#named-cross-file-policy-rules). They are contract data, not a production validator.

- `valid/cases.json` and `invalid/cases.json` contain enumerated cases with expected rule codes.
- Each concept descriptor names a decoded fixture from `fixtures/concepts/1.0/valid`, applies a recursive object patch (arrays and scalar values replace), and supplies its body. The oracle renders the complete patched frontmatter as flow-style YAML between delimiters, producing deterministic exact UTF-8 Markdown bytes for immutability comparison.
- Each resource descriptor maps a bundle path to exact bytes under `resources/`; `kind` defaults to `regular` and can model a rejected filesystem kind such as `symlink`.
- Each case supplies the evidence roots and attachment byte limit used by its proposed tree.

`test/policy-contract.test.mjs` materializes every tree, schema-validates every decoded concept, evaluates a small fixture oracle, and checks exact UTF-8, CRLF, and binary digests. SPEC-002 must run the same cases through the production vault and Git-base validators; this fixture oracle is not exported from `pi-bookie-core`.
