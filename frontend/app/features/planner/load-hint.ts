import type { LoadRule, RiskRules } from "../../api/contract";
import { t } from "../../design-system/foundation/strings";
import { RISK_RULES } from "../../lib/risk";

/**
 * The load rules that apply at this weight: those with a weight threshold the load is over (the
 * rules file's `load_lb_min_exclusive`, strict like the domain's `>`). Rules without a threshold
 * (LR-1 applies at any load) are not about the load, so they are never listed.
 */
export function applicableLoadRules(
  loadLb: number,
  rules: RiskRules = RISK_RULES,
): readonly LoadRule[] {
  return rules.load_rules.filter(
    (rule) => rule.load_lb_min_exclusive !== null && loadLb > rule.load_lb_min_exclusive,
  );
}

/**
 * The live hint under the load field: which load rules apply, in the design's words. Which rules
 * apply comes from the rules file, so changing a threshold there changes the hint. The two
 * wordings the design wrote cover the rule sets today's file can produce; any other set falls back
 * to naming the rules by id.
 *
 * @param loadLb - The load in pounds; an empty field (`NaN`) applies no rule.
 */
export function loadHint(loadLb: number, rules: RiskRules = RISK_RULES): string {
  const ids = applicableLoadRules(loadLb, rules).map((rule) => rule.id);
  switch (ids.join(",")) {
    case "":
      return t("form.load.hint.none");
    case "LR-2":
      return t("form.load.hint.lr2");
    case "LR-2,LR-3":
      return t("form.load.hint.lr2lr3");
    default:
      return t("form.load.hint.rules", { rules: ids.join(", ") });
  }
}

/**
 * The gross weight routing uses (the assumed tractor-trailer tare plus the load), in words;
 * `null` while the field is empty.
 */
export function grossWeightHint(loadLb: number, rules: RiskRules = RISK_RULES): string | null {
  if (Number.isNaN(loadLb)) return null;
  return t("form.load.hint.gross", {
    gross: (rules.assumed_tare_lb + loadLb).toLocaleString("en-US"),
  });
}
