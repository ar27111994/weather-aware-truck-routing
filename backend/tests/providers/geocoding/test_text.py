"""Tests for the geocoding text helpers: query normalisation and provider-label sanitising."""

import hashlib
import unicodedata
from itertools import pairwise

import pytest
from hypothesis import given
from hypothesis import strategies as st

from haulcast.providers.geocoding.text import (
    DEFAULT_LABEL_MAX_CHARS,
    cache_digest,
    cache_key,
    join_label,
    normalize_country_code,
    normalize_query,
    optional_label,
    sanitize_label,
)

INVISIBLE_CATEGORIES = frozenset({"Cc", "Cf", "Cs", "Co", "Cn"})

# Text an upstream (or a user) might smuggle in. It must come back as plain data: never escaped,
# never rejected (the UI renders labels as text).
XSS_ISH = [
    "<script>alert(1)</script>",
    "<img src=x onerror=alert(1)>",
    '"><svg/onload=alert(1)>',
    "&lt;b&gt;bold&amp;",
    "'; DROP TABLE places; --",
    "{{7*7}} ${jndi:ldap://example.invalid/a}",
    "javascript:alert(1)",
]

# Characters chosen to provoke edge cases: whitespace flavours, combining marks, invisible format
# characters, NFKC-active characters, Hangul jamo and the three "unusable" categories.
NASTY_CHARS = [
    "e",
    "a",
    "N",
    " ",
    "\t",
    "\u00a0",
    "\u3000",
    "\u2028",
    "\x85",
    "\u0301",
    "\u0308",
    "\u0323",
    "\u200b",
    "\u200d",
    "\u00ad",
    "\ufeff",
    "\u202e",
    "\x00",
    "\u00a8",
    "\ufb01",
    "\uff24",
    "\u2460",
    "\u1100",
    "\u1161",
    "\u11a8",
    "\ud800",
    "\ue000",
    "\u0378",
]
ANY_TEXT = st.one_of(st.text(), st.text(alphabet=st.sampled_from(NASTY_CHARS), max_size=12))


def assert_clean(text: str) -> None:
    """A cleaned string holds no control/format/unusable char, only single inner spaces."""
    for char in text:
        assert unicodedata.category(char) not in INVISIBLE_CATEGORIES
        assert char == " " or not char.isspace()
    assert text == text.strip()
    assert "  " not in text


# --------------------------------------------------------------------------- normalize_query


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        pytest.param("Denver", "Denver", id="plain"),
        pytest.param("  Denver,   CO  ", "Denver, CO", id="trim-and-collapse"),
        pytest.param("Denver\tCO\nUSA\r\nUS", "Denver CO USA US", id="tab-newline-crlf"),
        pytest.param("a\u00a0b\u3000c\u2003d\u202fe", "a b c d e", id="unicode-spaces"),
        pytest.param("a\u2028b\u2029c\x85d", "a b c d", id="line-separators-and-nel"),
        pytest.param("a\x1cb\x1fc", "a b c", id="information-separators"),
        pytest.param("a\x0bb\x0cc", "a b c", id="vertical-tab-and-form-feed"),
    ],
)
def test_normalize_query_turns_every_kind_of_whitespace_into_single_spaces(
    raw: str, expected: str
) -> None:
    assert normalize_query(raw) == expected


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        pytest.param("Den\x00ver", "Denver", id="nul"),
        pytest.param("Den\u202ever", "Denver", id="bidi-override"),
        pytest.param("Den\u200bver", "Denver", id="zero-width-space"),
        pytest.param("Den\u200dver\u200c", "Denver", id="zero-width-joiners"),
        pytest.param("Den\u00adver", "Denver", id="soft-hyphen"),
        pytest.param("\ufeffDenver", "Denver", id="byte-order-mark"),
        pytest.param("Den\u2066ver\u2069", "Denver", id="bidi-isolates"),
        pytest.param("\x07Den\x7fver\x9f", "Denver", id="bell-del-and-c1-control"),
        pytest.param("Den\ud800ver", "Denver", id="lone-surrogate"),
        pytest.param("Den\ue000ver", "Denver", id="private-use"),
        pytest.param("Den\u0378ver", "Denver", id="unassigned"),
        pytest.param("Den\U000e0041ver", "Denver", id="tag-character"),
        pytest.param("a\u200bb", "ab", id="invisible-does-not-separate-words"),
        pytest.param("a \u200b b", "a b", id="invisible-between-spaces-collapses"),
        pytest.param("a\x00 b", "a b", id="nul-next-to-space"),
    ],
)
def test_normalize_query_drops_control_format_and_unusable_characters(
    raw: str, expected: str
) -> None:
    assert normalize_query(raw) == expected


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        pytest.param("\uff24\uff45\uff4e\uff56\uff45\uff52", "Denver", id="fullwidth-letters"),
        pytest.param("\ufb01nd", "find", id="ligature"),
        pytest.param("\u2460\u2461", "12", id="enclosed-digits"),
        pytest.param("x\u00b2", "x2", id="superscript"),
        pytest.param("cafe\u0301", "caf\u00e9", id="decomposed-accent-is-composed"),
        pytest.param("\u212b", "\u00c5", id="angstrom-sign"),
    ],
)
def test_normalize_query_applies_nfkc(raw: str, expected: str) -> None:
    assert normalize_query(raw) == expected


