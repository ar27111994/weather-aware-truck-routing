import { SAMPLING_INTERVALS_MI, type SamplingIntervalMi } from "../../api/contract";
import { DEFAULT_SAMPLING_INTERVAL_MI } from "../../lib/risk";

/** The interval a segmented control's value names; the default for a value that names none. */
export function intervalFromValue(value: string): SamplingIntervalMi {
  return (
    SAMPLING_INTERVALS_MI.find((interval) => String(interval) === value) ??
    DEFAULT_SAMPLING_INTERVAL_MI
  );
}
