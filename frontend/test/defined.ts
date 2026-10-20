/**
 * Narrows a value that a test knows is present, failing with a clear message when it is not.
 * It replaces `as` casts and `!` assertions, which the lint rules forbid and which would hide a
 * missing value as a confusing error further down.
 */
export function defined<T>(value: T | null | undefined, what = "value"): T {
  if (value === null || value === undefined) {
    throw new Error(`Expected ${what} to be defined`);
  }
  return value;
}
