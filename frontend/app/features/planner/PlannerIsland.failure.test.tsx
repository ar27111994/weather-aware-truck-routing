import { render, screen } from "@testing-library/react";
import { Component, type ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { allowConsole } from "../../../test/console-guard";
import { PlannerIsland } from "./PlannerIsland";

// The planner's code is a download, and a download can fail (the visitor went offline between the
// page and their first input). The visitor must not be left with a form that never wakes: the route's
// error page says so, and it can be reloaded.
vi.mock("./PlannerApp", () => {
  throw new Error("The connection dropped.");
});

vi.mock("./page-gate", () => ({
  pageGate: null,
  pageContext: () => ({ gate: null, island: true, search: "" }),
}));

/** What the route's error boundary does, in the part that matters here: it shows the error. */
class Boundary extends Component<
  { readonly children: ReactNode },
  { readonly error: Error | null }
> {
  override state: { readonly error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { readonly error: Error } {
    return { error };
  }

  override render(): ReactNode {
    const { error } = this.state;
    return error === null ? this.props.children : <p role="alert">{error.message}</p>;
  }
}

const island = document.createElement("div");

afterEach(() => {
  island.remove();
});

describe("the planner the server drew, when its code does not arrive", () => {
  it("is replaced by the route's error, which says the planner did not load", async () => {
    // Vitest says that the stand-in for the planner's code threw, and React says which component
    // the error passed through on its way to the boundary.
    allowConsole(/error when mocking a module/u);
    allowConsole(/did not load/u);
    island.setAttribute("data-planner-island", "");
    document.body.append(island);

    render(
      <Boundary>
        <MemoryRouter>
          <PlannerIsland />
        </MemoryRouter>
      </Boundary>,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("The planner's code did not load.");
  });
});
