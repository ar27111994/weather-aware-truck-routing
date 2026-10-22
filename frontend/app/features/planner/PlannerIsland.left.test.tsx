import { act, render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PlannerIsland } from "./PlannerIsland";

// A visit that is over before the planner's code has arrived starts nothing: there is no element
// left to give it. The download is held until the test lets it end.
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
    mountPlanner: vi.fn(),
  };
});

vi.mock("./PlannerApp", async () => {
  await download.ended;
  return { default: () => null, mountPlanner: download.mountPlanner };
});

vi.mock("./page-gate", () => ({
  pageGate: null,
  pageContext: () => ({ gate: null, island: true, search: "" }),
}));

const island = document.createElement("div");

afterEach(() => {
  island.remove();
});

describe("the planner the server drew, when the visit is over before its code arrives", () => {
  it("is not started into an element that is no longer in the page", async () => {
    island.setAttribute("data-planner-island", "");
    document.body.append(island);
    const { unmount } = render(
      <MemoryRouter>
        <PlannerIsland />
      </MemoryRouter>,
    );

    unmount();
    download.end();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(download.mountPlanner).not.toHaveBeenCalled();
  });
});
