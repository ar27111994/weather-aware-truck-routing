import { act, renderHook } from "@testing-library/react";
import type { ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { installMatchMedia } from "../../../test/match-media";
import { useMediaQuery } from "./useMediaQuery";

const WIDE = "(min-width: 1024px)";
const NARROW = "(max-width: 600px)";

function Probe({ query }: { readonly query: string }): ReactElement {
  return <output>{String(useMediaQuery(query))}</output>;
}

describe("useMediaQuery", () => {
  it("reports whether the query matches and follows changes", () => {
    const media = installMatchMedia({ [WIDE]: false });
    const { result } = renderHook(() => useMediaQuery(WIDE));
    expect(result.current).toBe(false);

    act(() => {
      media.setMatches(WIDE, true);
    });
    expect(result.current).toBe(true);

    act(() => {
      media.setMatches(WIDE, false);
    });
    expect(result.current).toBe(false);
  });

  it("starts from the current answer of the browser", () => {
    installMatchMedia({ [WIDE]: true });

    const { result } = renderHook(() => useMediaQuery(WIDE));

    expect(result.current).toBe(true);
  });

  it("registers one listener while mounted and none after it unmounts", () => {
    const media = installMatchMedia({ [WIDE]: false });
    const { unmount } = renderHook(() => useMediaQuery(WIDE));
    expect(media.listenerCount(WIDE)).toBe(1);

    unmount();

    expect(media.listenerCount(WIDE)).toBe(0);
  });

  it("subscribes once and reads one media query list, however often it renders (R1-40)", () => {
    const media = installMatchMedia({ [WIDE]: false });
    const { rerender } = renderHook(() => useMediaQuery(WIDE));

    for (let render = 0; render < 5; render += 1) {
      rerender();
    }

    expect(media.subscribeCount(WIDE)).toBe(1);
    expect(media.listCount(WIDE)).toBe(1);
  });

  it("lets go of the old query and listens to the new one when the query changes", () => {
    const media = installMatchMedia({ [WIDE]: false, [NARROW]: true });
    const { result, rerender } = renderHook(({ query }) => useMediaQuery(query), {
      initialProps: { query: WIDE },
    });
    expect(result.current).toBe(false);

    rerender({ query: NARROW });

    expect(result.current).toBe(true);
    expect(media.listenerCount(WIDE)).toBe(0);
    expect(media.listenerCount(NARROW)).toBe(1);
  });

  it("is false on the server and never touches the browser there", () => {
    const media = installMatchMedia({ [WIDE]: true });

    const html = renderToString(<Probe query={WIDE} />);

    expect(html).toContain("false");
    expect(media.listCount(WIDE)).toBe(0);
  });
});
