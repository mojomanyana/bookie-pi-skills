import type {
  ConceptMutationEditInternal,
  LoadedConcept,
  ReadonlyYamlMapping,
  ReadonlyYamlValue,
} from "./concept-loader.js";
import {
  hasLoneSurrogate,
  isObject,
  utf8ByteLength,
} from "./concept-mutation-model.js";
import type {
  AmendConceptRequest,
  FrontmatterPathSegment,
  MutationLimits,
} from "./concept-mutation-model.js";

export interface PreparedAmendment {
  readonly edits: readonly ConceptMutationEditInternal[];
  readonly bodyText?: string;
  readonly changed: boolean;
}

interface CloneBudget {
  remaining: number;
}

export type CloneYamlInputResult =
  | { readonly ok: true; readonly value: ReadonlyYamlValue }
  | { readonly ok: false; readonly reason: "input" | "bounds" };

const MAX_FRONTMATTER_EDITS = 256;

function debitCloneBudget(budget: CloneBudget, amount: number): boolean {
  budget.remaining -= amount;
  return budget.remaining >= 0;
}

function cloneYamlValue(
  value: unknown,
  depth: number,
  limits: MutationLimits,
  seen: WeakSet<object>,
  budget: CloneBudget,
): CloneYamlInputResult {
  if (depth > limits.maxYamlDepth) return { ok: false, reason: "bounds" };
  if (value === null || typeof value === "boolean") {
    return debitCloneBudget(budget, 1)
      ? { ok: true, value }
      : { ok: false, reason: "bounds" };
  }
  if (typeof value === "string") {
    if (hasLoneSurrogate(value)) return { ok: false, reason: "input" };
    return debitCloneBudget(budget, utf8ByteLength(value) + 1)
      ? { ok: true, value }
      : { ok: false, reason: "bounds" };
  }
  if (typeof value === "number") {
    if (
      !Number.isFinite(value) ||
      (Number.isInteger(value) && !Number.isSafeInteger(value))
    ) {
      return { ok: false, reason: "input" };
    }
    return debitCloneBudget(budget, 16)
      ? { ok: true, value }
      : { ok: false, reason: "bounds" };
  }
  if (typeof value !== "object") return { ok: false, reason: "input" };
  if (seen.has(value)) return { ok: false, reason: "input" };
  seen.add(value);

  if (Array.isArray(value)) {
    const keys = Reflect.ownKeys(value).filter((key) => key !== "length");
    if (
      keys.some(
        (key) =>
          typeof key !== "string" ||
          !/^(?:0|[1-9][0-9]*)$/u.test(key) ||
          Number(key) >= value.length,
      ) ||
      keys.length !== value.length
    ) {
      return { ok: false, reason: "input" };
    }
    if (!debitCloneBudget(budget, value.length + 2)) {
      return { ok: false, reason: "bounds" };
    }
    const clone: ReadonlyYamlValue[] = [];
    for (const child of value) {
      const childDepth =
        child !== null && typeof child === "object" ? depth + 1 : depth;
      const result = cloneYamlValue(child, childDepth, limits, seen, budget);
      if (!result.ok) return result;
      clone.push(result.value);
    }
    return { ok: true, value: clone };
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return { ok: false, reason: "input" };
  }
  const clone = Object.create(null) as Record<string, ReadonlyYamlValue>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || hasLoneSurrogate(key)) {
      return { ok: false, reason: "input" };
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      return { ok: false, reason: "input" };
    }
    if (!debitCloneBudget(budget, utf8ByteLength(key) + 2)) {
      return { ok: false, reason: "bounds" };
    }
    const childDepth =
      descriptor.value !== null && typeof descriptor.value === "object"
        ? depth + 1
        : depth;
    const result = cloneYamlValue(
      descriptor.value,
      childDepth,
      limits,
      seen,
      budget,
    );
    if (!result.ok) return result;
    Object.defineProperty(clone, key, {
      value: result.value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return { ok: true, value: clone };
}

function cloneYamlInputWithBudget(
  value: unknown,
  limits: MutationLimits,
  budget: CloneBudget,
): CloneYamlInputResult {
  return cloneYamlValue(value, 1, limits, new WeakSet(), budget);
}

export function cloneYamlInput(
  value: unknown,
  limits: MutationLimits,
  maximumBytes = limits.maxConceptBytes,
): CloneYamlInputResult {
  return cloneYamlInputWithBudget(value, limits, {
    remaining: maximumBytes,
  });
}

function yamlValuesEqual(
  left: ReadonlyYamlValue | undefined,
  right: ReadonlyYamlValue | undefined,
): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => yamlValuesEqual(value, right[index]))
    );
  }
  if (!isObject(left) || !isObject(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.hasOwn(right, key) &&
        yamlValuesEqual(
          left[key] as ReadonlyYamlValue | undefined,
          right[key] as ReadonlyYamlValue | undefined,
        ),
    )
  );
}

function pathIsPrefix(
  left: readonly FrontmatterPathSegment[],
  right: readonly FrontmatterPathSegment[],
): boolean {
  return (
    left.length <= right.length &&
    left.every(
      (segment, index) =>
        typeof segment === typeof right[index] && segment === right[index],
    )
  );
}

