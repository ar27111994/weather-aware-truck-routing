import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { Clock } from "./departure";
import { NO_EARLY_VALUES, applyEarlyValues, parseLoadText, readEarlyValues } from "./early-values";
import { usePlannerForm } from "./usePlannerForm";

const CLOCK: Clock = { now: () => new Date("2026-10-20T14:00:42Z"), timeZone: "America/Denver" };

/** The controls of the prerendered form that take typed text or a choice, as the server draws them. */
const FIELDS = `
  <input type="text" role="combobox" value="">
  <input type="text" role="combobox" value="">
  <input type="text" inputmode="numeric" value="">
  <fieldset role="radiogroup">
    <input type="radio" name="interval" value="10">
    <input type="radio" name="interval" value="25" checked>
    <input type="radio" name="interval" value="50">
  </fieldset>`;

function formFrom(fields: string): HTMLFormElement {
  document.body.innerHTML = `<form>${fields}</form>`;
  const form = document.querySelector("form");
  if (form === null) throw new Error("The test page has no form.");
  return form;
}

function input(form: HTMLFormElement, selector: string, index = 0): HTMLInputElement {
  const found = form.querySelectorAll<HTMLInputElement>(selector).item(index);
  return found;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("readEarlyValues: what the visitor did to the prerendered form", () => {
  it("reports nothing for a form nobody touched", () => {
    expect(readEarlyValues(formFrom(FIELDS))).toEqual(NO_EARLY_VALUES);
  });

  it("reports nothing when there is no prerendered form (the page was reached inside the app)", () => {
    expect(readEarlyValues(null)).toEqual(NO_EARLY_VALUES);
  });

  it("reports the text typed into the two places, each in its own field", () => {
    const form = formFrom(FIELDS);
    input(form, '[role="combobox"]', 0).value = "Salt";
    input(form, '[role="combobox"]', 1).value = "Denv";

    expect(readEarlyValues(form)).toEqual({
      ...NO_EARLY_VALUES,
      origin: "Salt",
      destination: "Denv",
    });
  });

  it("reports only the place that was typed into", () => {
    const form = formFrom(FIELDS);
    input(form, '[role="combobox"]', 1).value = "Denv";

    expect(readEarlyValues(form)).toEqual({ ...NO_EARLY_VALUES, destination: "Denv" });
  });

  it("reports the text typed into the load field", () => {
    const form = formFrom(FIELDS);
    input(form, '[inputmode="numeric"]').value = "38,000";

    expect(readEarlyValues(form)).toEqual({ ...NO_EARLY_VALUES, load: "38,000" });
  });

  it("reports the checkpoint interval the visitor chose", () => {
    const form = formFrom(FIELDS);
    input(form, '[type="radio"][value="10"]').checked = true;

    expect(readEarlyValues(form)).toEqual({ ...NO_EARLY_VALUES, interval: "10" });
  });

  it("does not count a choice that is the one the page was drawn with", () => {
    const form = formFrom(FIELDS);
    input(form, '[type="radio"][value="10"]').checked = true;
    input(form, '[type="radio"][value="25"]').checked = true;

    expect(readEarlyValues(form).interval).toBeNull();
  });

  it("copes with a form that lacks some of the controls", () => {
    expect(readEarlyValues(formFrom(""))).toEqual(NO_EARLY_VALUES);
  });
});

describe("parseLoadText: pounds as the visitor typed them", () => {
  it.each([
    ["38,000", "en-US", 38_000],
    ["38000", "en-US", 38_000],
    ["38.000", "de-DE", 38_000],
    // Spanish, Polish and Portuguese group only from four digits up, so a five-digit number shows
    // no separator at all; the thousands separator is still the full stop (or the space).
    ["38.000", "es-ES", 38_000],
    ["38 000", "pl-PL", 38_000],
    ["1.234,5", "es-ES", 1_234.5],
    ["1,23,456", "en-IN", 123_456],
    ["38\u202f000", "fr-FR", 38_000],
    ["38 000", "fr-FR", 38_000],
    ["12,5", "de-DE", 12.5],
    ["0", "en-US", 0],
  ])("reads %j in %s as %d", (text, locale, pounds) => {
    expect(parseLoadText(text, locale)).toBe(pounds);
  });

  it.each(["", "  ", "abc", "1e3", "-5", "38,000 lb", "1.2.3"])("reads %j as no number", (text) => {
    expect(parseLoadText(text, "en-US")).toBeNaN();
  });
});

describe("applyEarlyValues: putting what the visitor did into the form's state", () => {
  function formState() {
    return renderHook(() => usePlannerForm({}, CLOCK)).result;
  }

  it("takes over the typed texts, the load and the interval", () => {
    const form = formState();

    act(() => {
      applyEarlyValues(
        form.current,
        { origin: "Salt", destination: "Denv", load: "38,000", interval: "10" },
        "en-US",
      );
    });

    expect(form.current.origin).toEqual({ text: "Salt", place: null });
    expect(form.current.destination).toEqual({ text: "Denv", place: null });
    expect(form.current.load).toBe(38_000);
    expect(form.current.interval).toBe(10);
  });

  it("leaves alone everything the visitor did not touch", () => {
    const form = formState();
    act(() => {
      form.current.setOriginText("kept");
      form.current.setLoad(20_000);
      form.current.setInterval(50);
    });

    act(() => {
      applyEarlyValues(form.current, NO_EARLY_VALUES, "en-US");
    });

    expect(form.current.origin.text).toBe("kept");
    expect(form.current.load).toBe(20_000);
    expect(form.current.interval).toBe(50);
  });

  it("drops a load that is not a number instead of replacing the field's with nonsense", () => {
    const form = formState();
    act(() => {
      form.current.setLoad(20_000);
    });

    act(() => {
      applyEarlyValues(form.current, { ...NO_EARLY_VALUES, load: "abc" }, "en-US");
    });

    expect(form.current.load).toBe(20_000);
  });

  it("falls back to the default interval for a value that names none", () => {
    const form = formState();
    act(() => {
      form.current.setInterval(50);
    });

    act(() => {
      applyEarlyValues(form.current, { ...NO_EARLY_VALUES, interval: "7" }, "en-US");
    });

    expect(form.current.interval).toBe(25);
  });
});
