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
    "RULES_SCHEMA_ID",
    "VARIABLE_SPECS",
    "Assessment",
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
    "RulesValidationError",
    "Semantics",
    "VariableSpec",
    "WeatherSample",
    "WindMetric",
    "assess",
    "classify",
    "is_valid_reading",
    "load_rules",
    "load_rules_file",
    "sample_at",
]
