import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState, type ReactElement } from "react";
import type { Key } from "react-aria-components";
import { afterEach, describe, expect, it, vi } from "vitest";

import { expectNoAxeViolations } from "../../../../test/axe";
import { t } from "../../foundation/strings";
import { ComboBox, ComboBoxItem, type ComboBoxProps, type ComboBoxStatus } from "./ComboBox";
import { demo } from "./ComboBox.demo";

interface Place {
  readonly id: string;
  readonly name: string;
  readonly region: string;
  readonly kind: string;
}

const denver: Place = {
  id: "den",
  name: "Denver",
  region: "Colorado, United States",
  kind: "City",
};
const dallas: Place = { id: "dal", name: "Dallas", region: "Texas, United States", kind: "City" };
const places: readonly Place[] = [denver, dallas];

function renderPlace(place: Place): ReactElement {
  return (
    <ComboBoxItem
      id={place.id}
      textValue={place.name}
      title={place.name}
      subtitle={place.region}
      meta={place.kind}
    />
  );
}

type BoxProps = Partial<Omit<ComboBoxProps<Place>, "children">>;

const focusProps: BoxProps = { autoFocus: true };

function PlaceBox(props: BoxProps): ReactElement {
  return (
    <ComboBox<Place> label="Origin" items={places} {...props}>
      {renderPlace}
    </ComboBox>
  );
}

function getInput(): HTMLElement {
  return screen.getByRole("combobox", { name: "Origin" });
}

// React Aria hides everything outside the input and the popover from assistive technology while
// the popover is open, so the clear button is looked up with `hidden` to work in every state.
const clearButton = { name: t("search.clear"), hidden: true };

