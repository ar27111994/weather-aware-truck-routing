"""Where the cross-stack files that live outside the Python package are found."""

from pathlib import Path

import pytest

from haulcast.config.paths import SHARED_DIR_VARIABLE, shared_dir


def test_the_default_is_the_shared_directory_of_the_repository() -> None:
    directory = shared_dir({})

    assert directory.name == "shared"
    assert (directory / "risk-rules.json").is_file()


def test_the_environment_variable_overrides_the_location(tmp_path: Path) -> None:
    assert shared_dir({SHARED_DIR_VARIABLE: str(tmp_path)}) == tmp_path


def test_a_padded_override_is_trimmed(tmp_path: Path) -> None:
    assert shared_dir({SHARED_DIR_VARIABLE: f"  {tmp_path}  "}) == tmp_path


def test_a_blank_override_is_ignored() -> None:
    assert shared_dir({SHARED_DIR_VARIABLE: "   "}) == shared_dir({})


def test_the_process_environment_is_read_when_no_mapping_is_given(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(SHARED_DIR_VARIABLE, str(tmp_path))

    assert shared_dir() == tmp_path
