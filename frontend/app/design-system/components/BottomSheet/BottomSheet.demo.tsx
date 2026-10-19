import { useState, type ReactElement } from "react";

import { copy } from "../../copy";
import { DemoGrid, DemoState } from "../_shared/DemoState";
import { typography } from "../_shared/typography";
import { cls } from "../../cls";
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
export default function BottomSheetDemo(): ReactElement {
  const [snap, setSnap] = useState<SheetSnap>("half");

  return (
    <DemoGrid>
      <DemoState title="Snap points">
        <p className={cls(typography.body)}>Snap: {snap}</p>
        <div role="group" aria-label="Set the snap point">
          {SNAPS.map((value) => (
            <button
              key={value}
              type="button"
              className={cls(typography.label)}
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
        label={copy.app.regions.planner}
        snap={snap}
        onSnapChange={setSnap}
        dock={<p className={cls(typography.caption)}>Timeline dock</p>}
      >
        <p className={cls(typography.body)}>
          Drag the handle, tap it, or use the arrow keys. The content scrolls inside the sheet.
        </p>
      </BottomSheet>
    </DemoGrid>
  );
}
