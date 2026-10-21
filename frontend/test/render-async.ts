import { act, render } from "@testing-library/react";
import type { RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";

import { defined } from "./defined";

/**
 * Renders a tree that may suspend, and lets React settle every promise that has already resolved.
 * React warns about a component that suspends inside an `act` scope that is not awaited, and the
 * synchronous `render` is exactly that: the page behind `/design` suspends on every section
 * until its demo has loaded.
 *
 * @param ui - The tree to render.
 */
export async function renderAsync(ui: ReactElement): Promise<RenderResult> {
  let result: RenderResult | undefined;
  await act(() => {
    result = render(ui);
    // A thenable makes this an async `act`: React then waits for what the render suspended on.
    return Promise.resolve();
  });
  return defined(result, "the rendered tree");
}
