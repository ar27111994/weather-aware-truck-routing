"""The plan use case: validate, deduplicate, route, read weather at each ETA, score, rank, store.

One request runs these stages, each timed in the structured log, inside a 25 second budget:

1. validate (departure window, trip length) and look for an identical plan made in the last 10
   minutes: an idempotent hit returns it untouched (HTTP 200 instead of 201);
2. under a per-request single-flight lease (concurrent identical requests compute once and share the
   result; nothing is held meanwhile), ask the routing chain for routes (route cache, 24 h);
3. per route: path, display geometry, checkpoints with ETAs and owned miles (``haulcast.domain``);
4. enforce the upstream-budget caps (route length, unique weather lattice points);
5. one weather fetch for every point, covering departure to the last arrival *and* the 49
   heatmap frames, so the heatmap later finds everything cached (D-19);
6. read the forecast at each checkpoint's ETA, assess it with the load, summarize and rank
   (domain functions, no risk math here);
7. persist the plan and answer.

Failures are problems (``ProblemError``): validation 422, routing and weather 502/503 with
``Retry-After`` when known. Nothing of the plan is stored on a failure, but the route and forecast
fills that succeeded before it stay in the caches (each is committed on its own: no transaction
spans the computation), so the retry that the problem invites recomputes from them instead of
asking the providers again. The whole request runs inside one wall-clock deadline
(:data:`REQUEST_BUDGET_S`) that every upstream call consults.
"""

import logging
import string
from collections.abc import Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Final

from haulcast.config.timeouts import PLAN_BUDGET_S
from haulcast.domain import (
    Assessment,
    Checkpoint,
    InvalidPathError,
    RiskRules,
    RouteCandidate,
    RoutePath,
    assess,
    build_path,
    haversine_mi,
    plan_checkpoints,
    rank_routes,
    sample_at,
    summarize,
)
from haulcast.problems import FieldError, ProblemCode, ProblemError
from haulcast.providers.deadline import deadline_scope
from haulcast.providers.routing.base import RouteOption, RoutingResult
from haulcast.providers.routing.diversity import TARGET_ROUTES
from haulcast.providers.weather.base import (
    HourlyForecast,
    HourWindow,
    LatticePoint,
    floor_hour,
    snap_to_lattice,
)
from haulcast.providers.weather.scenario import ScenarioWeatherProvider
from haulcast.providers.weather.scenarios import ScenarioCatalog
from haulcast.services.forecasts import hourly_series, local_zone
from haulcast.services.plan_assembly import (
    SCENARIO_NOTICE,
    ScoredRoute,
    assessment_notes,
    checkpoint_document,
    round_to_second,
    rounded_cumulative,
    route_document,
    scenario_anchor,
    sources_document,
    weather_gap_warning,
    whole_seconds,
)
from haulcast.services.plan_document import (
    HEATMAP_FRAME_COUNT,
    PlanDoc,
    RecommendationDoc,
    RequestDoc,
)
from haulcast.services.plan_geometry import DisplayGeometry, checkpoint_spans, simplify_path
from haulcast.services.plan_request import PlanRequest
from haulcast.services.plan_store import PLAN_TTL, Runtime, add_plan, find_recent, get_plan
from haulcast.services.routing import RoutingService
from haulcast.services.single_flight import FlightTimeoutError, Job, single_flight
from haulcast.services.weather import WeatherService

logger = logging.getLogger("haulcast.plans")

MAX_ROUTE_MI: Final = 3_000.0
"""Longest route a plan accepts (API-CONTRACT): longer trips are refused with ``route_too_long``."""

MAX_WEATHER_LOCATIONS: Final = 250
"""Unique 0.1 degree lattice points per plan (D-19), else ``too_many_checkpoints``."""

MIN_TRIP_MI: Final = 1.0
"""Origin and destination must be at least this far apart."""

REQUEST_BUDGET_S: Final = PLAN_BUDGET_S
"""Wall-clock budget of one plan request; a slower request is answered with a retryable 503."""

DEPARTURE_PAST_TOLERANCE: Final = timedelta(minutes=15)
DEPARTURE_HORIZON: Final = timedelta(hours=120)
SLOW_RETRY_AFTER_S: Final = 5.0
ROUTE_LETTERS: Final = string.ascii_uppercase[:TARGET_ROUTES]
"""Route ids in the provider's order: one letter for each route the routing chain may deliver."""
MAX_ROUTES: Final = len(ROUTE_LETTERS)
"""A plan carries at most this many routes. The chain stops at its own target (R2-21); this is the
plan's bound, so a provider that hands over more cannot grow the plan (T9 F-m7)."""

