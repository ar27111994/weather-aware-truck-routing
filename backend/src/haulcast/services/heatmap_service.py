"""The heatmap use case: a 49-frame forecast field over the corridor, computed once per plan.

``HeatmapService.get`` answers from the stored heatmap; on the first request it computes it under a
per-plan single-flight lease (concurrent first requests compute once and share the result; nothing
is held meanwhile), stores it on the plan and answers. The field comes from the plan's own
geometry and request: the corridor grid
(``heatmap_grid``), one weather fetch for every cell centre over the plan's first 49 hours (cached
lattice lookups that checkpoints already filled are free, D-19), and per cell and frame the same
``sample_at`` and ``assess`` the plan used, with the plan's load. Frames start at the departure
hour: frame ``f`` is forecast hour ``f``.

Arrays are frame-major (``frame * len(cells) + cell``); ``risk`` is 0 to 4 or -1 (unknown);
the other fields are ``None`` where the forecast is unknown. Nothing is stored if the weather could
not be had: the next request tries again.
"""

from collections.abc import Mapping, Sequence
from datetime import timedelta
from typing import Final

from haulcast.config.timeouts import HEATMAP_BUDGET_S
from haulcast.domain import RiskRules, assess, sample_at
from haulcast.problems import ProblemCode, ProblemError
from haulcast.providers.deadline import deadline_scope
from haulcast.providers.weather.base import HourlyForecast, HourWindow, LatticePoint, floor_hour
from haulcast.providers.weather.scenario import ScenarioWeatherProvider
from haulcast.providers.weather.scenarios import ScenarioCatalog
from haulcast.services.forecasts import hourly_series
from haulcast.services.heatmap_grid import RouteLine, build_grid
from haulcast.services.plan_assembly import round_to_second, rounded, scenario_anchor
from haulcast.services.plan_document import (
    HEATMAP_FRAME_COUNT,
    HEATMAP_STEP_MINUTES,
    FieldsDoc,
    GridDoc,
    HeatmapDoc,
    PlanDoc,
)
from haulcast.services.plan_store import Runtime, get_plan, save_heatmap
from haulcast.services.single_flight import FlightTimeoutError, Job, single_flight
from haulcast.services.weather import WeatherService
from haulcast.store.models import Plan

SLOW_RETRY_AFTER_S: Final = 5.0
_GRID_DECIMALS: Final = 3


