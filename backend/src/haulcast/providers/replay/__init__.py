"""Replay mode: provider answers served from recordings instead of the live services.

A process started with ``HAULCAST_PROVIDER_MODE=replay`` builds its HTTP clients on a
:class:`~haulcast.providers.replay.transport.ReplayTransport`. The *real* adapters, retry policy and
parsers run unchanged on top of it; only the bytes that come back differ: they are the recorded
responses of ``backend/tests/fixtures/providers`` (the catalog), so no request ever leaves the
process and the answer to a given request is always the same.

* :mod:`~haulcast.providers.replay.catalog`: the recorded files, read once and served verbatim;
* :mod:`~haulcast.providers.replay.trips`: the recorded trips and the gazetteer built from them;
* :mod:`~haulcast.providers.replay.routing`, ``geocoding``, ``weather``: one responder per provider;
* :mod:`~haulcast.providers.replay.transport`: the ``httpx`` transport that dispatches to them;
* :mod:`~haulcast.providers.replay.clock`: the frozen wall clock.

Replay is refused in a deployed environment (``Config.validate``); see ``docs/BACKEND.md``.
"""
