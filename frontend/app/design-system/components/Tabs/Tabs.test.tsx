import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { useState, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { expectNoAxeViolations } from "../../../../test/axe";
import {
  expectHoverState,
  expectKeyboardFocusState,
  expectNoPointerStates,
  expectPointerFocusState,
  expectPressedState,
} from "../../../../test/states";
import { t } from "../../foundation/strings";
import { Tab, TabList, TabPanel, Tabs, type TabsProps } from "./Tabs";
import { demo } from "./Tabs.demo";

/** jsdom has no Web Animations API; React Aria's sliding indicator asks for the running animations. */
beforeEach(() => {
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: (): Animation[] => [],
  });
});
afterEach(() => {
  Reflect.deleteProperty(Element.prototype, "getAnimations");
});

function Example(props: Omit<TabsProps, "children">): ReactElement {
  return (
    <Tabs {...props}>
      <TabList aria-label="Route details">
        <Tab id="checkpoints">{t("tabs.checkpoints")}</Tab>
        <Tab id="profile">{t("tabs.profile")}</Tab>
        <Tab id="details">{t("tabs.details")}</Tab>
      </TabList>
      <TabPanel id="checkpoints">Checkpoint rows</TabPanel>
      <TabPanel id="profile">Risk chart</TabPanel>
      <TabPanel id="details">Trip facts</TabPanel>
    </Tabs>
  );
}

const tab = (name: string): HTMLElement => screen.getByRole("tab", { name });

