import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { createRoutesStub } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installMatchMedia } from "../../test/match-media";
import { unsavedThemeStore } from "../../test/theme-store";
import { DARK_QUERY } from "../design-system/foundation/theme";
import { ThemeProvider } from "../design-system/foundation/ThemeProvider";
import { NotFoundPage, RouteError } from "./RouteError";

function fail(failure: unknown): never {
  throw failure;
}

function Idle(): ReactElement {
  return <p>The page</p>;
}

/** `loader` throws the way a data loader does; `render` throws from the component itself. */
function renderRoute(failure: unknown, source: "loader" | "render"): ReturnType<typeof render> {
  const store = unsavedThemeStore();
  const Stub = createRoutesStub([
    {
      path: "/",
      ...(source === "loader"
        ? { loader: () => fail(failure), Component: Idle, HydrateFallback: Idle }
        : { Component: () => fail(failure) }),
      ErrorBoundary: RouteError,
    },
  ]);
  return render(
    <ThemeProvider store={store}>
      <Stub initialEntries={["/"]} />
    </ThemeProvider>,
  );
}

beforeEach(() => {
  installMatchMedia({ [DARK_QUERY]: false });
  // React and React Router log every caught render error; the tests expect them.
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("NotFoundPage", () => {
  it("says the page was not found and links back to the planner", () => {
    render(<NotFoundPage />);

    expect(screen.getByRole("heading", { level: 1, name: "Page not found" })).toBeInTheDocument();
    expect(screen.getByText(/doesn't match a page here/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to the planner" })).toHaveAttribute("href", "/");
  });
});

describe("RouteError", () => {
  it("shows the not-found page, inside the shell, for a 404 response", async () => {
    renderRoute(new Response(null, { status: 404 }), "loader");

    expect(
      await screen.findByRole("heading", { level: 1, name: "Page not found" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("banner")).toBeInTheDocument();
    expect(screen.getByRole("contentinfo")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it("shows the crash page with a reload button for any other response", async () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { href: window.location.href, reload });
    const user = userEvent.setup();
    renderRoute(new Response(null, { status: 500 }), "loader");

    expect(
      await screen.findByRole("heading", { level: 1, name: "Something went wrong" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(reload).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("link", { name: "Back to the planner" })).toBeInTheDocument();
  });

  it("shows the crash page for an unexpected exception", () => {
    renderRoute(new Error("render failed"), "render");

    expect(
      screen.getByRole("heading", { level: 1, name: "Something went wrong" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("That's on our side. Reload the page to try again."),
    ).toBeInTheDocument();
  });
});
