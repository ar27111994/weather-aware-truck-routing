// @vitest-environment node
import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";

import { allowConsole } from "../test/console-guard";

import { PRESSABLE_STYLE, PRESSABLE_STYLE_ID } from "./design-system/foundation/pressable-style";
import { THEME_INIT_SCRIPT } from "./design-system/foundation/theme-script";
import { ThemeProvider } from "./design-system/foundation/ThemeProvider";
import App, { ErrorBoundary, HydrateFallback, Layout, links } from "./root";
import { RouteError } from "./shell/RouteError";
import type { RouteHandle } from "./shell/route-handle";

// `<html>` cannot be mounted inside a jsdom container, so the document shell is rendered to a
// string on the server, which is also how the prerender step produces it.
function render(path: string, routes: Parameters<typeof createRoutesStub>[0]): string {
  const Stub = createRoutesStub(routes);
  // In the app `Layout` supplies the theme provider around whichever page renders.
  return renderToString(
    <ThemeProvider>
      <Stub initialEntries={[path]} />
    </ThemeProvider>,
  );
}

describe("root document", () => {
  beforeEach(() => {
    // `createRoutesStub` gives `<Links />` and `<Scripts />` a placeholder manifest, and React
    // warns about the empty `href` it renders. That is the test stub, not the app: in a build the
    // manifest has real URLs. Anything else React or React Router logs still fails the test.
    allowConsole(/An empty string \(""\) was passed to the %s attribute/);
  });

  const document = [
    {
      path: "/",
      Component: () => (
        <Layout>
          <p>routed page</p>
        </Layout>
      ),
    },
  ];

  it("is a complete English html document with the routed page in the body", () => {
    const html = render("/", document);

    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<meta charSet="utf-8"/>');
    expect(html).toContain('name="viewport" content="width=device-width, initial-scale=1"');
    expect(html).toContain("<p>routed page</p>");
  });

  it("asks the browser for both colour schemes so native controls follow the theme", () => {
    expect(render("/", document)).toContain('<meta name="color-scheme" content="light dark"/>');
  });

  it("colours the browser chrome for each colour scheme", () => {
    const html = render("/", document);

    expect(html).toContain(
      '<meta name="theme-color" content="#F6F6F3" media="(prefers-color-scheme: light)"/>',
    );
    expect(html).toContain(
      '<meta name="theme-color" content="#141412" media="(prefers-color-scheme: dark)"/>',
    );
  });

  it("ships the style React Aria would write at run time, so the policy never has to block one", () => {
    // style-src 'self' blocks a <style> element created in the browser. React Aria writes one for
    // pressable elements unless the document already has it; inject-csp hashes this one at build time.
    expect(render("/", document)).toContain(
      `<style id="${PRESSABLE_STYLE_ID}">${PRESSABLE_STYLE}</style>`,
    );
  });

  it("carries the no-flash theme script, byte for byte, before anything is painted", () => {
    const html = render("/", document);

    expect(html).toContain(`<script>${THEME_INIT_SCRIPT}</script>`);
    expect(html.indexOf("<script>")).toBeLessThan(html.indexOf("<body"));
  });
});

describe("root route", () => {
  it("wraps the matched child route in the app shell", () => {
    const html = render("/", [
      {
        path: "/",
        Component: App,
        children: [{ index: true, Component: () => <h1>child route</h1> }],
      },
    ]);

    expect(html).toContain("<h1>child route</h1>");
    expect(html).toContain('<main id="main" tabindex="-1"');
    expect(html).toContain('href="#main"');
    expect(html).toContain("<header");
    expect(html).toContain("<footer");
  });

  it("shows a labelled spinner in the shell while a client-rendered route loads", () => {
    const html = render("/", [{ path: "/", Component: HydrateFallback }]);

    expect(html).toContain("<main");
    expect(html).toContain('aria-label="In progress"');
  });

  it("draws the same shell whatever route the build prerendered it for", () => {
    // The build prerenders this fallback at `/`, where the planner's handle hides the footer and
    // aims the skip link at the form. The browser draws it first on a page that is not prerendered
    // (/design, a wrong address), before that page's module and handle have loaded. Two different
    // shells are a hydration error (React 418): the whole page is drawn again and `<html>` loses
    // the `data-theme` the inline script gave it.
    const planner = {
      skipLink: { href: "#planner", label: "app.skipLink" },
      footer: false,
    } satisfies RouteHandle;
    const prerenderedAtPlanner = render("/", [
      { path: "/", Component: HydrateFallback, handle: planner },
    ]);
    const drawnBeforeAnyHandleLoaded = render("/", [{ path: "/", Component: HydrateFallback }]);

    expect(prerenderedAtPlanner).toBe(drawnBeforeAnyHandleLoaded);
    expect(prerenderedAtPlanner).toContain('href="#main"');
    expect(prerenderedAtPlanner).toContain("<footer");
  });

  it("uses the shared error page as its error boundary", () => {
    expect(ErrorBoundary).toBe(RouteError);
  });
});

describe("links", () => {
  it("preloads only the latin Overpass font file, as a cross-origin woff2", () => {
    // A link descriptor is either a `<link>` tag (it has a `rel`) or a prefetch of a route's page.
    const preloads = links().filter(
      (descriptor) => "rel" in descriptor && descriptor.rel === "preload",
    );

    expect(preloads).toHaveLength(1);
    expect(preloads[0]).toMatchObject({
      rel: "preload",
      as: "font",
      type: "font/woff2",
      crossOrigin: "anonymous",
    });
    expect(preloads[0]).toHaveProperty(
      "href",
      expect.stringMatching(/overpass-latin-wght-normal.*\.woff2$/),
    );
  });

  it("names the icons and the web manifest, each a file in public/", () => {
    const descriptors = links();

    expect(descriptors).toContainEqual({
      rel: "icon",
      href: "/favicon.svg",
      type: "image/svg+xml",
    });
    expect(descriptors).toContainEqual({
      rel: "icon",
      href: "/favicon-32.png",
      type: "image/png",
      sizes: "32x32",
    });
    expect(descriptors).toContainEqual({ rel: "apple-touch-icon", href: "/apple-touch-icon.png" });
    expect(descriptors).toContainEqual({ rel: "manifest", href: "/manifest.webmanifest" });
  });
});
