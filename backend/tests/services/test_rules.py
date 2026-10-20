"""Loading the rules document: a strong content-hash ETag over the file's exact bytes."""

import hashlib
import re
from pathlib import Path

import pytest

from haulcast.config.paths import shared_dir
from haulcast.services.rules import RULES_FILENAME, RulesDocumentError, load_rules_document


def test_the_shared_rules_file_loads_with_a_strong_hash_etag() -> None:
    document = load_rules_document()

    assert document.body == (shared_dir() / RULES_FILENAME).read_bytes()
    assert re.fullmatch(r'"[0-9a-f]{32}"', document.etag)
    assert document.etag == f'"{hashlib.sha256(document.body).hexdigest()[:32]}"'


def test_the_body_is_the_files_exact_bytes_not_a_reserialisation(tmp_path: Path) -> None:
    odd_formatting = b'{ "b":2,\r\n  "a" : [ 1,2 ] }'
    path = tmp_path / "rules.json"
    path.write_bytes(odd_formatting)

    assert load_rules_document(path).body == odd_formatting


def test_a_changed_file_changes_the_etag(tmp_path: Path) -> None:
    path = tmp_path / "rules.json"
    path.write_text('{"version": 1}', encoding="utf-8")
    first = load_rules_document(path).etag
    path.write_text('{"version": 2}', encoding="utf-8")

    assert load_rules_document(path).etag != first


@pytest.mark.parametrize(
    "content",
    [b"", b"not json", b"\xff\xfe\x00", b"[1, 2]", b'"text"', b"42", b"null", b"true"],
    ids=["empty", "garbage", "binary", "array", "string", "number", "null", "boolean"],
)
def test_anything_that_is_not_a_json_object_is_refused(tmp_path: Path, content: bytes) -> None:
    path = tmp_path / "rules.json"
    path.write_bytes(content)

    with pytest.raises(RulesDocumentError) as raised:
        load_rules_document(path)

    assert "rules.json" in str(raised.value)
    assert str(tmp_path) not in str(raised.value)


def test_a_missing_file_is_refused_without_naming_the_directory(tmp_path: Path) -> None:
    with pytest.raises(RulesDocumentError, match=r"cannot load rules\.json") as raised:
        load_rules_document(tmp_path / "rules.json")

    assert str(tmp_path) not in str(raised.value)
