---
name: bookie-continuity
description: Keep a compact task checkpoint and retrieve exact decisions or evidence when continuing, handing off, or recovering work. Use optional Bookie tools within an already selected project; works with a session note when Bookie is absent.
license: MIT
compatibility: Pi; Bookie is optional. No Principal, Pi Daddy, Scout, JEV, service, or provider dependency.
---

# Task continuity

Keep the user's outcome in view across interruptions, roles and repositories. Use a short checkpoint when it prevents repeated questions or repeated work. Do not add a memory step to a simple task that already has enough context.

## Keep one compact checkpoint

Retain only what the next useful action needs:

- Requested outcome and explicit non-goals.
- Current phase, last settled result and next action.
- Accepted verification routes, their scope and unresolved limitations.
- Scoped user decisions, the original user source reference when available, and any later replacement or revocation.
- Open questions that materially affect the next action.
- Exact artifact, evidence and execution references; fetch bodies only when needed.

Use original references supplied by the source or owning tool. Never invent message IDs, hashes, workspace permissions or approval. If a source lacks a stable reference, identify the observed session/turn or supplied file honestly and mark the locator unavailable.

A saved statement such as “fallback review allowed” is context, not permission. Follow an applicable instruction already present in the trusted conversation. Otherwise inspect the original user instruction through an authorized source before relying on it; ask only when required authority or scope is still unresolved. Memory cannot restore expired tool grants, approve a changed workspace, or authorize a new provider call.

Example: “Outcome: display the imported model. Non-goal: redesign the importer. Verification: user accepted the supplied fixture for this task at <actual source reference>. Live browser check remains missing. Next: inspect the retained result.” This records the permitted route without claiming browser verification or expanding it to another task.

## Save through existing surfaces

When Pi reports that automatic Bookie memory is ready for this folder, use `bookie_remember` for a short routine project decision or handoff. Use the user’s actual choice; if they have not made one, ask before recording it. To recall a choice use `bookie_search` without a vault path. Never substitute a guess from the conversation for a successful lookup.

A later delivery completes a different part of the task. When giving the user a public resource, call `bookie_remember` with the task name, a short summary, and its exact `deliveryUrl` before sharing the link. A pending receipt is published only if that URL appears in the completed reply. On resumption search for the topic and for "shared resource", check related receipts and distinguish the original plan from what Pi delivered. A recap reuses the original receipt. If a delivery record is missing, say what the memory establishes and leave the user’s next choice open.

For a structured checkpoint in an explicitly selected project, reuse its Activity checkpoint workflow. Read [the fragment recipe](references/checkpoint-recipe.md) only when preparing a save. Existing session/project routine-capture permission permits matching summaries without repeated confirmation; ordinary writes and disclosure remain separate permissions. Save at a meaningful boundary or on request, not after every tool call.

Keep producer output in its owner's store. Record exact Scout research, Daddy execution or Harness evaluation references instead of copying their transcripts into a new Activity. Mark historical observations, partial output and missing evidence honestly. Do not infer task acceptance from a source hash, test exit, JEV advice or stored summary.

Without Bookie, selected-project access, or a needed tool, continue from a concise session note or an already authorized project-local note. Preserve useful work; mention the unavailable memory capability once. Do not scan home directories, initialize a vault, enable a service, request broad access, or build a replacement memory system to complete an unrelated task.

## Retrieve for a concrete need

Before repeating a question or rerunning work, check the compact checkpoint for a relevant accepted route or settled result. Resolve only the required exact reference, under current scope and destination permission. With Bookie, prepare/read that selected concept through `bookie_context_prepare` and `bookie_context_read`; reuse a live exact handle when it remains applicable. Complete source metadata is evidence identity, not proof of semantic correctness.

For a request that branches on whether prior work exists, proceed with first-time research only after a successful, complete search with no relevant notes. If recall is blocked or incomplete, report that the history is unknown and stop before that branch. Do not substitute a similarly named record or use a shell/other tool to bypass denied Bookie disclosure. Use the still-valid conversation/local note and independent authorized work; explain the specific missing input only if it blocks the next action. A possibly completed write with withheld confirmation is not a safe retry: inspect the known target before any new save.

Bookie absence must not prevent the domain skill from working. Daddy owns execution settlement and permissions; Scout supplies research evidence; Harness evaluates behavior. Optional JEV may advise whether retrieval or another check is useful when already enabled, but cannot approve actions or bypass these controls.

When saving the handoff, name the specific choice the user still owns in `openChoice`, if one exists. For a single delivered resource, a separate `Open choice: …` line in the final reply also records it under Unresolved work. Give each real alternative its own short label in `choiceOptions`. Use the number that fits the decision. When the evidence favors one, give the option, a concrete reason and its supporting quote from the note or delivered URL in `choiceRecommendation`. For example, a workshop brief asking participants to practise grid references supports a map with an index grid. A preference without supporting evidence can stay unranked. After the user answers in the dashboard, recall their recorded decision on resumption.