class HeatmapService:
    """Serves the heatmap of a stored plan, computing it on first use."""

    def __init__(
        self,
        weather: WeatherService,
        scenarios: ScenarioCatalog,
        rules: RiskRules,
        runtime: Runtime | None = None,
    ) -> None:
        """Wire the weather source, the scenarios, the rules and the clock."""
        self._weather = weather
        self._scenarios = scenarios
        self._rules = rules
        self._runtime = runtime if runtime is not None else Runtime()

    def get(self, plan_id: str) -> HeatmapDoc:
        """Return the heatmap of plan ``plan_id``.

        A refusal is simply raised: nothing in this flow needs to survive it, because its only
        fill is the weather service's, which commits each fill on its own and stores nothing
        unless every chunk of its fetch answered.

        Raises:
            ProblemError: ``plan_not_found`` (404) for an unknown, malformed or expired plan;
                ``weather_capacity_exhausted`` / ``weather_unavailable`` (503/502) when the
                forecast cannot be had; ``service_unavailable`` (503) when another request has
                been computing it for longer than this one may wait.
        """
        stored = self._stored(plan_id)
        if stored.heatmap is not None:
            return HeatmapDoc.model_validate(stored.heatmap)
        job = Job(probe=lambda: self._saved(plan_id), work=lambda: self._compute_and_save(plan_id))
        try:
            with deadline_scope(HEATMAP_BUDGET_S, clock=self._runtime.monotonic):
                return single_flight.run("heatmap", plan_id, job)
        except FlightTimeoutError as exc:
            raise ProblemError(
                ProblemCode.SERVICE_UNAVAILABLE,
                detail="The heatmap is still being computed; retry shortly.",
                retry_after_s=SLOW_RETRY_AFTER_S,
            ) from exc

    def _saved(self, plan_id: str) -> HeatmapDoc | None:
        """Return the heatmap another request stored meanwhile, or ``None``."""
        fresh = self._stored(plan_id)
        return None if fresh.heatmap is None else HeatmapDoc.model_validate(fresh.heatmap)

    def _compute_and_save(self, plan_id: str) -> HeatmapDoc:
        document = self._compute(PlanDoc.model_validate(self._stored(plan_id).result))
        save_heatmap(plan_id, document.model_dump(mode="json"))
        return document

    def _stored(self, plan_id: str) -> Plan:
        row = get_plan(plan_id, self._runtime.clock())
        if row is None:
            raise ProblemError(
                ProblemCode.PLAN_NOT_FOUND, detail="No plan with this id exists, or it has expired."
            )
        return row

    def _compute(self, plan: PlanDoc) -> HeatmapDoc:
        grid = build_grid(
            [
                RouteLine(
                    coords=tuple(route.geometry.coordinates), cum_mi=tuple(route.cumulative_mi)
                )
                for route in plan.routes
            ]
        )
        points = [grid.centre(index) for index in grid.cells]
        start = floor_hour(plan.request.departure_time)
        forecasts = self._forecasts(plan, points, HourWindow(start, HEATMAP_FRAME_COUNT))
        series = [hourly_series(forecasts[point]) for point in points]
        risk: list[int] = []
        wind: list[float | None] = []
        gust: list[float | None] = []
        rain: list[float | None] = []
        snow: list[float | None] = []
        for frame in range(HEATMAP_FRAME_COUNT):
            moment = start + timedelta(hours=frame)
            for cell_series in series:
                sample = sample_at(cell_series, moment)
                assessment = assess(sample, plan.request.load_weight_lb, self._rules)
                risk.append(-1 if assessment.level is None else int(assessment.level))
                wind.append(rounded(sample.wind_mph, 1))
                gust.append(rounded(sample.gust_mph, 1))
                rain.append(rounded(sample.rain_in_hr, 3))
                snow.append(rounded(sample.snow_in_hr, 3))
        return HeatmapDoc(
            plan_id=plan.plan_id,
            start_time=start,
            frame_count=HEATMAP_FRAME_COUNT,
            step_minutes=HEATMAP_STEP_MINUTES,
            grid=GridDoc(
                lat0=round(grid.lat0, _GRID_DECIMALS),
                lon0=round(grid.lon0, _GRID_DECIMALS),
                dlat=grid.dlat,
                dlon=grid.dlon,
                rows=grid.rows,
                cols=grid.cols,
            ),
            cells=list(grid.cells),
            fields=FieldsDoc(
                risk=risk, wind_mph=wind, gust_mph=gust, rain_in_hr=rain, snow_in_hr=snow
            ),
            load_weight_lb=plan.request.load_weight_lb,
            sources=plan.sources,
            generated_at=round_to_second(self._runtime.clock()),
        )

    def _forecasts(
        self, plan: PlanDoc, points: Sequence[LatticePoint], window: HourWindow
    ) -> Mapping[LatticePoint, HourlyForecast]:
        """One forecast per cell centre: real (cached, budget-guarded) or the plan's scenario."""
        if plan.request.scenario is None:
            return self._weather.hourly(points, window)
        fastest = min(plan.routes, key=lambda route: (route.duration_s, route.route_id))
        anchor = scenario_anchor(
            fastest.geometry.coordinates,
            fastest.cumulative_mi,
            fastest.cumulative_s,
            plan.request.departure_time,
        )
        provider = ScenarioWeatherProvider(self._scenarios.get(plan.request.scenario), anchor)
        return provider.fetch(points, window)
