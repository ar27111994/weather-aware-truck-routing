#!/usr/bin/env python
"""Django's command-line utility for administrative tasks (migrate, check, runserver, ...)."""

import os
import sys

from django.core.management import execute_from_command_line


def main() -> None:
    """Run the requested management command against the Haulcast settings."""
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "haulcast.config.settings")
    execute_from_command_line(sys.argv)


if __name__ == "__main__":
    main()
