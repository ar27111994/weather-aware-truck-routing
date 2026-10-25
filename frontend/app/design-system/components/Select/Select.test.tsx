import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import type { Key } from "react-aria-components";
import { describe, expect, it, vi } from "vitest";

import { expectNoAxeViolations } from "../../../../test/axe";
import { Controlled } from "../../../../test/controlled";
import {
  expectHoverState,
  expectKeyboardFocusState,
  expectNoPointerStates,
  expectPressedState,
} from "../../../../test/states";
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

/**
 * The name of the storm's option (D-58, WCAG 2.5.3 Label in Name): all the text that the option
 * shows, the title first, and a space between the two lines.
 */
const STORM_OPTION = "Winter storm Heavy snow on I-80.";

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

/**
 * The option at `index` of the open list, in the order of `sources` (live, storm, fog). The
 * type-ahead and the chosen-text tests find an option by its place and not by its name, so that
 * what they check does not depend on how an option is named.
 */
function listedOption(index: number): HTMLElement {
  const option = within(screen.getByRole("listbox")).getAllByRole("option")[index];
  if (option === undefined) {
    throw new Error(`The open list has no option at index ${String(index)}.`);
  }
  return option;
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

    // The 2 px border follows the validation state of the field, not only the `isInvalid` prop: a
    // failing `validate` marks the trigger the same way (R3-10).
    it("marks the trigger invalid while a validate function reports an error", async () => {
      const user = userEvent.setup();
      render(
        <SourceSelect
          defaultValue="storm"
          validate={(key) => (key === "storm" ? "Storm data is not on offer." : null)}
        />,
      );

      expect(getTrigger()).toHaveAttribute("data-invalid", "true");
      expect(getTrigger()).toHaveAccessibleDescription("Storm data is not on offer.");
      await user.click(getTrigger());
      await user.click(screen.getByRole("option", { name: /Dense fog/ }));

      expect(getTrigger()).not.toHaveAttribute("data-invalid");
    });

    // The Select uses React Aria's `aria` validation mode, in which only `isInvalid` and `validate`
    // can invalidate a field: React Aria gets no built-in result for `isRequired` there, so a
    // required field that is left empty has no invalid state for the border to follow (R3-10).
    it("does not take a required field for invalid when it is left empty", async () => {
      const user = userEvent.setup();
      render(<SourceSelect isRequired />);

      await user.tab();
      await user.tab();

      expect(getTrigger()).not.toHaveAttribute("data-invalid");
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
      await user.click(screen.getByRole("option", { name: STORM_OPTION }));

      const form = screen.getByRole<HTMLFormElement>("form", { name: "Trip" });
      expect(new FormData(form).get("weather")).toBe("storm");
    });
  });

  describe("options", () => {
    // D-58, WCAG 2.5.3 Label in Name (OV-1): an option is named by all its visible text, the title
    // first, and its second line is not also its description, which would say it twice. jsdom draws
    // nothing, so this checks the name that a browser computes from the option's content; the axe
    // rule that compares the name with the text on screen runs in `e2e/accessibility.spec.ts`.
    it("opens a list of the items, each named by all its visible text and described by none", async () => {
      const user = userEvent.setup();
      render(<SourceSelect />);

      await user.click(getTrigger());

      expect(getTrigger()).toHaveAttribute("aria-expanded", "true");
      const list = screen.getByRole("listbox");
      expect(within(list).getAllByRole("option")).toHaveLength(3);
      const described = within(list).getByRole("option", { name: STORM_OPTION });
      expect(described).toHaveAccessibleName(STORM_OPTION);
      expect(described).not.toHaveAccessibleDescription();
      const plain = within(list).getByRole("option", { name: "Dense fog" });
      expect(plain).toHaveAccessibleName("Dense fog");
      expect(plain).not.toHaveAccessibleDescription();
    });

    it("shows the chosen item's name in the trigger and reports its key", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<SourceSelect onChange={onChange} />);

      await user.click(getTrigger());
      await user.click(screen.getByRole("option", { name: STORM_OPTION }));

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
      render(
        <Controlled<Key | null> initial="live">
          {({ value, onChange }) => (
            <>
              <SourceSelect value={value} onChange={onChange} />
              <p>Chosen: {String(value)}</p>
            </>
          )}
        </Controlled>,
      );
      expect(screen.getByText("Chosen: live")).toBeInTheDocument();

      await user.click(getTrigger());
      await user.click(screen.getByRole("option", { name: "Dense fog" }));

      expect(screen.getByText("Chosen: fog")).toBeInTheDocument();
    });

    it("opens with Enter and closes with Escape", async () => {
      const user = userEvent.setup();
      render(<SourceSelect defaultValue="live" />);

      await user.tab();
      expect(getTrigger()).toHaveFocus();
      await user.keyboard("{Enter}");
      expect(screen.getByRole("listbox")).toBeInTheDocument();
      await user.keyboard("{Escape}");

      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });

    // One popover per test: opening the list is the costly step of a Select under jsdom, and a
    // test that opened it twice took more than the 5 s limit on a loaded runner.
    it("opens with ArrowDown and puts focus on the chosen option", async () => {
      const user = userEvent.setup();
      render(<SourceSelect defaultValue="live" />);

      await user.tab();
      await user.keyboard("{ArrowDown}");

      const chosen = await screen.findByRole("option", { name: t("form.scenario.live") });
      await waitFor(() => {
        expect(chosen).toHaveFocus();
      });
    });

    it("moves with the arrows and chooses with Enter", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<SourceSelect defaultValue="live" onChange={onChange} />);

      await user.tab();
      await user.keyboard("{ArrowDown}");
      await waitFor(() => {
        expect(screen.getByRole("option", { name: t("form.scenario.live") })).toHaveFocus();
      });
      await user.keyboard("{ArrowDown}{ArrowDown}{ArrowUp}{Enter}");

      expect(onChange).toHaveBeenCalledWith("storm");
      expect(within(getTrigger()).getByText("Winter storm")).toBeInTheDocument();
    });

    // D-58: the name of an option holds its second line, and what the trigger shows, what type-ahead
    // matches and what the hidden form field carries is still its `textValue`, the title.
    it("shows only the title of a chosen option in the trigger, not its second line", async () => {
      const user = userEvent.setup();
      render(<SourceSelect />);

      await user.click(getTrigger());
      await user.click(listedOption(1));

      expect(within(getTrigger()).getByText("Winter storm")).toBeInTheDocument();
      expect(getTrigger()).not.toHaveTextContent("Heavy snow");
    });

    it("moves focus to the option whose title starts with the letters typed", async () => {
      const user = userEvent.setup();
      render(<SourceSelect defaultValue="live" />);

      await user.tab();
      await user.keyboard("{ArrowDown}");
      await waitFor(() => {
        expect(listedOption(0)).toHaveFocus();
      });
      await user.keyboard("wi");

      await waitFor(() => {
        expect(listedOption(1)).toHaveFocus();
      });
    });

    it("does not match the letters of the second line, only those of the title", async () => {
      const user = userEvent.setup();
      render(<SourceSelect defaultValue="live" />);

      await user.tab();
      await user.keyboard("{ArrowDown}");
      await waitFor(() => {
        expect(listedOption(0)).toHaveFocus();
      });
      await user.keyboard("he");

      expect(listedOption(0)).toHaveFocus();
      expect(listedOption(1)).not.toHaveFocus();
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

  describe("interaction states", () => {
    const option = (name: string): HTMLElement => screen.getByRole("option", { name });

    describe("trigger", () => {
      it("is hovered while the pointer rests on it", async () => {
        const user = userEvent.setup();
        render(<SourceSelect />);

        await expectHoverState(user, getTrigger());
      });

      it("is pressed as soon as a pointer button goes down on it", async () => {
        // Not expectPressedState: the list opens on pointer down and keeps the trigger pressed.
        const user = userEvent.setup();
        render(<SourceSelect />);

        await user.pointer({ keys: "[MouseLeft>]", target: getTrigger() });
        expect(getTrigger()).toHaveAttribute("data-pressed", "true");
        await user.pointer({ keys: "[/MouseLeft]" });
      });

      it("stays pressed while its list is open and lets go when the list closes", async () => {
        const user = userEvent.setup();
        render(<SourceSelect />);

        await user.click(getTrigger());
        expect(screen.getByRole("listbox")).toBeInTheDocument();
        expect(getTrigger()).toHaveAttribute("data-pressed", "true");
        await user.keyboard("{Escape}");

        expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
        expect(getTrigger()).not.toHaveAttribute("data-pressed");
      });

      it("shows the focus ring when the keyboard puts focus on it", async () => {
        const user = userEvent.setup();
        render(<SourceSelect />);

        await expectKeyboardFocusState(user, getTrigger());
      });

      it("shows the focus ring again when Escape closes the list and gives focus back", async () => {
        const user = userEvent.setup();
        render(<SourceSelect />);
        await user.tab();
        await user.keyboard("{Enter}");

        await user.keyboard("{Escape}");

        await waitFor(() => {
          expect(getTrigger()).toHaveFocus();
        });
        expect(getTrigger()).toHaveAttribute("data-focus-visible", "true");
      });

      it("shows no focus ring when a click chooses an option and gives focus back", async () => {
        const user = userEvent.setup();
        render(<SourceSelect />);
        await user.click(getTrigger());

        await user.click(option(STORM_OPTION));

        await waitFor(() => {
          expect(getTrigger()).toHaveFocus();
        });
        expect(getTrigger()).not.toHaveAttribute("data-focus-visible");
      });

      it("is neither hovered nor pressed while disabled", async () => {
        const user = userEvent.setup();
        render(<SourceSelect isDisabled />);

        await expectNoPointerStates(user, getTrigger());
      });
    });

    describe("options", () => {
      it("hovers an option while the pointer rests on it", async () => {
        const user = userEvent.setup();
        render(<SourceSelect />);
        await user.click(getTrigger());

        await expectHoverState(user, option(STORM_OPTION));
      });

      it("presses an option while a pointer button is held down on it", async () => {
        // Letting go on an option chooses it and closes the list.
        const user = userEvent.setup();
        render(<SourceSelect />);
        await user.click(getTrigger());

        await expectPressedState(user, option(STORM_OPTION));
      });

      it("highlights a hovered option without drawing the keyboard ring on it", async () => {
        const user = userEvent.setup();
        render(<SourceSelect />);
        await user.click(getTrigger());

        await user.hover(option(STORM_OPTION));

        expect(option(STORM_OPTION)).toHaveAttribute("data-focused", "true");
        expect(option(STORM_OPTION)).not.toHaveAttribute("data-focus-visible");
      });

      it("shows the focus ring on the option the keyboard opens the list on", async () => {
        const user = userEvent.setup();
        render(<SourceSelect />);
        await user.tab();

        await user.keyboard("{Enter}");

        expect(option(t("form.scenario.live"))).toHaveFocus();
        expect(option(t("form.scenario.live"))).toHaveAttribute("data-focus-visible", "true");
      });

      it("moves the focus ring to the option the arrow keys reach", async () => {
        const user = userEvent.setup();
        render(<SourceSelect />);
        await user.tab();
        await user.keyboard("{Enter}");

        await user.keyboard("{ArrowDown}");

        expect(option(STORM_OPTION)).toHaveAttribute("data-focus-visible", "true");
        expect(option(t("form.scenario.live"))).not.toHaveAttribute("data-focus-visible");
      });

      it.each([
        [
          "loading",
          { status: "loading" as const, loadingMessage: "Loading scenarios" },
          "Loading scenarios",
        ],
        [
          "unavailable",
          { status: "error" as const, unavailableMessage: "Scenarios unavailable" },
          "Scenarios unavailable",
        ],
      ])("is neither hovered nor pressed on the %s message", async (_status, props, message) => {
        const user = userEvent.setup();
        render(<SourceSelect items={[live]} {...props} />);
        await user.click(getTrigger());

        await expectNoPointerStates(user, option(message));
      });
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
