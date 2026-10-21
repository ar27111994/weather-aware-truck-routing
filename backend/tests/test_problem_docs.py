"""``docs/api/problems.md`` has every problem, under the anchor its ``type`` URI names (R2-30)."""

import re
from pathlib import Path

from haulcast.problems import PROBLEM_DOCS_URL, PROBLEMS

DOCUMENT = Path(__file__).resolve().parents[2] / "docs" / "api" / "problems.md"
ENTRY = re.compile(r'<a id="(?P<anchor>[a-z-]+)"></a>\n\n### `(?P<code>[a-z_]+)`')


def test_the_type_uris_point_into_the_problems_document() -> None:
    assert PROBLEM_DOCS_URL.endswith("/docs/api/problems.md")
    assert DOCUMENT.is_file()


def test_every_problem_has_exactly_one_entry_under_its_anchor() -> None:
    entries = [
        (match["anchor"], match["code"]) for match in ENTRY.finditer(DOCUMENT.read_text("utf-8"))
    ]

    assert sorted(entries) == sorted((spec.anchor, code.value) for code, spec in PROBLEMS.items())


def test_the_document_has_no_anchor_that_no_problem_uses() -> None:
    anchors = re.findall(r'<a id="([^"]+)"></a>', DOCUMENT.read_text("utf-8"))

    assert sorted(anchors) == sorted(spec.anchor for spec in PROBLEMS.values())
