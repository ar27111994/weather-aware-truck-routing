import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactElement } from "react";
import type { Key } from "react-aria-components";
import { describe, expect, it, vi } from "vitest";

import { expectNoAxeViolations } from "../../../../test/axe";
import { t } from "../../foundation/strings";
import { Select, SelectItem, type SelectProps } from "./Select";
import { demo } from "./Select.demo";

interface Source {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
}

const live: Source = { id: "live", name: t("form.scenario.live") };
const storm: Source = { id: "storm", name: "Winter storm", description: "Heavy snow on I-80." };
const fog: Source = { id: "fog", name: "Dense fog" };
const sources: readonly Source[] = [live, storm, fog];

function renderSource(source: Source): ReactElement {
  return (
    <SelectItem
      id={source.id}
      textValue={source.name}
      {...(source.description === undefined ? {} : { description: source.description })}
    >
      {source.name}
    </SelectItem>
  );
}

type SelectTestProps = Partial<Omit<SelectProps<Source>, "children">>;

function SourceSelect(props: SelectTestProps): ReactElement {
  return (
    <Select<Source> label={t("form.scenario.label")} items={sources} {...props}>
      {renderSource}
    </Select>
  );
}

function getTrigger(): HTMLElement {
  return screen.getByRole("button", { name: new RegExp(t("form.scenario.label")), hidden: true });
}

