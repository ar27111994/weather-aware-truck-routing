import { act, screen } from "@testing-library/react";
import { I18nProvider } from "react-aria";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { renderWithApi, startMockApi } from "../../../test/api";
import { t } from "../../design-system/foundation/strings";
import { ISLAND_SELECTOR } from "./intent";
import { PlannerIsland } from "./PlannerIsland";

vi.setConfig({ testTimeout: 30_000 });

const api = startMockApi();

// The prerendered page is the planner's server drawing; its code is a separate download that starts
// when the visitor first gives the page an input (ADR 0007). This is that, end to end, with the
// page's own gate: nothing loads while the visitor leaves the page alone, and the first input does.
describe("PlannerIsland", () => {
  it("loads the planner's code at the visitor's first input, and not before", async () => {
    const island = document.createElement("div");
    island.setAttribute(ISLAND_SELECTOR.slice(1, -1), "");
    document.body.append(island);

    renderWithApi(
      <I18nProvider locale="en-US">
        <MemoryRouter initialEntries={["/"]}>
          <PlannerIsland />
        </MemoryRouter>
      </I18nProvider>,
      api.client,
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    expect(screen.queryByRole("button", { name: t("form.submit") })).not.toBeInTheDocument();

    act(() => {
      document.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });

    expect(await screen.findByRole("button", { name: t("form.submit") })).toBeInTheDocument();
    island.remove();
  });
});