@pytest.mark.parametrize(
    "text",
    [
        "Denver, CO",
        "St. Louis (MO)",
        "O'Fallon, IL",
        "1600 Pennsylvania Ave. NW - Washington",
        "S\u00e3o Paulo",
        "Z\u00fcrich",
        "\u6771\u4eac",
        "Dennebr\u0153ucq",
    ],
)
def test_normalize_query_keeps_case_punctuation_and_letters_of_any_script(text: str) -> None:
    assert normalize_query(text) == text


@pytest.mark.parametrize("text", XSS_ISH)
def test_normalize_query_leaves_markup_alone(text: str) -> None:
    assert normalize_query(text) == text


@pytest.mark.parametrize("raw", ["", "   ", "\t\r\n", "\u200b\x00\u202e", " \u200b "])
def test_normalize_query_of_nothing_visible_is_empty(raw: str) -> None:
    assert normalize_query(raw) == ""


def test_normalize_query_composes_marks_that_dropping_a_format_character_exposes() -> None:
    # NFKC alone leaves "e" + ZWSP + acute untouched; once the ZWSP is gone a second pass would
    # compose them, so the result must already be composed (idempotence).
    assert normalize_query("e\u200b\u0301") == "\u00e9"
    assert normalize_query(normalize_query("e\u200b\u0301")) == "\u00e9"


@given(ANY_TEXT)
def test_normalize_query_is_idempotent(raw: str) -> None:
    once = normalize_query(raw)
    assert normalize_query(once) == once


@given(ANY_TEXT)
def test_normalize_query_never_leaves_control_characters_or_stray_spaces(raw: str) -> None:
    assert_clean(normalize_query(raw))


@given(st.text(alphabet="abc xyz,\t\n"))
def test_normalize_query_does_not_change_case(raw: str) -> None:
    assert normalize_query(raw.upper()) == normalize_query(raw).upper()


# --------------------------------------------------------------------------- cache_key


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        pytest.param("Denver", "denver", id="lowercases"),
        pytest.param("  DENVER,   Co ", "denver, co", id="trims-and-collapses"),
        pytest.param("Stra\u00dfe", "strasse", id="casefold-not-lower"),
        pytest.param("\uff24\uff25\uff2e", "den", id="nfkc-then-casefold"),
        pytest.param("Den\u200bVer", "denver", id="drops-invisible-characters"),
        pytest.param("", "", id="empty"),
    ],
)
def test_cache_key_is_the_normalised_query_casefolded(raw: str, expected: str) -> None:
    assert cache_key(raw) == expected


@given(st.text(alphabet="abc xyz,\t\n"))
def test_cache_key_ignores_case_and_surrounding_whitespace(raw: str) -> None:
    assert cache_key(f" \t{raw.upper()}\n ") == cache_key(raw)


# --------------------------------------------------------------------------- cache_digest


def test_cache_digest_is_the_sha256_of_the_case_folded_normal_form() -> None:
    assert cache_digest("  DENVER,\tCo ") == hashlib.sha256(b"denver, co").hexdigest()


