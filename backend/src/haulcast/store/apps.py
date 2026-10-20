"""App configuration for the persistence layer."""

from django.apps import AppConfig


class StoreConfig(AppConfig):
    """Owns the ``app`` schema's models, migrations and row level security."""

    name = "haulcast.store"
    label = "store"
    default_auto_field = "django.db.models.BigAutoField"
