# ADR-0023: Correct an item that is not a separate decision

- Status: Accepted for the owner-authorized choice-quality batch on 2026-11-19.
- Scope: SPEC-003, BK-054; extends ADR-0016 and ADR-0021. Core stays 0.3.0.

The authenticated dashboard may offer **Not a separate decision** for a saved open
item. After human confirmation, Bookie appends an Activity classification linked to
the exact source note and revision. It removes only that item from Open choices.
The source remains ordinary retrievable memory; this action neither answers a
question nor deletes, edits, merges or resolves any other record.

The optional `reclassify(id, revision, assertCurrent)` callback extends the existing
host-only choice controls. Older Daddy hosts ignore it. No model tool can invoke
the correction. Current project, disclosure, owner and source checks apply before
and inside publication. Correction and answering use the same host queue and
recheck both slots under core's cross-process vault writer lock. Concurrent updated
writers can publish only one disposition. Repeated identical correction is
idempotent; a changed source, occupied conflicting slot or lost access refuses.

Store `classification-<choice digest>.md` beside existing managed notes and answers,
with `choice-reclassification` tag and `bookie.choice_classification` linking source,
revision and `kind: context`. Source and classification bytes are checked before
reporting `choiceDisposition.status: not-a-decision`. This metadata is separate from
`choiceResolution`, which continues to describe a real answer. An old extension can
still read the Activity but does not understand the correction and may offer the
old question again. An older writer cannot be made to honor the new slot; if both
records exist, the updated reader reports a classification conflict and preserves
the actual answer rather than pretending either record did not happen.

Do not classify natural-language questions heuristically. Existing free-form,
multilingual, legacy and compound questions remain eligible. New authoring guidance
records each genuine decision once and puts references to existing decisions in a
progress summary. This does not guarantee that every model authors a perfect choice;
explicit correction supplies the repair without inferred answers or hidden history.

Qualification covers exact correction and fresh-session recall, unaffected answers
and questions, stale/revoked controls, repeated requests, two-process arbitration,
mixed-host compatibility and affected existing suites. No provider or JEV call is
needed. Delivery is tracked separately from implementation and local validation.
