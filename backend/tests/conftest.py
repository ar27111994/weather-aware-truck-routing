"""Shared pytest configuration: Hypothesis profiles (``dev`` locally, ``ci`` in GitHub Actions)."""

import os

from hypothesis import settings

# Property tests assert correctness, not speed: wall-clock deadlines only add flakiness on busy
# machines. Performance budgets are asserted by dedicated benchmarks instead.
settings.register_profile("dev", max_examples=50, deadline=None)
settings.register_profile("ci", max_examples=500, deadline=None)
settings.load_profile(os.environ.get("HYPOTHESIS_PROFILE", "dev"))
