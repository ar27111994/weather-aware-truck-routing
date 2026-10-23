"""Tests of the replay catalog: the recorded provider files, read once and named when missing."""

from pathlib import Path

import pytest

from haulcast.providers.replay.catalog import KINDS, ReplayCatalog, ReplayCatalogError
from tests.plans.support import FIXTURES


def test_the_catalog_has_one_folder_per_provider_kind() -> None:
    assert KINDS == ("geocoding", "routing", "weather")


def test_a_recorded_file_is_read_verbatim(catalog: ReplayCatalog) -> None:
    name = "valhalla-error-no-path.json"

    assert catalog.read_bytes("routing", name) == (FIXTURES / "routing" / name).read_bytes()


def test_a_recorded_file_is_read_from_disk_once(catalog: ReplayCatalog) -> None:
    first = catalog.read_bytes("weather", "openmeteo-denver-gmt-start-end-hour.json")

    assert catalog.read_bytes("weather", "openmeteo-denver-gmt-start-end-hour.json") is first


def test_a_recording_is_parsed_as_json(catalog: ReplayCatalog) -> None:
    assert catalog.recorded("routing", "valhalla-error-no-path.json")["error_code"] == 442


def test_the_catalog_names_the_directory_it_was_opened_on(catalog: ReplayCatalog) -> None:
    assert catalog.root == FIXTURES


def test_a_missing_directory_is_no_catalog(tmp_path: Path) -> None:
    missing = tmp_path / "no-such-catalog"

    with pytest.raises(ReplayCatalogError, match="not a directory") as excinfo:
        ReplayCatalog(missing)

    assert str(missing) in str(excinfo.value)


def test_a_file_is_no_catalog(tmp_path: Path) -> None:
    file = tmp_path / "catalog.json"
    file.write_text("{}", encoding="utf-8")

    with pytest.raises(ReplayCatalogError, match="not a directory"):
        ReplayCatalog(file)


@pytest.mark.parametrize("missing", KINDS)
def test_a_directory_lacking_a_provider_folder_is_no_catalog(tmp_path: Path, missing: str) -> None:
    for kind in KINDS:
        if kind != missing:
            (tmp_path / kind).mkdir()

    with pytest.raises(ReplayCatalogError, match=missing):
        ReplayCatalog(tmp_path)

    (tmp_path / missing).mkdir()
    assert ReplayCatalog(tmp_path).root == tmp_path


def test_a_missing_recording_is_named_with_its_catalog(catalog: ReplayCatalog) -> None:
    with pytest.raises(ReplayCatalogError, match=r"routing/no-such-recording\.json") as excinfo:
        catalog.read_bytes("routing", "no-such-recording.json")

    assert str(FIXTURES) in str(excinfo.value)


@pytest.mark.parametrize("name", ["", ".", "..", "../secret.json", "a/b.json", "a\\b.json"])
def test_a_recording_name_is_a_plain_file_name(catalog: ReplayCatalog, name: str) -> None:
    with pytest.raises(ReplayCatalogError, match="plain file name"):
        catalog.read_bytes("routing", name)


def test_an_unknown_kind_is_refused(catalog: ReplayCatalog) -> None:
    with pytest.raises(ReplayCatalogError, match="unknown kind"):
        catalog.read_bytes("secrets", "valhalla-error-no-path.json")
