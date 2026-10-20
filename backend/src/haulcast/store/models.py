"""Models of the ``app`` schema: caches, stored plans, and the rate-limit / upstream-budget buckets.

Tables are declared with plain unqualified names (``db_table = "geocode_cache"``): the
``haulcast_owner`` and ``haulcast_app`` roles carry ``search_path = app`` (set by
``backend/scripts/bootstrap_db.py``), so Django's unqualified SQL lands in schema ``app`` with no
schema-quoting tricks. Every lookup key is unique and every TTL table has a btree index on
``expires_at``; row level security and the grants live in the SQL migrations that follow.

Timestamps that the database owns (``created_at`` / ``fetched_at``) use ``db_default=Now()``;
expiry times are always computed by the application so they follow its injectable clock.
"""

from django.db import models
from django.db.models.functions import Now


class GeocodeCache(models.Model):
    """A geocoding answer for one normalised query (30 days)."""

    key = models.CharField(max_length=200, unique=True)
    payload = models.JSONField()
    provider = models.CharField(max_length=40)
    created_at = models.DateTimeField(db_default=Now())
    expires_at = models.DateTimeField()

    class Meta:
        """Table name and TTL index."""

        db_table = "geocode_cache"
        indexes = (models.Index(fields=["expires_at"], name="geocode_cache_expires_idx"),)

    def __str__(self) -> str:
        """Return the cache key."""
        return self.key


class RouteCache(models.Model):
    """The routes a provider returned for one trip (24 hours)."""

    key = models.CharField(max_length=200, unique=True)
    payload = models.JSONField()
    provider = models.CharField(max_length=40)
    created_at = models.DateTimeField(db_default=Now())
    expires_at = models.DateTimeField()

    class Meta:
        """Table name and TTL index."""

        db_table = "route_cache"
        indexes = (models.Index(fields=["expires_at"], name="route_cache_expires_idx"),)

    def __str__(self) -> str:
        """Return the cache key."""
        return self.key


class WeatherCache(models.Model):
    """Hourly forecast of one 0.1 degree lattice point for one window (60 minutes).

    One row per (location, model, variable set, window start): plans departing in the same hour
    share rows, and a plan needing a longer window than the cached one simply replaces the row.
    ``payload`` is :meth:`haulcast.providers.weather.base.HourlyForecast.to_payload`.
    """

    location_key = models.CharField(max_length=16)
    model = models.CharField(max_length=40)
    variables_hash = models.CharField(max_length=16)
    window_start = models.DateTimeField()
    hours = models.PositiveSmallIntegerField()
    payload = models.JSONField()
    fetched_at = models.DateTimeField(db_default=Now())
    expires_at = models.DateTimeField()

    class Meta:
        """Table name, the unique lookup key and the TTL index."""

        db_table = "weather_cache"
        constraints = (
            models.UniqueConstraint(
                fields=["location_key", "model", "variables_hash", "window_start"],
                name="weather_cache_lookup_uniq",
            ),
        )
        indexes = (models.Index(fields=["expires_at"], name="weather_cache_expires_idx"),)

    def __str__(self) -> str:
        """Return a readable identity of the cached forecast."""
        return f"{self.model} {self.location_key} @ {self.window_start:%Y-%m-%dT%H}"


class Plan(models.Model):
    """A computed plan, addressable by an unguessable id (``pln_`` + ULID) for 7 days."""

    id = models.CharField(max_length=30, primary_key=True)
    request_hash = models.CharField(max_length=64)
    request = models.JSONField()
    result = models.JSONField()
    heatmap = models.JSONField(null=True)
    created_at = models.DateTimeField(db_default=Now())
    expires_at = models.DateTimeField()

    class Meta:
        """Table name, the idempotency lookup index and the TTL index."""

        db_table = "plan"
        indexes = (
            models.Index(fields=["request_hash", "created_at"], name="plan_request_hash_idx"),
            models.Index(fields=["expires_at"], name="plan_expires_idx"),
        )

    def __str__(self) -> str:
        """Return the plan id."""
        return self.id


class RateLimitBucket(models.Model):
    """GCRA state of one per-client bucket; ``key`` embeds an HMAC of the client IP, not the IP."""

    key = models.CharField(max_length=120, primary_key=True)
    tat = models.DateTimeField()
    last_allowed = models.BooleanField()
    updated_at = models.DateTimeField()
    expires_at = models.DateTimeField()

    class Meta:
        """Table name and TTL index."""

        db_table = "rate_limit_bucket"
        indexes = (models.Index(fields=["expires_at"], name="rate_limit_bucket_expires_idx"),)

    def __str__(self) -> str:
        """Return the bucket key."""
        return self.key


class UpstreamBudget(models.Model):
    """GCRA state of one global upstream budget bucket (for example Open-Meteo calls per minute)."""

    key = models.CharField(max_length=120, primary_key=True)
    tat = models.DateTimeField()
    last_allowed = models.BooleanField()
    updated_at = models.DateTimeField()
    expires_at = models.DateTimeField()

    class Meta:
        """Table name and TTL index."""

        db_table = "upstream_budget"
        indexes = (models.Index(fields=["expires_at"], name="upstream_budget_expires_idx"),)

    def __str__(self) -> str:
        """Return the bucket key."""
        return self.key


class SingleFlightLease(models.Model):
    """Who is computing something right now, and until when.

    A *lease*, not a lock: a row says "``holder`` leads the work named ``key`` until
    ``expires_at``". Nothing is held while the work runs (no transaction, no lock, no pooled
    connection), a leader that dies merely lets its lease expire, and the row is deleted when the
    work ends. ``key`` is a short digest (see ``haulcast.services.single_flight``).
    """

    key = models.CharField(max_length=64, primary_key=True)
    holder = models.CharField(max_length=32)
    expires_at = models.DateTimeField()

    class Meta:
        """Table name and TTL index."""

        db_table = "single_flight_lease"
        indexes = (models.Index(fields=["expires_at"], name="single_flight_lease_expires_idx"),)

    def __str__(self) -> str:
        """Return the lease key."""
        return self.key
