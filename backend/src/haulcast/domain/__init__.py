"""Pure-Python risk, sampling and ranking domain: no Django, no I/O, no clock (domain card).

The public API mirrors DOMAIN-CONTRACT section 9; everything else is an implementation detail.
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

__all__ = [
    "EARTH_RADIUS_MI",
    "RULES_SCHEMA_ID",
    "VARIABLE_SPECS",
    "Assessment",
    "Coordinate",
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
    "RankingRules",
    "RiskLevel",
    "RiskRules",
    "RoutePath",
    "RulesValidationError",
    "Semantics",
    "VariableSpec",
    "WeatherSample",
    "WindMetric",
    "assess",
    "build_path",
    "classify",
    "haversine_mi",
    "is_valid_reading",
    "load_rules",
    "load_rules_file",
    "locate",
    "sample_at",
]
