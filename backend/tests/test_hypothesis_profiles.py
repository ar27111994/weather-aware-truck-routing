"""The Hypothesis profiles say what they mean, whatever the environment says (R2-25).

On GitHub Actions (``CI=true``) Hypothesis loads its own built-in ``ci`` profile, which is
derandomised. A profile registered without a parent inherits the profile loaded at that moment,
so the project's ``ci`` profile used to inherit ``derandomize=True`` and ``database=None`` without
anybody having said so: CI replayed the same 500 examples on every run while a developer's
machine, with another default, found a flaky property that CI never could. These tests pin the
choice: pull requests replay the same examples on purpose, and exploration happens on a schedule.
"""

import ast
from pathlib import Path

from hypothesis import settings

CONFTEST = Path(__file__).with_name("conftest.py")


def test_pull_requests_replay_the_same_examples_on_purpose() -> None:
    profile = settings.get_profile("ci")

    assert profile.derandomize is True  # a red check is the change's own and reproducible
    assert profile.max_examples == 500
    assert profile.deadline is None
    assert profile.print_blob is True  # a failure prints how to replay it


def test_a_developers_runs_explore_with_fresh_examples_every_time() -> None:
    profile = settings.get_profile("dev")

    assert profile.derandomize is False
    assert profile.max_examples == 50
    assert profile.deadline is None


def test_the_scheduled_run_goes_deeper_with_fresh_examples_and_keeps_no_database() -> None:
    profile = settings.get_profile("explore")

    assert profile.derandomize is False
    assert profile.max_examples == 2_000
    assert profile.deadline is None
    assert profile.database is None
    assert profile.print_blob is True


def test_every_profile_names_its_parent_and_whether_it_is_derandomised() -> None:
    tree = ast.parse(CONFTEST.read_text(encoding="utf-8"))
    registrations = [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "register_profile"
    ]

    assert {
        call.args[0].value for call in registrations if isinstance(call.args[0], ast.Constant)
    } == {
        "dev",
        "ci",
        "explore",
    }
    for call in registrations:
        keywords = {keyword.arg for keyword in call.keywords}
        assert {"parent", "derandomize"} <= keywords, ast.unparse(call)
