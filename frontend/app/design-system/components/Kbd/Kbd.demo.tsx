import { ArrowLeft, ArrowRight } from "lucide-react";

import type { Demo } from "../../foundation/demo";
import { Icon } from "../Icon";
import { VisuallyHidden } from "../VisuallyHidden";
import { Kbd } from "./Kbd";

export const demo: Demo = {
  name: "Kbd",
  description:
    "Key caps for help text. Arrows are icons with hidden words because Overpass has no arrow glyphs.",
  states: [
    { id: "text", title: "Text key", node: <Kbd>PgUp</Kbd> },
    {
      id: "arrows",
      title: "Arrow keys: icon plus hidden words",
      node: (
        <span style={{ display: "inline-flex", gap: "var(--space-1)" }}>
          <Kbd>
            <Icon icon={ArrowLeft} size={14} />
            <VisuallyHidden>left arrow</VisuallyHidden>
          </Kbd>
          <Kbd>
            <Icon icon={ArrowRight} size={14} />
            <VisuallyHidden>right arrow</VisuallyHidden>
          </Kbd>
        </span>
      ),
    },
  ],
};
