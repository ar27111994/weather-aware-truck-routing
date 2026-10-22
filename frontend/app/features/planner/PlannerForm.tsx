import { ArrowUpDown } from "lucide-react";
import { useEffect, useRef, useState, type ReactElement, type SyntheticEvent } from "react";

import type { PlanRequest } from "../../api/contract";
import { useScenarios } from "../../api/queries";
import { Button } from "../../design-system/components/Button";
import { IconButton } from "../../design-system/components/IconButton";
import { Select, SelectItem, type SelectStatus } from "../../design-system/components/Select";
import { Segmented } from "../../design-system/components/Segmented";
import { SAMPLING_INTERVALS_MI } from "../../api/contract";
import { t } from "../../design-system/foundation/strings";
import type { Clock } from "./departure";
import { DepartureField } from "./DepartureField";
import { intervalFromValue } from "./intervals";
import { LoadField } from "./LoadField";
import { PlaceField } from "./PlaceField";
import styles from "./PlannerForm.module.css";
import { useRecentPlaces } from "./recent-places";
import type { PlannerFormState } from "./usePlannerForm";

/** The key of the "live forecast" option: a scenario id is never this, and `null` is not a key. */
const LIVE = "live";

/** The first control with an error, in page order: where the keyboard goes after a refused submit. */
const FIRST_INVALID = 'input[aria-invalid="true"], [role="spinbutton"][aria-invalid="true"]';

/** Props for {@link PlannerForm}. */
export interface PlannerFormProps {
  readonly form: PlannerFormState;
  /** The visitor's clock; `null` on the prerendered page. */
  readonly clock: Clock | null;
  /** A plan request is in flight: the button shows it and presses are ignored. */
  readonly isSubmitting: boolean;
  /** Called with the request when the trip is valid. */
  readonly onSubmit: (request: PlanRequest) => void;
}

/**
 * The trip form (R1, R14): origin and destination search with a swap button, departure date and
 * time with chips, load weight, checkpoint interval, the weather source, and Plan routes. Nothing
 * reaches the API until the same rules the server applies pass; a refused submit marks every field
 * that is wrong, each message tied to its field, and moves the keyboard to the first one.
 *
 * While the planner's code is on the way, the page's gate marks the prerendered form `aria-busy`
 * when the visitor uses it (intent.ts). That attribute is not in the markup the server drew, so the
 * form says that it may differ (`suppressHydrationWarning`): React's development build would
 * otherwise report it at hydration.
 */
export function PlannerForm({
  form,
  clock,
  isSubmitting,
  onSubmit,
}: PlannerFormProps): ReactElement {
  const recent = useRecentPlaces();
  const scenarios = useScenarios();
  const element = useRef<HTMLFormElement>(null);
  const [refused, setRefused] = useState(0);

  // After a refused submit the errors are on screen; the first wrong field takes the focus.
  useEffect(() => {
    if (refused === 0) return;
    element.current?.querySelector<HTMLElement>(FIRST_INVALID)?.focus();
  }, [refused]);

  const scenarioStatus: SelectStatus = scenarios.isPending
    ? "loading"
    : scenarios.isError
      ? "error"
      : "idle";
  const options = [
    { id: LIVE, name: t("form.scenario.live"), description: undefined },
    ...(scenarios.data ?? []).map((scenario) => ({
      id: scenario.id,
      name: scenario.name,
      description: scenario.description,
    })),
  ];

  const submit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const request = form.submit();
    if (request === null) {
      setRefused((count) => count + 1);
    } else {
      onSubmit(request);
    }
  };

  return (
    <form
      ref={element}
      noValidate
      onSubmit={submit}
      className={styles.form}
      suppressHydrationWarning
    >
      <PlaceField
        label={t("form.origin.label")}
        hint={t("form.origin.hint")}
        placeholder={t("form.origin.placeholder")}
        text={form.origin.text}
        onText={form.setOriginText}
        onPick={(place) => {
          form.pickOrigin(place);
          if (place !== null) recent.remember(place);
        }}
        recent={recent.places}
        errorMessage={form.errors.origin}
      />
      <div className={styles.swap}>
        <IconButton
          icon={ArrowUpDown}
          label={t("form.swap")}
          variant="secondary"
          onPress={form.swapPlaces}
        />
      </div>
      <PlaceField
        label={t("form.destination.label")}
        hint={t("form.destination.hint")}
        placeholder={t("form.destination.placeholder")}
        text={form.destination.text}
        onText={form.setDestinationText}
        onPick={(place) => {
          form.pickDestination(place);
          if (place !== null) recent.remember(place);
        }}
        recent={recent.places}
        errorMessage={form.errors.destination}
      />
      <DepartureField
        value={form.departure}
        onChange={form.setDeparture}
        clock={clock}
        errorMessage={form.errors.departure}
      />
      <LoadField value={form.load} onChange={form.setLoad} errorMessage={form.errors.load} />
      <div className={styles.interval}>
        <span className={styles.intervalLabel}>{t("form.interval.label")}</span>
        <Segmented
          label={t("form.interval.label")}
          items={SAMPLING_INTERVALS_MI.map((interval) => ({
            id: String(interval),
            label: t("form.interval.option", { n: interval }),
          }))}
          value={String(form.interval)}
          onChange={(value) => {
            form.setInterval(intervalFromValue(value));
          }}
        />
        <p className={styles.hint}>{t("form.interval.hint")}</p>
        {form.errors.interval === undefined ? null : (
          <p className={styles.error}>{form.errors.interval}</p>
        )}
      </div>
      <Select
        label={t("form.scenario.label")}
        description={t("form.scenario.hint")}
        items={options}
        value={form.scenario ?? LIVE}
        onChange={(key) => {
          form.setScenario(key === LIVE || key === null ? null : String(key));
        }}
        status={scenarioStatus}
        loadingMessage={t("form.scenario.loading")}
        unavailableMessage={t("form.scenario.unavailable")}
      >
        {(option) => (
          <SelectItem id={option.id} textValue={option.name} description={option.description}>
            {option.name}
          </SelectItem>
        )}
      </Select>
      <Button
        type="submit"
        variant="primary"
        size="lg"
        isLoading={isSubmitting}
        loadingLabel={t("form.submitting")}
      >
        {t("form.submit")}
      </Button>
    </form>
  );
}
