"""Risk levels, weather factors and the wind-metric switch (DOMAIN-CONTRACT sections 1-3)."""

from enum import IntEnum, StrEnum
from typing import Self


class RiskLevel(IntEnum):
    """Ordinal risk level. Missing data is not a level: it is ``None`` (UNKNOWN), never ``LOW``."""

    LOW = 0
    MODERATE = 1
    HIGH = 2
    SEVERE = 3
    NO_TRAVEL = 4

    @property
    def id(self) -> str:
        """The level's identifier in ``shared/risk-rules.json`` and the API (``"no_travel"``)."""
        return self.name.lower()

    @classmethod
    def from_id(cls, level_id: str) -> Self:
        """Return the level whose identifier is ``level_id`` (``KeyError`` when there is none)."""
        return cls[level_id.upper()]


class Factor(StrEnum):
    """A weather factor that is classified on its own scale (DOMAIN-CONTRACT section 3)."""

    WIND = "wind"
    RAIN = "rain"
    SNOW = "snow"


class WindMetric(StrEnum):
    """Which wind value classifies the wind factor (``factors.wind.metric`` in the rules file).

    ``SUSTAINED`` (the default) uses the 10 m sustained speed, ``GUST`` the preceding-hour peak
    gust, and ``MAX`` the higher of the two.
    """

    SUSTAINED = "sustained"
    GUST = "gust"
    MAX = "max"
