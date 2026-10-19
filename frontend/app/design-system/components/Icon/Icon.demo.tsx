import { Flag, Truck, Wind } from "lucide-react";

import type { Demo } from "../../foundation/demo";
import { Icon } from "./Icon";

export const demo: Demo = {
  name: "Icon",
  description:
    "Lucide line icons at the three allowed sizes. Decorative by default, labelled on request.",
  states: [
    {
      id: "sizes",
      title: "16, 20 and 24 px",
      node: (
        <span style={{ display: "inline-flex", gap: "var(--space-4)", alignItems: "center" }}>
          <Icon icon={Truck} size={16} />
          <Icon icon={Truck} size={20} />
          <Icon icon={Truck} size={24} />
        </span>
      ),
    },
    {
      id: "labelled",
      title: "Labelled (exposed as an image)",
      node: <Icon icon={Flag} label="Destination" />,
    },
    {
      id: "inherits-colour",
      title: "Follows the text colour",
      node: (
        <span style={{ color: "var(--color-text-secondary)" }}>
          <Icon icon={Wind} />
        </span>
      ),
    },
  ],
};
