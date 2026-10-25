import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { useState, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PlanLocation } from "../../api/contract";
import { DENVER, SLC } from "../../../test/plans";
import { renderWithApi, startMockApi } from "../../../test/api";
import { elapse, fakeTimerUser, installFakeTimers } from "../../../test/fake-timers";
import { PlaceField, optionFromRecent, optionFromResult } from "./PlaceField";
import { SEARCH_DEBOUNCE_MS } from "./use-debounced-value";

const api = startMockApi();

// The pause before a search, and a little more: a search that should not be sent is sent by then.
const PAST_THE_PAUSE_MS = SEARCH_DEBOUNCE_MS + 150;

afterEach(() => {
  vi.useRealTimers();
});

// The popover shows each message of the search in a row, and the live region says it again for
// screen readers (R3-25), so the row is looked up inside the popover.
async function findShownMessage(message: string): Promise<HTMLElement> {
  return waitFor(() => {
    const popover = document.querySelector<HTMLElement>("[data-trigger]");
    if (popover === null) throw new Error("The popover is not open.");
    return within(popover).getByText(message);
  });
}

function Harness({
  recent = [],
  errorMessage,
  onPick,
  restored = null,
}: {
  readonly recent?: readonly PlanLocation[];
  readonly errorMessage?: string;
  readonly onPick?: (place: PlanLocation | null) => void;
  /** A place that the page's address restored: in the field before anyone touched it. */
  readonly restored?: PlanLocation | null;
}): ReactElement {
  const [text, setText] = useState(restored?.label ?? "");
  const [chosen, setChosen] = useState<PlanLocation | null>(restored);
  return (
    <PlaceField
      field="origin"
      label="From"
      hint="City, address or place"
      placeholder="Search a place"
      text={text}
      onText={setText}
      chosen={chosen}
      onPick={(place) => {
        setChosen(place);
        onPick?.(place);
      }}
      recent={recent}
      errorMessage={errorMessage}
    />
  );
}

describe("optionFromResult", () => {
  it("reads a hit as its name, then region and country, then kind, and picks its label", () => {
    expect(
      optionFromResult({
        id: "osm:R1",
        label: "Denver, Colorado, United States",
        name: "Denver",
        region: "Colorado",
        country: "United States",
        country_code: "US",
        kind: "city",
        lat: 39.7392,
        lon: -104.9903,
      }),
    ).toEqual({
      id: "osm:R1",
      title: "Denver",
      subtitle: "Colorado, United States",
      meta: "city",
      place: { lat: 39.7392, lon: -104.9903, label: "Denver, Colorado, United States" },
    });
  });

  it("leaves out the parts a provider did not give (a country-level hit)", () => {
    const option = optionFromResult({
      id: "osm:R2",
      label: "Wales",
      name: "Wales",
      region: null,
      country: null,
      country_code: null,
      kind: "country",
      lat: 52,
      lon: -3,
    });

    expect(option.subtitle).toBeUndefined();
    expect(option.title).toBe("Wales");
  });
});

describe("optionFromRecent", () => {
  it("splits a saved label into the name and the rest", () => {
    expect(optionFromRecent(DENVER)).toMatchObject({
      title: "Denver",
      subtitle: "Colorado, United States",
      meta: undefined,
      place: DENVER,
    });
  });

  it("keeps a label without a comma whole", () => {
    expect(optionFromRecent({ lat: 1, lon: 2, label: "Springfield" })).toMatchObject({
      title: "Springfield",
      subtitle: undefined,
    });
  });

  it("gives two places with one label and different coordinates different ids", () => {
    const a = optionFromRecent({ lat: 1, lon: 2, label: "Springfield" });
    const b = optionFromRecent({ lat: 3, lon: 4, label: "Springfield" });

    expect(a.id).not.toBe(b.id);
  });
});

