"""App configuration for the persistence layer."""

from django.apps import AppConfig


class StoreConfig(AppConfig):
    """Placeholder app that owns the ``app`` schema's models and migrations."""

    name = "haulcast.store"
    label = "store"
    default_auto_field = "django.db.models.BigAutoField"
