import { describe, expect, it } from "vitest";

import * as designSystem from "./index";
import barrel from "./index.ts?raw";

const FOLDERS = Object.keys(import.meta.glob("./components/*/index.ts"))
  .map((path) => path.split("/")[2])
  .filter((name): name is string => name !== undefined);

describe("the design-system barrel", () => {
  it("re-exports every component folder, one line each, sorted alphabetically", () => {
    const lines = barrel
      .split("\n")
      .filter((line) => line.startsWith('export * from "./components/'))
      .map((line) => /components\/(\w+)"/.exec(line)?.[1]);

    expect(lines).toEqual([...FOLDERS].sort((left, right) => left.localeCompare(right, "en")));
  });

  it("exports the components people reach for", () => {
    for (const name of [
      "Button",
      "IconButton",
      "Link",
      "Badge",
      "Slider",
      "TimelineSlider",
      "Banner",
      "Legend",
      "Popover",
      "Tooltip",
      "ThemeToggle",
      "Stack",
      "SkipLink",
      "Skeleton",
    ] as const) {
      expect(designSystem).toHaveProperty(name);
    }
  });

  it("exports the foundation: strings, theme, risk metadata and tokens", () => {
    for (const name of [
      "cx",
      "t",
      "tPlural",
      "riskInfo",
      "RISK_LEVELS",
      "ThemeProvider",
      "useTheme",
      "useMediaQuery",
      "THEMES",
      "tokens",
    ] as const) {
      expect(designSystem).toHaveProperty(name);
    }
  });
});
