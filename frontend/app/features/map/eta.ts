/**
 * Local clock text for map labels (D-16: the user's locale decides the hour cycle). The clock comes
 * from the checkpoint's numeric UTC offset, like `formatLocalTime`, so it is the same in every host
 * time zone; one formatter is built per locale and reused for every label of a plan.
 */
import type { Checkpoint } from "../../api/contract";

/** `checkpoint => "2:20 PM"` (en-US) or `"14:20"` (en-GB): the ETA at the checkpoint's own clock. */
export function createEtaLabel(locale?: string): (checkpoint: Checkpoint) => string {
  const clock = new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    hour: "numeric",
    minute: "2-digit",
  });
  return (checkpoint) => clock.format(Date.parse(checkpoint.eta) + checkpoint.utc_offset_s * 1000);
}
