import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { expectNoAxeViolations } from "../../../../test/axe";
import { t } from "../../foundation/strings";
import { Button } from "../Button";
import { Banner } from "./Banner";
import type { BannerVariant } from "./Banner";

const VARIANTS: readonly BannerVariant[] = [
  "info",
  "warning",
  "danger",
  "scenario",
  "no-safe-route",
];

describe("Banner", () => {
  it.each([
    ["info", "status"],
    ["warning", "status"],
    ["danger", "alert"],
    ["scenario", "status"],
    ["no-safe-route", "alert"],
  ] as const)("announces %s as a %s", (variant, role) => {
    render(<Banner variant={variant} title="Heads up" />);

    const banner = screen.getByRole(role);
    expect(banner).toHaveAttribute("data-variant", variant);
    expect(banner).toHaveTextContent("Heads up");
  });

  it("shows the title and the detail", () => {
    render(
      <Banner variant="warning" title="Some weather data is missing">
        3 checkpoints have no forecast.
      </Banner>,
    );

    expect(screen.getByText("Some weather data is missing")).toBeInTheDocument();
    expect(screen.getByText("3 checkpoints have no forecast.")).toBeInTheDocument();
  });

  it("works with a title alone", () => {
    const { container } = render(<Banner variant="info" title="Fewer than three routes" />);

    expect(container.querySelectorAll("p")).toHaveLength(1);
  });

  it("renders an action beside the text", () => {
    render(
      <Banner
        variant="no-safe-route"
        title={t("banner.noSafeRoute.title")}
        action={<Button variant="secondary">{t("banner.noSafeRoute.action")}</Button>}
      >
        Every route crosses No Travel conditions.
      </Banner>,
    );

    expect(screen.getByRole("button", { name: "Change departure" })).toBeInTheDocument();
  });

  it("draws a hidden, decorative icon on every variant", () => {
    for (const variant of VARIANTS) {
      const { container, unmount } = render(<Banner variant={variant} title="Title" />);
      expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
      unmount();
    }
  });

  it("makes the no-safe-route icon 24 px and every other icon 20 px", () => {
    const sizes = VARIANTS.map((variant) => {
      const { container, unmount } = render(<Banner variant={variant} title="Title" />);
      const width = container.querySelector("svg")?.getAttribute("width");
      unmount();
      return [variant, width];
    });

    expect(sizes).toEqual([
      ["info", "20"],
      ["warning", "20"],
      ["danger", "20"],
      ["scenario", "20"],
      ["no-safe-route", "24"],
    ]);
  });

  it("hatches only the scenario variant", () => {
    const { container: scenario } = render(<Banner variant="scenario" title="Simulated" />);
    const { container: info } = render(<Banner variant="info" title="Plain" />);

    expect(scenario.querySelector("[aria-hidden='true']:not(svg)")).not.toBeNull();
    expect(info.querySelector("[aria-hidden='true']:not(svg)")).toBeNull();
  });

  it("uses the agreed scenario wording from the microcopy", () => {
    render(
      <Banner variant="scenario" title={t("banner.scenario.title")}>
        {t("banner.scenario.body", { name: "Blizzard on I-80" })}
      </Banner>,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Simulated weather. Not a forecast.");
  });

  it("merges a caller class name", () => {
    render(<Banner variant="info" title="Title" className="custom" />);

    expect(screen.getByRole("status")).toHaveClass("custom");
  });

  it("has no accessibility violations in any variant", async () => {
    const { container } = render(
      <div>
        {VARIANTS.map((variant) => (
          <Banner key={variant} variant={variant} title="Title">
            Detail text.
          </Banner>
        ))}
      </div>,
    );

    await expectNoAxeViolations(container);
  });
});
