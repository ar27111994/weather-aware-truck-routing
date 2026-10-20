import type { SortDescriptor } from "react-aria-components";

/**
 * What a column sorts by. `null`, `undefined` and `NaN` mean "no value" and always sort last, in
 * both directions, so a missing reading is never mistaken for the smallest or the largest one.
 */
export type SortValue = number | string | null | undefined;

/** The part of a table column that sorting needs. */
export interface SortableColumn<Row> {
  readonly id: string;
  /** Reads the value to order by; a column without it keeps the source order. */
  readonly sortValue?: (row: Row) => SortValue;
}

type PresentValue = number | string;

function isPresent(value: SortValue): value is PresentValue {
  return (
    value !== null && value !== undefined && !(typeof value === "number" && Number.isNaN(value))
  );
}

/** Ascending order of two present values: numbers by value, then strings by the collator. */
function comparePresent(left: PresentValue, right: PresentValue, collator: Intl.Collator): number {
  if (typeof left === "number") {
    if (typeof right === "string") {
      return -1;
    }
    if (left === right) {
      return 0;
    }
    return left < right ? -1 : 1;
  }
  return typeof right === "string" ? collator.compare(left, right) : 1;
}

/** Orders two values; the sign flips only the present-vs-present order, never the missing-last rule. */
function compareValues(
  left: SortValue,
  right: SortValue,
  collator: Intl.Collator,
  sign: 1 | -1,
): number {
  if (!isPresent(left)) {
    return isPresent(right) ? 1 : 0;
  }
  if (!isPresent(right)) {
    return -1;
  }
  return sign * comparePresent(left, right, collator);
}

/**
 * Sorts rows by one column and returns a new array; the input is never changed.
 *
 * - The sort is stable: rows with equal values keep their source order, also when descending (the
 *   array is never reversed, only the comparison flips).
 * - Numbers compare as numbers; strings compare with `collator`, so the user's locale decides.
 *   Between the two kinds, numbers come first when ascending. Nothing is coerced.
 * - Missing values (`null`, `undefined`, `NaN`) come last in both directions, in source order.
 * - A descriptor naming an unknown column, or a column without `sortValue`, keeps the source order.
 * - Each row's value is read once, not once per comparison.
 *
 * @param rows - The rows in source order.
 * @param columns - Every column; the descriptor's `column` is looked up here by `id`.
 * @param descriptor - Which column to sort by and in which direction.
 * @param collator - Compares strings, e.g. `useCollator({ numeric: true })` from `react-aria`.
 */
export function sortRows<Row>(
  rows: readonly Row[],
  columns: readonly SortableColumn<Row>[],
  descriptor: SortDescriptor,
  collator: Intl.Collator,
): Row[] {
  const sortValue = columns.find((column) => column.id === descriptor.column)?.sortValue;
  if (sortValue === undefined) {
    return [...rows];
  }
  const sign = descriptor.direction === "descending" ? -1 : 1;
  return rows
    .map((row) => ({ row, value: sortValue(row) }))
    .sort((left, right) => compareValues(left.value, right.value, collator, sign))
    .map((entry) => entry.row);
}
