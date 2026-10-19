import { ArrowUpDown, Search } from "lucide-react";

import type { Demo } from "../../foundation/demo";
import { Button } from "./Button";

export const demo: Demo = {
  name: "Button",
  description:
    "Commit actions. One primary per view. Hover and pressed cannot be pinned here; try them with the mouse and keyboard.",
  states: [
    { id: "primary", title: "Primary", node: <Button variant="primary">Plan routes</Button> },
    { id: "secondary", title: "Secondary", node: <Button>Edit trip</Button> },
    { id: "ghost", title: "Ghost", node: <Button variant="ghost">Try a demo scenario</Button> },
    { id: "danger", title: "Danger (reserved)", node: <Button variant="danger">Clear</Button> },
    { id: "small", title: "Small, 32 px", node: <Button size="sm">Retry</Button> },
    {
      id: "large",
      title: "Large, 48 px, primary",
      node: (
        <Button size="lg" variant="primary">
          Plan routes
        </Button>
      ),
    },
    {
      id: "leading-icon",
      title: "Leading icon",
      node: <Button leadingIcon={Search}>Search a place</Button>,
    },
    {
      id: "trailing-icon",
      title: "Trailing icon",
      node: <Button trailingIcon={ArrowUpDown}>Swap</Button>,
    },
    {
      id: "disabled",
      title: "Disabled",
      node: (
        <Button isDisabled variant="primary">
          Plan routes
        </Button>
      ),
    },
    {
      id: "loading",
      title: "Loading (width locked)",
      node: (
        <Button isLoading loadingLabel="Planning routes" variant="primary">
          Plan routes
        </Button>
      ),
    },
    {
      id: "loading-secondary",
      title: "Loading, secondary",
      node: (
        <Button isLoading loadingLabel="Copying">
          Copy link
        </Button>
      ),
    },
  ],
};
