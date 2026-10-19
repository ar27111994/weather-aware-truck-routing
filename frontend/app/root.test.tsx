// @vitest-environment node
import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { describe, expect, it } from "vitest";

import App, { Layout } from "./root";

// `<html>` cannot be mounted inside a jsdom container, so the document shell is rendered to a
// string on the server, which is also how the prerender step produces it.
describe("root route", () => {
  it("renders a complete html document around the page content", () => {
    const Stub = createRoutesStub([
      {
        path: "/",
        Component: () => (
          <Layout>
            <p>routed page</p>
          </Layout>
        ),
      },
    ]);

    const html = renderToString(<Stub initialEntries={["/"]} />);

    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<meta charSet="utf-8"/>');
    expect(html).toContain('name="viewport" content="width=device-width, initial-scale=1"');
    expect(html).toContain("<p>routed page</p>");
  });

  it("renders the matched child route through the outlet", () => {
    const Stub = createRoutesStub([
      {
        path: "/",
        Component: App,
        children: [{ index: true, Component: () => <p>child route</p> }],
      },
    ]);

    expect(renderToString(<Stub initialEntries={["/"]} />)).toContain("<p>child route</p>");
  });
});
