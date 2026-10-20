import type { Demo } from "../../foundation/demo";
import { useState, type ReactElement } from "react";

import { cx } from "../../foundation/cx";
import { t } from "../../foundation/strings";
import { DemoGrid, DemoState } from "../_shared/DemoState";
import { typography } from "../_shared/typography";
import { Button } from "../Button";
import { Inline } from "../Layout";
import { BottomSheet, type SheetSnap } from "./BottomSheet";

const SNAPS = ["peek", "half", "full"] as const;
const SNAP_BUTTONS: Readonly<Record<SheetSnap, string>> = {
  peek: "Peek",
  half: "Half",
  full: "Full",
};

/**
 * Kitchen-sink states of {@link BottomSheet}: one sheet the parent owns, with the timeline dock, so
 * every snap point can be reached by dragging, tapping, the keyboard or the buttons here. The sheet
 * is fixed to the bottom of the viewport, as it is in the planner, so mounted all the time it would
 * cover the rest of the page and every golden. It is mounted only when the reviewer asks for it.
 */
function BottomSheetDemo(): ReactElement {
  const [isShown, setIsShown] = useState(false);
  const [snap, setSnap] = useState<SheetSnap>("half");

  return (
    <DemoGrid>
      <DemoState title="Snap points">
        <p className={cx(typography.bodySm)}>
          The sheet is fixed to the bottom of the viewport, as in the planner, so it appears only on
          request.
        </p>
        <Inline gap={2} wrap>
          <Button
            onPress={() => {
              setIsShown((shown) => !shown);
            }}
          >
            {isShown ? "Hide the sheet" : "Show the sheet"}
          </Button>
        </Inline>
        <p className={cx(typography.body)}>Snap: {snap}</p>
        <Inline gap={2} wrap role="group" aria-label="Set the snap point">
          {SNAPS.map((value) => (
            <Button
              key={value}
              size="sm"
              onPress={() => {
                setSnap(value);
              }}
            >
              {SNAP_BUTTONS[value]}
            </Button>
          ))}
        </Inline>
      </DemoState>
      {isShown ? (
        <BottomSheet
          label={t("app.regions.planner")}
          snap={snap}
          onSnapChange={setSnap}
          dock={<p className={cx(typography.caption)}>Timeline dock</p>}
        >
          <p className={cx(typography.body)}>
            Drag the handle, tap it, or use the arrow keys. The content scrolls inside the sheet.
          </p>
        </BottomSheet>
      ) : null}
    </DemoGrid>
  );
}

/** What the `/design` route renders for BottomSheet: every state, laid out by the demo component. */
export const demo: Demo = {
  name: "BottomSheet",
  description:
    "Draggable mobile sheet with peek, half and full snap points; the map behind stays interactive.",
  states: [{ id: "states", title: "States", node: <BottomSheetDemo /> }],
};