describe("Tabs", () => {
  it("lists the tabs in a named tablist and shows the first panel", () => {
    render(<Example />);

    expect(screen.getByRole("tablist", { name: "Route details" })).toBeInTheDocument();
    expect(screen.getAllByRole("tab").map((element) => element.textContent)).toEqual([
      t("tabs.checkpoints"),
      t("tabs.profile"),
      t("tabs.details"),
    ]);
    expect(tab(t("tabs.checkpoints"))).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Checkpoint rows");
  });

  it("selects a tab by click and reports it", async () => {
    const user = userEvent.setup();
    const onSelectionChange = vi.fn();
    render(<Example onSelectionChange={onSelectionChange} />);

    await user.click(tab(t("tabs.profile")));

    expect(tab(t("tabs.profile"))).toHaveAttribute("aria-selected", "true");
    expect(tab(t("tabs.checkpoints"))).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Risk chart");
    expect(onSelectionChange).toHaveBeenLastCalledWith("profile");
  });

  it("moves and selects with the arrow keys, wrapping at the ends", async () => {
    const user = userEvent.setup();
    render(<Example />);
    await user.tab();

    await user.keyboard("{ArrowRight}");
    expect(tab(t("tabs.profile"))).toHaveFocus();
    expect(tab(t("tabs.profile"))).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Risk chart");

    await user.keyboard("{ArrowRight}");
    expect(tab(t("tabs.details"))).toHaveAttribute("aria-selected", "true");

    await user.keyboard("{ArrowRight}");
    expect(tab(t("tabs.checkpoints"))).toHaveAttribute("aria-selected", "true");

    await user.keyboard("{ArrowLeft}");
    expect(tab(t("tabs.details"))).toHaveFocus();
    expect(tab(t("tabs.details"))).toHaveAttribute("aria-selected", "true");
  });

  it("jumps to the first and last tab with Home and End and selects them", async () => {
    const user = userEvent.setup();
    render(<Example defaultSelectedKey="profile" />);
    await user.tab();

    await user.keyboard("{End}");
    expect(tab(t("tabs.details"))).toHaveFocus();
    expect(tab(t("tabs.details"))).toHaveAttribute("aria-selected", "true");

    await user.keyboard("{Home}");
    expect(tab(t("tabs.checkpoints"))).toHaveFocus();
    expect(tab(t("tabs.checkpoints"))).toHaveAttribute("aria-selected", "true");
  });

  it("keeps only the selected tab in the tab order and moves on to its panel", async () => {
    const user = userEvent.setup();
    render(<Example defaultSelectedKey="profile" />);

    await user.tab();
    expect(tab(t("tabs.profile"))).toHaveFocus();
    await user.tab();

    expect(screen.getByRole("tabpanel")).toHaveFocus();
  });

  it("starts on the tab named by defaultSelectedKey", () => {
    render(<Example defaultSelectedKey="details" />);

    expect(tab(t("tabs.details"))).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Trip facts");
  });

  it("follows selectedKey when controlled and lets the parent decide", async () => {
    const user = userEvent.setup();
    const onSelectionChange = vi.fn();
    render(<Example selectedKey="checkpoints" onSelectionChange={onSelectionChange} />);

    await user.click(tab(t("tabs.details")));

    expect(onSelectionChange).toHaveBeenCalledExactlyOnceWith("details");
    expect(tab(t("tabs.checkpoints"))).toHaveAttribute("aria-selected", "true");
  });

  it("works controlled from a parent that applies the change", async () => {
    const user = userEvent.setup();
    function Controlled(): ReactElement {
      const [key, setKey] = useState<string>("checkpoints");
      return (
        <Example
          selectedKey={key}
          onSelectionChange={(next) => {
            setKey(String(next));
          }}
        />
      );
    }
    render(<Controlled />);

    await user.click(tab(t("tabs.profile")));

    expect(tab(t("tabs.profile"))).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Risk chart");
  });

  it("skips a disabled tab with the keyboard and ignores a click on it", async () => {
    const user = userEvent.setup();
    render(<Example disabledKeys={["profile"]} />);
    await user.tab();

    await user.keyboard("{ArrowRight}");
    expect(tab(t("tabs.details"))).toHaveFocus();
    expect(tab(t("tabs.details"))).toHaveAttribute("aria-selected", "true");

    await user.click(tab(t("tabs.profile")));
    expect(tab(t("tabs.profile"))).toHaveAttribute("aria-disabled", "true");
    expect(tab(t("tabs.profile"))).toHaveAttribute("aria-selected", "false");
    expect(tab(t("tabs.details"))).toHaveAttribute("aria-selected", "true");
  });

  it("links the selected tab and its panel both ways", () => {
    render(<Example />);

    const selected = tab(t("tabs.checkpoints"));
    const panel = screen.getByRole("tabpanel");
    expect(selected).toHaveAttribute("aria-controls", panel.id);
    expect(panel).toHaveAttribute("aria-labelledby", selected.id);
    expect(panel).toHaveAccessibleName(t("tabs.checkpoints"));
  });

  it("shows keyboard focus on a tab", async () => {
    const user = userEvent.setup();
    render(<Example />);

    await user.tab();

    expect(tab(t("tabs.checkpoints"))).toHaveAttribute("data-focus-visible", "true");
  });

  it("marks hover on a tab", async () => {
    const user = userEvent.setup();
    render(<Example />);

    await user.hover(tab(t("tabs.profile")));

    expect(tab(t("tabs.profile"))).toHaveAttribute("data-hovered", "true");
  });

  describe("interaction states", () => {
    const tabs = [[t("tabs.checkpoints")], [t("tabs.profile")], [t("tabs.details")]] as const;

    it.each(tabs)("hovers the %s tab while the pointer rests on it", async (name) => {
      const user = userEvent.setup();
      render(<Example />);

      await expectHoverState(user, tab(name));
    });

    it.each(tabs)("presses the %s tab while a pointer button is held down on it", async (name) => {
      const user = userEvent.setup();
      render(<Example />);

      await expectPressedState(user, tab(name));
    });

    it("shows the focus ring when the keyboard puts focus on the selected tab", async () => {
      const user = userEvent.setup();
      render(<Example />);

      await expectKeyboardFocusState(user, tab(t("tabs.checkpoints")));
    });

    it("moves the focus ring to the tab the arrow keys reach", async () => {
      const user = userEvent.setup();
      render(<Example />);
      await user.tab();

      await user.keyboard("{ArrowRight}");

      expect(tab(t("tabs.profile"))).toHaveAttribute("data-focus-visible", "true");
      expect(tab(t("tabs.checkpoints"))).not.toHaveAttribute("data-focus-visible");
    });

    it("shows no focus ring when a click puts focus on a tab", async () => {
      const user = userEvent.setup();
      render(<Example />);

      await expectPointerFocusState(user, tab(t("tabs.details")));
    });

    it("shows the focus ring on the panel when the keyboard moves into it", async () => {
      const user = userEvent.setup();
      render(<Example />);
      await user.tab();

      // The panel is the next tab stop after the selected tab.
      await expectKeyboardFocusState(user, screen.getByRole("tabpanel"));
    });

    it("marks only the selected tab and moves the mark with the selection", async () => {
      const user = userEvent.setup();
      render(<Example />);
      expect(tab(t("tabs.checkpoints"))).toHaveAttribute("data-selected", "true");
      expect(tab(t("tabs.profile"))).not.toHaveAttribute("data-selected");

      await user.click(tab(t("tabs.profile")));

      expect(tab(t("tabs.profile"))).toHaveAttribute("data-selected", "true");
      expect(tab(t("tabs.checkpoints"))).not.toHaveAttribute("data-selected");
    });

    it("draws the underline inside the selected tab only", async () => {
      const user = userEvent.setup();
      render(<Example />);
      expect(tab(t("tabs.checkpoints")).children).toHaveLength(1);
      expect(tab(t("tabs.profile")).children).toHaveLength(0);

      await user.click(tab(t("tabs.profile")));

      expect(tab(t("tabs.profile")).children).toHaveLength(1);
      expect(tab(t("tabs.checkpoints")).children).toHaveLength(0);
    });

    it("is neither hovered nor pressed while disabled", async () => {
      const user = userEvent.setup();
      render(<Example disabledKeys={["profile"]} />);

      await expectNoPointerStates(user, tab(t("tabs.profile")));
    });
  });

  describe("styling contract", () => {
    const css = readFileSync(join(import.meta.dirname, "Tabs.module.css"), "utf8");

    it("slides the underline with the base duration token", () => {
      expect(css).toMatch(
        /transition:\s*translate\s+var\(--motion-duration-base\)\s+var\(--motion-easing-standard\)/,
      );
    });
  });

  describe("accessibility (axe)", () => {
    it("has no violations by default and with a disabled tab", async () => {
      const { container } = render(
        <>
          <Example />
          <Example disabledKeys={["profile"]} defaultSelectedKey="details" />
        </>,
      );

      await expectNoAxeViolations(container);
    });

    it("has no violations in the demo", async () => {
      const { container } = render(<>{demo.states[0]?.node}</>);

      await expectNoAxeViolations(container);
    });
  });
});
