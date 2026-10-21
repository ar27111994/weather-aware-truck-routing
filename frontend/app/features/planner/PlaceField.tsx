import type { ReactElement } from "react";

import { useGeocode } from "../../api/queries";
import type { GeocodeResult, PlanLocation } from "../../api/contract";
import { ComboBox, ComboBoxItem } from "../../design-system/components/ComboBox";
import { useDebouncedValue } from "./use-debounced-value";

/** How many recent places are listed when the empty field takes focus (DESIGN.md section 10). */
export const RECENT_SHOWN = 5;

/** One line of the list: the place to use if chosen, and how it reads. */
interface PlaceOption {
  readonly id: string;
  readonly title: string;
  readonly subtitle: string | undefined;
  readonly meta: string | undefined;
  readonly place: PlanLocation;
}

/** A geocoder hit: its name, then region and country, then its kind. */
export function optionFromResult(result: GeocodeResult): PlaceOption {
  const detail = [result.region, result.country]
    .filter((part): part is string => part !== null)
    .join(", ");
  return {
    id: result.id,
    title: result.name,
    subtitle: detail === "" ? undefined : detail,
    meta: result.kind,
    place: { lat: result.lat, lon: result.lon, label: result.label },
  };
}

/** A place used before: its label split into the name and the rest, as a hit would read. */
export function optionFromRecent(place: PlanLocation): PlaceOption {
  const comma = place.label.indexOf(", ");
  return {
    id: `recent:${place.label}|${String(place.lat)}|${String(place.lon)}`,
    title: comma < 0 ? place.label : place.label.slice(0, comma),
    subtitle: comma < 0 ? undefined : place.label.slice(comma + 2),
    meta: undefined,
    place,
  };
}

/** Props for {@link PlaceField}. */
export interface PlaceFieldProps {
  readonly label: string;
  readonly hint: string;
  readonly placeholder: string;
  /** What the input shows. A place counts as chosen only while this is exactly its label. */
  readonly text: string;
  readonly onText: (text: string) => void;
  /** Called with the place picked from the list, or `null` when the field is emptied. */
  readonly onPick: (place: PlanLocation | null) => void;
  /** Places used before, newest first. */
  readonly recent: readonly PlanLocation[];
  readonly errorMessage?: string | undefined;
}

/**
 * Origin or destination search (R1): suggestions come from the geocoder after a 250 ms pause and at
 * least two letters, the previous suggestions stay while the next load, and the places used before
 * are listed when the empty field takes focus. React Aria supplies the keyboard model (arrows, Enter,
 * Escape). The parent keeps the text and the chosen place and decides when a place still counts.
 */
export function PlaceField({
  label,
  hint,
  placeholder,
  text,
  onText,
  onPick,
  recent,
  errorMessage,
}: PlaceFieldProps): ReactElement {
  const query = useDebouncedValue(text);
  const geocode = useGeocode(query);
  const waiting = text.trim() !== query.trim() || geocode.isFetching;
  const results = (geocode.data?.results ?? []).map(optionFromResult);
  const recents = recent.slice(0, RECENT_SHOWN).map(optionFromRecent);
  return (
    <ComboBox
      label={label}
      description={hint}
      placeholder={placeholder}
      items={results}
      recentItems={recents}
      status={waiting ? "loading" : geocode.isError ? "error" : "idle"}
      onRetry={() => {
        void geocode.refetch();
      }}
      inputValue={text}
      onInputChange={onText}
      onChange={(key) => {
        const chosen = [...results, ...recents].find((option) => option.id === key);
        onPick(chosen?.place ?? null);
      }}
      isInvalid={errorMessage !== undefined}
      {...(errorMessage === undefined ? {} : { errorMessage })}
    >
      {(option) => (
        <ComboBoxItem
          id={option.id}
          textValue={option.place.label}
          title={option.title}
          subtitle={option.subtitle}
          meta={option.meta}
        />
      )}
    </ComboBox>
  );
}
