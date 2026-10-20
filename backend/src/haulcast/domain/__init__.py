"""Pure-Python risk, sampling and ranking domain: no Django, no I/O, no clock (domain card).

The public API mirrors DOMAIN-CONTRACT section 9; everything else is an implementation detail.
The only I/O is ``load_rules_file``, a thin reader in front of the pure ``load_rules``.
"""

from haulcast.domain.errors import (
    DomainError,
    InvalidAssessmentsError,
    InvalidCandidatesError,
    InvalidForecastError,
    InvalidIntervalError,
    InvalidLoadError,
    InvalidPathError,
    NaiveDatetimeError,
    RulesValidationError,
)
from haulcast.domain.forecast import (
    VARIABLE_SPECS,
    HourlySeries,
    Semantics,
    VariableSpec,
    WeatherSample,
    sample_at,
)
from haulcast.domain.geometry import (
    EARTH_RADIUS_MI,
    Coordinate,
    RoutePath,
    build_path,
    haversine_mi,
    locate,
)
from haulcast.domain.levels import Factor, RiskLevel, WindMetric
from haulcast.domain.risk import Assessment, assess, classify, is_valid_reading
from haulcast.domain.rules import (
    RULES_SCHEMA_ID,
    FactorRules,
    LoadRule,
    RankingRules,
    RiskRules,
    load_rules,
    load_rules_file,
)
from haulcast.domain.sampling import CHECKPOINT_EPSILON_MI, Checkpoint, plan_checkpoints
from haulcast.domain.scoring import (
    DecidedBy,
    Ranking,
    RankingKey,
    RouteCandidate,
    RouteRiskStats,
    RouteStatus,
    is_low_coverage,
    rank_routes,
    ranking_key,
    summarize,
)

__all__ = [
    "CHECKPOINT_EPSILON_MI",
    "EARTH_RADIUS_MI",
    "RULES_SCHEMA_ID",
    "VARIABLE_SPECS",
    "Assessment",
    "Checkpoint",
    "Coordinate",
    "DecidedBy",
    "DomainError",
    "Factor",
    "FactorRules",
    "HourlySeries",
    "InvalidAssessmentsError",
    "InvalidCandidatesError",
    "InvalidForecastError",
    "InvalidIntervalError",
    "InvalidLoadError",
    "InvalidPathError",
    "LoadRule",
    "NaiveDatetimeError",
    "Ranking",
    "RankingKey",
    "RankingRules",
    "RiskLevel",
    "RiskRules",
    "RouteCandidate",
    "RoutePath",
    "RouteRiskStats",
    "RouteStatus",
    "RulesValidationError",
    "Semantics",
    "VariableSpec",
    "WeatherSample",
    "WindMetric",
    "assess",
    "build_path",
    "classify",
    "haversine_mi",
    "is_low_coverage",
    "is_valid_reading",
    "load_rules",
    "load_rules_file",
    "locate",
    "plan_checkpoints",
    "rank_routes",
    "ranking_key",
    "sample_at",
    "summarize",
]
