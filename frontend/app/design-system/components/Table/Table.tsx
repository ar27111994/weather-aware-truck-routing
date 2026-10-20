import { ArrowDown, ArrowUp } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { useCollator } from "react-aria";
import {
  Cell as AriaCell,
  Column as AriaColumn,
  Group,
  Row as AriaRow,
  Table as AriaTable,
  TableBody,
  TableHeader,
} from "react-aria-components";
import type { Selection, SortDescriptor } from "react-aria-components";

import { cx } from "../../foundation/cx";
import { t } from "../../foundation/strings";
import { Icon } from "../Icon";
import { keyToSelection, selectionToKey } from "./selection";
import { sortRows } from "./sortRows";
import type { SortValue } from "./sortRows";
import styles from "./Table.module.css";

type SortDirection = SortDescriptor["direction"];

/** The arrow of the sorted column: up is ascending, down is descending (DESIGN.md section 10). */
const SORT_ARROWS: Readonly<Record<SortDirection, LucideIcon>> = {
  ascending: ArrowUp,
  descending: ArrowDown,
};

/** One column of a {@link Table}: what its header says, how its cells read and how it sorts. */
export interface TableColumn<Row> {
  /** Stable id; it is what `sortDescriptor.column` names. */
  readonly id: string;
  /** The header content. */
  readonly header: ReactNode;
  /** Which edge the column's text sits on. Defaults to `"end"` for a numeric column, else `"start"`. */
  readonly align?: "start" | "end";
  /** Numeric columns use the `data-sm` type style and align to the end unless `align` says otherwise. */
  readonly numeric?: boolean;
  /** Turns the header into a sort control. Such a column also needs a `sortValue`. */
  readonly sortable?: boolean;
  /**
   * What to order the rows by. A missing value (`null`, `undefined`, `NaN`) always sorts last, in
   * both directions. The column that is sorted by default needs one even if it is not `sortable`.
   */
  readonly sortValue?: (row: Row) => SortValue;
  /** The cell content for one row. Keep it pure: it is called while the table is built. */
  readonly cell: (row: Row) => ReactNode;
  /**
   * Whether the column names the row for assistive technology. When no column says so, the first
   * column does, because a table needs a row header.
   */
  readonly isRowHeader?: boolean;
}

/** Props of {@link Table}. */
export interface TableProps<Row> {
  /** Names both the scroll region and the table inside it, for example "Checkpoints for Route B". */
  readonly regionLabel: string;
  readonly columns: readonly TableColumn<Row>[];
  /** The rows in source order; the table sorts a copy and never changes this array. */
  readonly rows: readonly Row[];
  /** A stable, unique id for a row: it is what selection reports and keeps across sorting. */
  readonly getRowId: (row: Row) => string;
  /** The sort to start from when the sort is not controlled. Defaults to the first column ascending. */
  readonly defaultSortDescriptor?: SortDescriptor;
  /** The sort, when the caller owns it. Pair it with `onSortChange`. */
  readonly sortDescriptor?: SortDescriptor;
  /** Called with the requested sort whenever the user changes it, controlled or not. */
  readonly onSortChange?: (descriptor: SortDescriptor) => void;
  /** The selected row's id when the caller owns the selection; `null` is no selection. */
  readonly selectedKey?: string | null;
  /** Called with the new row id, or `null` when the selection is cleared (Escape). */
  readonly onSelectionChange?: (key: string | null) => void;
  /** Shown when there are no rows. Defaults to the microcopy string for no checkpoints. */
  readonly emptyMessage?: string;
  readonly className?: string;
}

interface SortSlotProps {
  readonly direction: SortDirection | undefined;
}

/**
 * The reserved space for a column's sort arrow. The arrow only shows on the sorted column; the slot
 * stays so that sorting never changes a column's width. DESIGN.md asks for a 12 px arrow.
 */
function SortSlot({ direction }: SortSlotProps): ReactElement {
  const Arrow = direction === undefined ? null : SORT_ARROWS[direction];
  return (
    <span className={styles.sortSlot}>
      {Arrow === null ? null : <Icon icon={Arrow} size={12} />}
    </span>
  );
}

/**
 * A sortable table for numbers and readings, with one selectable row. It sits in a keyboard-reachable
 * scroll region with a sticky header, and wraps React Aria's Table for the grid semantics, the sort
 * and selection keyboard model, and `aria-sort`.
 *
 * The table sorts a copy of `rows` itself: stable (ties keep their source order), numbers as numbers,
 * text with the user's locale, missing values last in both directions. The sort and the selection
 * work uncontrolled, or controlled through `sortDescriptor` and `selectedKey`.
 */
export function Table<Row>({
  regionLabel,
  columns,
  rows,
  getRowId,
  defaultSortDescriptor,
  sortDescriptor,
  onSortChange,
  selectedKey,
  onSelectionChange,
  emptyMessage = t("table.none"),
  className,
}: TableProps<Row>): ReactElement {
  const collator = useCollator({ numeric: true });
  const [ownSort, setOwnSort] = useState(defaultSortDescriptor);
  const firstColumnId = columns[0]?.id;
  const activeSort: SortDescriptor = sortDescriptor ??
    ownSort ?? { column: firstColumnId ?? "", direction: "ascending" };
  const sortedRows = sortRows(rows, columns, activeSort, collator);
  const selection = keyToSelection(selectedKey);
  const rowHeaderFallbackId = columns.some((column) => column.isRowHeader === true)
    ? undefined
    : firstColumnId;

  function handleSortChange(next: SortDescriptor): void {
    if (sortDescriptor === undefined) {
      setOwnSort(next);
    }
    onSortChange?.(next);
  }

  function handleSelectionChange(next: Selection): void {
    onSelectionChange?.(selectionToKey(next));
  }

  return (
    <Group
      role="region"
      aria-label={regionLabel}
      tabIndex={0}
      className={cx(styles.region, className)}
    >
      <AriaTable
        aria-label={regionLabel}
        className={cx(styles.table)}
        selectionMode="single"
        selectionBehavior="replace"
        sortDescriptor={activeSort}
        onSortChange={handleSortChange}
        onSelectionChange={handleSelectionChange}
        {...(selection === undefined ? {} : { selectedKeys: selection })}
      >
        <TableHeader columns={columns}>
          {(column) => (
            <AriaColumn
              id={column.id}
              isRowHeader={column.isRowHeader === true || column.id === rowHeaderFallbackId}
              allowsSorting={column.sortable === true}
              className={cx(styles.column)}
              data-align={column.align ?? (column.numeric === true ? "end" : "start")}
            >
              {({ allowsSorting, sortDirection }) => (
                <span className={styles.columnContent}>
                  {column.header}
                  {allowsSorting ? <SortSlot direction={sortDirection} /> : null}
                </span>
              )}
            </AriaColumn>
          )}
        </TableHeader>
        <TableBody
          items={sortedRows}
          dependencies={[columns]}
          renderEmptyState={() => <span className={styles.empty}>{emptyMessage}</span>}
        >
          {(row) => (
            <AriaRow id={getRowId(row)} columns={columns} className={cx(styles.row)}>
              {(column) => (
                <AriaCell
                  className={cx(
                    styles.cell,
                    column.numeric === true ? styles.numeric : styles.text,
                  )}
                  data-align={column.align ?? (column.numeric === true ? "end" : "start")}
                >
                  {column.cell(row)}
                </AriaCell>
              )}
            </AriaRow>
          )}
        </TableBody>
      </AriaTable>
    </Group>
  );
}
