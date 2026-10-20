import type { ReactElement, ReactNode } from "react";

import type { Demo } from "../../foundation/demo";
import { Grid, Inline, Stack } from "./Layout";

function Box({ children }: { readonly children: ReactNode }): ReactElement {
  return (
    <span
      style={{
        padding: "var(--space-2) var(--space-3)",
        border: "var(--border-width-hairline) solid var(--color-border-control)",
        borderRadius: "var(--radius-control)",
        background: "var(--color-surface-raised)",
      }}
    >
      {children}
    </span>
  );
}

export const demo: Demo = {
  name: "Layout",
  description:
    "Stack, Inline and Grid: spacing comes from a gap key on the parent, never from margins on children.",
  states: [
    {
      id: "stack",
      title: "Stack, gap 3, aligned start",
      node: (
        <Stack gap={3} align="start">
          <Box>One</Box>
          <Box>Two</Box>
          <Box>Three</Box>
        </Stack>
      ),
    },
    {
      id: "inline",
      title: "Inline, gap 2, centred",
      node: (
        <Inline gap={2}>
          <Box>One</Box>
          <Box>Two</Box>
          <Box>Three</Box>
        </Inline>
      ),
    },
    {
      id: "inline-between",
      title: "Inline, space between",
      node: (
        <div style={{ inlineSize: "20rem" }}>
          <Inline justify="between">
            <Box>Left</Box>
            <Box>Right</Box>
          </Inline>
        </div>
      ),
    },
    {
      id: "inline-wrap",
      title: "Inline that wraps",
      node: (
        <div style={{ inlineSize: "12rem" }}>
          <Inline wrap gap={2}>
            <Box>Wind</Box>
            <Box>Rain</Box>
            <Box>Snow</Box>
            <Box>Risk</Box>
          </Inline>
        </div>
      ),
    },
    {
      id: "grid-fixed",
      title: "Grid, 3 columns",
      node: (
        <div style={{ inlineSize: "24rem" }}>
          <Grid columns={3} gap={2}>
            <Box>A</Box>
            <Box>B</Box>
            <Box>C</Box>
            <Box>D</Box>
            <Box>E</Box>
            <Box>F</Box>
          </Grid>
        </div>
      ),
    },
    {
      id: "grid-auto",
      title: "Grid, auto-fill from 220 px",
      node: (
        <div style={{ inlineSize: "30rem" }}>
          <Grid gap={3}>
            <Box>Distance</Box>
            <Box>Duration</Box>
            <Box>Arrival</Box>
          </Grid>
        </div>
      ),
    },
  ],
};
