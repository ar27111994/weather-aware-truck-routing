"""Django's own system checks pass.

The test database is built with ``call_command("migrate")``, and ``call_command`` skips the system
checks. So a model Django rejects can leave the whole suite green while ``manage.py`` (the OpenAPI
export, ``migrate``, ``runserver``) refuses to start: the lease table once shipped an index name one
character over the limit (``models.E034``, 30 characters) and nothing noticed until the contract
check ran the management command. This test runs the checks the way ``manage.py`` does.
"""

from django.core.management import call_command


def test_django_finds_no_error_in_the_models_or_the_settings() -> None:
    call_command("check")  # raises SystemCheckError on any error
