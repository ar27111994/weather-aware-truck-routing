import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { I18nProvider } from "react-aria-components";
import type { SortDescriptor } from "react-aria-components";
import { describe, expect, it, vi } from "vitest";

import { expectNoAxeViolations } from "../../../../test/axe";
import {
  expectHoverState,
  expectKeyboardFocusState,
  expectNoPointerStates,
  expectPointerFocusState,
  expectPressedState,
} from "../../../../test/states";
import { compareRisk, riskInfo, riskSortValue } from "../../foundation/risk";
import type { ApiRiskLevel } from "../../foundation/risk";
import { t } from "../../foundation/strings";
import { Table } from "./Table";
import type { TableColumn, TableProps } from "./Table";
import { demo } from "./Table.demo";

interface Stop {
  readonly id: string;
  readonly name: string;
  readonly miles: number | null;
  readonly note: string;
}

const REGION = "Stops for Route B";

const STOPS: readonly Stop[] = [
  { id: "amarillo", name: "Amarillo", miles: 120, note: "Fuel" },
  { id: "bismarck", name: "Bismarck", miles: 40, note: "Rest" },
  { id: "cheyenne", name: "Cheyenne", miles: null, note: "Scale" },
  { id: "dallas", name: "Dallas", miles: 40, note: "Yard" },
];

const COLUMNS: readonly TableColumn<Stop>[] = [
  {
    id: "name",
    header: "Stop",
    isRowHeader: true,
    sortable: true,
    sortValue: (stop) => stop.name,
    cell: (stop) => stop.name,
  },
  {
    id: "miles",
    header: "Distance (mi)",
    numeric: true,
    sortable: true,
    sortValue: (stop) => stop.miles,
    cell: (stop) => stop.miles ?? "No data",
  },
  { id: "note", header: "Note", cell: (stop) => stop.note },
];

function stopId(stop: Stop): string {
  return stop.id;
}

function tableElement(overrides: Partial<TableProps<Stop>> = {}): ReactElement {
  return (
    <Table regionLabel={REGION} columns={COLUMNS} rows={STOPS} getRowId={stopId} {...overrides} />
  );
}

function renderTable(overrides: Partial<TableProps<Stop>> = {}) {
  const user = userEvent.setup();
  return { user, ...render(tableElement(overrides)) };
}

function header(name: string): HTMLElement {
  return screen.getByRole("columnheader", { name });
}

/** The row headers (stop names) in the order the table shows them. */
function order(): (string | null)[] {
  return screen.getAllByRole("rowheader").map((cell) => cell.textContent);
}

function row(name: string): HTMLElement {
  return screen.getByRole("row", { name: new RegExp(name) });
}

const BY_NAME_ASCENDING = ["Amarillo", "Bismarck", "Cheyenne", "Dallas"];
const BY_NAME_DESCENDING = ["Dallas", "Cheyenne", "Bismarck", "Amarillo"];
/** Bismarck and Dallas tie at 40 and keep their source order; Cheyenne has no value and is last. */
const BY_MILES_ASCENDING = ["Bismarck", "Dallas", "Amarillo", "Cheyenne"];
const BY_MILES_DESCENDING = ["Amarillo", "Bismarck", "Dallas", "Cheyenne"];

