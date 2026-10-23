import { render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { t } from "../../foundation/strings";
import { BottomSheet } from "./BottomSheet";

const LABEL = t("app.regions.planner");
const css = readFileSync(join(import.meta.dirname, "BottomSheet.module.css"), "utf8");

// The planner's panel is one element on every screen (D-47): the sheet over the map on a phone and
// the panel beside it from 1024 px. The sheet is drawn in the prerendered page, so the form inside
// it is never moved or rebuilt when the sheet's code arrives and takes over.
describe("BottomSheet as the side panel of a wide screen (panelOnWide)", () => {
  it("is the same labelled region, marked for the style sheet", () => {
    render(
      <BottomSheet label={LABEL} panelOnWide>
        <p>Content</p>
      </BottomSheet>,
    );

    expect(screen.getByRole("region", { name: LABEL })).toHaveAttribute("data-wide", "panel");
  });

  it("is a plain sheet unless it is asked to be a panel", () => {
    render(
      <BottomSheet label={LABEL}>
        <p>Content</p>
      </BottomSheet>,
    );

    expect(screen.getByRole("region", { name: LABEL })).not.toHaveAttribute("data-wide");
  });

  it("keeps the handle in the markup: the style sheet hides it on a wide screen, the code does not remove it", () => {
    render(
      <BottomSheet label={LABEL} panelOnWide>
        <p>Content</p>
      </BottomSheet>,
    );

    expect(screen.getByRole("button", { name: "Resize panel" })).toBeInTheDocument();
  });

  describe("style sheet", () => {
    const wide = css.slice(css.indexOf('.sheet[data-wide="panel"]'));

    it("only changes the sheet from 1024 px, the width the layout switches at", () => {
      expect(css).toMatch(/@media \(min-width: 1024px\) \{[^@]*\.sheet\[data-wide="panel"\] \{/u);
    });

    it("puts the panel in the page's flow: not fixed, not moved down by its snap point", () => {
      expect(wide).toMatch(/--sheet-offset: 0px;/u);
      expect(wide).toMatch(/position: relative;/u);
      expect(wide).toMatch(/transform: none;/u);
      expect(wide).toMatch(/box-shadow: none;/u);
    });

    it("hides the handle and gives the content's padding back to the panel inside", () => {
      expect(wide).toMatch(/\.sheet\[data-wide="panel"\] \.handle \{\s*display: none;/u);
      expect(wide).toMatch(/\.sheet\[data-wide="panel"\] \.content \{[^}]*padding-inline: 0;/u);
    });
  });
});
