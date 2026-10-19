import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { useState, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { expectNoAxeViolations } from "../../../../test/axe";
import { copy } from "../../copy";
import { Tab, TabList, TabPanel, Tabs, type TabsProps } from "./Tabs";
import TabsDemo from "./Tabs.demo";

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
        <Tab id="checkpoints">{copy.tabs.checkpoints}</Tab>
        <Tab id="profile">{copy.tabs.profile}</Tab>
        <Tab id="details">{copy.tabs.details}</Tab>
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
      copy.tabs.checkpoints,
      copy.tabs.profile,
      copy.tabs.details,
    ]);
    expect(tab(copy.tabs.checkpoints)).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Checkpoint rows");
  });

  it("selects a tab by click and reports it", async () => {
    const user = userEvent.setup();
    const onSelectionChange = vi.fn();
    render(<Example onSelectionChange={onSelectionChange} />);

    await user.click(tab(copy.tabs.profile));

    expect(tab(copy.tabs.profile)).toHaveAttribute("aria-selected", "true");
    expect(tab(copy.tabs.checkpoints)).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Risk chart");
    expect(onSelectionChange).toHaveBeenLastCalledWith("profile");
  });

  it("moves and selects with the arrow keys, wrapping at the ends", async () => {
    const user = userEvent.setup();
    render(<Example />);
    await user.tab();

    await user.keyboard("{ArrowRight}");
    expect(tab(copy.tabs.profile)).toHaveFocus();
    expect(tab(copy.tabs.profile)).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Risk chart");

    await user.keyboard("{ArrowRight}");
    expect(tab(copy.tabs.details)).toHaveAttribute("aria-selected", "true");

    await user.keyboard("{ArrowRight}");
    expect(tab(copy.tabs.checkpoints)).toHaveAttribute("aria-selected", "true");

    await user.keyboard("{ArrowLeft}");
    expect(tab(copy.tabs.details)).toHaveFocus();
    expect(tab(copy.tabs.details)).toHaveAttribute("aria-selected", "true");
  });

  it("jumps to the first and last tab with Home and End and selects them", async () => {
    const user = userEvent.setup();
    render(<Example defaultSelectedKey="profile" />);
    await user.tab();

    await user.keyboard("{End}");
    expect(tab(copy.tabs.details)).toHaveFocus();
    expect(tab(copy.tabs.details)).toHaveAttribute("aria-selected", "true");

    await user.keyboard("{Home}");
    expect(tab(copy.tabs.checkpoints)).toHaveFocus();
    expect(tab(copy.tabs.checkpoints)).toHaveAttribute("aria-selected", "true");
  });

  it("keeps only the selected tab in the tab order and moves on to its panel", async () => {
    const user = userEvent.setup();
    render(<Example defaultSelectedKey="profile" />);

    await user.tab();
    expect(tab(copy.tabs.profile)).toHaveFocus();
    await user.tab();

    expect(screen.getByRole("tabpanel")).toHaveFocus();
  });

  it("starts on the tab named by defaultSelectedKey", () => {
    render(<Example defaultSelectedKey="details" />);

    expect(tab(copy.tabs.details)).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Trip facts");
  });

  it("follows selectedKey when controlled and lets the parent decide", async () => {
    const user = userEvent.setup();
    const onSelectionChange = vi.fn();
    render(<Example selectedKey="checkpoints" onSelectionChange={onSelectionChange} />);

    await user.click(tab(copy.tabs.details));

    expect(onSelectionChange).toHaveBeenCalledExactlyOnceWith("details");
    expect(tab(copy.tabs.checkpoints)).toHaveAttribute("aria-selected", "true");
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

    await user.click(tab(copy.tabs.profile));

    expect(tab(copy.tabs.profile)).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Risk chart");
  });

  it("skips a disabled tab with the keyboard and ignores a click on it", async () => {
    const user = userEvent.setup();
    render(<Example disabledKeys={["profile"]} />);
    await user.tab();

    await user.keyboard("{ArrowRight}");
    expect(tab(copy.tabs.details)).toHaveFocus();
    expect(tab(copy.tabs.details)).toHaveAttribute("aria-selected", "true");

    await user.click(tab(copy.tabs.profile));
    expect(tab(copy.tabs.profile)).toHaveAttribute("aria-disabled", "true");
    expect(tab(copy.tabs.profile)).toHaveAttribute("aria-selected", "false");
    expect(tab(copy.tabs.details)).toHaveAttribute("aria-selected", "true");
  });

  it("links the selected tab and its panel both ways", () => {
    render(<Example />);

    const selected = tab(copy.tabs.checkpoints);
    const panel = screen.getByRole("tabpanel");
    expect(selected).toHaveAttribute("aria-controls", panel.id);
    expect(panel).toHaveAttribute("aria-labelledby", selected.id);
    expect(panel).toHaveAccessibleName(copy.tabs.checkpoints);
  });

  it("shows keyboard focus on a tab", async () => {
    const user = userEvent.setup();
    render(<Example />);

    await user.tab();

    expect(tab(copy.tabs.checkpoints)).toHaveAttribute("data-focus-visible", "true");
  });

  it("marks hover on a tab", async () => {
    const user = userEvent.setup();
    render(<Example />);

    await user.hover(tab(copy.tabs.profile));

    expect(tab(copy.tabs.profile)).toHaveAttribute("data-hovered", "true");
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
      const { container } = render(<TabsDemo />);

      await expectNoAxeViolations(container);
    });
  });
});
