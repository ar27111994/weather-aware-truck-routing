"""Errors shared by the replay responders and the replay transport."""


class ReplayRequestError(Exception):
    """A request has no recorded answer: a wiring bug, never a recorded outcome.

    Recorded failures (no route, an empty search, a 400) are answered like the service answered
    them. This is raised for a request that no endpoint of the catalog serves at all, or whose body
    the adapters could not have produced, so a wrong URL or a new provider call fails loudly instead
    of falling back to the network.
    """
