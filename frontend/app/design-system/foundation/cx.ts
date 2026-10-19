/** A class name part: a name, or a falsy value that is skipped. */
export type ClassValue = string | false | null | undefined;

/**
 * Joins class names, skipping falsy parts. The design system styles state through `data-*`
 * attributes, so this is only needed to combine a module class with a caller's `className`.
 *
 * @param values - Class names or falsy placeholders.
 * @returns The class names separated by single spaces.
 */
export function cx(...values: readonly ClassValue[]): string {
  return values
    .filter((value): value is string => typeof value === "string" && value !== "")
    .join(" ");
}
