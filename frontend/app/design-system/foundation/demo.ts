import type { ReactNode } from "react";

/** One rendered state of a component on the `/design` kitchen sink. */
export interface DemoState {
  /** Stable id, unique within the demo; used for anchors and test selectors. */
  readonly id: string;
  /** Short human title shown under the specimen, e.g. "Disabled". */
  readonly title: string;
  /** What to render. Plain elements, or a small local component when the state needs hooks. */
  readonly node: ReactNode;
}

/**
 * What every `components/<Name>/<Name>.demo.tsx` exports as `demo`. The `/design` route discovers
 * these with `import.meta.glob` and renders every state, so a new component appears in the visual
 * goldens and the axe run by adding one file. Keep demos declarative: no inline functions and no
 * conditionals, because the demo registry test renders them and coverage counts them.
 */
export interface Demo {
  /** Component name, shown as the section heading. */
  readonly name: string;
  /** One sentence on what the component is for. */
  readonly description: string;
  /** Every variant and state worth seeing (default, hover cannot be shown; disabled, invalid...). */
  readonly states: readonly DemoState[];
}
