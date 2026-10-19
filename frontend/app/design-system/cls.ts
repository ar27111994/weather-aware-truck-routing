/** A class name, or a falsy value that {@link cls} skips (CSS-module lookups may be undefined). */
export type ClassValue = string | false | null | undefined;

/**
 * Joins class names, skipping falsy values. CSS-module lookups are `string | undefined` under
 * `noUncheckedIndexedAccess`, and React Aria's `className` prop rejects `undefined` under
 * `exactOptionalPropertyTypes`, so every `className` in the design system goes through this.
 */
export function cls(...names: readonly ClassValue[]): string {
  return names.filter(Boolean).join(" ");
}