@pytest.mark.parametrize("letter", ["\u00df", "\u0130", "\u0390"])
def test_cache_digest_has_one_length_whatever_the_letters_fold_to(letter: str) -> None:
    """Case folding turns these letters into two or three characters; the digest does not care."""
    assert len(cache_key(letter * 120)) > 200
    assert len(cache_digest(letter * 120)) == len(cache_digest("a"))


@given(st.text(alphabet="abc xyz,\t\n"))
def test_cache_digest_ignores_case_and_surrounding_whitespace(raw: str) -> None:
    assert cache_digest(f" \t{raw.upper()}\n ") == cache_digest(raw)


def test_cache_digest_tells_different_queries_apart() -> None:
    assert cache_digest("springfield, il") != cache_digest("springfield, ma")


# --------------------------------------------------------------------------- sanitize_label


@pytest.mark.parametrize("text", XSS_ISH)
def test_sanitize_label_returns_markup_verbatim_as_data(text: str) -> None:
    assert sanitize_label(text) == text


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        pytest.param("Evil\x00Name\u202e", "EvilName", id="nul-and-bidi-override"),
        pytest.param("Line1\nLine2\r\nLine3", "Line1 Line2 Line3", id="newlines-become-spaces"),
        pytest.param("  padded \t label  ", "padded label", id="trims-and-collapses"),
        pytest.param("<b>\u200bbold</b>", "<b>bold</b>", id="markup-with-invisible-character"),
        pytest.param("\uff24\uff45\uff4e", "\uff24\uff45\uff4e", id="nfc-keeps-fullwidth-letters"),
        pytest.param("Z\u00fcrich", "Z\u00fcrich", id="latin-accents-survive"),
        pytest.param("\u6771\u4eac\u90fd", "\u6771\u4eac\u90fd", id="cjk-survives"),
        pytest.param("", "", id="empty"),
        pytest.param(" \t\u200b ", "", id="nothing-visible"),
    ],
)
def test_sanitize_label_cleans_provider_text(raw: str, expected: str) -> None:
    assert sanitize_label(raw) == expected


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        pytest.param("\ufb01nd", "\ufb01nd", id="ligature"),
        pytest.param("x\u00b2", "x\u00b2", id="superscript"),
        pytest.param("\u2460", "\u2460", id="circled-digit"),
        pytest.param("e\u0301", "\u00e9", id="a-combining-accent-is-composed"),
    ],
)
def test_sanitize_label_keeps_what_the_provider_wrote_and_only_composes_accents(
    raw: str, expected: str
) -> None:
    # R2-40: a label is shown, not searched for. NFKC rewrote ligatures, superscripts and
    # full-width forms; only keys (queries, country codes) are folded that way.
    assert sanitize_label(raw) == expected


def test_sanitize_label_caps_the_length_at_two_hundred_characters_by_default() -> None:
    assert DEFAULT_LABEL_MAX_CHARS == 200
    assert sanitize_label("a" * 500) == "a" * 200
    assert sanitize_label("a" * 200) == "a" * 200
    assert sanitize_label("a" * 199) == "a" * 199


@pytest.mark.parametrize(
    ("raw", "max_chars", "expected"),
    [
        pytest.param("abcdef", 3, "abc", id="plain-cut"),
        pytest.param("abcdef", 6, "abcdef", id="exact-fit"),
        pytest.param("abcdef", 10, "abcdef", id="shorter-than-cap"),
        pytest.param("abcdef", 0, "", id="zero-cap"),
        pytest.param("aaaa bbbb", 5, "aaaa", id="no-trailing-space-after-the-cut"),
        pytest.param("aaaa    bbbb", 6, "aaaa b", id="cap-counts-the-collapsed-whitespace"),
        pytest.param(
            "\u6771\u4eac" * 150, 5, "\u6771\u4eac\u6771\u4eac\u6771", id="counts-characters"
        ),
        pytest.param("\ufb01" * 150, 5, "\ufb01" * 5, id="cap-counts-the-characters-shown"),
    ],
)
def test_sanitize_label_cuts_on_a_character_boundary_without_trailing_space(
    raw: str, max_chars: int, expected: str
) -> None:
    assert sanitize_label(raw, max_chars) == expected


def test_sanitize_label_rejects_a_negative_cap() -> None:
    with pytest.raises(ValueError, match="max_chars"):
        sanitize_label("Denver", -1)


