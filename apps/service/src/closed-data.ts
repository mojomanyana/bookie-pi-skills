import { types } from "node:util";

/** Snapshot only the named own data fields, without invoking getters or proxy traps.
 * Callers retain their semantic validation and public static-error boundary. */
export function ownDataFields(
  value: unknown,
  keys: readonly string[],
): readonly unknown[] {
  if (
    value === null ||
    typeof value !== "object" ||
    types.isProxy(value) ||
    Array.isArray(value)
  )
    throw new TypeError("Expected a closed data object.");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== keys.length)
    throw new TypeError("Expected a closed data object.");
  return keys.map((key) => {
    const field = descriptors[key];
    if (
      !Object.hasOwn(descriptors, key) ||
      field === undefined ||
      !Object.hasOwn(field, "value")
    )
      throw new TypeError("Expected a closed data object.");
    return field.value as unknown;
  });
}
