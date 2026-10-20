"""Query normalisation and provider-text sanitising for the geocoding adapters.

Every string that reaches a client is either a user query (which becomes a cache key and an upstream
parameter) or text an upstream supplied (names, regions, labels). Both are untrusted. The helpers
here make them safe to store, log and pass on: control, format and other unusable characters never
survive, whitespace is canonical and lengths are capped. Nothing is ever HTML-escaped or rejected:
the API returns plain data and the UI renders it as text, so markup passes through verbatim.
"""

import unicodedata
from collections.abc import Iterable
from typing import Final, Literal

DEFAULT_LABEL_MAX_CHARS: Final = 200
"""Length cap for every provider-supplied text (names, regions, countries, labels)."""

_UNUSABLE_CATEGORIES: Final = frozenset({"Cc", "Cf", "Cs", "Co", "Cn"})
"""Unicode categories dropped outright: control, format, surrogate, private-use and unassigned."""
_COUNTRY_CODE_LENGTH: Final = 2


def _is_unusable(char: str) -> bool:
    """Whether ``char`` must vanish: an unusable category that is not whitespace.

    Whitespace is excluded because it becomes a space instead. Tab and newline are control
    characters too, but dropping them would glue two words together.
    """
    return unicodedata.category(char) in _UNUSABLE_CATEGORIES and not char.isspace()


def _clean(raw: str, form: Literal["NFC", "NFKC"]) -> str:
    """Return ``raw`` as one line in Unicode ``form``: single spaces, no unusable characters."""
    visible = "".join(char for char in raw if not _is_unusable(char))
    return " ".join(unicodedata.normalize(form, visible).split())


def normalize_query(raw: str) -> str:
    """Return ``raw`` as one canonical line: NFKC, single spaces, no unusable characters.

    Whitespace of any kind (tabs, newlines, Unicode spaces) becomes a single space and the result is
    trimmed. Other control, format, surrogate, private-use and unassigned characters (NUL, bidi
    overrides, zero-width spaces, ...) are dropped. The case is kept: use :func:`cache_key` for a
    case-insensitive key.

    Unusable characters are removed *before* NFKC on purpose. Removing one afterwards can bring a
    letter and a combining mark together, and a second pass would then compose them, so the result
    would not be a fixed point of this function.
    """
    return _clean(raw, "NFKC")


def cache_key(query: str) -> str:
    """Return the case-insensitive cache key of ``query``: its normalised form, casefolded."""
    return normalize_query(query).casefold()


def sanitize_label(value: str, max_chars: int = DEFAULT_LABEL_MAX_CHARS) -> str:
    """Clean provider-supplied text and cap it at ``max_chars`` characters.

    The cleaning is that of :func:`normalize_query` except that characters are composed
    canonically (NFC) rather than folded (NFKC): a label is shown, not searched for, and NFKC
    would rewrite ligatures, superscripts and full-width forms the provider wrote on purpose
    (R2-40). The cleaning is followed by a hard cut on a character boundary that leaves no
    trailing space. Otherwise the text is returned verbatim: markup such as ``<script>`` is data,
    not something to escape or reject.

    Raises:
        ValueError: ``max_chars`` is negative.
    """
    if max_chars < 0:
        raise ValueError("max_chars must not be negative")
    return _clean(value, "NFC")[:max_chars].rstrip()


def optional_label(value: object) -> str | None:
    """Return ``value`` sanitised when it is text with something visible in it, else ``None``.

    Upstream JSON may hold any type under a text field, so this is the one door through which
    optional provider text enters a candidate.
    """
    if not isinstance(value, str):
        return None
    return sanitize_label(value) or None


def join_label(parts: Iterable[str | None]) -> str:
    """Join ``parts`` with commas into a display label.

    Missing or empty parts are skipped, and a part that repeats the one before it (ignoring case)
    is dropped, so ``("Springfield", "Springfield", "Massachusetts")`` reads
    ``"Springfield, Massachusetts"``.
    """
    kept: list[str] = []
    for part in parts:
        if part and (not kept or part.casefold() != kept[-1].casefold()):
            kept.append(part)
    return ", ".join(kept)


def normalize_country_code(value: object) -> str | None:
    """Return ``value`` as an upper-case ISO 3166-1 alpha-2 code, or ``None`` if it is not one.

    The shape is checked before upper-casing, because upper-casing can lengthen a string (the German
    sharp s becomes ``"SS"``) and would let a non-code through.
    """
    if not isinstance(value, str):
        return None
    code = normalize_query(value)  # a code is a key: compatibility forms are folded (full-width)
    if len(code) != _COUNTRY_CODE_LENGTH or not (code.isascii() and code.isalpha()):
        return None
    return code.upper()
