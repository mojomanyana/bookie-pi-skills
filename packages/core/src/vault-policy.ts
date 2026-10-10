import { setImmediate as yieldToEventLoop } from "node:timers/promises";

import { throwIfAborted } from "./vault-cancellation.js";
import { createDiagnostic, DiagnosticCollector } from "./vault-diagnostics.js";
import type {
  BookieCandidate,
  BookieData,
  BookiePolicySource,
  BookieRecord,
  Manifest,
  Relation,
  SchemaValidators,
} from "./vault-model.js";

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function trustedPolicySource(
  path: string,
  displayFile: string,
  type: string,
  frontmatter: Readonly<Record<string, unknown>>,
  bookie: Readonly<Record<string, unknown>>,
): BookiePolicySource {
  const status =
    typeof frontmatter.status === "string" ? frontmatter.status : undefined;
  const profile =
    typeof bookie.profile === "string" ? bookie.profile : undefined;
  const uid = typeof bookie.uid === "string" ? bookie.uid : undefined;
  const project =
    typeof bookie.project === "string" ? bookie.project : undefined;
  const state = typeof bookie.state === "string" ? bookie.state : undefined;
  const sensitivity =
    typeof bookie.sensitivity === "string" ? bookie.sensitivity : undefined;
  const sha256 = typeof bookie.sha256 === "string" ? bookie.sha256 : undefined;
  let relations: BookieData["relations"];
  if (Array.isArray(bookie.relations)) {
    const trusted = [];
    let malformed = false;
    for (const relation of bookie.relations) {
      if (
        !isObject(relation) ||
        typeof relation.kind !== "string" ||
        typeof relation.target !== "string" ||
        (relation.target_uid !== undefined &&
          typeof relation.target_uid !== "string")
      ) {
        malformed = true;
        break;
      }
      trusted.push({
        kind: relation.kind,
        target: relation.target,
        ...(relation.target_uid === undefined
          ? {}
          : { target_uid: relation.target_uid }),
      });
    }
    if (!malformed) relations = trusted;
  }
  const supports =
    Array.isArray(bookie.supports) &&
    bookie.supports.every((support) => typeof support === "string")
      ? bookie.supports
      : undefined;
  return {
    path,
    displayFile,
    type,
    ...(status === undefined ? {} : { status }),
    frontmatter,
    bookie: {
      ...(profile === undefined ? {} : { profile }),
      ...(uid === undefined ? {} : { uid }),
      ...(project === undefined ? {} : { project }),
      ...(state === undefined ? {} : { state }),
      ...(sensitivity === undefined ? {} : { sensitivity }),
      ...(relations === undefined ? {} : { relations }),
      ...(supports === undefined ? {} : { supports }),
      ...(sha256 === undefined ? {} : { sha256 }),
    },
  };
}

const inverseKinds = new Map<string, string>([
  ["relates_to", "relates_to"],
  ["blocks", "blocked_by"],
  ["blocked_by", "blocks"],
]);
const YIELD_EVERY_OPERATIONS = 1_024;

function relationInverse(kind: string, sourceType: string): string | undefined {
  const direct = inverseKinds.get(kind);
  if (direct !== undefined) return direct;
  if (sourceType === "Decision" && kind === "supersedes") {
    return "superseded_by";
  }
  if (sourceType === "Decision" && kind === "superseded_by") {
    return "supersedes";
  }
  return undefined;
}

function asRelations(bookie: {
  readonly relations?: readonly Relation[];
}): readonly Relation[] {
  return bookie.relations ?? [];
}

function relationKey(kind: string, target: string): string {
  return `${kind}\0${target}`;
}

export function validateCandidateIdentity(
  candidates: readonly BookieCandidate[],
  manifest: Manifest | undefined,
  validators: SchemaValidators,
  collector: DiagnosticCollector,
): void {
  const uids = new Set<string>();
  for (const candidate of candidates) {
    if (!validators.conceptPathPattern.test(candidate.path)) {
      collector.add(createDiagnostic("CONCEPT-PATH", candidate.displayFile));
    }
    if (
      manifest !== undefined &&
      candidate.profile !== undefined &&
      candidate.type !== undefined &&
      !manifest.allowed_concept_types.includes(candidate.type)
    ) {
      collector.add(createDiagnostic("TYPE-ALLOWED", candidate.displayFile));
    }
    if (candidate.uid !== undefined) {
      if (uids.has(candidate.uid)) {
        collector.add(createDiagnostic("UID-UNIQUE", candidate.displayFile));
      } else {
        uids.add(candidate.uid);
      }
    }
  }
}

