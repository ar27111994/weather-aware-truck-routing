import { useState } from "react";
import type { ReactElement } from "react";

import type { Demo } from "../../foundation/demo";
import type { Theme } from "../../foundation/theme";
import { ThemeToggle } from "./ThemeToggle";

/** A toggle that keeps its own choice, so a specimen can be clicked without changing the page. */
function Specimen({ initial }: { readonly initial: Theme }): ReactElement {
  const [value, setValue] = useState(initial);
  return <ThemeToggle value={value} onChange={setValue} />;
}

export const demo: Demo = {
  name: "ThemeToggle",
  description:
    "Light, dark or system as three icon buttons. Selected is ink. Each specimen keeps its own choice; the toggle in the page header is the live one.",
  states: [
    { id: "system", title: "System selected (default)", node: <Specimen initial="system" /> },
    { id: "light", title: "Light selected", node: <Specimen initial="light" /> },
    { id: "dark", title: "Dark selected", node: <Specimen initial="dark" /> },
  ],
};
