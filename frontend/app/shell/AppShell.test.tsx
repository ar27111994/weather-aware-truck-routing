import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { Outlet, createRoutesStub } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";

import { installMatchMedia } from "../../test/match-media";
import { unsavedThemeStore } from "../../test/theme-store";
import { Link } from "../design-system/components/Link";
import { DARK_QUERY } from "../design-system/foundation/theme";
import { ThemeProvider } from "../design-system/foundation/ThemeProvider";
import { AppFooter } from "./AppFooter";
import { AppHeader } from "./AppHeader";
import { AppShell } from "./AppShell";

beforeEach(() => {
  installMatchMedia({ [DARK_QUERY]: false });
});

function renderAt(
  path: string,
  routes: Parameters<typeof createRoutesStub>[0],
): ReturnType<typeof render> {
  const store = unsavedThemeStore();
  const Stub = createRoutesStub(routes);
  return render(
    <ThemeProvider store={store}>
      <Stub initialEntries={[path]} />
    </ThemeProvider>,
  );
}

describe("AppHeader", () => {
  const header = [{ path: "*", Component: AppHeader }];

  it("is a banner with the wordmark linking home and a primary navigation", () => {
    renderAt("/", header);

    expect(screen.getByRole("banner")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Haulcast" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("navigation", { name: "Primary" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Methodology" })).toHaveAttribute(
      "href",
      "/methodology",
    );
  });

  it("marks the planner as the current page on /", () => {
    renderAt("/", header);

    expect(screen.getByRole("link", { name: "Planner" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Methodology" })).not.toHaveAttribute("aria-current");
  });

  it.each(["/methodology", "/methodology/"])("marks the methodology as current on %s", (path) => {
    renderAt(path, header);

    expect(screen.getByRole("link", { name: "Methodology" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: "Planner" })).not.toHaveAttribute("aria-current");
  });

  it("marks neither link on an unknown page", () => {
    renderAt("/nowhere", header);

    expect(screen.getByRole("link", { name: "Planner" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: "Methodology" })).not.toHaveAttribute("aria-current");
  });

  it("holds the theme toggle, which switches the theme and stays in sync", async () => {
    const user = userEvent.setup();
    renderAt("/", header);
    expect(screen.getByRole("radio", { name: "Match system theme" })).toBeChecked();

    await user.click(screen.getByRole("radio", { name: "Dark theme" }));

    expect(screen.getByRole("radio", { name: "Dark theme" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Match system theme" })).not.toBeChecked();
  });
});

describe("AppFooter", () => {
  it("is a contentinfo landmark with the three data attributions as external links", () => {
    render(<AppFooter />);

    expect(screen.getByRole("contentinfo")).toBeInTheDocument();
    for (const [name, href] of [
      ["Map data © OpenStreetMap contributors", "https://www.openstreetmap.org/copyright"],
      ["Map tiles: OpenFreeMap", "https://openfreemap.org"],
      ["Weather data by Open-Meteo.com (CC BY 4.0)", "https://open-meteo.com"],
    ] as const) {
      const link = screen.getByRole("link", { name: `${name} (opens in new tab)` });
      expect(link).toHaveAttribute("href", href);
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
    }
  });

  it("states that it is a planning aid and links to the source", () => {
    render(<AppFooter />);

    expect(
      screen.getByText(/planning aid, not a dispatch or safety certification/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Source on GitHub (opens in new tab)" }),
    ).toHaveAttribute("href", "https://github.com/ar27111994/weather-aware-truck-routing");
  });
});

describe("AppShell", () => {
  const shell = [
    {
      path: "/",
      Component: () => (
        <AppShell>
          <h1>Page content</h1>
        </AppShell>
      ),
    },
  ];

  it("has the skip link first, then the banner, one main landmark and the footer", async () => {
    const user = userEvent.setup();
    renderAt("/", shell);

    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(screen.getByRole("main")).toHaveAttribute("id", "main");
    expect(screen.getByRole("main")).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("main")).toHaveTextContent("Page content");
    expect(screen.getByRole("banner")).toBeInTheDocument();
    expect(screen.getByRole("contentinfo")).toBeInTheDocument();

    const skip = screen.getByRole("link", { name: "Skip to main content" });
    const precedes = (first: Element, second: Element): boolean =>
      (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    expect(precedes(skip, screen.getByRole("banner"))).toBe(true);
    expect(precedes(screen.getByRole("banner"), screen.getByRole("main"))).toBe(true);
    expect(precedes(screen.getByRole("main"), screen.getByRole("contentinfo"))).toBe(true);

    await user.tab();
    expect(skip).toHaveFocus();
    expect(skip).toHaveAttribute("href", "#main");
  });

  it("leaves the footer's external links exactly as written and still resolves app paths", () => {
    renderAt("/", shell);

    const footer = within(screen.getByRole("contentinfo"));
    for (const [name, href] of [
      ["Map data © OpenStreetMap contributors", "https://www.openstreetmap.org/copyright"],
      ["Map tiles: OpenFreeMap", "https://openfreemap.org"],
      ["Weather data by Open-Meteo.com (CC BY 4.0)", "https://open-meteo.com"],
      ["Source on GitHub", "https://github.com/ar27111994/weather-aware-truck-routing"],
    ] as const) {
      expect(footer.getByRole("link", { name: `${name} (opens in new tab)` })).toHaveAttribute(
        "href",
        href,
      );
    }
    expect(screen.getByRole("link", { name: "Methodology" })).toHaveAttribute(
      "href",
      "/methodology",
    );
  });

  it.each([
    "https://example.com/a?b=1#c",
    "http://example.com",
    "HTTPS://EXAMPLE.COM/UPPER",
    "mailto:help@example.com",
    "tel:+15551234567",
    "//cdn.example.com/x",
  ])("passes the address %s through to the anchor unchanged", (address) => {
    renderAt("/", [
      {
        path: "/",
        Component: () => (
          <AppShell>
            <Link href={address}>Probe</Link>
          </AppShell>
        ),
      },
    ]);

    expect(screen.getByRole("link", { name: "Probe" })).toHaveAttribute("href", address);
  });

  it("lets a route aim the skip link elsewhere and draw its own footer", () => {
    renderAt("/", [
      {
        path: "/",
        handle: { skipLink: { href: "#planner", label: "app.skipLink" }, footer: false },
        Component: () => (
          <AppShell>
            <section id="planner" aria-label="Trip planner" />
          </AppShell>
        ),
      },
    ]);

    expect(screen.getByRole("link", { name: "Skip to trip planner" })).toHaveAttribute(
      "href",
      "#planner",
    );
    expect(screen.queryByRole("contentinfo")).not.toBeInTheDocument();
  });

  it("keeps the footer when a route says nothing about it", () => {
    renderAt("/", [
      {
        path: "/",
        handle: {},
        Component: (): ReactElement => (
          <AppShell>
            <h1>Page content</h1>
          </AppShell>
        ),
      },
    ]);

    expect(screen.getByRole("contentinfo")).toBeInTheDocument();
  });

  it("ignores route handles that are not objects, and merges the deepest handle last", () => {
    renderAt("/", [
      {
        path: "/",
        handle: null,
        Component: (): ReactElement => (
          <AppShell>
            <Outlet />
          </AppShell>
        ),
        children: [
          {
            index: true,
            handle: { footer: false },
            Component: (): ReactElement => <h1>Page content</h1>,
          },
        ],
      },
    ]);

    expect(screen.queryByRole("contentinfo")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Skip to main content" })).toBeInTheDocument();
  });

  it("routes link presses through React Router, so navigating never reloads the page", async () => {
    const user = userEvent.setup();
    renderAt("/", [
      {
        path: "/",
        Component: (): ReactElement => (
          <AppShell>
            <Outlet />
          </AppShell>
        ),
        children: [
          { index: true, Component: (): ReactElement => <h1>Planner page</h1> },
          { path: "methodology", Component: (): ReactElement => <h1>Methodology page</h1> },
        ],
      },
    ]);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Planner page");

    await user.click(screen.getByRole("link", { name: "Methodology" }));

    expect(
      await screen.findByRole("heading", { level: 1, name: "Methodology page" }),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "Methodology" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });
});
