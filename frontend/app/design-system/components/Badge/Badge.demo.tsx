import type { ReactElement } from "react";

import type { Demo } from "../../foundation/demo";
import { RISK_LEVELS } from "../../foundation/risk";
import type { RiskLevel } from "../../foundation/risk";
import { Badge } from "./Badge";

function Row({ level }: { readonly level: RiskLevel | null }): ReactElement {
  return (
    <span style={{ display: "inline-flex", gap: "var(--space-3)", alignItems: "center" }}>
      <Badge level={level} variant="solid" />
      <Badge level={level} variant="subtle" />
      <Badge level={level} variant="outline" />
    </span>
  );
}

export const demo: Demo = {
  name: "Badge",
  description:
    "Risk level as word plus shape (solid, subtle, outline) and the neutral ink badge. Never interactive, never colour alone.",
  states: [
    ...RISK_LEVELS.map((level) => ({
      id: level,
      title: `${level}: solid, subtle, outline`,
      node: <Row level={level} />,
    })),
    { id: "unknown", title: "Unknown: missing weather data", node: <Row level={null} /> },
    { id: "neutral", title: "Neutral", node: <Badge variant="neutral">Recommended</Badge> },
  ],
};
