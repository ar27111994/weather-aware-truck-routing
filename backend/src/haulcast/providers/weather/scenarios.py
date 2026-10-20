"""Demo weather scenarios: the validated document format, its JSON Schema and the catalog.

A scenario is deterministic *synthetic* weather that makes the risk and recommendation logic
demonstrable on a calm day and powers deterministic end-to-end tests (``GET /api/v1/scenarios``;
the UI always labels it "Simulated weather - not a forecast"). It is a JSON document in
``shared/scenarios/<id>.json`` with a *baseline* (the conditions everywhere) and up to eight
*storm cells* placed **relative to the trip's fastest route**, so every scenario demonstrates the
logic on any origin and destination:

* a cell is centred at ``fraction`` of the fastest route's length, with a ``radius_mi`` beyond
  which it has no effect and an inner ``core_fraction`` of that radius with full effect;
* its ``window`` is measured in hours **relative to the ETA at that anchor point**, so the storm
  meets the truck wherever and whenever it passes; ``ramp_h`` is the linear fade-in and fade-out;
* ``peak`` is what the core looks like at full intensity; ``motion`` (optional) drifts the cell.

How cells are evaluated at a place and hour is :mod:`haulcast.providers.weather.scenario`; this
module only owns the format. Documents are validated strictly: unknown keys are refused, nothing is
coerced (``"9.0"`` is not a number), numbers must be finite and inside documented limits. The JSON
Schema generated from the models is checked in next to the scenarios
(``shared/scenarios/scenario.schema.json``) and a test keeps the two in step.

Error messages name the offending file and the place in the document but never echo the file's
content (a scenario directory is trusted configuration, yet a stray secret in a broken file must
not end up in logs).
"""

import json
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Final, Self

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    ValidationError,
    model_validator,
)
from pydantic.json_schema import JsonSchemaValue
from pydantic_core import ErrorDetails

from haulcast.config.paths import shared_dir

JSON_SCHEMA_DIALECT: Final = "https://json-schema.org/draft/2020-12/schema"
SCHEMA_FILE_NAME: Final = "scenario.schema.json"
SCENARIOS_DIRECTORY: Final = "scenarios"
MAX_CELLS: Final = 8
"""More cells than this make a scenario hard to reason about and slow to evaluate."""

_MAX_REPORTED_PROBLEMS: Final = 5
_MAX_SHOWN_ID_CHARS: Final = 40
_SLUG_PATTERN: Final = r"^[a-z0-9]+(-[a-z0-9]+)*$"
_NAME_PATTERN: Final = r"^(?:\S|\S[^\x00-\x1f\x7f]*\S)$"
"""Single line, no control characters, no leading or trailing whitespace."""
_TEXT_PATTERN: Final = r"^\S(?:[\s\S]*\S)?$"
"""No leading or trailing whitespace; newlines inside are fine (paragraphs)."""

Slug = Annotated[str, StringConstraints(pattern=_SLUG_PATTERN, max_length=48)]
Name = Annotated[str, StringConstraints(min_length=1, max_length=80, pattern=_NAME_PATTERN)]
Description = Annotated[str, StringConstraints(min_length=1, max_length=600, pattern=_TEXT_PATTERN)]


class _Model(BaseModel):
    """Immutable, strict, closed: the shared configuration of every document model."""

    model_config = ConfigDict(frozen=True, extra="forbid", strict=True)


class Conditions(_Model):
    """Weather at one place and hour, in the units of the API (mph, inches per hour, deg F)."""

    wind_mph: float = Field(
        ge=0, le=200, allow_inf_nan=False, description="Sustained 10 m wind speed in mph."
    )
    gust_mph: float = Field(
        ge=0,
        le=300,
        allow_inf_nan=False,
        description="Wind gust in mph; never below wind_mph.",
    )
    rain_in_hr: float = Field(
        ge=0, le=10, allow_inf_nan=False, description="Liquid precipitation rate in inches/hour."
    )
    snow_in_hr: float = Field(
        ge=0, le=10, allow_inf_nan=False, description="Snowfall rate in inches/hour."
    )
    temperature_f: float = Field(
        ge=-60, le=130, allow_inf_nan=False, description="Air temperature in degrees Fahrenheit."
    )
    weather_code: int = Field(
        ge=0, le=99, description="WMO weather interpretation code (0 clear ... 99 thunderstorm)."
    )

    @model_validator(mode="after")
    def _gust_is_not_below_the_wind(self) -> Self:
        if self.gust_mph < self.wind_mph:
            raise ValueError("gust_mph must be at least wind_mph")
        return self


