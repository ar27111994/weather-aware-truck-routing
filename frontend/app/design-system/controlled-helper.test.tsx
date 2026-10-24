import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { Controlled } from "../../test/controlled";

/**
 * Tests of `test/controlled.tsx`, the parent that a component is controlled by in a test (R3-20).
 *
 * The helper holds the value a parent would hold: the component asks for a change, the helper keeps
 * it and hands the new value back down. The tests of a dozen components use it, and some of them
 * hear every change through a spy while others read only what the screen shows. A counter button
 * stands for the component, so that nothing but the helper is under test.
 */

/** A component that is controlled by its parent and asks for the next number when it is pressed. */
function count(control: {
  readonly value: number;
  readonly onChange: (next: number) => void;
}): ReactElement {
  return (
    <button
      type="button"
      onClick={() => {
        control.onChange(control.value + 1);
      }}
    >
      {`Count ${String(control.value)}`}
    </button>
  );
}

describe("Controlled", () => {
  it("hands the component the value it starts with", () => {
    render(<Controlled<number> initial={2}>{count}</Controlled>);

    expect(screen.getByRole("button")).toHaveTextContent("Count 2");
  });

  it("keeps every change the component asks for, hands it back down and tells the test", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Controlled<number> initial={2} onChange={onChange}>
        {count}
      </Controlled>,
    );

    await user.click(screen.getByRole("button"));
    await user.click(screen.getByRole("button"));

    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenNthCalledWith(1, 3);
    expect(onChange).toHaveBeenNthCalledWith(2, 4);
    expect(screen.getByRole("button")).toHaveTextContent("Count 4");
  });

  it("needs no listener when a test reads only what the screen shows", async () => {
    const user = userEvent.setup();
    // React reports an error that a handler throws to the window, and Vitest fails the whole run
    // for it. A listener on the window takes that over, so that this test is the one that fails.
    const reported: unknown[] = [];
    const onError = (event: ErrorEvent): void => {
      event.preventDefault();
      reported.push(event.error);
    };
    window.addEventListener("error", onError);
    try {
      render(<Controlled<number> initial={2}>{count}</Controlled>);

      await user.click(screen.getByRole("button"));
      await user.click(screen.getByRole("button"));
    } finally {
      window.removeEventListener("error", onError);
    }

    expect(reported).toEqual([]);
    expect(screen.getByRole("button")).toHaveTextContent("Count 4");
  });
});