// Testing Library only advances its own timers when it sees a `jest` global, and without that
// `user.type` waits forever on Vitest's fake timers.
function useVitestFakeTimers(): void {
  vi.useFakeTimers();
  vi.stubGlobal("jest", { advanceTimersByTime: vi.advanceTimersByTime.bind(vi) });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ComboBox", () => {
  describe("field", () => {
    it("names the input by its label and starts closed", () => {
      render(<PlaceBox />);

      expect(getInput()).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });

    it("shows a placeholder without letting it name the field", () => {
      render(<PlaceBox placeholder="City or address" />);

      expect(getInput()).toHaveAttribute("placeholder", "City or address");
    });

    it("describes the input with its hint", () => {
      render(<PlaceBox description="Where the trip starts." />);

      expect(getInput()).toHaveAccessibleDescription("Where the trip starts.");
    });

    it("shows no error while the field is valid", () => {
      render(<PlaceBox errorMessage="Choose a place from the list." />);

      expect(getInput()).not.toHaveAttribute("aria-invalid");
      expect(screen.queryByText("Choose a place from the list.")).not.toBeInTheDocument();
    });

    it("shows the error and reads it out with the field when invalid", () => {
      render(
        <PlaceBox
          description="Where the trip starts."
          isInvalid
          errorMessage="Choose a place from the list."
        />,
      );

      expect(getInput()).toHaveAttribute("aria-invalid", "true");
      expect(getInput()).toHaveAttribute("data-invalid", "true");
      expect(getInput()).toHaveAccessibleDescription(
        "Where the trip starts. Choose a place from the list.",
      );
    });

    it("passes required, name and autofocus through", async () => {
      const user = userEvent.setup();
      render(
        <form aria-label="Trip">
          <PlaceBox isRequired name="origin" {...focusProps} />
        </form>,
      );

      expect(getInput()).toBeRequired();
      expect(getInput()).toHaveFocus();
      await user.type(getInput(), "de");
      await user.click(screen.getByRole("option", { name: "Denver" }));
      const form = screen.getByRole<HTMLFormElement>("form", { name: "Trip" });
      expect(new FormData(form).get("origin")).toBe("den");
    });

    it("cannot be edited while disabled and offers no clear button", async () => {
      const user = userEvent.setup();
      render(<PlaceBox isDisabled defaultInputValue="Denver" />);

      await user.type(getInput(), "more");

      expect(getInput()).toBeDisabled();
      expect(getInput()).toHaveValue("Denver");
      expect(screen.queryByRole("button", clearButton)).not.toBeInTheDocument();
    });

    it("cannot be edited while read only and offers no clear button", async () => {
      const user = userEvent.setup();
      render(<PlaceBox isReadOnly defaultInputValue="Denver" />);

      await user.type(getInput(), "more");

      expect(getInput()).toHaveAttribute("readonly");
      expect(getInput()).toHaveValue("Denver");
      expect(screen.queryByRole("button", clearButton)).not.toBeInTheDocument();
    });
  });

  describe("popover states", () => {
    it("stays closed while idle and empty", async () => {
      const user = userEvent.setup();
      render(<PlaceBox />);

      await user.click(getInput());

      expect(getInput()).toHaveAttribute("aria-expanded", "false");
    });

    it("asks for more letters, with no options, while the query is under the minimum", async () => {
      const user = userEvent.setup();
      render(<PlaceBox />);

      await user.type(getInput(), "d");

      expect(getInput()).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByText(t("search.tooShort"))).toBeInTheDocument();
      expect(screen.queryAllByRole("option")).toHaveLength(0);
    });

    it("honours a custom minimum query length", async () => {
      const user = userEvent.setup();
      render(<PlaceBox minQueryLength={3} />);

      await user.type(getInput(), "de");
      expect(screen.getByText(t("search.tooShort"))).toBeInTheDocument();
      await user.type(getInput(), "n");

      expect(screen.queryByText(t("search.tooShort"))).not.toBeInTheDocument();
      expect(screen.getAllByRole("option")).toHaveLength(2);
    });

    it("shows the items it is given without filtering them on the client", async () => {
      const user = userEvent.setup();
      render(<PlaceBox />);

      await user.type(getInput(), "zz");

      const list = screen.getByRole("listbox", { name: /Origin/ });
      expect(within(list).getAllByRole("option")).toHaveLength(2);
      expect(within(list).getByRole("group", { name: t("search.results") })).toBeInTheDocument();
    });

    it("renders title, subtitle and meta of each item", async () => {
      const user = userEvent.setup();
      render(<PlaceBox />);

      await user.type(getInput(), "de");

      const option = screen.getByRole("option", { name: "Denver" });
      expect(option).toHaveAccessibleDescription("Colorado, United States City");
    });

    it("renders an item with a subtitle only, and one with a meta only", async () => {
      const user = userEvent.setup();
      render(
        <ComboBox<Place> label="Origin" items={places}>
          {(place) =>
            place.id === "den" ? (
              <ComboBoxItem
                id={place.id}
                textValue={place.name}
                title={place.name}
                subtitle={place.region}
              />
            ) : (
              <ComboBoxItem
                id={place.id}
                textValue={place.name}
                title={place.name}
                meta={place.kind}
              />
            )
          }
        </ComboBox>,
      );

      await user.type(getInput(), "de");

      expect(screen.getByRole("option", { name: "Denver" })).toHaveAccessibleDescription(
        "Colorado, United States",
      );
      expect(screen.getByRole("option", { name: "Dallas" })).toHaveAccessibleDescription("City");
    });

    it("renders an item with only a title", async () => {
      const user = userEvent.setup();
      render(
        <ComboBox<Place> label="Origin" items={[denver]}>
          {(place) => <ComboBoxItem id={place.id} textValue={place.name} title={place.name} />}
        </ComboBox>,
      );

      await user.type(getInput(), "de");

      expect(screen.getByRole("option", { name: "Denver" })).not.toHaveAccessibleDescription();
    });

    it("keeps the previous results visible and shows a spinner row while loading", async () => {
      const user = userEvent.setup();
      render(<PlaceBox status="loading" />);

      await user.type(getInput(), "de");

      expect(screen.getByText(t("search.loading"))).toBeInTheDocument();
      expect(screen.getAllByRole("option")).toHaveLength(2);
    });

    it("shows only the spinner row while loading with nothing to keep", async () => {
      const user = userEvent.setup();
      render(<PlaceBox status="loading" items={[]} />);

      await user.type(getInput(), "de");

      expect(screen.getByText(t("search.loading"))).toBeInTheDocument();
      expect(screen.queryAllByRole("option")).toHaveLength(0);
      expect(screen.queryByText(t("search.empty", { query: "de" }))).not.toBeInTheDocument();
    });

    it("says that nothing matches, with the query, when there are no results", async () => {
      const user = userEvent.setup();
      render(<PlaceBox items={[]} />);

      await user.type(getInput(), "zz");

      expect(screen.getByText(t("search.empty", { query: "zz" }))).toBeInTheDocument();
      expect(screen.queryAllByRole("option")).toHaveLength(0);
    });

    it("shows the error and a Retry button that reports the press and refocuses the input", async () => {
      const user = userEvent.setup();
      const onRetry = vi.fn();
      render(<PlaceBox status="error" onRetry={onRetry} />);

      await user.type(getInput(), "de");
      expect(screen.getByText(t("search.error"))).toBeInTheDocument();
      expect(screen.queryAllByRole("option")).toHaveLength(0);
      await user.click(screen.getByRole("button", { name: t("search.retry") }));

      expect(onRetry).toHaveBeenCalledTimes(1);
      expect(getInput()).toHaveFocus();
    });

    it("draws Retry as the design-system ghost Button in its small size", async () => {
      const user = userEvent.setup();
      render(<PlaceBox status="error" />);

      await user.type(getInput(), "de");

      const retry = screen.getByRole("button", { name: t("search.retry") });
      expect(retry).toHaveAttribute("data-variant", "ghost");
      expect(retry).toHaveAttribute("data-size", "sm");
    });

    it("lets Retry be pressed when no handler is given", async () => {
      const user = userEvent.setup();
      render(<PlaceBox status="error" />);

      await user.type(getInput(), "de");
      await user.click(screen.getByRole("button", { name: t("search.retry") }));

      expect(getInput()).toHaveFocus();
    });

    it("shows recent places when the empty input is focused, then swaps them for results", async () => {
      const user = userEvent.setup();
      render(<PlaceBox items={[dallas]} recentItems={[denver]} />);

      await user.click(getInput());

      const recent = screen.getByRole("group", { name: t("search.recent") });
      expect(within(recent).getByRole("option", { name: "Denver" })).toBeInTheDocument();
      await user.type(getInput(), "da");

      expect(screen.queryByRole("group", { name: t("search.recent") })).not.toBeInTheDocument();
      const results = screen.getByRole("group", { name: t("search.results") });
      expect(within(results).getByRole("option", { name: "Dallas" })).toBeInTheDocument();
    });

    it("does not open on focus when there are no recent places", async () => {
      const user = userEvent.setup();
      render(<PlaceBox recentItems={[]} />);

      await user.click(getInput());

      expect(getInput()).toHaveAttribute("aria-expanded", "false");
    });
  });

  describe("selection", () => {
    it("shows the chosen item's text in the input and reports its key", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<PlaceBox onChange={onChange} />);

      await user.type(getInput(), "de");
      await user.click(screen.getByRole("option", { name: "Denver" }));

      expect(onChange).toHaveBeenCalledWith("den");
      expect(getInput()).toHaveValue("Denver");
      expect(getInput()).toHaveAttribute("aria-expanded", "false");
    });

    it("moves through the options with the arrow keys and chooses with Enter", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<PlaceBox onChange={onChange} />);

      await user.type(getInput(), "de");
      await user.keyboard("{ArrowDown}");
      expect(getInput()).toHaveAttribute(
        "aria-activedescendant",
        screen.getByRole("option", { name: "Denver" }).id,
      );
      await user.keyboard("{ArrowDown}");
      expect(getInput()).toHaveAttribute(
        "aria-activedescendant",
        screen.getByRole("option", { name: "Dallas" }).id,
      );
      await user.keyboard("{ArrowUp}{ArrowDown}{Enter}");

      expect(onChange).toHaveBeenCalledWith("dal");
      expect(getInput()).toHaveValue("Dallas");
    });

    it("closes the popover with Escape", async () => {
      const user = userEvent.setup();
      render(<PlaceBox />);

      await user.type(getInput(), "de");
      expect(screen.getByRole("listbox")).toBeInTheDocument();
      await user.keyboard("{Escape}");

      expect(getInput()).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });

    it("selects a default key and shows its text when given a default input value", () => {
      render(<PlaceBox defaultValue="den" defaultInputValue="Denver" />);

      expect(getInput()).toHaveValue("Denver");
    });
  });

  describe("clear button", () => {
    it("appears only while the input has text", async () => {
      const user = userEvent.setup();
      render(<PlaceBox />);
      expect(screen.queryByRole("button", clearButton)).not.toBeInTheDocument();

      await user.type(getInput(), "d");

      expect(screen.getByRole("button", clearButton)).toBeInTheDocument();
    });

    it("clears the text and the selection and returns focus to the input", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<PlaceBox onChange={onChange} />);
      await user.type(getInput(), "de");
      await user.click(screen.getByRole("option", { name: "Denver" }));

      await user.click(screen.getByRole("button", clearButton));

      expect(getInput()).toHaveValue("");
      expect(getInput()).toHaveFocus();
      expect(onChange).toHaveBeenLastCalledWith(null);
      expect(screen.queryByRole("button", clearButton)).not.toBeInTheDocument();
    });

    it("clears a controlled selection through onChange", async () => {
      const user = userEvent.setup();
      function Controlled(): ReactElement {
        const [key, setKey] = useState<Key | null>("den");
        return (
          <>
            <PlaceBox value={key} onChange={setKey} defaultInputValue="Denver" />
            <p>Selected: {String(key)}</p>
          </>
        );
      }
      render(<Controlled />);
      expect(screen.getByText("Selected: den")).toBeInTheDocument();

      await user.click(screen.getByRole("button", clearButton));

      expect(screen.getByText("Selected: null")).toBeInTheDocument();
      expect(getInput()).toHaveValue("");
    });
  });

  describe("input value", () => {
    it("works uncontrolled from a default value", async () => {
      const user = userEvent.setup();
      render(<PlaceBox defaultInputValue="Den" />);

      await user.type(getInput(), "v");

      expect(getInput()).toHaveValue("Denv");
    });

    it("works controlled and reports every change", async () => {
      const user = userEvent.setup();
      const onInputChange = vi.fn();
      function Controlled(): ReactElement {
        const [value, setValue] = useState("");
        return (
          <PlaceBox
            inputValue={value}
            onInputChange={(next) => {
              onInputChange(next);
              setValue(next.toUpperCase());
            }}
          />
        );
      }
      render(<Controlled />);

      await user.type(getInput(), "ab");

      expect(onInputChange).toHaveBeenNthCalledWith(1, "a");
      expect(onInputChange).toHaveBeenNthCalledWith(2, "Ab");
      expect(getInput()).toHaveValue("AB");
    });
  });

  describe("async search (fake fetch)", () => {
    function SearchHarness(): ReactElement {
      const [query, setQuery] = useState("");
      const [status, setStatus] = useState<ComboBoxStatus>("idle");
      const [items, setItems] = useState<readonly Place[]>([]);
      const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
      const failuresLeft = useRef(1);

      function search(next: string): void {
        clearTimeout(timer.current);
        setStatus("loading");
        timer.current = setTimeout(() => {
          if (next === "boom" && failuresLeft.current > 0) {
            failuresLeft.current -= 1;
            setStatus("error");
            return;
          }
          setItems(
            places.filter((place) => place.name.toLowerCase().startsWith(next.toLowerCase())),
          );
          setStatus("idle");
        }, 300);
      }

      return (
        <PlaceBox
          items={items}
          status={status}
          inputValue={query}
          onInputChange={(next) => {
            setQuery(next);
            search(next);
          }}
          onRetry={() => {
            search(query);
          }}
        />
      );
    }

    async function settle(): Promise<void> {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
    }

    it("goes from loading to results and keeps the old results while the next search runs", async () => {
      useVitestFakeTimers();
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(<SearchHarness />);

      await user.type(getInput(), "de");
      expect(screen.getByText(t("search.loading"))).toBeInTheDocument();
      expect(screen.queryAllByRole("option")).toHaveLength(0);
      await settle();
      expect(screen.queryByText(t("search.loading"))).not.toBeInTheDocument();
      expect(screen.getAllByRole("option")).toHaveLength(1);
      expect(screen.getByRole("option", { name: "Denver" })).toBeInTheDocument();

      await user.type(getInput(), "x");
      expect(screen.getByText(t("search.loading"))).toBeInTheDocument();
      expect(screen.getByRole("option", { name: "Denver" })).toBeInTheDocument();
      await settle();
      expect(screen.getByText(t("search.empty", { query: "dex" }))).toBeInTheDocument();
    });

    it("shows the error, then recovers when Retry is pressed", async () => {
      useVitestFakeTimers();
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(<SearchHarness />);

      await user.type(getInput(), "boom");
      await settle();
      expect(screen.getByText(t("search.error"))).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: t("search.retry") }));
      expect(screen.getByText(t("search.loading"))).toBeInTheDocument();
      await settle();

      expect(screen.queryByText(t("search.error"))).not.toBeInTheDocument();
      expect(screen.getByText(t("search.empty", { query: "boom" }))).toBeInTheDocument();
    });
  });

  describe("accessibility (axe)", () => {
    it("has no violations closed, invalid, disabled and read only", async () => {
      const { container } = render(
        <>
          <PlaceBox label="One" />
          <PlaceBox label="Two" description="Hint" defaultInputValue="Denver" />
          <PlaceBox label="Three" isInvalid errorMessage="Bad" />
          <PlaceBox label="Four" isDisabled />
          <PlaceBox label="Five" isReadOnly />
        </>,
      );

      await expectNoAxeViolations(container);
    });

    it.each([
      ["results", { items: places }, "de"],
      ["too short", {}, "d"],
      ["loading", { status: "loading" as const }, "de"],
      ["empty", { items: [] }, "zz"],
      ["error", { status: "error" as const }, "de"],
    ])("has no violations with the popover open: %s", async (_name, props, typed) => {
      const user = userEvent.setup();
      render(<PlaceBox {...props} />);

      await user.type(getInput(), typed);

      await expectNoAxeViolations(document.body);
    });

    it("has no violations with recent places open", async () => {
      const user = userEvent.setup();
      render(<PlaceBox recentItems={[denver]} />);

      await user.click(getInput());

      await expectNoAxeViolations(document.body);
    });

    it("has no violations in the kitchen-sink demo", async () => {
      const { container } = render(<>{demo.states[0]?.node}</>);

      await expectNoAxeViolations(container);
    });
  });
});
