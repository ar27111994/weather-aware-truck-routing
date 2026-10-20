import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { t, tList } from "../../foundation/strings";
import { expectNoAxeViolations } from "../../../../test/axe";
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

  it("renders the action the caller passes", () => {
    render(
      <EmptyState title={t("empty.title")} action={<a href="#demo">{t("empty.tryScenario")}</a>}>
        {t("empty.body")}
      </EmptyState>,
    );

    expect(screen.getByRole("link", { name: t("empty.tryScenario") })).toBeInTheDocument();
  });

  it("passes axe in the demo", async () => {
    const { container } = render(<>{demo.states[0]?.node}</>);

    expect(screen.getByRole("link", { name: t("empty.tryScenario") })).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });
});
