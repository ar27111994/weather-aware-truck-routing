import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState, type ReactElement } from "react";
import type { Key } from "react-aria-components";
import { afterEach, describe, expect, it, vi } from "vitest";

import { expectNoAxeViolations } from "../../../../test/axe";
import { Controlled } from "../../../../test/controlled";
import { elapse, fakeTimerUser, installFakeTimers } from "../../../../test/fake-timers";
import {
  expectHoverState,
  expectKeyboardFocusState,
  expectNoPointerStates,
  expectPressedState,
} from "../../../../test/states";
import { t } from "../../foundation/strings";
import {
  ComboBox,
  ComboBoxItem,
  type ComboBoxItemProps,
  type ComboBoxProps,
  type ComboBoxStatus,
} from "./ComboBox";
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

/**
 * The names of the two places' options (D-58, WCAG 2.5.3 Label in Name): all the text that an
 * option shows, the title first, then its region and its kind, with a space between the lines.
 */
const DENVER_OPTION = "Denver Colorado, United States City";
const DALLAS_OPTION = "Dallas Texas, United States City";

function renderPlace(place: Place): ReactElement<ComboBoxItemProps> {
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

/**
 * The option at `index` of the open list, in the order of `places` (Denver, Dallas). The test of
 * what a pick writes into the input finds an option by its place and not by its name, so that it
 * does not depend on how an option is named.
 */
function listedOption(index: number): HTMLElement {
  const option = within(screen.getByRole("listbox")).getAllByRole("option")[index];
  if (option === undefined) {
    throw new Error(`The open list has no option at index ${String(index)}.`);
  }
  return option;
}

// React Aria hides everything outside the input and the popover from assistive technology while
// the popover is open, so the clear button is looked up with `hidden` to work in every state. It
// is named "Clear" and then the label of its field, so its name is matched by its start.
const clearButton = { name: new RegExp(`^${t("search.clear")}`, "u"), hidden: true };

// The popover shows each message of the search in a row, and the live region says it again for
// screen readers (R3-25), so the row is looked up inside the popover.
function shownMessage(message: string): HTMLElement {
  const popover = document.querySelector<HTMLElement>("[data-trigger]");
  if (popover === null) throw new Error("The popover is not open.");
  return within(popover).getByText(message);
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

    // WebKit does not scroll a field that a script focuses into view when the field is scrolled out
    // of the sheet's content, and the list then opened above the screen (R4-01, the iPhone 14 in
    // `e2e/early-input.spec.ts`). The other engines scroll, and `nearest` moves nothing for a field
    // that is in view.
    it("scrolls the input into view when it takes focus (R4-01)", async () => {
      const user = userEvent.setup();
      const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView");
      render(<PlaceBox />);

      await user.click(getInput());

      expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
      expect(scrollIntoView.mock.contexts).toContain(getInput());
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
      await user.click(screen.getByRole("option", { name: DENVER_OPTION }));
      const form = screen.getByRole<HTMLFormElement>("form", { name: "Trip" });
      expect(new FormData(form).get("origin")).toBe("den");
    });

    // A form gets what a `select` gets: the key of the chosen item, and nothing for text that names
    // no item. With custom text allowed React Aria would post the text of the input instead.
    it("posts nothing under its name for text that names no item", async () => {
      const user = userEvent.setup();
      render(
        <form aria-label="Trip">
          <PlaceBox name="origin" {...focusProps} />
        </form>,
      );

      await user.type(getInput(), "de");
      await user.tab();

      const form = screen.getByRole<HTMLFormElement>("form", { name: "Trip" });
      expect(getInput()).toHaveValue("de");
      expect(new FormData(form).get("origin")).toBe("");
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

    // A live region that appears together with its text is not reliably read out, and that is what
    // the rows of the popover were. The combo box keeps one in the page from the start, empty, and
    // writes the message into it (R3-25).
    it("keeps one live region, empty until the search has something to say", async () => {
      const user = userEvent.setup();
      render(<PlaceBox />);
      const region = screen.getByRole("status");
      expect(region.textContent).toBe("");

      await user.type(getInput(), "d");

      expect(screen.getAllByRole("status")).toEqual([region]);
      expect(region.textContent).toBe(t("search.tooShort"));
    });

    it("writes the message of each state into the live region, and empties it when the list closes", async () => {
      const user = userEvent.setup();
      const { rerender } = render(<PlaceBox items={[]} />);
      const region = screen.getByRole("status");

      await user.type(getInput(), "de");
      expect(region.textContent).toBe(t("search.empty", { query: "de" }));
      rerender(<PlaceBox items={[]} status="loading" />);
      expect(region.textContent).toBe(t("search.loading"));
      rerender(<PlaceBox items={[]} status="error" />);
      expect(region.textContent).toBe(t("search.error"));
      await user.keyboard("{Escape}");

      expect(region.textContent).toBe("");
    });

    it("leaves the live region empty while the list shows places", async () => {
      const user = userEvent.setup();
      render(<PlaceBox items={[dallas]} recentItems={[denver]} />);
      const region = screen.getByRole("status");

      await user.click(getInput());
      expect(screen.getAllByRole("option")).toHaveLength(1);
      expect(region.textContent).toBe("");
      await user.type(getInput(), "da");

      expect(screen.getAllByRole("option")).toHaveLength(1);
      expect(region.textContent).toBe("");
    });

    // React Aria hides everything but the input and the list from assistive technology while the
    // list is open, and the list is open whenever there is a message. Its own announcer carries
    // `data-live-announcer` to be left alone, and so does this region; a region that was hidden
    // would be silent when it matters.
    it("keeps the live region exposed to assistive technology while the list is open", async () => {
      const user = userEvent.setup();
      render(<PlaceBox />);
      const region = screen.getByRole("status");

      await user.type(getInput(), "d");

      expect(getInput()).toHaveAttribute("aria-expanded", "true");
      expect(region.closest('[aria-hidden="true"]')).toBeNull();
    });

    it("asks for more letters, with no options, while the query is under the minimum", async () => {
      const user = userEvent.setup();
      render(<PlaceBox />);

      await user.type(getInput(), "d");

      expect(getInput()).toHaveAttribute("aria-expanded", "true");
      expect(shownMessage(t("search.tooShort"))).toBeInTheDocument();
      expect(screen.queryAllByRole("option")).toHaveLength(0);
    });

    it("shows the items it is given without filtering them on the client", async () => {
      const user = userEvent.setup();
      render(<PlaceBox />);

      await user.type(getInput(), "zz");

      const list = screen.getByRole("listbox", { name: /Origin/ });
      expect(within(list).getAllByRole("option")).toHaveLength(2);
      expect(within(list).getByRole("group", { name: t("search.results") })).toBeInTheDocument();
    });

    // D-58, WCAG 2.5.3 Label in Name (OV-1): an option is named by all the text it shows, the title
    // first, then its region and its kind, and none of that is also its description, which would
    // say it twice. jsdom draws nothing, so this checks the name that a browser computes from the
    // option's content; the axe rule that compares the name with the text on screen runs in
    // `e2e/accessibility.spec.ts`.
    it("names an option by its title, subtitle and meta, and describes it by none of them", async () => {
      const user = userEvent.setup();
      render(<PlaceBox />);

      await user.type(getInput(), "de");

      const option = screen.getByRole("option", { name: DENVER_OPTION });
      expect(option).toHaveAccessibleName(DENVER_OPTION);
      expect(option).not.toHaveAccessibleDescription();
      expect(screen.getByRole("option", { name: DALLAS_OPTION })).not.toHaveAccessibleDescription();
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

      const subtitleOnly = screen.getByRole("option", { name: "Denver Colorado, United States" });
      const metaOnly = screen.getByRole("option", { name: "Dallas City" });
      expect(subtitleOnly).not.toHaveAccessibleDescription();
      expect(metaOnly).not.toHaveAccessibleDescription();
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

      expect(shownMessage(t("search.loading"))).toBeInTheDocument();
      expect(screen.getAllByRole("option")).toHaveLength(2);
    });

    it("shows only the spinner row while loading with nothing to keep", async () => {
      const user = userEvent.setup();
      render(<PlaceBox status="loading" items={[]} />);

      await user.type(getInput(), "de");

      expect(shownMessage(t("search.loading"))).toBeInTheDocument();
      expect(screen.queryAllByRole("option")).toHaveLength(0);
      expect(screen.queryByText(t("search.empty", { query: "de" }))).not.toBeInTheDocument();
    });

    it("says that nothing matches, with the query, when there are no results", async () => {
      const user = userEvent.setup();
      render(<PlaceBox items={[]} />);

      await user.type(getInput(), "zz");

      expect(shownMessage(t("search.empty", { query: "zz" }))).toBeInTheDocument();
      expect(screen.queryAllByRole("option")).toHaveLength(0);
    });

    it("shows the error and a Retry button that reports the press and refocuses the input", async () => {
      const user = userEvent.setup();
      const onRetry = vi.fn();
      render(<PlaceBox status="error" onRetry={onRetry} />);

      await user.type(getInput(), "de");
      expect(shownMessage(t("search.error"))).toBeInTheDocument();
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
      expect(within(recent).getByRole("option", { name: DENVER_OPTION })).toBeInTheDocument();
      await user.type(getInput(), "da");

      expect(screen.queryByRole("group", { name: t("search.recent") })).not.toBeInTheDocument();
      const results = screen.getByRole("group", { name: t("search.results") });
      expect(within(results).getByRole("option", { name: DALLAS_OPTION })).toBeInTheDocument();
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
      await user.click(screen.getByRole("option", { name: DENVER_OPTION }));

      expect(onChange).toHaveBeenCalledWith("den");
      expect(getInput()).toHaveValue("Denver");
      expect(getInput()).toHaveAttribute("aria-expanded", "false");
    });

    // D-58: the name of an option holds its region and its kind, and what a pick writes into the
    // input is still its `textValue`, the place.
    it("writes only the place of a chosen option into the input, not its region and kind", async () => {
      const user = userEvent.setup();
      render(<PlaceBox />);

      await user.type(getInput(), "de");
      await user.click(listedOption(0));

      expect(getInput()).toHaveValue("Denver");
    });

    it("moves through the options with the arrow keys and chooses with Enter", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<PlaceBox onChange={onChange} />);

      await user.type(getInput(), "de");
      await user.keyboard("{ArrowDown}");
      expect(getInput()).toHaveAttribute(
        "aria-activedescendant",
        screen.getByRole("option", { name: DENVER_OPTION }).id,
      );
      await user.keyboard("{ArrowDown}");
      expect(getInput()).toHaveAttribute(
        "aria-activedescendant",
        screen.getByRole("option", { name: DALLAS_OPTION }).id,
      );
      await user.keyboard("{ArrowUp}{ArrowDown}{Enter}");

      expect(onChange).toHaveBeenCalledWith("dal");
      expect(getInput()).toHaveValue("Dallas");
    });

    // React Aria closes a list that is open when a region around the input scrolls, and a close
    // also takes back what was typed. The browser scrolls the region to show a field that took
    // focus, and that scroll event can come after the first letters have opened the list, so the
    // text was lost and the list with it (R4-01). The input has focus for as long as the list is
    // open, so a scroll must neither close the list nor touch the text. `e2e/early-input.spec.ts`
    // is the real-browser test.
    it("keeps what was typed, and the list, when a region around the input scrolls (R4-01)", async () => {
      const user = userEvent.setup();
      const onInputChange = vi.fn();
      render(
        <Controlled<string> initial="" onChange={onInputChange}>
          {({ value, onChange }) => (
            <div data-testid="scroller" style={{ overflowY: "auto" }}>
              <PlaceBox inputValue={value} onInputChange={onChange} />
            </div>
          )}
        </Controlled>,
      );

      await user.type(getInput(), "salt");
      expect(screen.getByRole("listbox")).toBeInTheDocument();
      fireEvent.scroll(screen.getByTestId("scroller"));

      expect(getInput()).toHaveValue("salt");
      expect(onInputChange).not.toHaveBeenCalledWith("");
      expect(getInput()).toHaveAttribute("aria-expanded", "true");
      await user.click(screen.getByRole("option", { name: DENVER_OPTION }));
      expect(getInput()).toHaveValue("Denver");
    });

    it("still closes the list when something other than a scroll closes the popover", async () => {
      const user = userEvent.setup();
      render(<PlaceBox />);

      await user.type(getInput(), "de");
      fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });

      expect(getInput()).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
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

    // React Aria finds the chosen item only among the items of the list that is showing. A place
    // picked from "Recent" is in none of the lists that follow, so it read as no selection and
    // leaving the field emptied it (R3-14). The combo box holds the chosen key itself.
    it("keeps a place picked from the recent ones when focus leaves", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<PlaceBox items={[dallas]} recentItems={[denver]} onChange={onChange} />);

      await user.click(getInput());
      await user.click(screen.getByRole("option", { name: DENVER_OPTION }));
      expect(getInput()).toHaveValue("Denver");
      await user.tab();

      expect(getInput()).toHaveValue("Denver");
      expect(onChange).toHaveBeenCalledExactlyOnceWith("den");
    });

    it("puts the chosen place back when the text was edited and the list does not hold it", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      const { rerender } = render(<PlaceBox onChange={onChange} />);
      await user.type(getInput(), "de");
      await user.click(screen.getByRole("option", { name: DENVER_OPTION }));
      rerender(<PlaceBox items={[dallas]} onChange={onChange} />);

      await user.type(getInput(), "x");
      expect(getInput()).toHaveValue("Denverx");
      await user.tab();

      expect(getInput()).toHaveValue("Denver");
      expect(onChange).toHaveBeenCalledExactlyOnceWith("den");
    });

    it("keeps the text of a default key that no item has when focus leaves", async () => {
      const user = userEvent.setup();
      render(<PlaceBox defaultValue="nowhere" defaultInputValue="xy" />);

      await user.click(getInput());
      await user.tab();

      expect(getInput()).toHaveValue("xy");
    });

    // Enter commits the field. React Aria finds the text of the chosen item in the list that is
    // showing: a place that the list does not hold has none there, and Enter closed the list and
    // opened it again (R3-14). What Enter does cannot depend on whether the list holds the place:
    // the list is closed, the text stays and nobody is told anything.
    it("does the same on Enter for a chosen place that the list holds and for one that it does not", async () => {
      interface Seen {
        readonly text: string;
        readonly expanded: string | null;
        readonly told: number;
      }
      const record =
        (told: unknown[]) =>
        (value: unknown): void => {
          told.push(value);
        };
      async function afterEnter(box: ReactElement, told: unknown[], pick: boolean): Promise<Seen> {
        const user = userEvent.setup();
        const { unmount } = render(box);
        if (pick) {
          await user.type(getInput(), "de");
          await user.click(screen.getByRole("option", { name: DENVER_OPTION }));
        } else {
          await user.click(getInput());
        }
        const before = told.length;
        await user.keyboard("{Enter}");
        const input = screen.getByRole<HTMLInputElement>("combobox", { name: "Origin" });
        const seen: Seen = {
          text: input.value,
          expanded: input.getAttribute("aria-expanded"),
          told: told.length - before,
        };
        unmount();
        return seen;
      }
      // Once a place is picked, the planner's search lists nothing: the text is the answer.
      function Picked({ told }: { readonly told: unknown[] }): ReactElement {
        const [key, setKey] = useState<Key | null>(null);
        const [text, setText] = useState("");
        return (
          <PlaceBox
            items={key === null ? places : [dallas]}
            value={key}
            onChange={(next) => {
              record(told)(next);
              setKey(next);
            }}
            inputValue={text}
            onInputChange={(next) => {
              record(told)(next);
              setText(next);
            }}
          />
        );
      }
      const toldListed: unknown[] = [];
      const toldRestored: unknown[] = [];
      const toldPicked: unknown[] = [];

      const listed = await afterEnter(
        <PlaceBox
          items={places}
          value="den"
          inputValue="Denver"
          onChange={record(toldListed)}
          onInputChange={record(toldListed)}
        />,
        toldListed,
        false,
      );
      const restored = await afterEnter(
        <PlaceBox
          items={[dallas]}
          value="den"
          inputValue="Denver"
          onChange={record(toldRestored)}
          onInputChange={record(toldRestored)}
        />,
        toldRestored,
        false,
      );
      const picked = await afterEnter(<Picked told={toldPicked} />, toldPicked, true);

      const expected: Seen = { text: "Denver", expanded: "false", told: 0 };
      expect(listed).toEqual(expected);
      expect(restored).toEqual(expected);
      expect(picked).toEqual(expected);
    });

    it("reports that nothing is chosen when the text is deleted", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<PlaceBox onChange={onChange} />);
      await user.type(getInput(), "de");
      await user.click(screen.getByRole("option", { name: DENVER_OPTION }));

      await user.clear(getInput());

      expect(onChange).toHaveBeenCalledTimes(2);
      expect(onChange).toHaveBeenLastCalledWith(null);
    });

    // D-56: a field never deletes text that was typed, or that its parent put there (a place that
    // a shared link restored). Leaving it closes the list and nothing more. Whether the text names
    // a place is for the parent to say: the planner's form says it when it is submitted.
    it("keeps what was typed when no place was chosen and focus leaves", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<PlaceBox onChange={onChange} />);

      await user.type(getInput(), "de");
      await user.tab();

      expect(getInput()).toHaveValue("de");
      expect(getInput()).toHaveAttribute("aria-expanded", "false");
      expect(onChange).not.toHaveBeenCalled();
    });

    it("keeps what was typed when Escape closes the list", async () => {
      const user = userEvent.setup();
      render(<PlaceBox />);

      await user.type(getInput(), "de");
      await user.keyboard("{Escape}");

      expect(getInput()).toHaveValue("de");
      expect(getInput()).toHaveAttribute("aria-expanded", "false");
    });

    it("keeps the text that its parent put in the field when focus leaves", async () => {
      const user = userEvent.setup();
      const onInputChange = vi.fn();
      const onChange = vi.fn();
      render(
        <PlaceBox inputValue="Salt Lake City" onInputChange={onInputChange} onChange={onChange} />,
      );

      await user.click(getInput());
      await user.tab();

      expect(getInput()).toHaveValue("Salt Lake City");
      expect(onInputChange).not.toHaveBeenCalled();
      expect(onChange).not.toHaveBeenCalled();
    });

    // The parent owns the text, and the planner's swap button moves it from one field to the
    // other. A place that this field chose describes text that is no longer in it, so leaving
    // the field must not write that old text back over the parent's.
    it("does not write a chosen place's text back over text that the parent has set since", async () => {
      const user = userEvent.setup();
      render(
        <Controlled<string> initial="">
          {({ value, onChange }) => (
            <>
              <PlaceBox inputValue={value} onInputChange={onChange} />
              <button
                type="button"
                onClick={() => {
                  onChange("Dallas");
                }}
              >
                Swap
              </button>
            </>
          )}
        </Controlled>,
      );
      await user.type(getInput(), "de");
      await user.click(screen.getByRole("option", { name: DENVER_OPTION }));
      await user.click(screen.getByRole("button", { name: "Swap" }));
      expect(getInput()).toHaveValue("Dallas");

      await user.click(getInput());
      await user.tab();

      expect(getInput()).toHaveValue("Dallas");
    });

    it("selects a default key and shows its text when given a default input value", () => {
      render(<PlaceBox defaultValue="den" defaultInputValue="Denver" />);

      expect(getInput()).toHaveValue("Denver");
    });
  });

  describe("side of the list", () => {
    // jsdom has no layout. The things that decide on which side of the input the list opens are
    // given here: the visual viewport (700 px tall; React Aria and the component both read it),
    // where the input is in it, and how tall the list is (React Aria reads the size of the list
    // from `offsetHeight`). The side is `data-placement` on the popover.
    const VIEWPORT = 700;

    function stubLayout(input: { readonly top: number }): {
      readonly viewport: EventTarget & { height: number };
      readonly setListHeight: (height: number) => void;
    } {
      let listHeight = 46;
      const viewport = Object.assign(new EventTarget(), {
        width: 390,
        height: VIEWPORT,
        offsetTop: 0,
        offsetLeft: 0,
        pageTop: 0,
        pageLeft: 0,
        scale: 1,
      });
      vi.stubGlobal("visualViewport", viewport);
      const isList = (element: Element): boolean => element.hasAttribute("data-trigger");
      vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
        this: Element,
      ) {
        if (this.matches("input")) return new DOMRect(0, input.top, 300, 44);
        if (isList(this)) return new DOMRect(0, 0, 300, listHeight);
        return new DOMRect(0, 0, 0, 0);
      });
      vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (
        this: HTMLElement,
      ) {
        return isList(this) ? listHeight : 0;
      });
      vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (
        this: HTMLElement,
      ) {
        return isList(this) ? 300 : 0;
      });
      return {
        viewport,
        setListHeight: (height) => {
          listHeight = height;
        },
      };
    }

    const popover = (): Element | null => document.querySelector("[data-trigger]");

    it("opens the list above the input when there is little room below it (R4-01)", async () => {
      const user = userEvent.setup();
      stubLayout({ top: 500 });
      render(<PlaceBox />);

      await user.type(getInput(), "de");

      expect(popover()).toHaveAttribute("data-placement", "top");
    });

    it("opens the list below the input when there is room for it (R4-01)", async () => {
      const user = userEvent.setup();
      stubLayout({ top: 100 });
      render(<PlaceBox />);

      await user.type(getInput(), "de");

      expect(popover()).toHaveAttribute("data-placement", "bottom");
    });

    // A list changes size while it is open: a search that is still running shows one row, and the
    // results are taller. React Aria moves a list that no longer fits to the other side of the
    // input, and it does so in the callback of the ResizeObserver that watches the list, so the
    // list grows within the frame that reported its size and WebKit reports a resize loop
    // (R4-01, the iPhone 14 in `e2e/early-input.spec.ts`). The side comes from the room that the
    // input has and never from the size of the list.
    it("keeps the side of the list when the results make it taller (R4-01)", async () => {
      const user = userEvent.setup();
      const layout = stubLayout({ top: 380 });
      render(<PlaceBox />);
      await user.type(getInput(), "de");
      expect(popover()).toHaveAttribute("data-placement", "bottom");

      layout.setListHeight(300);
      act(() => {
        window.dispatchEvent(new Event("resize"));
      });

      expect(popover()).toHaveAttribute("data-placement", "bottom");
    });

    it("chooses the side again when the window changes size while the list is open", async () => {
      const user = userEvent.setup();
      const layout = stubLayout({ top: 300 });
      render(<PlaceBox />);
      await user.type(getInput(), "de");
      expect(popover()).toHaveAttribute("data-placement", "bottom");

      layout.viewport.height = 500;
      act(() => {
        window.dispatchEvent(new Event("resize"));
      });

      expect(popover()).toHaveAttribute("data-placement", "top");
    });

    // An on-screen keyboard shrinks the visual viewport, not the layout viewport.
    it("chooses the side again when the visual viewport changes size", async () => {
      const user = userEvent.setup();
      const layout = stubLayout({ top: 250 });
      render(<PlaceBox />);
      await user.type(getInput(), "de");
      expect(popover()).toHaveAttribute("data-placement", "bottom");

      layout.viewport.height = 300;
      act(() => {
        layout.viewport.dispatchEvent(new Event("resize"));
      });

      expect(popover()).toHaveAttribute("data-placement", "top");
    });

    it("stops listening to the window and the visual viewport when the list closes", async () => {
      const user = userEvent.setup();
      const layout = stubLayout({ top: 100 });
      const removeFromWindow = vi.spyOn(window, "removeEventListener");
      const removeFromViewport = vi.spyOn(layout.viewport, "removeEventListener");
      render(<PlaceBox />);
      await user.type(getInput(), "de");

      await user.keyboard("{Escape}");

      expect(removeFromWindow).toHaveBeenCalledWith("resize", expect.any(Function));
      expect(removeFromViewport).toHaveBeenCalledWith("resize", expect.any(Function));
    });
  });

  describe("controlled selection", () => {
    // React Aria writes no text when the value and the input are both controlled, so the
    // component writes the chosen item's text itself and the parent only stores it.
    function BothControlled({
      onInputChange,
    }: {
      readonly onInputChange: (text: string) => void;
    }): ReactElement {
      const [key, setKey] = useState<Key | null>(null);
      const [text, setText] = useState("");
      return (
        <PlaceBox
          value={key}
          onChange={setKey}
          inputValue={text}
          onInputChange={(next) => {
            onInputChange(next);
            setText(next);
          }}
        />
      );
    }

    it("reports the text of an item picked with the pointer through onInputChange", async () => {
      const user = userEvent.setup();
      const onInputChange = vi.fn();
      render(<BothControlled onInputChange={onInputChange} />);

      await user.type(getInput(), "de");
      await user.click(screen.getByRole("option", { name: DENVER_OPTION }));

      expect(onInputChange).toHaveBeenLastCalledWith("Denver");
      expect(getInput()).toHaveValue("Denver");
    });

    it("reports the text of an item picked with the keyboard through onInputChange", async () => {
      const user = userEvent.setup();
      const onInputChange = vi.fn();
      render(<BothControlled onInputChange={onInputChange} />);

      await user.type(getInput(), "da");
      await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");

      expect(onInputChange).toHaveBeenLastCalledWith("Dallas");
      expect(getInput()).toHaveValue("Dallas");
    });

    function ValueOnly({
      outside,
      typed = "",
    }: {
      readonly outside: Key | null;
      readonly typed?: string;
    }): ReactElement {
      const [key, setKey] = useState<Key | null>(null);
      return (
        <>
          <PlaceBox value={key} onChange={setKey} defaultInputValue={typed} />
          <button
            type="button"
            aria-label="Set from outside"
            onClick={() => {
              setKey(outside);
            }}
          >
            Set
          </button>
          <p>Selected: {String(key)}</p>
        </>
      );
    }

    it("shows the text of the item picked while only the value is controlled", async () => {
      const user = userEvent.setup();
      render(<ValueOnly outside={null} />);

      await user.type(getInput(), "de");
      await user.click(screen.getByRole("option", { name: DENVER_OPTION }));

      expect(screen.getByText("Selected: den")).toBeInTheDocument();
      expect(getInput()).toHaveValue("Denver");
    });

    it("shows the text of a value that the parent sets from outside", async () => {
      const user = userEvent.setup();
      render(<ValueOnly outside="dal" />);

      await user.click(screen.getByRole("button", { name: "Set from outside" }));

      expect(getInput()).toHaveValue("Dallas");
    });

    it("empties the input when the parent clears the value from outside", async () => {
      const user = userEvent.setup();
      render(<ValueOnly outside={null} />);
      await user.type(getInput(), "de");
      await user.click(screen.getByRole("option", { name: DENVER_OPTION }));

      await user.click(screen.getByRole("button", { name: "Set from outside" }));

      expect(getInput()).toHaveValue("");
    });

    it("keeps the text when the parent sets a value that no item has", async () => {
      const user = userEvent.setup();
      render(<ValueOnly outside="nowhere" typed="xy" />);

      await user.click(screen.getByRole("button", { name: "Set from outside" }));

      expect(getInput()).toHaveValue("xy");
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

    // Two fields on one page (the planner's From and To) must not have two buttons that are both
    // called "Clear" (R3-23): the name is "Clear" and then the label of the field it empties.
    it("is named after the field it clears", async () => {
      const user = userEvent.setup();
      render(<PlaceBox />);

      await user.type(getInput(), "d");

      expect(
        screen.getByRole("button", { name: `${t("search.clear")} Origin`, hidden: true }),
      ).toBeInTheDocument();
    });

    it("tells two fields' clear buttons apart", () => {
      render(
        <>
          <PlaceBox label="From" defaultInputValue="Denver" />
          <PlaceBox label="To" defaultInputValue="Dallas" />
        </>,
      );

      expect(
        screen.getByRole("button", { name: `${t("search.clear")} From`, hidden: true }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: `${t("search.clear")} To`, hidden: true }),
      ).toBeInTheDocument();
    });

    it("clears the text and the selection and returns focus to the input", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<PlaceBox onChange={onChange} />);
      await user.type(getInput(), "de");
      await user.click(screen.getByRole("option", { name: DENVER_OPTION }));

      await user.click(screen.getByRole("button", clearButton));

      expect(getInput()).toHaveValue("");
      expect(getInput()).toHaveFocus();
      expect(onChange).toHaveBeenLastCalledWith(null);
      expect(screen.queryByRole("button", clearButton)).not.toBeInTheDocument();
    });

    it("clears a controlled selection through onChange", async () => {
      const user = userEvent.setup();
      render(
        <Controlled<Key | null> initial="den">
          {({ value, onChange }) => (
            <>
              <PlaceBox value={value} onChange={onChange} defaultInputValue="Denver" />
              <p>Selected: {String(value)}</p>
            </>
          )}
        </Controlled>,
      );
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
      render(
        <Controlled<string> initial="">
          {({ value, onChange: store }) => (
            <PlaceBox
              inputValue={value}
              onInputChange={(next) => {
                onInputChange(next);
                store(next.toUpperCase());
              }}
            />
          )}
        </Controlled>,
      );

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

    // Past the 300 ms that the harness's fake search takes.
    const settle = (): Promise<void> => elapse(300);

    it("goes from loading to results and keeps the old results while the next search runs", async () => {
      installFakeTimers();
      const user = fakeTimerUser();
      render(<SearchHarness />);

      await user.type(getInput(), "de");
      expect(shownMessage(t("search.loading"))).toBeInTheDocument();
      expect(screen.queryAllByRole("option")).toHaveLength(0);
      await settle();
      expect(screen.queryByText(t("search.loading"))).not.toBeInTheDocument();
      expect(screen.getAllByRole("option")).toHaveLength(1);
      expect(screen.getByRole("option", { name: DENVER_OPTION })).toBeInTheDocument();

      await user.type(getInput(), "x");
      expect(shownMessage(t("search.loading"))).toBeInTheDocument();
      expect(screen.getByRole("option", { name: DENVER_OPTION })).toBeInTheDocument();
      await settle();
      expect(shownMessage(t("search.empty", { query: "dex" }))).toBeInTheDocument();
    });

    it("shows the error, then recovers when Retry is pressed", async () => {
      installFakeTimers();
      const user = fakeTimerUser();
      render(<SearchHarness />);

      await user.type(getInput(), "boom");
      await settle();
      expect(shownMessage(t("search.error"))).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: t("search.retry") }));
      expect(shownMessage(t("search.loading"))).toBeInTheDocument();
      await settle();

      expect(screen.queryByText(t("search.error"))).not.toBeInTheDocument();
      expect(shownMessage(t("search.empty", { query: "boom" }))).toBeInTheDocument();
    });
  });

  describe("interaction states", () => {
    describe("input", () => {
      it("is hovered while the pointer rests on it", async () => {
        const user = userEvent.setup();
        render(<PlaceBox />);

        await expectHoverState(user, getInput());
      });

      it("shows the focus ring when the keyboard puts focus on it", async () => {
        const user = userEvent.setup();
        render(<PlaceBox />);

        await expectKeyboardFocusState(user, getInput());
      });

      // A click on the input is left out on purpose: the ring then comes from the browser's own
      // :focus-visible, which jsdom does not model, and React Aria sets no attribute for it.

      it("is neither hovered nor pressed while disabled", async () => {
        const user = userEvent.setup();
        render(<PlaceBox isDisabled />);

        await expectNoPointerStates(user, getInput());
      });
    });

    describe("clear button", () => {
      it("is hovered while the pointer rests on it", async () => {
        const user = userEvent.setup();
        render(<PlaceBox defaultInputValue="Denver" />);

        await expectHoverState(user, screen.getByRole("button", clearButton));
      });

      it("is pressed while a pointer button is held down on it", async () => {
        const user = userEvent.setup();
        // A parent that ignores the cleared text keeps the button on the page after the release.
        // Left to itself the field empties and the button leaves the page still marked pressed.
        render(<PlaceBox inputValue="Denver" onInputChange={() => undefined} />);

        await expectPressedState(user, screen.getByRole("button", clearButton));
      });
    });

    describe("Retry button", () => {
      it("is hovered and pressed like any ghost Button while the popover is open", async () => {
        const user = userEvent.setup();
        render(<PlaceBox status="error" />);
        await user.type(getInput(), "de");
        // The combo box lends its own toggle state (pressed while open) to the Buttons inside it,
        // but not to those in its popover: Retry starts unpressed, which the press helper checks.
        const retry = screen.getByRole("button", { name: t("search.retry") });

        await expectHoverState(user, retry);
        await expectPressedState(user, retry);
      });
    });

    describe("options", () => {
      async function typeAndFindOption(
        user: ReturnType<typeof userEvent.setup>,
        name: string,
      ): Promise<HTMLElement> {
        await user.type(getInput(), "de");
        return screen.getByRole("option", { name });
      }

      it("is hovered while the pointer rests on it", async () => {
        const user = userEvent.setup();
        render(<PlaceBox />);

        await expectHoverState(user, await typeAndFindOption(user, DENVER_OPTION));
      });

      it("is pressed while a pointer button is held down on it", async () => {
        const user = userEvent.setup();
        render(<PlaceBox />);

        await expectPressedState(user, await typeAndFindOption(user, DENVER_OPTION));
      });

      // Focus stays on the input and the arrow keys only point at an option (aria-activedescendant),
      // so the ring is read off the option's own attributes: `toHaveFocus` would name the input.
      it("shows the focus ring on the option the arrow keys point at, and moves it with them", async () => {
        const user = userEvent.setup();
        render(<PlaceBox />);
        const denver = await typeAndFindOption(user, DENVER_OPTION);
        const dallas = screen.getByRole("option", { name: DALLAS_OPTION });
        expect(denver).not.toHaveAttribute("data-focus-visible");

        await user.keyboard("{ArrowDown}");
        expect(getInput()).toHaveFocus();
        expect(denver).toHaveAttribute("data-focus-visible", "true");
        expect(dallas).not.toHaveAttribute("data-focus-visible");

        await user.keyboard("{ArrowDown}");
        expect(denver).not.toHaveAttribute("data-focus-visible");
        expect(dallas).toHaveAttribute("data-focus-visible", "true");
      });

      it("shows no focus ring while the pointer holds it down", async () => {
        const user = userEvent.setup();
        render(<PlaceBox />);
        const denver = await typeAndFindOption(user, DENVER_OPTION);

        await user.pointer({ keys: "[MouseLeft>]", target: denver });

        expect(denver).toHaveAttribute("data-pressed", "true");
        expect(denver).not.toHaveAttribute("data-focus-visible");
        await user.pointer({ keys: "[/MouseLeft]" });
      });

      it("stays marked as selected while the pointer rests on it", async () => {
        const user = userEvent.setup();
        render(<PlaceBox defaultValue="den" defaultInputValue="Denver" />);
        await user.click(getInput());
        await user.keyboard("{ArrowDown}");
        const denver = screen.getByRole("option", { name: DENVER_OPTION });

        await user.hover(denver);

        expect(denver).toHaveAttribute("data-selected", "true");
        expect(denver).toHaveAttribute("data-hovered", "true");
      });

      it("is neither hovered nor pressed while disabled, and cannot be chosen", async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        render(
          <ComboBox<Place> label="Origin" items={places} onChange={onChange}>
            {(place) => (
              <ComboBoxItem
                id={place.id}
                textValue={place.name}
                title={place.name}
                isDisabled={place.id === dallas.id}
              />
            )}
          </ComboBox>,
        );
        const option = await typeAndFindOption(user, "Dallas");

        await expectNoPointerStates(user, option);
        await user.pointer({ keys: "[/MouseLeft]" });

        expect(option).toHaveAttribute("data-disabled", "true");
        expect(onChange).not.toHaveBeenCalled();
        expect(getInput()).toHaveAttribute("aria-expanded", "true");
      });
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
