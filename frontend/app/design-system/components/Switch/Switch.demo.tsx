import type { Demo } from "../../foundation/demo";
import { Switch } from "./Switch";

export const demo: Demo = {
  name: "Switch",
  description: "On or off, applied at once. The label sits to the right of a 40 by 24 px track.",
  states: [
    { id: "off", title: "Off", node: <Switch>Show forecast map</Switch> },
    { id: "on", title: "On", node: <Switch defaultSelected>Show forecast map</Switch> },
    {
      id: "disabled-off",
      title: "Disabled, off",
      node: <Switch isDisabled>Show forecast map</Switch>,
    },
    {
      id: "disabled-on",
      title: "Disabled, on",
      node: (
        <Switch isDisabled defaultSelected>
          Show forecast map
        </Switch>
      ),
    },
  ],
};