_HEATMAP_SPAN: Final = timedelta(hours=HEATMAP_FRAME_COUNT - 1)


@dataclass(frozen=True, slots=True)
class PlanOutcome:
    """A plan and whether this call created it (``False``: an identical recent plan was reused)."""

    document: PlanDoc
    created: bool


@dataclass(frozen=True, slots=True)
class _Prepared:
    """One routed option with its display geometry, checkpoints and weather lattice points."""

    route_id: str
    label: str
    option: RouteOption
    path: RoutePath
    display: DisplayGeometry
    checkpoints: tuple[Checkpoint, ...]
    points: tuple[LatticePoint, ...]


def _lattice_points(checkpoints: Sequence[Checkpoint]) -> tuple[LatticePoint, ...]:
    return tuple(snap_to_lattice(checkpoint.lat, checkpoint.lon) for checkpoint in checkpoints)


class PlanService:
    """Creates plans and serves stored ones."""

    def __init__(
        self,
        routing: RoutingService,
        weather: WeatherService,
        scenarios: ScenarioCatalog,
        rules: RiskRules,
        runtime: Runtime | None = None,
    ) -> None:
        """Wire the collaborators; ``runtime`` supplies the clock and the id source."""
        self._routing = routing
        self._weather = weather
        self._scenarios = scenarios
        self._rules = rules
        self._runtime = runtime if runtime is not None else Runtime()

    def get(self, plan_id: str) -> PlanDoc:
        """Return the stored plan.

        Raises:
            ProblemError: ``plan_not_found`` (404) when the id is unknown, malformed or expired.
        """
        row = get_plan(plan_id, self._runtime.clock())
        if row is None:
            raise ProblemError(
                ProblemCode.PLAN_NOT_FOUND, detail="No plan with this id exists, or it has expired."
            )
        return PlanDoc.model_validate(row.result)

    def create(self, request: PlanRequest) -> PlanOutcome:
        """Return the plan for ``request``: an identical recent one, or a newly computed one.

        Raises:
            ProblemError: validation (``departure_out_of_range``, ``same_origin_destination``,
                ``route_too_long``, ``too_many_checkpoints``, ``no_route_found``: 422), upstream
                trouble (``routing_unavailable``, ``weather_unavailable``,
                ``weather_capacity_exhausted``: 503/502) or a request that outlasted its budget.
        """
        started = self._runtime.monotonic()
        sent_departure = request.departure
        request = request.normalized()
        self._validate(request, sent_departure, self._runtime.clock())
        digest = request.request_hash
        reused = self._reuse(digest)
        if reused is not None:
            return PlanOutcome(reused, created=False)
        job = Job(
            probe=lambda: self._reused(digest),
            work=lambda: self._compute_and_store(request, digest, started),
        )
        try:
            with deadline_scope(REQUEST_BUDGET_S, clock=self._runtime.monotonic):
                return single_flight.run("plan", digest, job)
        except FlightTimeoutError as exc:
            raise ProblemError(
                ProblemCode.SERVICE_UNAVAILABLE,
                detail="An identical plan is still being computed; retry shortly.",
                retry_after_s=SLOW_RETRY_AFTER_S,
            ) from exc

    def _reused(self, digest: str) -> PlanOutcome | None:
        """Return the identical recent plan as a reuse, or ``None``."""
        reused = self._reuse(digest)
        return None if reused is None else PlanOutcome(reused, created=False)

    def _compute_and_store(self, request: PlanRequest, digest: str, started: float) -> PlanOutcome:
        """Compute the plan and store it; a refusal is raised.

        Nothing is rolled back by raising: the route and forecast fills this request paid for were
        each committed as they happened, so the retry that a 503 or a 422 invites finds them cached
        and does not ask the shared routers again.
        """
        created_at = self._runtime.clock().replace(microsecond=0)
        document = self._compute(request, created_at, started)
        add_plan(
            document.plan_id,
            digest,
            request.to_json(),
            document.model_dump(mode="json"),
            created_at,
        )
        return PlanOutcome(document, created=True)

    def _reuse(self, digest: str) -> PlanDoc | None:
        row = find_recent(digest, self._runtime.clock())
        return None if row is None else PlanDoc.model_validate(row.result)

    def _validate(self, request: PlanRequest, sent_departure: datetime, now: datetime) -> None:
        """Check what a schema cannot: the clock window and the distance between the places.

        The window is judged on the departure as the client sent it. Flooring it to its minute
        first would move both edges by up to 59 seconds (T9 F-m5).
        """
        if not now - DEPARTURE_PAST_TOLERANCE <= sent_departure <= now + DEPARTURE_HORIZON:
            message = "departure_time must be between 15 minutes ago and 120 hours from now"
            raise ProblemError(
                ProblemCode.DEPARTURE_OUT_OF_RANGE,
                detail=message,
                errors=[FieldError(("body", "departure_time"), message, "departure_out_of_range")],
            )
        miles = haversine_mi(
            (request.origin.lon, request.origin.lat),
            (request.destination.lon, request.destination.lat),
        )
        if miles < MIN_TRIP_MI:
            message = "origin and destination must be at least 1 mile apart"
            raise ProblemError(
                ProblemCode.SAME_ORIGIN_DESTINATION,
                detail=message,
                errors=[FieldError(("body", "destination"), message, "same_origin_destination")],
            )

    def _compute(self, request: PlanRequest, created_at: datetime, started: float) -> PlanDoc:
        with self._stage("routing", started):
            routing = self._routing.routes(
                (request.origin.lon, request.origin.lat),
                (request.destination.lon, request.destination.lat),
                request.load_weight_lb,
            )
        with self._stage("geometry", started):
            routes = self._prepare(routing, request)
            self._enforce_cap(routes, request)
        with self._stage("weather", started):
            forecasts = self._forecasts(routes, request)
        with self._stage("scoring", started):
            scored, assessments = self._score(routes, forecasts, request)
            ranking = rank_routes(
                [
                    RouteCandidate(
                        route_id=route.route_id,
                        duration_s=route.option.duration_s,
                        distance_mi=route.option.distance_mi,
                        stats=route.stats,
                        label=route.label,
                    )
                    for route in scored
                ],
                self._rules,
            )
        by_id = {route.route_id: route for route in scored}
        return PlanDoc(
            plan_id=self._runtime.new_id(created_at),
            created_at=created_at,
            expires_at=created_at + PLAN_TTL,
            request=RequestDoc.model_validate(request.to_json()),
            sources=sources_document(routing, request.scenario),
            routes=[
                route_document(
                    by_id[route_id],
                    departure=request.departure,
                    rank=position,
                    recommended=route_id == ranking.recommended_id,
                )
                for position, route_id in enumerate(ranking.order, start=1)
            ],
            recommendation=RecommendationDoc(
                route_id=ranking.recommended_id,
                status=ranking.status,
                decided_by=ranking.decided_by,
                rationale=list(ranking.rationale),
                warnings=list(ranking.warnings),
            ),
            warnings=self._warnings(routing, request, scored, assessments),
        )

    def _prepare(self, routing: RoutingResult, request: PlanRequest) -> list[_Prepared]:
        """Build every route's path, display geometry, checkpoints and lattice points."""
        prepared: list[_Prepared] = []
        for letter, option in zip(ROUTE_LETTERS, routing.routes[:MAX_ROUTES], strict=False):
            if option.distance_mi > MAX_ROUTE_MI:
                message = f"Route {letter} is {option.distance_mi:,.0f} mi; the limit is 3,000 mi"
                raise ProblemError(ProblemCode.ROUTE_TOO_LONG, detail=message)
            try:
                path = build_path(option.coords, option.cum_s, option.distance_mi)
                checkpoints = plan_checkpoints(
                    path, request.sampling_interval_mi, request.departure
                )
            except InvalidPathError as exc:
                raise ProblemError(
                    ProblemCode.ROUTING_UNAVAILABLE,
                    detail="The routing service returned an unusable route.",
                    status=502,
                ) from exc
            prepared.append(
                _Prepared(
                    route_id=letter,
                    label=f"Route {letter}",
                    option=option,
                    path=path,
                    display=simplify_path(path),
                    checkpoints=checkpoints,
                    points=_lattice_points(checkpoints),
                )
            )
        return prepared

    def _enforce_cap(self, routes: Sequence[_Prepared], request: PlanRequest) -> None:
        """Refuse a plan whose checkpoints need more than 250 distinct weather lookups (D-19)."""
        needed = len({point for route in routes for point in route.points})
        if needed <= MAX_WEATHER_LOCATIONS:
            return
        advice = self._advice(routes, request)
        message = (
            f"At a {request.sampling_interval_mi} mi interval this trip needs {needed} forecast "
            f"locations; the limit is {MAX_WEATHER_LOCATIONS}. {advice}"
        )
        raise ProblemError(
            ProblemCode.TOO_MANY_CHECKPOINTS,
            detail=message,
            errors=[FieldError(("body", "sampling_interval_mi"), message, "too_many_checkpoints")],
        )

    def _advice(self, routes: Sequence[_Prepared], request: PlanRequest) -> str:
        """Name the smallest larger interval that fits, or say that none does."""
        for interval in sorted(self._rules.sampling_intervals_mi):
            if interval <= request.sampling_interval_mi:
                continue
            fits = {
                point
                for route in routes
                for point in _lattice_points(
                    plan_checkpoints(route.path, interval, request.departure)
                )
            }
            if len(fits) <= MAX_WEATHER_LOCATIONS:
                return f"Use a {interval} mi checkpoint interval."
        return "This trip is too long to sample at any checkpoint interval."

    def _forecasts(
        self, routes: Sequence[_Prepared], request: PlanRequest
    ) -> Mapping[LatticePoint, HourlyForecast]:
        """Fetch one forecast per distinct point, covering the trip and the 49 heatmap frames."""
        points = list(dict.fromkeys(point for route in routes for point in route.points))
        first = floor_hour(request.departure)
        last = max(
            [first + _HEATMAP_SPAN, *(cp.eta for route in routes for cp in route.checkpoints)]
        )
        window = HourWindow.covering(first, last)
        if request.scenario is None:
            return self._weather.hourly(points, window)
        fastest = min(
            routes, key=lambda route: (whole_seconds(route.option.duration_s), route.route_id)
        )
        cumulative_mi, cumulative_s = rounded_cumulative(fastest.display)
        anchor = scenario_anchor(
            fastest.display.coords, cumulative_mi, cumulative_s, request.departure
        )
        provider = ScenarioWeatherProvider(self._scenarios.get(request.scenario), anchor)
        return provider.fetch(points, window)

    def _score(
        self,
        routes: Sequence[_Prepared],
        forecasts: Mapping[LatticePoint, HourlyForecast],
        request: PlanRequest,
    ) -> tuple[list[ScoredRoute], list[Assessment]]:
        """Read each forecast at its checkpoint's ETA, assess it and summarize every route."""
        series = {point: hourly_series(forecast) for point, forecast in forecasts.items()}
        scored: list[ScoredRoute] = []
        every_assessment: list[Assessment] = []
        for route in routes:
            spans = checkpoint_spans(
                route.display.cum_mi, [checkpoint.owned_mi for checkpoint in route.checkpoints]
            )
            documents = []
            assessments = []
            for checkpoint, point, span in zip(route.checkpoints, route.points, spans, strict=True):
                eta = round_to_second(checkpoint.eta)
                sample = sample_at(series[point], eta)
                assessment = assess(sample, request.load_weight_lb, self._rules)
                assessments.append(assessment)
                documents.append(
                    checkpoint_document(
                        checkpoint,
                        sample,
                        assessment,
                        span,
                        local_zone(checkpoint.lat, checkpoint.lon, eta),
                    )
                )
            every_assessment.extend(assessments)
            scored.append(
                ScoredRoute(
                    route_id=route.route_id,
                    label=route.label,
                    option=route.option,
                    display=route.display,
                    checkpoints=tuple(documents),
                    stats=summarize(route.checkpoints, assessments),
                )
            )
        return scored, every_assessment

    @staticmethod
    def _warnings(
        routing: RoutingResult,
        request: PlanRequest,
        scored: Sequence[ScoredRoute],
        assessments: Sequence[Assessment],
    ) -> list[str]:
        """Everything the traveller should know: provider notes, simulation, gaps, data quality."""
        warnings = [warning.message for warning in routing.warnings]
        if request.scenario is not None:
            warnings.append(SCENARIO_NOTICE)
        for route in scored:
            unknown = sum(1 for checkpoint in route.checkpoints if checkpoint.risk.level is None)
            if unknown:
                warnings.append(
                    weather_gap_warning(
                        route.label, unknown, len(route.checkpoints), route.stats.unknown_mi
                    )
                )
        return [*warnings, *assessment_notes(assessments)]

    @contextmanager
    def _stage(self, name: str, started: float) -> Iterator[None]:
        """Log the stage's duration, then refuse to go on when the request budget is spent."""
        begin = self._runtime.monotonic()
        try:
            yield
        finally:
            logger.info(
                "plan_stage",
                extra={
                    "event": f"plan_stage.{name}",
                    "latency_ms": round((self._runtime.monotonic() - begin) * 1000.0, 1),
                },
            )
        if self._runtime.monotonic() - started > REQUEST_BUDGET_S:
            raise ProblemError(
                ProblemCode.SERVICE_UNAVAILABLE,
                detail=f"The plan took too long to compute (after {name}); retry shortly.",
                retry_after_s=SLOW_RETRY_AFTER_S,
            )
