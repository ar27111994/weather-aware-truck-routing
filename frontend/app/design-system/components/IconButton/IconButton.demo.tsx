import { ArrowUpDown, Copy, Maximize2, Play, Plus, X } from "lucide-react";

import type { Demo } from "../../foundation/demo";
import { t } from "../../foundation/strings";
import { IconButton } from "./IconButton";

export const demo: Demo = {
  name: "IconButton",
  description:
    "Square icon-only button. The label is the accessible name and the tooltip text. Hover for 400 ms or tab to it to see the tooltip.",
  states: [
    {
      id: "ghost",
      title: "Ghost (toolbars, map controls)",
      node: <IconButton icon={Copy} label="Copy link" />,
    },
    {
      id: "secondary",
      title: "Secondary",
      node: (
        <IconButton icon={ArrowUpDown} label="Swap origin and destination" variant="secondary" />
      ),
    },
    {
      id: "small",
      title: "Small, 32 px",
      node: <IconButton icon={X} label={t("dialog.close")} size="sm" />,
    },
    { id: "medium", title: "Medium, 40 px", node: <IconButton icon={Plus} label="Zoom in" /> },
    {
      id: "large",
      title: "Large, 44 px",
      node: <IconButton icon={Play} label="Play forecast" size="lg" />,
    },
    {
      id: "no-tooltip",
      title: "No tooltip (label visible elsewhere)",
      node: (
        <IconButton icon={Maximize2} label="Fit routes" showTooltip={false} variant="secondary" />
      ),
    },
    {
      id: "disabled",
      title: "Disabled",
      node: <IconButton icon={Copy} label="Copy link" isDisabled />,
    },
    {
      id: "disabled-secondary",
      title: "Disabled, secondary",
      node: <IconButton icon={Copy} label="Copy link" variant="secondary" isDisabled />,
    },
  ],
};
