import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, useNavigate } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { navigatorFor, usePlannerBridge } from "./planner-bridge";

describe("navigatorFor", () => {
  it("pushes through the page's router, carrying the state in the options", () => {
    const navigate = vi.fn();
    const address = { pathname: "/", search: "?plan=p_1", hash: "" };

    navigatorFor(navigate).push(address, { from: "planner" }, { preventScrollReset: true });

    expect(navigate).toHaveBeenCalledExactlyOnceWith(address, {
      preventScrollReset: true,
      state: { from: "planner" },
    });
  });

  it("replaces through the page's router, so the page's history stays the one history", () => {
    const navigate = vi.fn();

    navigatorFor(navigate).replace("/?plan=p_2", null, {});

    expect(navigate).toHaveBeenCalledExactlyOnceWith("/?plan=p_2", { state: null, replace: true });
  });

  it("goes back and forward by whole steps", () => {
    const navigate = vi.fn();

    navigatorFor(navigate).go(-1);

    expect(navigate).toHaveBeenCalledExactlyOnceWith(-1);
  });

  it("writes an address as a link, given as text or as its parts", () => {
    const navigator = navigatorFor(vi.fn());

    expect(navigator.createHref("/?a=1")).toBe("/?a=1");
    expect(navigator.createHref({ pathname: "/methodology", search: "?a=1", hash: "#x" })).toBe(
      "/methodology?a=1#x",
    );
  });
});

describe("usePlannerBridge", () => {
  function wrapper({ children }: { readonly children: ReactNode }): ReactNode {
    return <MemoryRouter initialEntries={["/?origin=a"]}>{children}</MemoryRouter>;
  }

  it("gives the page's address, and follows it when it changes", () => {
    const { result } = renderHook(() => ({ bridge: usePlannerBridge(), navigate: useNavigate() }), {
      wrapper,
    });
    expect(result.current.bridge.location.search).toBe("?origin=a");

    act(() => {
      void result.current.navigate("/?origin=b");
    });

    expect(result.current.bridge.location.search).toBe("?origin=b");
  });

  it("gives the same bridge again while the address has not changed", () => {
    const { result, rerender } = renderHook(() => usePlannerBridge(), { wrapper });
    const first = result.current;

    rerender();

    expect(result.current).toBe(first);
  });
});