describe("Table", () => {
  describe("structure", () => {
    it("is a focusable scroll region named by regionLabel that holds the table", () => {
      renderTable();

      const region = screen.getByRole("region", { name: REGION });
      expect(region).toHaveAttribute("tabindex", "0");
      expect(within(region).getByRole("grid", { name: REGION })).toBeInTheDocument();
    });

    it("renders a header per column and a row per record", () => {
      renderTable();

      expect(screen.getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual([
        "Stop",
        "Distance (mi)",
        "Note",
      ]);
      expect(screen.getAllByRole("row")).toHaveLength(STOPS.length + 1);
      expect(
        within(row("Bismarck"))
          .getAllByRole("gridcell")
          .map((cell) => cell.textContent),
      ).toEqual(["40", "Rest"]);
    });

    it("keeps one row header per row for the column that is flagged as the row header", () => {
      renderTable();

      expect(order()).toEqual(BY_NAME_ASCENDING);
    });

    it("merges a caller class name onto the scroll region", () => {
      renderTable({ className: "custom" });

      expect(screen.getByRole("region", { name: REGION })).toHaveClass("custom");
    });

    it("never shows selection checkboxes", () => {
      renderTable();

      expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    });

    it("accepts any node as a header", () => {
      const columns: readonly TableColumn<Stop>[] = [
        { id: "name", header: <span>Where</span>, isRowHeader: true, cell: (stop) => stop.name },
      ];
      renderTable({ columns });

      expect(header("Where")).toBeInTheDocument();
    });

    it("re-renders the cells when the columns change but the rows do not", () => {
      function nameColumns(format: (name: string) => string): readonly TableColumn<Stop>[] {
        return [
          { id: "name", header: "Stop", isRowHeader: true, cell: (stop) => format(stop.name) },
        ];
      }
      const { rerender } = renderTable({ columns: nameColumns((name) => name.toLowerCase()) });
      expect(order()).toContain("amarillo");

      rerender(tableElement({ columns: nameColumns((name) => name.toUpperCase()) }));

      expect(order()).toContain("AMARILLO");
      expect(order()).not.toContain("amarillo");
    });

    it("renders a table with no columns and no rows without failing", () => {
      renderTable({ columns: [], rows: [] });

      expect(screen.getByRole("region", { name: REGION })).toBeInTheDocument();
    });

    it("makes the first column the row header when no column says so", () => {
      const unflagged = COLUMNS.map((column) => ({ ...column, isRowHeader: false }));
      renderTable({ columns: unflagged });

      expect(order()).toEqual(BY_NAME_ASCENDING);
    });
  });

  describe("alignment", () => {
    const columns: readonly TableColumn<Stop>[] = [
      { id: "name", header: "Stop", isRowHeader: true, cell: (stop) => stop.name },
      { id: "a", header: "Numeric", numeric: true, cell: () => "1" },
      { id: "b", header: "Numeric at start", numeric: true, align: "start", cell: () => "2" },
      { id: "c", header: "Text at end", align: "end", cell: () => "3" },
      { id: "d", header: "Text", cell: () => "4" },
    ];

    it("aligns numeric columns to the end unless an alignment is given", () => {
      renderTable({ columns });

      const names = ["Stop", "Numeric", "Numeric at start", "Text at end", "Text"];
      const aligns = names.map((name) => header(name).dataset["align"]);
      expect(aligns).toEqual(["start", "end", "start", "end", "start"]);
      const cells = [
        ...within(row("Amarillo")).getAllByRole("rowheader"),
        ...within(row("Amarillo")).getAllByRole("gridcell"),
      ];
      expect(cells.map((cell) => cell.dataset["align"])).toEqual([
        "start",
        "end",
        "start",
        "end",
        "start",
      ]);
    });
  });

  describe("sorting", () => {
    it("sorts by the first column ascending unless told otherwise", () => {
      renderTable();

      expect(order()).toEqual(BY_NAME_ASCENDING);
      expect(header("Stop")).toHaveAttribute("aria-sort", "ascending");
    });

    it("gives aria-sort to sortable columns only", () => {
      renderTable();

      expect(header("Distance (mi)")).toHaveAttribute("aria-sort", "none");
      expect(header("Note")).not.toHaveAttribute("aria-sort");
    });

    it("sorts by the first column even when it has no sort control", () => {
      const columns: readonly TableColumn<Stop>[] = [
        {
          id: "miles",
          header: "Distance (mi)",
          sortValue: (stop) => stop.miles,
          cell: (stop) => stop.miles ?? "No data",
        },
        { id: "name", header: "Stop", isRowHeader: true, cell: (stop) => stop.name },
      ];
      renderTable({ columns });

      expect(order()).toEqual(["Bismarck", "Dallas", "Amarillo", "Cheyenne"]);
      expect(header("Distance (mi)")).not.toHaveAttribute("aria-sort");
    });

    it("starts from defaultSortDescriptor", () => {
      renderTable({ defaultSortDescriptor: { column: "miles", direction: "descending" } });

      expect(order()).toEqual(BY_MILES_DESCENDING);
      expect(header("Distance (mi)")).toHaveAttribute("aria-sort", "descending");
      expect(header("Stop")).toHaveAttribute("aria-sort", "none");
    });

    it("toggles the direction on click and starts ascending on another column", async () => {
      const { user } = renderTable();

      await user.click(header("Stop"));
      expect(order()).toEqual(BY_NAME_DESCENDING);
      expect(header("Stop")).toHaveAttribute("aria-sort", "descending");

      await user.click(header("Stop"));
      expect(order()).toEqual(BY_NAME_ASCENDING);
      expect(header("Stop")).toHaveAttribute("aria-sort", "ascending");

      await user.click(header("Distance (mi)"));
      expect(header("Distance (mi)")).toHaveAttribute("aria-sort", "ascending");
      expect(header("Stop")).toHaveAttribute("aria-sort", "none");
    });

    it("keeps ties in source order and missing values last, in both directions", async () => {
      const { user } = renderTable();

      await user.click(header("Distance (mi)"));
      expect(order()).toEqual(BY_MILES_ASCENDING);

      await user.click(header("Distance (mi)"));
      expect(order()).toEqual(BY_MILES_DESCENDING);
    });

    it("sorts a risk column by riskSortValue in the order compareRisk gives, Unknown last in both directions (R3-27)", async () => {
      interface Reading {
        readonly id: string;
        readonly level: ApiRiskLevel;
      }
      const readings: readonly Reading[] = [
        { id: "a", level: null },
        { id: "b", level: "high" },
        { id: "c", level: "low" },
        { id: "d", level: null },
        { id: "e", level: "no_travel" },
        { id: "f", level: "severe" },
        { id: "g", level: "moderate" },
        { id: "h", level: "high" },
      ];
      const levelColumns: readonly TableColumn<Reading>[] = [
        { id: "id", header: "Stop", isRowHeader: true, cell: (reading) => reading.id },
        {
          id: "level",
          header: "Level",
          sortable: true,
          sortValue: (reading) => riskSortValue(reading.level),
          cell: (reading) => riskInfo(reading.level).label,
        },
      ];
      const byCompareRisk = (direction: "ascending" | "descending"): string[] =>
        readings
          .toSorted((left, right) => compareRisk(left.level, right.level, direction))
          .map((reading) => reading.id);
      const user = userEvent.setup();
      render(
        <Table
          regionLabel={REGION}
          columns={levelColumns}
          rows={readings}
          getRowId={(reading) => reading.id}
          defaultSortDescriptor={{ column: "level", direction: "ascending" }}
        />,
      );

      expect(order()).toEqual(byCompareRisk("ascending"));

      await user.click(header("Level"));

      expect(order()).toEqual(byCompareRisk("descending"));
    });

    it.each([
      ["Enter", "{Enter}"],
      ["Space", " "],
    ])("sorts from the keyboard with %s on a focused header", async (_name, keys) => {
      const { user } = renderTable();
      header("Distance (mi)").focus();

      await user.keyboard(keys);
      expect(header("Distance (mi)")).toHaveAttribute("aria-sort", "ascending");
      expect(order()).toEqual(BY_MILES_ASCENDING);

      await user.keyboard(keys);
      expect(header("Distance (mi)")).toHaveAttribute("aria-sort", "descending");
      expect(order()).toEqual(BY_MILES_DESCENDING);
    });

    it("ignores a click on a column that is not sortable", async () => {
      const { user } = renderTable();

      await user.click(header("Note"));

      expect(order()).toEqual(BY_NAME_ASCENDING);
      expect(header("Stop")).toHaveAttribute("aria-sort", "ascending");
    });

    it("shows a 12 px arrow in the sorted column only, up when ascending and down when descending", async () => {
      const { user } = renderTable();
      const arrowOf = (name: string) => header(name).querySelector("svg");

      expect(arrowOf("Stop")).toHaveClass("lucide-arrow-up");
      expect(arrowOf("Stop")).toHaveAttribute("width", "12");
      expect(arrowOf("Stop")).toHaveAttribute("aria-hidden", "true");
      expect(arrowOf("Distance (mi)")).toBeNull();
      expect(arrowOf("Note")).toBeNull();

      await user.click(header("Stop"));

      expect(arrowOf("Stop")).toHaveClass("lucide-arrow-down");
      expect(arrowOf("Stop")).toHaveAttribute("height", "12");
    });

    it("orders text by the user's locale", () => {
      const places: readonly Stop[] = [
        { id: "z", name: "Zürich", miles: 1, note: "" },
        { id: "a", name: "Älmhult", miles: 2, note: "" },
        { id: "b", name: "Aachen", miles: 3, note: "" },
      ];
      const german = render(
        <I18nProvider locale="de-DE">{tableElement({ rows: places })}</I18nProvider>,
      );
      const germanOrder = order();
      german.unmount();
      render(<I18nProvider locale="sv-SE">{tableElement({ rows: places })}</I18nProvider>);

      expect(germanOrder).toEqual(["Aachen", "Älmhult", "Zürich"]);
      expect(order()).toEqual(["Aachen", "Zürich", "Älmhult"]);
    });

    it("reports every change through onSortChange when uncontrolled", async () => {
      const onSortChange = vi.fn();
      const { user } = renderTable({ onSortChange });

      await user.click(header("Distance (mi)"));
      await user.click(header("Distance (mi)"));

      expect(onSortChange).toHaveBeenNthCalledWith(1, { column: "miles", direction: "ascending" });
      expect(onSortChange).toHaveBeenNthCalledWith(2, { column: "miles", direction: "descending" });
      expect(order()).toEqual(BY_MILES_DESCENDING);
    });

    it("follows a controlled sortDescriptor and only reports the requested change", async () => {
      const onSortChange = vi.fn();
      const controlled: SortDescriptor = { column: "miles", direction: "descending" };
      const { user, rerender } = renderTable({ sortDescriptor: controlled, onSortChange });
      expect(order()).toEqual(BY_MILES_DESCENDING);

      await user.click(header("Distance (mi)"));

      expect(onSortChange).toHaveBeenCalledExactlyOnceWith({
        column: "miles",
        direction: "ascending",
      });
      expect(order()).toEqual(BY_MILES_DESCENDING);

      rerender(
        tableElement({ sortDescriptor: { column: "miles", direction: "ascending" }, onSortChange }),
      );

      expect(order()).toEqual(BY_MILES_ASCENDING);
      expect(header("Distance (mi)")).toHaveAttribute("aria-sort", "ascending");
    });
  });

  describe("selection", () => {
    it("selects a row on click, reports its id and moves the selection on the next click", async () => {
      const onSelectionChange = vi.fn();
      const { user } = renderTable({ onSelectionChange });

      await user.click(row("Bismarck"));
      expect(onSelectionChange).toHaveBeenLastCalledWith("bismarck");
      expect(row("Bismarck")).toHaveAttribute("aria-selected", "true");
      expect(row("Dallas")).toHaveAttribute("aria-selected", "false");

      await user.click(row("Dallas"));
      expect(onSelectionChange).toHaveBeenLastCalledWith("dallas");
      expect(row("Dallas")).toHaveAttribute("aria-selected", "true");
      expect(row("Bismarck")).toHaveAttribute("aria-selected", "false");
    });

    it("selects by the id getRowId returns, not by position, after the sort changes", async () => {
      const onSelectionChange = vi.fn();
      const { user } = renderTable({ onSelectionChange });
      await user.click(header("Stop"));

      await user.click(row("Amarillo"));

      expect(onSelectionChange).toHaveBeenCalledExactlyOnceWith("amarillo");
    });

    it("keeps the selected row selected when the sort moves it", async () => {
      const { user } = renderTable();
      await user.click(row("Amarillo"));

      await user.click(header("Stop"));

      expect(row("Amarillo")).toHaveAttribute("aria-selected", "true");
    });

    it.each([
      ["Enter", "{Enter}"],
      ["Space", " "],
    ])("selects the focused row with %s", async (_name, keys) => {
      const onSelectionChange = vi.fn();
      const { user } = renderTable({ onSelectionChange });
      row("Cheyenne").focus();

      await user.keyboard(keys);

      expect(onSelectionChange).toHaveBeenCalledExactlyOnceWith("cheyenne");
      expect(row("Cheyenne")).toHaveAttribute("aria-selected", "true");
    });

    it("follows a controlled selectedKey and only reports the requested change", async () => {
      const onSelectionChange = vi.fn();
      const { user, rerender } = renderTable({ selectedKey: "cheyenne", onSelectionChange });
      expect(row("Cheyenne")).toHaveAttribute("aria-selected", "true");

      await user.click(row("Amarillo"));

      expect(onSelectionChange).toHaveBeenCalledExactlyOnceWith("amarillo");
      expect(row("Cheyenne")).toHaveAttribute("aria-selected", "true");
      expect(row("Amarillo")).toHaveAttribute("aria-selected", "false");

      rerender(tableElement({ selectedKey: "amarillo", onSelectionChange }));

      expect(row("Amarillo")).toHaveAttribute("aria-selected", "true");
      expect(row("Cheyenne")).toHaveAttribute("aria-selected", "false");
    });

    it("shows no selection for a null selectedKey", () => {
      renderTable({ selectedKey: null });

      for (const stop of STOPS) {
        expect(row(stop.name)).toHaveAttribute("aria-selected", "false");
      }
    });

    it("reports null when the selection is cleared", async () => {
      const onSelectionChange = vi.fn();
      const { user } = renderTable({ onSelectionChange, selectedKey: "bismarck" });
      row("Bismarck").focus();

      await user.keyboard("{Escape}");

      expect(onSelectionChange).toHaveBeenCalledExactlyOnceWith(null);
    });
  });

  describe("empty", () => {
    it("says there are no checkpoints, from the microcopy, when there are no rows", () => {
      renderTable({ rows: [] });

      expect(screen.getByText(t("table.none"))).toBeInTheDocument();
      // React Aria puts the message in the one cell of a single body row, so no stop is listed.
      expect(screen.getAllByRole("rowheader").map((cell) => cell.textContent)).toEqual([
        t("table.none"),
      ]);
      expect(screen.getAllByRole("columnheader")).toHaveLength(COLUMNS.length);
    });

    it("shows the caller's message instead when one is given", () => {
      renderTable({ rows: [], emptyMessage: "Nothing on this route" });

      expect(screen.getByText("Nothing on this route")).toBeInTheDocument();
      expect(screen.queryByText(t("table.none"))).not.toBeInTheDocument();
    });
  });

  describe("interaction states", () => {
    // The ring of the scroll region is the browser's own :focus-visible (`.region:focus-visible`),
    // which jsdom does not model. What is checked is that the keyboard reaches the region before
    // anything inside the table, and that React Aria counts that focus as the keyboard's.
    describe("scroll region", () => {
      it("shows the focus ring when the keyboard puts focus on it", async () => {
        const { user } = renderTable();

        await expectKeyboardFocusState(user, screen.getByRole("region", { name: REGION }));
      });

      it("shows no focus ring when a click puts focus on it", async () => {
        const { user } = renderTable();

        await expectPointerFocusState(user, screen.getByRole("region", { name: REGION }));
      });
    });

    describe("sortable header", () => {
      it("is hovered while the pointer rests on it", async () => {
        const { user } = renderTable();

        await expectHoverState(user, header("Distance (mi)"));
      });

      it("is pressed while a pointer button is held down on it", async () => {
        const { user } = renderTable();

        await expectPressedState(user, header("Distance (mi)"));
      });

      it("shows the focus ring when the arrow keys reach it", async () => {
        const { user } = renderTable();
        await user.tab(); // the scroll region
        await user.tab(); // the grid's one tab stop: the first row

        // Up from the first row is the "Stop" header; right of it is "Distance (mi)".
        await user.keyboard("{ArrowUp}{ArrowRight}");

        expect(header("Distance (mi)")).toHaveFocus();
        expect(header("Distance (mi)")).toHaveAttribute("data-focus-visible", "true");
        expect(header("Stop")).not.toHaveAttribute("data-focus-visible");
      });

      it("is neither hovered nor pressed when the column cannot be sorted", async () => {
        const { user } = renderTable();

        await expectNoPointerStates(user, header("Note"));
      });
    });

    describe("row", () => {
      it("is hovered while the pointer rests on it", async () => {
        const { user } = renderTable();

        await expectHoverState(user, row("Bismarck"));
      });

      it("is pressed while a pointer button is held down on it", async () => {
        const { user } = renderTable();

        await expectPressedState(user, row("Bismarck"));
      });

      it("shows the focus ring when the keyboard puts focus on it", async () => {
        const { user } = renderTable();
        await user.tab(); // the scroll region comes first

        await expectKeyboardFocusState(user, row("Amarillo"));
      });

      it("shows no focus ring when a click puts focus on it", async () => {
        const { user } = renderTable();

        await expectPointerFocusState(user, row("Bismarck"));
      });

      it("stays selected while it is hovered and pressed", async () => {
        const { user } = renderTable({ selectedKey: "bismarck" });
        const selected = row("Bismarck");

        await user.hover(selected);
        await user.pointer({ keys: "[MouseLeft>]", target: selected });

        expect(selected).toHaveAttribute("data-selected", "true");
        expect(selected).toHaveAttribute("data-hovered", "true");
        expect(selected).toHaveAttribute("data-pressed", "true");
        await user.pointer({ keys: "[/MouseLeft]" });
      });
    });

    describe("cell", () => {
      it("shows the focus ring when an arrow key reaches it", async () => {
        const { user } = renderTable();
        await user.tab(); // the scroll region
        await user.tab(); // the first row

        await user.keyboard("{ArrowRight}");

        const cell = within(row("Amarillo")).getByRole("rowheader");
        expect(cell).toHaveFocus();
        expect(cell).toHaveAttribute("data-focus-visible", "true");
      });
    });
  });

  describe("accessibility", () => {
    it("has no violations sorted, with a selected row", async () => {
      const { container } = renderTable({
        selectedKey: "bismarck",
        defaultSortDescriptor: { column: "miles", direction: "descending" },
      });

      await expectNoAxeViolations(container);
    });

    it("has no violations when empty", async () => {
      const { container } = renderTable({ rows: [] });

      await expectNoAxeViolations(container);
    });
  });
});

// The demo test renders three tables of 80 cells and clicks through React Aria's sort handling, and
// the axe run covers all of them: under coverage on a busy machine that outgrows the 5 s default.
describe("Table demo", { timeout: 30_000 }, () => {
  const ROUTE_B = t("table.regionLabel", { route: "B" });
  const ROUTE_A = t("table.regionLabel", { route: "A" });
  const ROUTE_C = t("table.regionLabel", { route: "C" });

  function renderDemo() {
    const user = userEvent.setup();
    const view = render(
      <div>
        {demo.states.map((state) => (
          <section key={state.id}>{state.node}</section>
        ))}
      </div>,
    );
    return { user, ...view };
  }

  function regionOf(label: string) {
    return within(screen.getByRole("region", { name: label }));
  }

  /** The checkpoint numbers (the row-header column) in the order a table shows them. */
  function checkpointOrder(label: string): (string | null)[] {
    return regionOf(label)
      .getAllByRole("rowheader")
      .map((cell) => cell.textContent);
  }

  it("declares a name, a description and states with unique ids", () => {
    const ids = demo.states.map((state) => state.id);

    expect(demo.name).toBe("Table");
    expect(demo.description).not.toBe("");
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("shows the checkpoint columns with their microcopy headers", () => {
    renderDemo();

    const headers = regionOf(ROUTE_B)
      .getAllByRole("columnheader")
      .map((cell) => cell.textContent);
    expect(headers).toEqual([
      t("table.cols.index"),
      t("table.cols.distance"),
      t("table.cols.eta"),
      t("table.cols.level"),
      t("table.cols.wind"),
      t("table.cols.gust"),
      t("table.cols.rain"),
      t("table.cols.snow"),
      t("table.cols.temp"),
      t("table.cols.loadRule"),
    ]);
  });

  it("shows eight checkpoints, one of them selected, one of them without weather data", () => {
    renderDemo();
    const table = regionOf(ROUTE_B);

    expect(table.getAllByRole("rowheader")).toHaveLength(8);
    expect(table.getAllByRole("row", { selected: true })).toHaveLength(1);
    expect(table.getByText(t("risk.unknown"))).toBeInTheDocument();
    expect(table.getAllByText(t("popover.missing")).length).toBeGreaterThan(0);
  });

  it("names every region differently so the landmarks stay unique", () => {
    renderDemo();

    expect(screen.getAllByRole("region")).toHaveLength(demo.states.length);
    expect(new Set(screen.getAllByRole("region").map((region) => region.ariaLabel)).size).toBe(
      demo.states.length,
    );
  });

  it("shows the sort arrow where the demo starts sorted, and the empty state", () => {
    renderDemo();

    const wind = regionOf(ROUTE_A).getByRole("columnheader", { name: t("table.cols.wind") });

    expect(wind).toHaveAttribute("aria-sort", "descending");
    expect(regionOf(ROUTE_C).getByText(t("table.none"))).toBeInTheDocument();
  });

  describe("the # column (R3-28)", () => {
    const ALONG_THE_ROUTE = ["1", "2", "3", "4", "5", "6", "7", "8"];

    function indexHeader(label: string): HTMLElement {
      return regionOf(label).getByRole("columnheader", { name: t("table.cols.index") });
    }

    it("is the default sort and says so: aria-sort and an up arrow, where the demo starts on it", () => {
      renderDemo();

      expect(checkpointOrder(ROUTE_B)).toEqual(ALONG_THE_ROUTE);
      expect(indexHeader(ROUTE_B)).toHaveAttribute("aria-sort", "ascending");
      expect(indexHeader(ROUTE_B).querySelector("svg")).toHaveClass("lucide-arrow-up");
    });

    it("is a sort control that is not the sort, with no arrow, where the demo starts on wind", () => {
      renderDemo();

      expect(indexHeader(ROUTE_A)).toHaveAttribute("aria-sort", "none");
      expect(indexHeader(ROUTE_A).querySelector("svg")).toBeNull();
    });

    it("brings the order along the route back after another sort, then reverses it", async () => {
      const { user } = renderDemo();
      await user.click(regionOf(ROUTE_B).getByRole("columnheader", { name: t("table.cols.wind") }));
      expect(checkpointOrder(ROUTE_B)).not.toEqual(ALONG_THE_ROUTE);

      await user.click(indexHeader(ROUTE_B));
      expect(indexHeader(ROUTE_B)).toHaveAttribute("aria-sort", "ascending");
      expect(checkpointOrder(ROUTE_B)).toEqual(ALONG_THE_ROUTE);

      await user.click(indexHeader(ROUTE_B));
      expect(indexHeader(ROUTE_B)).toHaveAttribute("aria-sort", "descending");
      expect(checkpointOrder(ROUTE_B)).toEqual(ALONG_THE_ROUTE.toReversed());
    });
  });

  it("orders levels by severity with Unknown last, in both directions, keeping ties in route order", async () => {
    const { user } = renderDemo();
    const level = regionOf(ROUTE_B).getByRole("columnheader", { name: t("table.cols.level") });

    await user.click(level);
    expect(checkpointOrder(ROUTE_B)).toEqual(["1", "2", "8", "3", "7", "4", "5", "6"]);

    await user.click(level);
    expect(checkpointOrder(ROUTE_B)).toEqual(["5", "4", "7", "3", "1", "2", "8", "6"]);
  });

  it.each(["wind", "rain", "snow"] as const)(
    "puts the checkpoint without data last when sorting by %s, ascending and descending",
    async (key) => {
      const { user } = renderDemo();
      const column = regionOf(ROUTE_B).getByRole("columnheader", { name: t(`table.cols.${key}`) });

      await user.click(column);
      expect(column).toHaveAttribute("aria-sort", "ascending");
      const ascending = checkpointOrder(ROUTE_B);

      await user.click(column);
      expect(column).toHaveAttribute("aria-sort", "descending");
      const descending = checkpointOrder(ROUTE_B);

      expect(ascending.at(-1)).toBe("6");
      expect(descending.at(-1)).toBe("6");
      expect(ascending.at(0)).not.toBe(descending.at(0));
    },
  );

  it.each(["distance", "eta"] as const)(
    "sorts by %s along the route, ascending and descending",
    async (key) => {
      const { user } = renderDemo();
      const column = regionOf(ROUTE_B).getByRole("columnheader", { name: t(`table.cols.${key}`) });

      await user.click(column);
      expect(checkpointOrder(ROUTE_B)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);

      await user.click(column);
      expect(checkpointOrder(ROUTE_B)).toEqual(["8", "7", "6", "5", "4", "3", "2", "1"]);
    },
  );

  it("has no accessibility violations in any state", async () => {
    const { container } = renderDemo();

    await expectNoAxeViolations(container);
  });
});
