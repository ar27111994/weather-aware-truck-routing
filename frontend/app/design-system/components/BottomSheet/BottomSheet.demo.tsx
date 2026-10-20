import type { Demo } from "../../foundation/demo";
import { useState, type ReactElement } from "react";

import { t } from "../../foundation/strings";
import { DemoGrid, DemoState } from "../_shared/DemoState";
import { typography } from "../_shared/typography";
import { cx } from "../../foundation/cx";
import { BottomSheet, type SheetSnap } from "./BottomSheet";

const SNAPS = ["peek", "half", "full"] as const;
const SNAP_BUTTONS: Readonly<Record<SheetSnap, string>> = {
  peek: "Peek",
  half: "Half",
  full: "Full",
};

/**
 * Kitchen-sink states of {@link BottomSheet}: one sheet the parent owns, with the timeline dock, so
 * every snap point can be reached by dragging, tapping, the keyboard or the buttons here.
 */
function BottomSheetDemo(): ReactElement {
  const [snap, setSnap] = useState<SheetSnap>("half");

  return (
    <DemoGrid>
      <DemoState title="Snap points">
        <p className={cx(typography.body)}>Snap: {snap}</p>
        <div role="group" aria-label="Set the snap point">
          {SNAPS.map((value) => (
            <button
              key={value}
              type="button"
              className={cx(typography.label)}
              onClick={() => {
                setSnap(value);
              }}
            >
              {SNAP_BUTTONS[value]}
            </button>
          ))}
        </div>
      </DemoState>
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