describe("PlaceField", () => {
  it("is a labelled search with its hint", () => {
    renderWithApi(<Harness />, api.client);

    const input = screen.getByRole("combobox", { name: /From/u });
    expect(input).toHaveAccessibleDescription(/City, address or place/u);
    expect(input).toHaveAttribute("placeholder", "Search a place");
  });

  it("asks for at least two letters before it searches", async () => {
    const user = userEvent.setup();
    renderWithApi(<Harness />, api.client);

    await user.type(screen.getByRole("combobox", { name: /From/u }), "d");

    expect(await findShownMessage("Type at least 2 letters.")).toBeInTheDocument();
  });

  it("lists the places that match after the pause, and picks one with the keyboard", async () => {
    const onPick = vi.fn<(place: PlanLocation | null) => void>();
    const user = userEvent.setup();
    renderWithApi(<Harness onPick={onPick} />, api.client);
    const input = screen.getByRole("combobox", { name: /From/u });

    await user.type(input, "denv");
    const option = await screen.findByRole("option", { name: /Denver/u });
    expect(option).toHaveTextContent("Colorado, United States");
    await user.keyboard("{ArrowDown}{Enter}");

    expect(onPick).toHaveBeenLastCalledWith(DENVER);
    expect(input).toHaveValue("Denver, Colorado, United States");
  });

  // R4-20: choosing a place writes its label into the field, and the label is not a question.
  it("does not search for the label of the place it has just picked", async () => {
    installFakeTimers();
    const searches: string[] = [];
    api.server.events.on("request:start", ({ request }) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/geocode")) searches.push(url.searchParams.get("q") ?? "");
    });
    const user = fakeTimerUser();
    renderWithApi(<Harness />, api.client);
    const input = screen.getByRole("combobox", { name: /From/u });
    await user.type(input, "denv");
    await user.click(await screen.findByRole("option", { name: /Denver/u }));
    expect(input).toHaveValue("Denver, Colorado, United States");

    // The pause before a search is on the fake clock: let it pass, and a little more.
    await elapse(PAST_THE_PAUSE_MS);

    expect(searches).toEqual(["denv"]);
    api.server.events.removeAllListeners();
  });

  it("searches again once the visitor edits the picked label", async () => {
    const searches: string[] = [];
    api.server.events.on("request:start", ({ request }) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/geocode")) searches.push(url.searchParams.get("q") ?? "");
    });
    const user = userEvent.setup();
    renderWithApi(<Harness />, api.client);
    const input = screen.getByRole("combobox", { name: /From/u });
    await user.type(input, "denv");
    await user.click(await screen.findByRole("option", { name: /Denver/u }));

    await user.type(input, " Co");

    await waitFor(() => {
      expect(searches).toContain("Denver, Colorado, United States Co");
    });
    api.server.events.removeAllListeners();
  });

  it("says when no place matches", async () => {
    const user = userEvent.setup();
    renderWithApi(<Harness />, api.client);

    await user.type(screen.getByRole("combobox", { name: /From/u }), "zzzz");

    expect(await findShownMessage('No places match "zzzz".')).toBeInTheDocument();
  });

  it("says the search is not responding and tries again on Retry", async () => {
    let attempts = 0;
    api.server.use(
      http.get("*/api/v1/geocode", () => {
        attempts += 1;
        return attempts === 1
          ? HttpResponse.json({ title: "x", status: 400, code: "bad_request" }, { status: 400 })
          : HttpResponse.json({ query: "denver", results: [] });
      }),
    );
    const user = userEvent.setup();
    renderWithApi(<Harness />, api.client);

    await user.type(screen.getByRole("combobox", { name: /From/u }), "denver");
    expect(await findShownMessage("Place search isn't responding.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => {
      expect(attempts).toBe(2);
    });
  });

  it("lists the places used before when the empty field takes focus, and picks one", async () => {
    const onPick = vi.fn<(place: PlanLocation | null) => void>();
    const user = userEvent.setup();
    renderWithApi(<Harness recent={[SLC, DENVER]} onPick={onPick} />, api.client);

    await user.click(screen.getByRole("combobox", { name: /From/u }));
    const option = await screen.findByRole("option", { name: /Salt Lake City/u });
    expect(screen.getByText("Recent")).toBeInTheDocument();
    await user.click(option);

    expect(onPick).toHaveBeenLastCalledWith(SLC);
  });

  // R3-14: a place picked from the places used before is in none of the lists that follow, and a
  // place picked from the results can be missing from the next search.
  it("keeps a place picked from the places used before when focus leaves", async () => {
    const onPick = vi.fn<(place: PlanLocation | null) => void>();
    const user = userEvent.setup();
    renderWithApi(<Harness recent={[SLC, DENVER]} onPick={onPick} />, api.client);
    const input = screen.getByRole("combobox", { name: /From/u });

    await user.click(input);
    await user.click(await screen.findByRole("option", { name: /Salt Lake City/u }));
    await user.tab();

    expect(input).toHaveValue(SLC.label);
    expect(onPick).toHaveBeenCalledExactlyOnceWith(SLC);
  });

  it("keeps a place picked from the results when the next search does not list it", async () => {
    const onPick = vi.fn<(place: PlanLocation | null) => void>();
    const user = userEvent.setup();
    renderWithApi(<Harness onPick={onPick} />, api.client);
    const input = screen.getByRole("combobox", { name: /From/u });
    await user.type(input, "denv");
    await user.click(await screen.findByRole("option", { name: /Denver/u }));
    api.server.use(
      http.get("*/api/v1/geocode", () => HttpResponse.json({ query: "x", results: [] })),
    );

    await user.type(input, " x");
    await findShownMessage(`No places match "${DENVER.label} x".`);
    await user.tab();

    expect(input).toHaveValue(DENVER.label);
    expect(onPick).toHaveBeenCalledExactlyOnceWith(DENVER);
  });

  // D-56: the place that a shared link restored is the field's answer, as if it had been picked.
  // Focus passing through the field takes nothing out of it and asks the geocoder nothing.
  it("keeps the place that a shared link restored when focus goes through the field", async () => {
    installFakeTimers();
    const searches: string[] = [];
    api.server.events.on("request:start", ({ request }) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/geocode")) searches.push(url.searchParams.get("q") ?? "");
    });
    const onPick = vi.fn<(place: PlanLocation | null) => void>();
    const user = fakeTimerUser();
    renderWithApi(<Harness restored={SLC} onPick={onPick} />, api.client);
    const input = screen.getByRole("combobox", { name: /From/u });

    await user.click(input);
    await user.tab();
    // The pause before a search is on the fake clock: let it pass, and a little more.
    await elapse(PAST_THE_PAUSE_MS);

    expect(input).toHaveValue(SLC.label);
    expect(onPick).not.toHaveBeenCalled();
    expect(searches).toEqual([]);
    api.server.events.removeAllListeners();
  });

  it("keeps what was typed and never chosen when focus leaves, and picks nothing", async () => {
    const onPick = vi.fn<(place: PlanLocation | null) => void>();
    const user = userEvent.setup();
    renderWithApi(<Harness onPick={onPick} />, api.client);
    const input = screen.getByRole("combobox", { name: /From/u });

    await user.type(input, "denv");
    await screen.findByRole("option", { name: /Denver/u });
    await user.tab();

    expect(input).toHaveValue("denv");
    expect(input).toHaveAttribute("aria-expanded", "false");
    expect(onPick).not.toHaveBeenCalled();
  });

  it("shows at most five of the places used before", async () => {
    const many = Array.from({ length: 8 }, (_, n) => ({
      lat: 30 + n,
      lon: -100,
      label: `Town ${String(n)}, State`,
    }));
    const user = userEvent.setup();
    renderWithApi(<Harness recent={many} />, api.client);

    await user.click(screen.getByRole("combobox", { name: /From/u }));

    expect(await screen.findAllByRole("option")).toHaveLength(5);
  });

  it("reports that the pick is cleared when the field is emptied", async () => {
    const onPick = vi.fn<(place: PlanLocation | null) => void>();
    const user = userEvent.setup();
    renderWithApi(<Harness onPick={onPick} />, api.client);
    const input = screen.getByRole("combobox", { name: /From/u });
    await user.type(input, "denv");
    await user.click(await screen.findByRole("option", { name: /Denver/u }));

    await user.clear(input);

    expect(onPick).toHaveBeenLastCalledWith(null);
  });

  it("shows its error tied to the field", () => {
    renderWithApi(<Harness errorMessage="Choose a starting point from the list." />, api.client);

    const input = screen.getByRole("combobox", { name: /From/u });
    expect(input).toBeInvalid();
    expect(input).toHaveAccessibleDescription(/Choose a starting point from the list\./u);
  });
});