describe("Select", () => {
  describe("field", () => {
    it("names the trigger by its label and starts closed", () => {
      render(<SourceSelect />);

      expect(getTrigger()).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });

    it("shows the placeholder while nothing is chosen", () => {
      render(<SourceSelect placeholder="Choose a source" />);

      expect(within(getTrigger()).getByText("Choose a source")).toBeInTheDocument();
    });

    it("describes the trigger with its hint", () => {
      render(<SourceSelect description={t("form.scenario.hint")} />);

      expect(getTrigger()).toHaveAccessibleDescription(t("form.scenario.hint"));
    });

    it("shows no error while valid, and the error with the field when invalid", () => {
      const { rerender } = render(<SourceSelect errorMessage="Choose a source." />);
      expect(screen.queryByText("Choose a source.")).not.toBeInTheDocument();
      expect(getTrigger()).not.toHaveAttribute("data-invalid");

      rerender(<SourceSelect isInvalid errorMessage="Choose a source." />);

      expect(getTrigger()).toHaveAttribute("data-invalid", "true");
      expect(getTrigger()).toHaveAccessibleDescription("Choose a source.");
    });

    it("cannot be opened while disabled", async () => {
      const user = userEvent.setup();
      render(<SourceSelect isDisabled />);

      await user.click(getTrigger());

      expect(getTrigger()).toBeDisabled();
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });

    it("submits the chosen key under its name", async () => {
      const user = userEvent.setup();
      render(
        <form aria-label="Trip">
          <SourceSelect name="weather" isRequired defaultValue="live" />
        </form>,
      );

      await user.click(getTrigger());
      await user.click(screen.getByRole("option", { name: "Winter storm" }));

      const form = screen.getByRole<HTMLFormElement>("form", { name: "Trip" });
      expect(new FormData(form).get("weather")).toBe("storm");
    });
  });

  describe("options", () => {
    it("opens a list of the items, each with its name and description", async () => {
      const user = userEvent.setup();
      render(<SourceSelect />);

      await user.click(getTrigger());

      expect(getTrigger()).toHaveAttribute("aria-expanded", "true");
      const list = screen.getByRole("listbox");
      expect(within(list).getAllByRole("option")).toHaveLength(3);
      expect(
        within(list).getByRole("option", { name: "Winter storm" }),
      ).toHaveAccessibleDescription("Heavy snow on I-80.");
      expect(
        within(list).getByRole("option", { name: "Dense fog" }),
      ).not.toHaveAccessibleDescription();
    });

    it("shows the chosen item's name in the trigger and reports its key", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<SourceSelect onChange={onChange} />);

      await user.click(getTrigger());
      await user.click(screen.getByRole("option", { name: "Winter storm" }));

      expect(onChange).toHaveBeenCalledWith("storm");
      expect(within(getTrigger()).getByText("Winter storm")).toBeInTheDocument();
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });

    it("starts from a default key, uncontrolled", () => {
      render(<SourceSelect defaultValue="fog" />);

      expect(within(getTrigger()).getByText("Dense fog")).toBeInTheDocument();
    });

    it("works controlled", async () => {
      const user = userEvent.setup();
      function Controlled(): ReactElement {
        const [key, setKey] = useState<Key | null>("live");
        return (
          <>
            <SourceSelect value={key} onChange={setKey} />
            <p>Chosen: {String(key)}</p>
          </>
        );
      }
      render(<Controlled />);
      expect(screen.getByText("Chosen: live")).toBeInTheDocument();

      await user.click(getTrigger());
      await user.click(screen.getByRole("option", { name: "Dense fog" }));

      expect(screen.getByText("Chosen: fog")).toBeInTheDocument();
    });

    it("opens with the keyboard, moves with the arrows, chooses with Enter and closes with Escape", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<SourceSelect defaultValue="live" onChange={onChange} />);

      await user.tab();
      expect(getTrigger()).toHaveFocus();
      await user.keyboard("{Enter}");
      expect(screen.getByRole("listbox")).toBeInTheDocument();
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
      await user.keyboard("{ArrowDown}");
      expect(screen.getByRole("option", { name: t("form.scenario.live") })).toHaveFocus();
      await user.keyboard("{ArrowDown}{ArrowDown}{ArrowUp}{Enter}");

      expect(onChange).toHaveBeenCalledWith("storm");
      expect(within(getTrigger()).getByText("Winter storm")).toBeInTheDocument();
    });
  });

  describe("status", () => {
    it("shows one non-selectable option with the loading message while loading", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(
        <SourceSelect
          items={[live]}
          status="loading"
          loadingMessage={t("form.scenario.loading")}
          onChange={onChange}
        />,
      );

      await user.click(getTrigger());
      const loading = screen.getByRole("option", { name: t("form.scenario.loading") });
      await user.click(loading);

      expect(screen.getAllByRole("option")).toHaveLength(2);
      expect(loading).toHaveAttribute("aria-disabled", "true");
      expect(onChange).not.toHaveBeenCalled();
    });

    it("shows one disabled option with the unavailable message on error", async () => {
      const user = userEvent.setup();
      render(
        <SourceSelect
          items={[live]}
          status="error"
          unavailableMessage={t("form.scenario.unavailable")}
        />,
      );

      await user.click(getTrigger());

      expect(screen.getAllByRole("option")).toHaveLength(2);
      expect(screen.getByRole("option", { name: t("form.scenario.unavailable") })).toHaveAttribute(
        "aria-disabled",
        "true",
      );
    });

    it("shows only the items when a status has no message", async () => {
      const user = userEvent.setup();
      const { rerender } = render(<SourceSelect items={[live]} status="loading" />);

      await user.click(getTrigger());
      expect(screen.getAllByRole("option")).toHaveLength(1);
      await user.keyboard("{Escape}");
      rerender(<SourceSelect items={[live]} status="error" />);
      await user.click(getTrigger());

      expect(screen.getAllByRole("option")).toHaveLength(1);
    });
  });

  describe("accessibility (axe)", () => {
    it("has no violations closed, invalid and disabled", async () => {
      const { container } = render(
        <>
          <SourceSelect label="One" defaultValue="live" />
          <SourceSelect label="Two" description="Hint" />
          <SourceSelect label="Three" isInvalid errorMessage="Bad" />
          <SourceSelect label="Four" isDisabled />
        </>,
      );

      await expectNoAxeViolations(container);
    });

    it.each([
      ["items", {}],
      ["loading", { items: [live], status: "loading" as const, loadingMessage: "Loading" }],
      ["error", { items: [live], status: "error" as const, unavailableMessage: "Unavailable" }],
    ])("has no violations with the list open: %s", async (_name, props) => {
      const user = userEvent.setup();
      render(<SourceSelect {...props} />);

      await user.click(getTrigger());

      await expectNoAxeViolations(document.body);
    });

    it("has no violations in the kitchen-sink demo", async () => {
      const { container } = render(<>{demo.states[0]?.node}</>);

      await expectNoAxeViolations(container);
    });
  });
});
