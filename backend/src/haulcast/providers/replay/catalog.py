"""The replay catalog: the recorded provider answers a replaying process serves.

A catalog is a directory with one folder per kind of provider (``geocoding``, ``routing``,
``weather``) that holds the responses exactly as the services sent them. Files are read on demand,
once, and handed out byte for byte: nothing is re-serialised, so what a test saw when it served the
recording through ``respx`` is what replay mode serves over the transport.
"""

import json
import re
from pathlib import Path
from typing import Any, Final

KINDS: Final = ("geocoding", "routing", "weather")
"""The provider folders every catalog holds."""

_PLAIN_FILE_NAME: Final = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")


class ReplayCatalogError(RuntimeError):
    """The replay catalog is missing, incomplete, or asked for a file it does not hold."""


class ReplayCatalog:
    """The recorded files below one directory."""

    def __init__(self, root: Path) -> None:
        """Open the catalog at ``root``, which must hold a folder for every kind of provider.

        Raises:
            ReplayCatalogError: ``root`` is not a directory or lacks a provider folder.
        """
        if not root.is_dir():
            raise ReplayCatalogError(f"the replay catalog {root} is not a directory")
        for kind in KINDS:
            if not (root / kind).is_dir():
                raise ReplayCatalogError(f"the replay catalog {root} has no {kind} folder")
        self._root = root
        self._files: dict[tuple[str, str], bytes] = {}

    @property
    def root(self) -> Path:
        """The directory this catalog was opened on."""
        return self._root

    def read_bytes(self, kind: str, name: str) -> bytes:
        """Return the recorded file ``kind``/``name`` byte for byte (read from disk once).

        ``name`` must be a plain file name: a catalog never reaches outside its folders.

        Raises:
            ReplayCatalogError: ``kind`` is unknown, ``name`` is not a plain file name, or the
                catalog holds no such file.
        """
        cached = self._files.get((kind, name))
        if cached is not None:
            return cached
        if kind not in KINDS:
            raise ReplayCatalogError(f"unknown kind {kind!r}: a catalog holds {', '.join(KINDS)}")
        if _PLAIN_FILE_NAME.fullmatch(name) is None:
            raise ReplayCatalogError(f"{name!r} is not a plain file name")
        path = self._root / kind / name
        if not path.is_file():
            raise ReplayCatalogError(f"the replay catalog {self._root} holds no {kind}/{name}")
        content = path.read_bytes()
        self._files[(kind, name)] = content
        return content

    def recorded(self, kind: str, name: str) -> dict[str, Any]:
        """Return the recorded JSON document ``kind``/``name`` (see :meth:`read_bytes`)."""
        document: dict[str, Any] = json.loads(self.read_bytes(kind, name))
        return document