class ActiveWindow(_Model):
    """When a cell is active, in hours relative to the ETA at the cell's anchor point."""

    start_offset_h: float = Field(
        ge=-168,
        le=168,
        allow_inf_nan=False,
        description="Hours from the anchor ETA until the cell starts to build (may be negative).",
    )
    end_offset_h: float = Field(
        ge=-168,
        le=168,
        allow_inf_nan=False,
        description="Hours from the anchor ETA until the cell has fully gone; after the start.",
    )
    ramp_h: float = Field(
        ge=0,
        le=168,
        allow_inf_nan=False,
        description=(
            "Length of the linear build-up after the start and of the linear fade-out before "
            "the end, in hours; at most half of the window."
        ),
    )

    @model_validator(mode="after")
    def _runs_forwards_with_ramps_that_fit(self) -> Self:
        if self.end_offset_h <= self.start_offset_h:
            raise ValueError("end_offset_h must be after start_offset_h")
        if self.ramp_h > (self.end_offset_h - self.start_offset_h) / 2:
            raise ValueError("ramp_h must be at most half of the window")
        return self


class Motion(_Model):
    """Drift of a cell: it moves from its anchor position from the start of its window."""

    bearing_deg: float = Field(
        ge=0,
        le=360,
        allow_inf_nan=False,
        description="Direction of travel in degrees clockwise from north.",
    )
    speed_mph: float = Field(
        ge=0, le=120, allow_inf_nan=False, description="Speed of the cell's centre in mph."
    )


class StormCell(_Model):
    """A circular patch of weather anchored on the trip's fastest route."""

    id: Slug = Field(description="Identifier, unique within the scenario.")
    fraction: float = Field(
        ge=0,
        le=1,
        allow_inf_nan=False,
        description="Anchor position along the fastest route: 0 is the origin, 1 the destination.",
    )
    radius_mi: float = Field(
        gt=0,
        le=400,
        allow_inf_nan=False,
        description="Distance from the centre, in miles, beyond which the cell has no effect.",
    )
    core_fraction: float = Field(
        ge=0,
        lt=1,
        allow_inf_nan=False,
        description=(
            "Share of the radius that has full effect; the effect then falls off linearly to "
            "nothing at the radius."
        ),
    )
    window: ActiveWindow
    peak: Conditions = Field(description="Conditions at the core at full intensity.")
    motion: Motion | None = Field(default=None, description="Drift; absent means stationary.")


class Scenario(_Model):
    """One demo scenario: baseline conditions everywhere plus storm cells on the fastest route."""

    id: Slug = Field(description="Identifier used by the API; equals the file name stem.")
    name: Name = Field(description="Short title shown in the scenario picker.")
    description: Description = Field(description="What the scenario demonstrates (plain text).")
    sort_order: int = Field(ge=0, le=10_000, description="Position in the picker, ascending.")
    baseline: Conditions = Field(description="Conditions everywhere outside every cell.")
    cells: tuple[StormCell, ...] = Field(
        max_length=MAX_CELLS, description="Storm cells; none means calm everywhere."
    )

    @model_validator(mode="after")
    def _cell_ids_are_unique(self) -> Self:
        seen: set[str] = set()
        for cell in self.cells:
            if cell.id in seen:
                raise ValueError(f"duplicate cell id {cell.id!r}")
            seen.add(cell.id)
        return self


@dataclass(frozen=True, slots=True)
class ScenarioSummary:
    """What a scenario picker needs: the identifier and the words."""

    id: str
    name: str
    description: str


class ScenarioFileError(ValueError):
    """A scenario file (or the directory holding them) is unusable; the message names the file."""

    def __init__(self, file_name: str, problem: str) -> None:
        """Record the offending ``file_name`` and a ``problem`` that never echoes file content."""
        super().__init__(f"{file_name}: {problem}")
        self.file_name = file_name


class UnknownScenarioError(KeyError):
    """The requested scenario id is not in the catalog."""

    def __init__(self, scenario_id: str) -> None:
        """Remember the unknown ``scenario_id`` (kept short and escaped in the message)."""
        super().__init__(scenario_id)
        self.scenario_id = scenario_id

    def __str__(self) -> str:
        """Return ``unknown scenario 'id'`` with the id truncated and escaped."""
        shown = repr(self.scenario_id[:_MAX_SHOWN_ID_CHARS])
        more = "..." if len(self.scenario_id) > _MAX_SHOWN_ID_CHARS else ""
        return f"unknown scenario {shown}{more}"


