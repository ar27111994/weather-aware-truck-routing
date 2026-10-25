import type { ReactElement, ReactNode } from "react";

import { listParts } from "./ListParts";

/** Props for {@link OptionLines}. */
export interface OptionLinesProps {
  /** The first line of the option, in body text. */
  readonly title: ReactNode;
  /** The second line, in secondary body-sm text. Left out, the option has one line. */
  readonly detail?: ReactNode;
}

/**
 * The lines of a list option, shared by ComboBox and Select: a title and an optional second line.
 *
 * An option is named by all of its visible text, the title first (WCAG 2.5.3 Label in Name; D-58,
 * finding OV-1). React Aria names an option by the element that carries the `label` slot of `Text`
 * and describes it by the one that carries the `description` slot, through `aria-labelledby` and
 * `aria-describedby`. With the second line in the `description` slot the name was the title alone,
 * which leaves out text that the option shows, and axe reports `label-content-name-mismatch`.
 *
 * The lines here are plain content, so no element carries a slot id. React Aria drops a slot id that
 * no element carries (`useSlotId` in `useOption`), the option has neither `aria-labelledby` nor
 * `aria-describedby`, and a browser names it from its content: the title, then the second line. The
 * second line is not also read out as a description, so it is not said twice.
 *
 * A space sits between the lines. The styles make the lines blocks and a browser puts a space
 * between blocks, but a name that is built from the markup alone (jsdom, or a page whose styles
 * have not arrived) would run the two lines together without it.
 *
 * The item's `textValue` stays the title: it is what type-ahead matches and what the control shows
 * once the option is chosen.
 */
export function OptionLines({ title, detail }: OptionLinesProps): ReactElement {
  return (
    <>
      <span className={listParts.title}>{title}</span>
      {detail === undefined ? null : (
        <>
          {" "}
          <span className={listParts.detail}>{detail}</span>
        </>
      )}
    </>
  );
}
