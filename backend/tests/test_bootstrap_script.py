"""The runbook script ``backend/scripts/bootstrap_db.py`` delegates to the bootstrap CLI."""

import runpy
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "bootstrap_db.py"
BOOTSTRAP_VARIABLES = ("DATABASE_URL", "HAULCAST_OWNER_DB_PASSWORD", "HAULCAST_APP_DB_PASSWORD")


def test_the_script_exits_non_zero_and_names_the_missing_variable_when_run_unconfigured(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    for name in BOOTSTRAP_VARIABLES:
        monkeypatch.delenv(name, raising=False)
    # An operator's argv is just the script path (pytest's own arguments are not the script's).
    monkeypatch.setattr(sys, "argv", [str(SCRIPT)])

    with pytest.raises(SystemExit) as exit_info:
        runpy.run_path(str(SCRIPT), run_name="__main__")

    captured = capsys.readouterr()
    assert exit_info.value.code == 1
    assert captured.err == "bootstrap_db failed: BootstrapError: DATABASE_URL is required\n"
    assert captured.out == ""


def test_importing_the_script_does_not_run_it(capsys: pytest.CaptureFixture[str]) -> None:
    namespace = runpy.run_path(str(SCRIPT), run_name="not_main")

    assert callable(namespace["main"])
    assert capsys.readouterr() == ("", "")