@given(ANY_TEXT, st.integers(min_value=0, max_value=60))
def test_sanitize_label_never_exceeds_the_cap(raw: str, max_chars: int) -> None:
    assert len(sanitize_label(raw, max_chars)) <= max_chars


@given(ANY_TEXT, st.integers(min_value=0, max_value=60))
def test_sanitize_label_output_is_clean_and_stable(raw: str, max_chars: int) -> None:
    once = sanitize_label(raw, max_chars)
    assert_clean(once)
    assert sanitize_label(once, max_chars) == once


@given(ANY_TEXT)
def test_a_label_folds_to_the_same_key_as_the_text_it_was_made_from(raw: str) -> None:
    # The label keeps compatibility characters (NFC), the key folds them (NFKC): both must
    # still agree on what the text *is*, or a displayed place could not be searched for again.
    assert normalize_query(sanitize_label(raw, 10_000)) == normalize_query(raw)


# --------------------------------------------------------------------------- optional_label


@pytest.mark.parametrize("value", [None, 5, 1.5, True, [], {}, b"Denver", ("Denver",)])
def test_optional_label_ignores_values_that_are_not_text(value: object) -> None:
    assert optional_label(value) is None


@pytest.mark.parametrize("value", ["", "   ", "\u200b", "\x00\t"])
def test_optional_label_ignores_text_with_nothing_visible(value: str) -> None:
    assert optional_label(value) is None


def test_optional_label_sanitises_text() -> None:
    assert optional_label("  Den\u200bver\n") == "Denver"
    assert optional_label("<script>alert(1)</script>") == "<script>alert(1)</script>"
    assert optional_label("x" * 500) == "x" * 200


# --------------------------------------------------------------------------- join_label


@pytest.mark.parametrize(
    ("parts", "expected"),
    [
        pytest.param(
            ["Denver", "Colorado", "United States"],
            "Denver, Colorado, United States",
            id="plain",
        ),
        pytest.param(["Denver", None, "", "United States"], "Denver, United States", id="gaps"),
        pytest.param(
            ["Springfield", "Springfield", "Massachusetts"],
            "Springfield, Massachusetts",
            id="consecutive-duplicate",
        ),
        pytest.param(["Denver", "DENVER", "Colorado"], "Denver, Colorado", id="case-insensitive"),
        pytest.param(
            ["New York", "New York", "United States"], "New York, United States", id="same-state"
        ),
        pytest.param(["Denmark", None, None, "Denmark"], "Denmark", id="duplicate-after-gaps"),
        pytest.param(["A", "B", "A"], "A, B, A", id="non-consecutive-duplicates-stay"),
        pytest.param([None, ""], "", id="all-empty"),
        pytest.param([], "", id="no-parts"),
    ],
)
def test_join_label_joins_with_commas_dropping_gaps_and_consecutive_repeats(
    parts: list[str | None], expected: str
) -> None:
    assert join_label(parts) == expected


@given(st.lists(st.one_of(st.none(), st.text(alphabet="abAB ", max_size=3)), max_size=8))
def test_join_label_never_repeats_a_part_next_to_itself(parts: list[str | None]) -> None:
    joined = join_label(parts)
    pieces = joined.split(", ") if joined else []
    assert all(first.casefold() != second.casefold() for first, second in pairwise(pieces))


# --------------------------------------------------------------------------- normalize_country_code


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        pytest.param("US", "US", id="upper"),
        pytest.param("us", "US", id="lower"),
        pytest.param(" Ca ", "CA", id="padded-mixed"),
        pytest.param("\uff35\uff33", "US", id="fullwidth"),
    ],
)
def test_normalize_country_code_upper_cases_two_letter_codes(value: str, expected: str) -> None:
    assert normalize_country_code(value) == expected


@pytest.mark.parametrize(
    "value",
    [
        None,
        5,
        True,
        [],
        {},
        b"US",
        "",
        " ",
        "U",
        "USA",
        "U1",
        "1U",
        "U S",
        "\u00df",
        "\u00c5\u00c4",
    ],
)
def test_normalize_country_code_rejects_anything_that_is_not_two_ascii_letters(
    value: object,
) -> None:
    assert normalize_country_code(value) is None
