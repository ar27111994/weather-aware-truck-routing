import type { Demo } from "../../foundation/demo";
import { Slider } from "./Slider";
import { TimelineReadout, TimelineSlider } from "./TimelineSlider";

// A fixed departure and zone keep the specimens, and the screenshot goldens, deterministic:
// Tue 14:00 in Denver (MDT).
const CLOCK = {
  departure: Date.UTC(2026, 9, 20, 20, 0, 0),
  timeZone: "America/Denver",
  locale: "en-US",
} as const;

const WIDE = { inlineSize: "min(100%, 34rem)" } as const;

export const demo: Demo = {
  name: "Slider",
  description:
    "Generic slider and the forecast timeline: a tick every hour, a label every sixth hour, local midnights marked with the weekday. Arrows move 1 hour, Page Up and Page Down 6.",
  states: [
    {
      id: "generic",
      title: "Generic, with value readout",
      node: (
        <div style={WIDE}>
          <Slider
            label="Wind threshold, mph"
            minValue={0}
            maxValue={60}
            step={5}
            defaultValue={25}
            showValue
          />
        </div>
      ),
    },
    {
      id: "generic-disabled",
      title: "Generic, disabled",
      node: (
        <div style={WIDE}>
          <Slider label="Wind threshold, mph" defaultValue={40} isDisabled showValue />
        </div>
      ),
    },
    {
      id: "timeline-departure",
      title: "Timeline at departure (+0 h)",
      node: (
        <div style={WIDE}>
          <TimelineSlider {...CLOCK} defaultValue={0} />
        </div>
      ),
    },
    {
      id: "timeline-mid",
      title: "Timeline at +30 h, with the readout",
      node: (
        <div style={{ ...WIDE, display: "flex", gap: "var(--space-4)", alignItems: "center" }}>
          <TimelineReadout {...CLOCK} hour={30} />
          <div style={{ flex: 1 }}>
            <TimelineSlider {...CLOCK} defaultValue={30} />
          </div>
        </div>
      ),
    },
    {
      id: "timeline-end",
      title: "Timeline at +48 h (end label hangs inward)",
      node: (
        <div style={WIDE}>
          <TimelineSlider {...CLOCK} defaultValue={48} />
        </div>
      ),
    },
    {
      id: "timeline-loading",
      title: "Timeline while frames load",
      node: (
        <div style={WIDE}>
          <TimelineSlider {...CLOCK} isLoading />
        </div>
      ),
    },
  ],
};
