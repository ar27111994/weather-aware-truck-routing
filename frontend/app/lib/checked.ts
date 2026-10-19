/**
 * Element `index` of `items`, or a `RangeError`: bounds-checked access that keeps
 * `noUncheckedIndexedAccess` honest without non-null assertions or unreachable fallbacks.
 * Negative, fractional and NaN indices are out of range (bracket access never wraps around).
 */
export function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new RangeError(`Index ${String(index)} is out of range (length ${String(items.length)})`);
  }
  return item;
}
