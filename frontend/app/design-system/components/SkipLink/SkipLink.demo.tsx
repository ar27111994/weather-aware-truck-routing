import type { Demo } from "../../foundation/demo";
import { SkipLink } from "./SkipLink";

export const demo: Demo = {
  name: "SkipLink",
  description:
    "Invisible until it has keyboard focus: press Tab from the top of the page. Then it is a fixed ink label in the top-left corner.",
  states: [
    {
      id: "default",
      title: "Default wording (focus it with Tab to see it)",
      node: <SkipLink href="#design-skip-target">Skip to the component list</SkipLink>,
    },
  ],
};