export async function validateCurrentTree(
  records: readonly BookieRecord[],
  collector: DiagnosticCollector,
  signal?: AbortSignal,
  sources: readonly BookiePolicySource[] = records,
): Promise<void> {
  const byPath = new Map(records.map((record) => [record.path, record]));
  const validPaths = new Set(byPath.keys());
  const relationsByPath = new Map<string, readonly Relation[]>();
  const edgeIndex = new Map<
    string,
    ReadonlyMap<string, { count: number; readonly first: Relation }>
  >();
  const incomingDecisionReplacements = new Map<string, number>();
  let operations = 0;

  const checkpoint = async (): Promise<void> => {
    throwIfAborted(signal);
    operations += 1;
    if (operations % YIELD_EVERY_OPERATIONS === 0) {
      await yieldToEventLoop();
      throwIfAborted(signal);
    }
  };

  for (const record of records) {
    await checkpoint();
    const relations = asRelations(record.bookie);
    relationsByPath.set(record.path, relations);
    const byEdge = new Map<
      string,
      { count: number; readonly first: Relation }
    >();
    for (const relation of relations) {
      await checkpoint();
      const key = relationKey(relation.kind, relation.target);
      const matching = byEdge.get(key);
      if (matching === undefined)
        byEdge.set(key, { count: 1, first: relation });
      else matching.count += 1;
    }
    edgeIndex.set(record.path, byEdge);
  }

  const matchingEdges = (
    path: string,
    kind: string,
    target: string,
  ): { readonly count: number; readonly first?: Relation } =>
    edgeIndex.get(path)?.get(relationKey(kind, target)) ?? { count: 0 };

  for (const source of sources) {
    await checkpoint();
    const sourceRelations = asRelations(source.bookie);
    const projectPath = source.bookie.project;
    if (projectPath !== undefined) {
      const project = byPath.get(projectPath);
      if (project === undefined || project.type !== "Project") {
        collector.add(createDiagnostic("PROJECT-TARGET", source.displayFile));
      }
    }

    const seen = new Set<string>();
    let correctionEdges = 0;
    for (const relation of sourceRelations) {
      await checkpoint();
      const logicalKey = relationKey(relation.kind, relation.target);
      if (seen.has(logicalKey)) {
        collector.add(createDiagnostic("RELATION-TARGET", source.displayFile));
      }
      seen.add(logicalKey);
      if (relation.kind === "supersedes") correctionEdges += 1;

      const target = byPath.get(relation.target);
      if (target === undefined) {
        collector.add(createDiagnostic("RELATION-TARGET", source.displayFile));
        if (source.type === "Decision" && relation.kind === "supersedes") {
          collector.add(
            createDiagnostic("DECISION-SUPERSESSION", source.displayFile),
          );
        }
        continue;
      }
      if (
        relation.target_uid !== undefined &&
        relation.target_uid !== target.bookie.uid
      ) {
        collector.add(createDiagnostic("RELATION-TARGET", source.displayFile));
      }

      if (relation.kind === "supersedes" || relation.kind === "superseded_by") {
        const correction =
          relation.kind === "supersedes" &&
          (source.type === "Activity" || source.type === "Evidence") &&
          target.type === source.type &&
          source.bookie.project === target.bookie.project;
        const decision =
          source.type === "Decision" && target.type === "Decision";
        if ((!correction && !decision) || target === source) {
          collector.add(
            createDiagnostic("RELATION-TARGET", source.displayFile),
          );
        }
      }

      const inverse = relationInverse(relation.kind, source.type);
      if (inverse !== undefined) {
        const matches = matchingEdges(target.path, inverse, source.path);
        const cachedUidValid =
          matches.first?.target_uid === undefined ||
          (source.bookie.uid !== undefined &&
            matches.first.target_uid === source.bookie.uid);
        if (matches.count !== 1 || !cachedUidValid) {
          collector.add(
            createDiagnostic("RELATION-INVERSE", source.displayFile),
          );
        }
      }

      if (source.type === "Decision" && relation.kind === "supersedes") {
        incomingDecisionReplacements.set(
          target.path,
          (incomingDecisionReplacements.get(target.path) ?? 0) + 1,
        );
        const reciprocal = matchingEdges(
          target.path,
          "superseded_by",
          source.path,
        );
        if (
          !validPaths.has(source.path) ||
          source.status !== "stable" ||
          source.bookie.state !== "accepted" ||
          target.type !== "Decision" ||
          target.bookie.project !== source.bookie.project ||
          target.status !== "deprecated" ||
          target.bookie.state !== "superseded" ||
          reciprocal.count !== 1
        ) {
          collector.add(
            createDiagnostic("DECISION-SUPERSESSION", source.displayFile),
          );
        }
      }
    }

    if (
      (source.type === "Activity" || source.type === "Evidence") &&
      correctionEdges > 1
    ) {
      collector.add(createDiagnostic("RELATION-TARGET", source.displayFile));
    }

    const predecessorLinks = sourceRelations.filter(
      (relation) => relation.kind === "superseded_by",
    );
    if (
      source.type === "Decision" &&
      (source.bookie.state === "superseded" || predecessorLinks.length > 0)
    ) {
      const links = predecessorLinks;
      const replacement = byPath.get(links[0]?.target ?? "");
      const replacementEdges =
        replacement === undefined
          ? { count: 0 }
          : matchingEdges(replacement.path, "supersedes", source.path);
      if (
        !validPaths.has(source.path) ||
        source.status !== "deprecated" ||
        links.length !== 1 ||
        replacement === undefined ||
        replacement.type !== "Decision" ||
        replacement.bookie.project !== source.bookie.project ||
        replacement.status !== "stable" ||
        replacement.bookie.state !== "accepted" ||
        replacementEdges.count !== 1
      ) {
        collector.add(
          createDiagnostic("DECISION-SUPERSESSION", source.displayFile),
        );
      }
    }

    if (source.type === "Evidence") {
      for (const support of source.bookie.supports ?? []) {
        await checkpoint();
        if (!byPath.has(support)) {
          collector.add(
            createDiagnostic("EVIDENCE-SUPPORT", source.displayFile),
          );
        }
      }
    }
  }

  for (const [path, count] of incomingDecisionReplacements) {
    await checkpoint();
    if (count > 1) {
      collector.add(
        createDiagnostic(
          "DECISION-SUPERSESSION",
          byPath.get(path)?.displayFile ?? "/bookie.yaml",
        ),
      );
    }
  }

  const decisionEdges = new Map<string, readonly string[]>(
    records
      .filter((record) => record.type === "Decision")
      .map((record) => [
        record.path,
        (relationsByPath.get(record.path) ?? [])
          .filter((relation) => relation.kind === "supersedes")
          .map((relation) => relation.target),
      ]),
  );
  const colors = new Map<string, 1 | 2>();
  const cyclicPaths = new Set<string>();
  for (const start of decisionEdges.keys()) {
    await checkpoint();
    if (colors.has(start)) continue;
    const stack: Array<{
      readonly path: string;
      readonly targets: readonly string[];
      index: number;
    }> = [{ path: start, targets: decisionEdges.get(start) ?? [], index: 0 }];
    colors.set(start, 1);

    while (stack.length > 0) {
      await checkpoint();
      const current = stack.at(-1);
      if (current === undefined) break;
      if (current.index >= current.targets.length) {
        colors.set(current.path, 2);
        stack.pop();
        continue;
      }
      const target = current.targets[current.index];
      current.index += 1;
      if (target === undefined || !decisionEdges.has(target)) continue;
      const color = colors.get(target);
      if (color === 1) {
        const cycleStart = stack.findIndex((entry) => entry.path === target);
        for (const entry of stack.slice(Math.max(0, cycleStart))) {
          cyclicPaths.add(entry.path);
        }
      } else if (color === undefined) {
        colors.set(target, 1);
        stack.push({
          path: target,
          targets: decisionEdges.get(target) ?? [],
          index: 0,
        });
      }
    }
  }
  for (const path of cyclicPaths) {
    collector.add(
      createDiagnostic(
        "DECISION-SUPERSESSION",
        byPath.get(path)?.displayFile ?? "/bookie.yaml",
      ),
    );
  }
}
