import { describe, expect, it } from "vitest";

import { t } from "../../design-system/foundation/strings";
import { RISK_RULES } from "../../lib/risk";
import { applicableLoadRules, grossWeightHint, loadHint } from "./load-hint";

describe("applicableLoadRules", () => {
  it("lists no rule up to and including 30,000 lb (the comparison is strict)", () => {
    expect(applicableLoadRules(0)).toEqual([]);
    expect(applicableLoadRules(30_000)).toEqual([]);
  });

  it("lists LR-2 from 30,001 lb and LR-3 from 40,001 lb, never LR-1 (it applies at any load)", () => {
    expect(applicableLoadRules(30_001).map((rule) => rule.id)).toEqual(["LR-2"]);
    expect(applicableLoadRules(40_000).map((rule) => rule.id)).toEqual(["LR-2"]);
    expect(applicableLoadRules(40_001).map((rule) => rule.id)).toEqual(["LR-2", "LR-3"]);
    expect(applicableLoadRules(80_000).map((rule) => rule.id)).toEqual(["LR-2", "LR-3"]);
  });

  it("lists nothing while the field is empty", () => {
    expect(applicableLoadRules(Number.NaN)).toEqual([]);
  });

  it("follows the thresholds in the rules file", () => {
    const rules = {
      ...RISK_RULES,
      load_rules: RISK_RULES.load_rules.map((rule) =>
        rule.id === "LR-2" ? { ...rule, load_lb_min_exclusive: 20_000 } : rule,
      ),
    };

    expect(applicableLoadRules(25_000, rules).map((rule) => rule.id)).toEqual(["LR-2"]);
    expect(applicableLoadRules(25_000)).toEqual([]);
  });
});

describe("loadHint", () => {
  it("says no load rule escalates up to 30,000 lb", () => {
    expect(loadHint(0)).toBe(t("form.load.hint.none"));
    expect(loadHint(30_000)).toBe(t("form.load.hint.none"));
    expect(loadHint(Number.NaN)).toBe(t("form.load.hint.none"));
  });

  it("names LR-2 between 30,001 and 40,000 lb", () => {
    expect(loadHint(30_001)).toBe(t("form.load.hint.lr2"));
    expect(loadHint(40_000)).toBe(t("form.load.hint.lr2"));
  });

  it("names LR-2 and LR-3 over 40,000 lb", () => {
    expect(loadHint(40_001)).toBe(t("form.load.hint.lr2lr3"));
    expect(loadHint(80_000)).toBe(t("form.load.hint.lr2lr3"));
  });

  it("names the rules by id when a rules file makes a combination the design did not word", () => {
    const rules = {
      ...RISK_RULES,
      load_rules: RISK_RULES.load_rules.filter((rule) => rule.id !== "LR-2"),
    };

    expect(loadHint(45_000, rules)).toBe(t("form.load.hint.rules", { rules: "LR-3" }));
    expect(loadHint(45_000, rules)).toBe("Load rules that apply at this weight: LR-3.");
  });
});

describe("grossWeightHint", () => {
  it("adds the assumed 35,000 lb tractor-trailer to the load", () => {
    expect(grossWeightHint(38_000)).toBe(
      "Routing uses a gross weight of 73,000 lb (35,000 lb tractor-trailer plus load).",
    );
  });

  it("uses the tare the rules file declares", () => {
    const rules = { ...RISK_RULES, assumed_tare_lb: 30_000 };

    expect(grossWeightHint(0, rules)).toContain("gross weight of 30,000 lb");
  });

  it("says nothing while the field is empty", () => {
    expect(grossWeightHint(Number.NaN)).toBeNull();
  });
});
