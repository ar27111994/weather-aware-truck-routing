import { Clock } from "lucide-react";

import type { Demo } from "../../foundation/demo";
import { ActionChip, Chip } from "./Chip";

export const demo: Demo = {
  name: "Chip",
  description:
    "Toggle chips filter or preset a value (selected is ink). Action chips are one-shot quick buttons.",
  states: [
    { id: "unselected", title: "Toggle, unselected", node: <Chip>Wind</Chip> },
    { id: "selected", title: "Toggle, selected", node: <Chip defaultSelected>Rain</Chip> },
    { id: "icon", title: "Toggle with icon", node: <Chip leadingIcon={Clock}>Departure</Chip> },
    { id: "disabled", title: "Toggle, disabled", node: <Chip isDisabled>Snow</Chip> },
    {
      id: "disabled-selected",
      title: "Toggle, selected and disabled",
      node: (
        <Chip isDisabled defaultSelected>
          Risk
        </Chip>
      ),
    },
    { id: "action", title: "Action chip (one shot)", node: <ActionChip>Now</ActionChip> },
    {
      id: "action-icon",
      title: "Action chip with icon",
      node: <ActionChip leadingIcon={Clock}>+3 h</ActionChip>,
    },
    {
      id: "action-disabled",
      title: "Action chip, disabled",
      node: <ActionChip isDisabled>Tomorrow 06:00</ActionChip>,
    },
  ],
};
