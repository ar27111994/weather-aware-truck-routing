import { act, render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { allowConsole } from "../../../test/console-guard";
import { PlannerIsland } from "./PlannerIsland";

// A download that fails after the visit is over has nobody to tell: nothing is drawn, and nothing is
// reported against a page that has gone. The download is held until the test lets it fail.
const download = vi.hoisted(() => {
  let end = (): void => undefined;
  const ended = new Promise<void>((resolve) => {
    end = resolve;
  });
  return {
    ended,
    end: () => {
      end();
    },
  };
});

vi.mock("./PlannerApp", async () => {
  await download.ended;
  throw new Error("The connection dropped.");
});

vi.mock("./page-gate", () => ({
  pageGate: null,
  pageContext: () => ({ gate: null, island: true, search: "" }),
}));

const island = document.createElement("div");

afterEach(() => {
  island.remove();
});

describe("the planner the server drew, when its code fails after the visit is over", () => {
  it("says nothing about it", async () => {
    // Vitest says that the stand-in for the planner's code threw; that is the failure under test.
    allowConsole(/error when mocking a module/u);
    island.setAttribute("data-planner-island", "");
    document.body.append(island);
    const { container, unmount } = render(
      <MemoryRouter>
        <PlannerIsland />
      </MemoryRouter>,
    );

    unmount();
    download.end();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(container).toBeEmptyDOMElement();
  });
});
