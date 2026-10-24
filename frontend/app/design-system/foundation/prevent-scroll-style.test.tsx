import { render } from "@testing-library/react";
import { createHash } from "node:crypto";
import { usePreventScroll } from "react-aria";
import { afterEach, describe, expect, it, vi } from "vitest";

import runtimeStyles from "../../../../shared/csp-runtime-styles.json";

/**
 * The SHA-256 that review R3 computed on its own from the text in react-aria
 * (`.planning/evidence/r3-ds-followups/csp/style_hashes.py`), and that `scripts/vercel_output.py`
 * adds to `style-src`. Written out here so that a mistake in the shared file cannot also change
 * what this test expects.
 */
const R3_HASH = "gYiS/BvZvRcK27JIXTuwhZ3hs2+VJ1X+2gUlE+farlg=";

function Locked(): null {
  usePreventScroll();
  return null;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the style that React Aria writes to lock the page's scroll on iOS (R3-01, D-25)", () => {
  // React Aria checks the platform once and keeps the answer, so this file asks for iOS before
  // anything in it renders. Every real iPhone and iPad takes this path (all iOS browsers are
  // WebKit), and no browser engine in CI reports an iOS platform, so only a test like this one can
  // tell that the policy allows what the library writes.
  it("is exactly the text that shared/csp-runtime-styles.json lists, and that the CSP allows by hash", () => {
    vi.spyOn(window.navigator, "platform", "get").mockReturnValue("iPhone");

    const { unmount } = render(<Locked />);
    const written = [...document.head.querySelectorAll("style")]
      .map((element) => element.textContent)
      .filter((text) => text.includes("overscroll-behavior"));
    unmount();

    expect(written).toEqual(runtimeStyles.styles.map((style) => style.text));
    expect(createHash("sha256").update(written.join("")).digest("base64")).toBe(R3_HASH);
  });
});
