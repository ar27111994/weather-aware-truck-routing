import type { Demo } from "../../foundation/demo";
import { Link } from "./Link";

export const demo: Demo = {
  name: "Link",
  description:
    "Ink text with a hairline underline that thickens on hover. External links open in a new tab and say so to screen readers.",
  states: [
    { id: "inline", title: "Inline", node: <Link href="#design-link">Read the methodology</Link> },
    {
      id: "external",
      title: "External: new tab, cue and hidden words",
      node: (
        <Link href="https://open-meteo.com" isExternal>
          Open-Meteo.com
        </Link>
      ),
    },
    {
      id: "nav",
      title: "Navigation item",
      node: (
        <Link href="#design-link" variant="nav">
          Methodology
        </Link>
      ),
    },
    {
      id: "nav-current",
      title: "Navigation item, current page",
      node: (
        <Link href="#design-link" variant="nav" aria-current="page">
          Planner
        </Link>
      ),
    },
  ],
};
