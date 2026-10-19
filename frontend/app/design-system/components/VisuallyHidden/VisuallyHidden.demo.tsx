import type { Demo } from "../../foundation/demo";
import { VisuallyHidden } from "./VisuallyHidden";

export const demo: Demo = {
  name: "VisuallyHidden",
  description:
    "Content for screen readers only. Nothing is visible below except the surrounding button text.",
  states: [
    {
      id: "inside-a-button",
      title: "Hidden label next to a visible icon cue",
      node: (
        <button type="button">
          Copy
          <VisuallyHidden> link to this plan</VisuallyHidden>
        </button>
      ),
    },
    {
      id: "focusable",
      title: "Focusable: appears while focused (skip links)",
      node: (
        <VisuallyHidden isFocusable>
          <a href="#design-sink">Skip to the component list</a>
        </VisuallyHidden>
      ),
    },
  ],
};
