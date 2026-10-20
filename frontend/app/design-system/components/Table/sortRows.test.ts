import { describe, expect, it, vi } from "vitest";

import { sortRows } from "./sortRows";
import type { SortableColumn, SortValue } from "./sortRows";

interface Item {
  readonly id: string;
  readonly value: SortValue;
}

const english = new Intl.Collator("en-US", { numeric: true });
const valueColumn: SortableColumn<Item> = { id: "value", sortValue: (item) => item.value };

/** Rows named r0, r1, ... in source order, so a result reads as the order of those names. */
function itemsOf(values: readonly SortValue[]): Item[] {
  return values.map((value, index) => ({ id: `r${String(index)}`, value }));
}

function sortedIds(
  values: readonly SortValue[],
  direction: "ascending" | "descending",
  collator: Intl.Collator = english,
): string[] {
  return sortRows(itemsOf(values), [valueColumn], { column: "value", direction }, collator).map(
    (item) => item.id,
  );
}

interface Case {
  readonly name: string;
  readonly values: readonly SortValue[];
  readonly direction: "ascending" | "descending";
  readonly expected: readonly string[];
}

const CASES: readonly Case[] = [
  {
    name: "numbers ascending",
    values: [3, 1, 2],
    direction: "ascending",
    expected: ["r1", "r2", "r0"],
  },
  {
    name: "numbers descending",
    values: [3, 1, 2],
    direction: "descending",
    expected: ["r0", "r2", "r1"],
  },
  {
    name: "numbers by value, not as text (9 before 10 before 100)",
    values: [10, 9, 100],
    direction: "ascending",
    expected: ["r1", "r0", "r2"],
  },
  {
    name: "negative, zero and fractional numbers",
    values: [0.5, -2, 0, -0.25],
    direction: "ascending",
    expected: ["r1", "r3", "r2", "r0"],
  },
  {
    name: "infinities at the ends",
    values: [Infinity, 1, -Infinity],
    direction: "ascending",
    expected: ["r2", "r1", "r0"],
  },
  {
    name: "equal infinities keep source order",
    values: [Infinity, Infinity],
    direction: "descending",
    expected: ["r0", "r1"],
  },
  {
    name: "ties keep source order when ascending",
    values: [2, 1, 2, 1],
    direction: "ascending",
    expected: ["r1", "r3", "r0", "r2"],
  },
  {
    name: "ties keep source order when descending",
    values: [2, 1, 2, 1],
    direction: "descending",
    expected: ["r0", "r2", "r1", "r3"],
  },
  {
    name: "strings with the collator, ignoring case",
    values: ["banana", "Apple", "cherry"],
    direction: "ascending",
    expected: ["r1", "r0", "r2"],
  },
  {
    name: "strings with the collator, descending",
    values: ["banana", "Apple", "cherry"],
    direction: "descending",
    expected: ["r2", "r0", "r1"],
  },
  {
    name: "numeric collation inside strings (Mile 2 before Mile 10)",
    values: ["Mile 10", "Mile 2", "Mile 1"],
    direction: "ascending",
    expected: ["r2", "r1", "r0"],
  },
  {
    name: "missing values (null, undefined, NaN) last when ascending, in source order",
    values: [2, null, 1, undefined, Number.NaN],
    direction: "ascending",
    expected: ["r2", "r0", "r1", "r3", "r4"],
  },
  {
    name: "missing values last when descending, in source order",
    values: [2, null, 1, undefined, Number.NaN],
    direction: "descending",
    expected: ["r0", "r2", "r1", "r3", "r4"],
  },
  {
    name: "missing string values last when ascending",
    values: [null, "b", "a"],
    direction: "ascending",
    expected: ["r2", "r1", "r0"],
  },
  {
    name: "missing string values last when descending",
    values: [null, "b", "a"],
    direction: "descending",
    expected: ["r1", "r2", "r0"],
  },
  {
    name: "a column of only missing values keeps source order",
    values: [null, undefined, null],
    direction: "descending",
    expected: ["r0", "r1", "r2"],
  },
  {
    name: "mixed types: numbers before strings when ascending",
    values: ["b", 2, "a", 1],
    direction: "ascending",
    expected: ["r3", "r1", "r2", "r0"],
  },
  {
    name: "mixed types: strings before numbers when descending",
    values: ["b", 2, "a", 1],
    direction: "descending",
    expected: ["r0", "r2", "r1", "r3"],
  },
  { name: "no rows", values: [], direction: "ascending", expected: [] },
  { name: "a single row", values: [7], direction: "descending", expected: ["r0"] },
];

describe("sortRows", () => {
  it.each(CASES)("$name", ({ values, direction, expected }) => {
    expect(sortedIds(values, direction)).toEqual(expected);
  });

  it("orders strings by the collator it is given, so the locale decides", () => {
    const values = ["z", "ä", "a"];

    expect(sortedIds(values, "ascending", new Intl.Collator("de"))).toEqual(["r2", "r1", "r0"]);
    expect(sortedIds(values, "ascending", new Intl.Collator("sv"))).toEqual(["r2", "r0", "r1"]);
  });

  it("sorts by the column the descriptor names", () => {
    const rows = [
      { id: "r0", value: 1, other: "b" },
      { id: "r1", value: 2, other: "a" },
    ];
    const columns: SortableColumn<(typeof rows)[number]>[] = [
      { id: "value", sortValue: (row) => row.value },
      { id: "other", sortValue: (row) => row.other },
    ];

    const byOther = sortRows(rows, columns, { column: "other", direction: "ascending" }, english);
    const byValueDescending = sortRows(
      rows,
      columns,
      { column: "value", direction: "descending" },
      english,
    );

    expect(byOther.map((row) => row.id)).toEqual(["r1", "r0"]);
    expect(byValueDescending.map((row) => row.id)).toEqual(["r1", "r0"]);
  });

  it.each([
    { name: "has no sortValue", columns: [{ id: "value" }] },
    { name: "is not one of the columns", columns: [] },
  ] satisfies readonly { name: string; columns: SortableColumn<Item>[] }[])(
    "keeps the source order when the sort column $name",
    ({ columns }) => {
      const rows = itemsOf([3, 1, 2]);

      const result = sortRows(rows, columns, { column: "value", direction: "ascending" }, english);

      expect(result).toEqual(rows);
      expect(result).not.toBe(rows);
    },
  );

  it("does not change the array it is given", () => {
    const rows = itemsOf([3, 1, 2]);

    sortRows(rows, [valueColumn], { column: "value", direction: "ascending" }, english);

    expect(rows.map((row) => row.id)).toEqual(["r0", "r1", "r2"]);
  });

  it("reads each row's value once, however many comparisons the sort makes", () => {
    const sortValue = vi.fn((item: Item) => item.value);
    const rows = itemsOf([5, 4, 3, 2, 1, 0]);

    sortRows(
      rows,
      [{ id: "value", sortValue }],
      { column: "value", direction: "ascending" },
      english,
    );

    expect(sortValue).toHaveBeenCalledTimes(rows.length);
  });
});
