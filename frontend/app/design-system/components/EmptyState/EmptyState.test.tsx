import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { t, tList } from "../../foundation/strings";
import { expectNoAxeViolations } from "../../../../test/axe";
import {
  expectHoverState,
  expectKeyboardFocusState,
  expectPressedState,
} from "../../../../test/states";
import { Button } from "../Button";
import { Link } from "../Link";
import { EmptyState } from "./EmptyState";
import { demo } from "./EmptyState.demo";

describe("EmptyState", () => {
  it("shows the title as a heading and the body", () => {
    render(<EmptyState title={t("empty.title")}>{t("empty.body")}</EmptyState>);

    expect(screen.getByRole("heading", { name: t("empty.title") })).toBeInTheDocument();
    expect(screen.getByText(t("empty.body"))).toBeInTheDocument();
  });

  it("lists the steps in an ordered list labelled by its heading", () => {
    render(
      <EmptyState title={t("empty.title")} stepsLabel="How it works" steps={tList("empty.steps")}>
        {t("empty.body")}
      </EmptyState>,
    );

    const list = screen.getByRole("list", { name: "How it works" });
    expect(list.tagName).toBe("OL");
    const items = within(list).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual(tList("empty.steps"));
  });

  it("renders no list and no steps heading without steps", () => {
    render(<EmptyState title={t("empty.title")}>{t("empty.body")}</EmptyState>);

    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    expect(screen.getAllByRole("heading")).toHaveLength(1);
  });

  it("keeps an h2 title and an h3 steps heading unless told otherwise", () => {
    render(
      <EmptyState title={t("empty.title")} stepsLabel="How it works" steps={tList("empty.steps")}>
        {t("empty.body")}
      </EmptyState>,
    );

    expect(screen.getByRole("heading", { level: 2, name: t("empty.title") })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "How it works" })).toBeInTheDocument();
  });

  it.each([
    { headingLevel: 1, stepsLevel: 2 },
    { headingLevel: 4, stepsLevel: 5 },
    { headingLevel: 6, stepsLevel: 6 },
  ] as const)(
    "puts the title at h$headingLevel and the steps heading at h$stepsLevel",
    ({ headingLevel, stepsLevel }) => {
      render(
        <EmptyState
          title={t("empty.title")}
          headingLevel={headingLevel}
          stepsLabel="How it works"
          steps={tList("empty.steps")}
        >
          {t("empty.body")}
        </EmptyState>,
      );

      const title = screen.getByRole("heading", { name: t("empty.title") });
      expect(title).toHaveProperty("tagName", `H${String(headingLevel)}`);
      const steps = screen.getByRole("heading", { name: "How it works" });
      expect(steps).toHaveProperty("tagName", `H${String(stepsLevel)}`);
      expect(screen.getByRole("list", { name: "How it works" })).toBeInTheDocument();
    },
  );

  it("renders the action the caller passes", () => {
    render(
      <EmptyState title={t("empty.title")} action={<a href="#demo">{t("empty.tryScenario")}</a>}>
        {t("empty.body")}
      </EmptyState>,
    );

    expect(screen.getByRole("link", { name: t("empty.tryScenario") })).toBeInTheDocument();
  });

  // EmptyState styles no state of its own: the action is whatever the caller passes in, and its
  // states come from there. DESIGN.md calls for a "ghost Link button", which is a design-system
  // Link or a ghost Button, so each gets one wiring test. The action is the panel's only tab stop.
  describe("interaction states", () => {
    it("wires hover, press and keyboard focus onto a Link action", async () => {
      const user = userEvent.setup();
      render(
        <EmptyState
          title={t("empty.title")}
          action={<Link href="#demo-scenario">{t("empty.tryScenario")}</Link>}
        >
          {t("empty.body")}
        </EmptyState>,
      );
      const link = screen.getByRole("link", { name: t("empty.tryScenario") });

      await expectKeyboardFocusState(user, link);
      await expectHoverState(user, link);
      await expectPressedState(user, link);
    });

    it("wires hover, press and keyboard focus onto a Button action", async () => {
      const user = userEvent.setup();
      render(
        <EmptyState
          title={t("empty.title")}
          action={<Button variant="ghost">{t("empty.tryScenario")}</Button>}
        >
          {t("empty.body")}
        </EmptyState>,
      );
      const button = screen.getByRole("button", { name: t("empty.tryScenario") });

      await expectKeyboardFocusState(user, button);
      await expectHoverState(user, button);
      await expectPressedState(user, button);
    });
  });

  it("passes axe in the demo", async () => {
    const { container } = render(<>{demo.states[0]?.node}</>);

    expect(screen.getByRole("link", { name: t("empty.tryScenario") })).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });
});
