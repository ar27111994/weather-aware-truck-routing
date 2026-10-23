"""Locations of the cross-stack files that live outside the Python package (``shared/``)."""

import os
from pathlib import Path
from typing import Final

SHARED_DIR_VARIABLE: Final = "HAULCAST_SHARED_DIR"
"""Environment variable that overrides the location of the repository's ``shared/`` directory."""

_REPOSITORY_ROOT_DEPTH: Final = 4
"""``backend/src/haulcast/config/paths.py`` -> the repository root is four parents up."""

_REPLAY_DIR_PARTS: Final = ("backend", "tests", "fixtures", "providers")
"""Where the repository keeps the recorded provider answers, below its root."""


def default_replay_dir() -> Path:
    """Return the repository's recorded provider fixtures: the replay catalog unless one is named.

    The fixtures live with the tests and are not part of a deployment (``vercel.json`` leaves
    ``tests`` out of the function), which is one more reason a deployed environment never replays.
    """
    return Path(__file__).resolve().parents[_REPOSITORY_ROOT_DEPTH].joinpath(*_REPLAY_DIR_PARTS)


def shared_dir(environ: dict[str, str] | None = None) -> Path:
    """Return the ``shared/`` directory: ``HAULCAST_SHARED_DIR`` if set, else the repository's."""
    value = (os.environ if environ is None else environ).get(SHARED_DIR_VARIABLE, "").strip()
    if value:
        return Path(value)
    return Path(__file__).resolve().parents[_REPOSITORY_ROOT_DEPTH] / "shared"