function valueAtPath(
  root: ReadonlyYamlMapping,
  path: readonly FrontmatterPathSegment[],
): { readonly exists: boolean; readonly value?: ReadonlyYamlValue } {
  let current: ReadonlyYamlValue = root;
  for (const segment of path) {
    if (Array.isArray(current)) {
      if (
        typeof segment !== "number" ||
        !Number.isSafeInteger(segment) ||
        segment < 0 ||
        segment >= current.length
      ) {
        return { exists: false };
      }
      const value: ReadonlyYamlValue | undefined = current[segment];
      if (value === undefined) return { exists: false };
      current = value;
    } else if (isObject(current)) {
      if (typeof segment !== "string" || !Object.hasOwn(current, segment)) {
        return { exists: false };
      }
      const value: ReadonlyYamlValue | undefined = current[segment] as
        ReadonlyYamlValue | undefined;
      if (value === undefined) return { exists: false };
      current = value;
    } else {
      return { exists: false };
    }
  }
  return { exists: true, value: current };
}

function validEditPath(
  path: unknown,
  maximumDepth: number,
): path is readonly FrontmatterPathSegment[] {
  return (
    Array.isArray(path) &&
    path.length > 0 &&
    path.length <= maximumDepth &&
    path.every(
      (segment) =>
        (typeof segment === "string" && !hasLoneSurrogate(segment)) ||
        (typeof segment === "number" &&
          Number.isSafeInteger(segment) &&
          segment >= 0),
    )
  );
}

export function prepareAmendment(
  concept: LoadedConcept,
  request: AmendConceptRequest,
  limits: MutationLimits,
):
  | { readonly ok: true; readonly amendment: PreparedAmendment }
  | {
      readonly ok: false;
      readonly code: "MUTATION-INPUT" | "MUTATION-BOUNDS";
    } {
  if (!Array.isArray(request.edits)) {
    return { ok: false, code: "MUTATION-INPUT" };
  }
  const hasBody = Object.hasOwn(request, "bodyText");
  if (
    request.edits.length > MAX_FRONTMATTER_EDITS ||
    (request.edits.length === 0 && !hasBody)
  ) {
    return {
      ok: false,
      code:
        request.edits.length > MAX_FRONTMATTER_EDITS
          ? "MUTATION-BOUNDS"
          : "MUTATION-INPUT",
    };
  }
  if (
    hasBody &&
    (typeof request.bodyText !== "string" || hasLoneSurrogate(request.bodyText))
  ) {
    return { ok: false, code: "MUTATION-INPUT" };
  }
  const changedBody =
    hasBody && request.bodyText !== concept.bodyText
      ? request.bodyText
      : undefined;
  const changedBodyBytes =
    changedBody === undefined ? 0 : utf8ByteLength(changedBody);
  if (changedBodyBytes > limits.maxConceptBytes) {
    return { ok: false, code: "MUTATION-BOUNDS" };
  }

  let remainingPreparationBytes = limits.maxConceptBytes - changedBodyBytes;
  const requestedPaths: FrontmatterPathSegment[][] = [];
  for (const requestedEdit of request.edits as readonly unknown[]) {
    if (!isObject(requestedEdit)) {
      return { ok: false, code: "MUTATION-INPUT" };
    }
    const operation = requestedEdit.op;
    const path = requestedEdit.path;
    if (
      (operation !== "set" && operation !== "remove") ||
      !validEditPath(path, limits.maxYamlDepth)
    ) {
      return { ok: false, code: "MUTATION-INPUT" };
    }
    if (
      requestedPaths.some(
        (existing) =>
          pathIsPrefix(existing, path) || pathIsPrefix(path, existing),
      )
    ) {
      return { ok: false, code: "MUTATION-INPUT" };
    }
    for (const segment of path) {
      const segmentBytes =
        typeof segment === "string" ? utf8ByteLength(segment) + 1 : 16;
      if (segmentBytes > remainingPreparationBytes) {
        return { ok: false, code: "MUTATION-BOUNDS" };
      }
      remainingPreparationBytes -= segmentBytes;
    }
    requestedPaths.push([...path]);
  }

  const edits: ConceptMutationEditInternal[] = [];
  const editBudget: CloneBudget = { remaining: remainingPreparationBytes };
  for (const edit of request.edits) {
    const parent = valueAtPath(concept.frontmatter, edit.path.slice(0, -1));
    if (!parent.exists || parent.value === undefined) {
      return { ok: false, code: "MUTATION-INPUT" };
    }
    const finalSegment = edit.path.at(-1);
    const parentIsSequence = Array.isArray(parent.value);
    if (
      finalSegment === undefined ||
      (parentIsSequence && typeof finalSegment !== "number") ||
      (!parentIsSequence &&
        (!isObject(parent.value) || typeof finalSegment !== "string"))
    ) {
      return { ok: false, code: "MUTATION-INPUT" };
    }
    const current = valueAtPath(concept.frontmatter, edit.path);
    if (
      (!current.exists && edit.op === "remove") ||
      (!current.exists && parentIsSequence)
    ) {
      return { ok: false, code: "MUTATION-INPUT" };
    }

    if (edit.op === "remove") {
      edits.push({ op: "remove", path: edit.path });
      continue;
    }
    const cloned = cloneYamlInputWithBudget(edit.value, limits, editBudget);
    if (!cloned.ok) {
      return {
        ok: false,
        code: cloned.reason === "bounds" ? "MUTATION-BOUNDS" : "MUTATION-INPUT",
      };
    }
    if (current.exists && yamlValuesEqual(current.value, cloned.value)) {
      continue;
    }
    edits.push({ op: "set", path: edit.path, value: cloned.value });
  }

  return {
    ok: true,
    amendment: {
      edits,
      ...(changedBody === undefined ? {} : { bodyText: changedBody }),
      changed: edits.length > 0 || changedBody !== undefined,
    },
  };
}
