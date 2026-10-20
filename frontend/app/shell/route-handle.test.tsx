import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { createRoutesStub, useRouteError } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { readRouteHandle, useRouteHandle } from "./route-handle";

describe("readRouteHandle", () => {
  it("accepts a skip link and a footer flag", () => {
    const handle = { skipLink: { href: "#planner", label: "app.skipLink" }, footer: false };

    expect(readRouteHandle(handle)).toEqual(handle);
  });

  it("reads only the fields the shell owns and leaves the rest of the handle to its owners", () => {
    expect(readRouteHandle({})).toEqual({});
    expect(readRouteHandle({ crumb: "Planner", footer: false })).toEqual({ footer: false });
  });

  it.each([null, undefined, "planner", 3, true])("reads %s as no handle at all", (value) => {
    expect(readRouteHandle(value)).toEqual({});
  });

  // R1-12: the old guard accepted any object, so each of these type-checked, then threw later
  // inside `t(skip.label)` with no hint of which route was wrong.
  it.each([
    ["a skip link that is a string", { skipLink: "x" }, "skipLink"],
    ["a skip link without an address", { skipLink: { label: "app.skipLink" } }, "skipLink.href"],
    [
      "an address that is not text",
      { skipLink: { href: 3, label: "app.skipLink" } },
      "skipLink.href",
    ],
    ["a skip link without a label", { skipLink: { href: "#a" } }, "skipLink.label"],
    [
      "a label that is no microcopy key",
      { skipLink: { href: "#a", label: "no.such.key" } },
      "skipLink.label",
    ],
    ["a skip link that is undefined", { skipLink: undefined }, "skipLink"],
    ["a footer flag that is not a boolean", { footer: "no" }, "footer"],
  ])("rejects %s and names the field", (_what, handle, field) => {
    expect(() => readRouteHandle(handle)).toThrow(field);
    expect(() => readRouteHandle(handle)).toThrow(/route handle/i);
  });
});

function ShowHandle(): ReactElement {
  return <output>{JSON.stringify(useRouteHandle())}</output>;
}

function ShowError(): ReactElement {
  const error = useRouteError();
  return <p role="alert">{error instanceof Error ? error.message : "unknown error"}</p>;
}

describe("useRouteHandle", () => {
  it("merges the handles of the matched routes, deepest last, skipping routes without one", () => {
    const Stub = createRoutesStub([
      {
        path: "/",
        handle: { footer: false, skipLink: { href: "#outer", label: "app.skipLink" } },
        children: [
          {
            path: "inner",
            handle: { skipLink: { href: "#inner", label: "app.skipToMain" } },
            children: [{ index: true, Component: ShowHandle }],
          },
        ],
      },
    ]);

    render(<Stub initialEntries={["/inner"]} />);

    expect(JSON.parse(screen.getByRole("status").textContent)).toEqual({
      footer: false,
      skipLink: { href: "#inner", label: "app.skipToMain" },
    });
  });

  it("fails in the route that wrote a malformed handle, saying what is wrong with it", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const Stub = createRoutesStub([
      {
        path: "/",
        handle: { skipLink: "x" },
        Component: ShowHandle,
        ErrorBoundary: ShowError,
      },
    ]);

    render(<Stub initialEntries={["/"]} />);

    expect(screen.getByRole("alert")).toHaveTextContent(/route handle.*skipLink/i);
  });
});
