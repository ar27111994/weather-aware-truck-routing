import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { useState, type ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import type { PlanLocation } from "../../api/contract";
import { DENVER, SLC } from "../../../test/plans";
import { renderWithApi, startMockApi } from "../../../test/api";
import { PlaceField, optionFromRecent, optionFromResult } from "./PlaceField";

const api = startMockApi();

function Harness({
  recent = [],
  errorMessage,
  onPick,
}: {
  readonly recent?: readonly PlanLocation[];
  readonly errorMessage?: string;
  readonly onPick?: (place: PlanLocation | null) => void;
}): ReactElement {
  const [text, setText] = useState("");
  const [chosen, setChosen] = useState<PlanLocation | null>(null);
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

    expect(await screen.findByText("Type at least 2 letters.")).toBeInTheDocument();
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
    expect(input).toHaveValue("Denver, Colorado, United States");

    // The pause before a search is 250 ms: wait it out, and a little more.
    await new Promise((resolve) => setTimeout(resolve, 400));

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

    expect(await screen.findByText('No places match "zzzz".')).toBeInTheDocument();
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
    expect(await screen.findByText("Place search isn't responding.")).toBeInTheDocument();
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
