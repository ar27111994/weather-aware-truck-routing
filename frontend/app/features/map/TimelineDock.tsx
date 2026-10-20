import { Pause, Play } from "lucide-react";
import type { ReactElement } from "react";

import type { Heatmap } from "../../api/contract";
import { IconButton } from "../../design-system/components/IconButton";
import { Segmented } from "../../design-system/components/Segmented";
import { TimelineReadout, TimelineSlider } from "../../design-system/components/Slider";
import { Switch } from "../../design-system/components/Switch";
import { cx } from "../../design-system/foundation/cx";
import { t } from "../../design-system/foundation/strings";
import {
  tripStore,
  useHeatmapField,
  useHeatmapVisible,
  usePlaying,
  useSliderFrame,
  useTripActions,
} from "../../state/trip-store";
import type { TripStore } from "../../state/trip-store";
import { fieldItems, toHeatmapLayer } from "./fields";
import styles from "./TimelineDock.module.css";
import { LAST_FRAME, usePlayback } from "./usePlayback";
import type { FrameClock } from "./usePlayback";

export interface TimelineDockProps {
  /** The corridor forecast; until it arrives the slider is a skeleton and every control waits. */
  readonly heatmap?: Heatmap | undefined;
  readonly store?: TripStore;
  /** BCP 47 locale of the times (D-16); the user's own by default. */
  readonly locale?: string;
  /** IANA zone of the times; the user's own by default (DESIGN.md section 10). */
  readonly timeZone?: string;
  /** The animation clock (tests pass a fake one). */
  readonly clock?: FrameClock;
  readonly className?: string;
}

/**
 * The timeline dock (DESIGN.md section 9.10, R7): Play/Pause, the time readout, the 0 to 48 h
 * slider from the heatmap's `start_time`, the layer switch and the heatmap switch. It drives the
 * store's `sliderFrame`; the map follows without a React render.
 */
export function TimelineDock({
  heatmap,
  store = tripStore,
  locale,
  timeZone,
  clock,
  className,
}: TimelineDockProps): ReactElement {
  const frame = useSliderFrame(store);
  const playing = usePlaying(store);
  const field = useHeatmapField(store);
  const visible = useHeatmapVisible(store);
  const actions = useTripActions(store);
  usePlayback(store, clock);
  const ready = heatmap !== undefined;
  const clockProps = {
    departure: ready ? Date.parse(heatmap.start_time) : 0,
    ...(timeZone === undefined ? {} : { timeZone }),
    ...(locale === undefined ? {} : { locale }),
  };
  return (
    <div
      role="group"
      aria-label={t("timeline.label")}
      className={cx(styles.dock, className)}
      data-ready={String(ready)}
    >
      <IconButton
        icon={playing ? Pause : Play}
        label={playing ? t("timeline.pause") : t("timeline.play")}
        variant="secondary"
        isDisabled={!ready}
        className={styles.play}
        onPress={() => {
          // Play at the end starts over from departure (DESIGN.md section 10).
          if (!playing && frame >= LAST_FRAME) actions.setFrame(0);
          actions.toggle();
        }}
      />
      {ready ? <TimelineReadout hour={frame} className={styles.readout} {...clockProps} /> : null}
      <TimelineSlider
        {...clockProps}
        value={frame}
        onChange={actions.setFrame}
        isLoading={!ready}
        className={styles.slider}
      />
      <div className={styles.controls}>
        <Segmented
          label={t("timeline.field")}
          items={fieldItems()}
          value={field}
          onChange={(id) => {
            actions.setField(toHeatmapLayer(id));
          }}
          isDisabled={!ready}
        />
        <Switch isSelected={visible} onChange={actions.setHeatmapVisible} isDisabled={!ready}>
          {t("timeline.showHeatmap")}
        </Switch>
      </div>
    </div>
  );
}