def scenario_json_schema() -> JsonSchemaValue:
    """Return the JSON Schema (draft 2020-12) of a scenario document."""
    return {"$schema": JSON_SCHEMA_DIALECT, **Scenario.model_json_schema()}


def write_json_schema(path: Path) -> None:
    """Write :func:`scenario_json_schema` as canonical JSON: sorted keys, LF, trailing newline."""
    text = json.dumps(scenario_json_schema(), indent=2, sort_keys=True, ensure_ascii=False)
    path.write_text(text + "\n", encoding="utf-8", newline="\n")


def _location(error: ErrorDetails) -> str:
    """Return the dotted place of a validation error; an unknown key's name is never shown."""
    parts = [str(part) for part in error["loc"]]
    if error["type"] == "extra_forbidden" and parts:
        parts[-1] = "<unknown key>"
    return ".".join(parts) or "<file>"


def _describe(error: ValidationError) -> str:
    """Summarise a validation failure: at most five problems, then how many more there were."""
    problems = [f"{_location(item)}: {item['msg']}" for item in error.errors()]
    shown = problems[:_MAX_REPORTED_PROBLEMS]
    if len(problems) > _MAX_REPORTED_PROBLEMS:
        shown.append(f"(and {len(problems) - _MAX_REPORTED_PROBLEMS} more)")
    return "; ".join(shown)


def _read(path: Path) -> Scenario:
    """Read and validate one scenario file; failures name the file and hide its content."""
    try:
        raw = path.read_bytes()
    except OSError as exc:
        raise ScenarioFileError(path.name, "cannot be read") from exc
    try:
        return Scenario.model_validate_json(raw.decode("utf-8"))
    except UnicodeDecodeError:
        raise ScenarioFileError(path.name, "<file>: is not valid UTF-8") from None
    except ValidationError as exc:
        raise ScenarioFileError(path.name, _describe(exc)) from None


class ScenarioCatalog:
    """The available scenarios, ordered by ``sort_order`` then ``id``, looked up by id."""

    def __init__(self, scenarios: Iterable[Scenario]) -> None:
        """Index ``scenarios``; ids must be unique.

        Raises:
            ValueError: two scenarios share an id.
        """
        ordered = sorted(scenarios, key=lambda item: (item.sort_order, item.id))
        by_id = {item.id: item for item in ordered}
        if len(by_id) != len(ordered):
            raise ValueError("scenario ids must be unique")
        self._ordered = tuple(ordered)
        self._by_id = by_id

    @classmethod
    def load(cls, directory: Path | None = None) -> Self:
        """Load every ``*.json`` scenario of ``directory`` (default ``shared/scenarios``).

        The schema file and files that are not ``*.json`` are ignored.

        Raises:
            ScenarioFileError: the directory is missing, a file cannot be read or is invalid, or
                two files define the same id (the message names the second file and the first).
        """
        folder = directory if directory is not None else shared_dir() / SCENARIOS_DIRECTORY
        if not folder.is_dir():
            raise ScenarioFileError(folder.name, "not a directory")
        first_file: dict[str, str] = {}
        scenarios: list[Scenario] = []
        for path in sorted(folder.iterdir(), key=lambda entry: entry.name):
            if path.suffix != ".json" or path.name == SCHEMA_FILE_NAME:
                continue
            scenario = _read(path)
            if scenario.id in first_file:
                raise ScenarioFileError(
                    path.name,
                    f"duplicate scenario id {scenario.id!r} (also defined in "
                    f"{first_file[scenario.id]})",
                )
            first_file[scenario.id] = path.name
            scenarios.append(scenario)
        return cls(scenarios)

    def all(self) -> tuple[Scenario, ...]:
        """Return every scenario in catalog order."""
        return self._ordered

    def summaries(self) -> tuple[ScenarioSummary, ...]:
        """Return what a picker needs for every scenario, in catalog order."""
        return tuple(
            ScenarioSummary(item.id, item.name, item.description) for item in self._ordered
        )

    def get(self, scenario_id: str) -> Scenario:
        """Return the scenario with ``scenario_id``.

        Raises:
            UnknownScenarioError: there is no such scenario.
        """
        try:
            return self._by_id[scenario_id]
        except KeyError:
            raise UnknownScenarioError(scenario_id) from None
