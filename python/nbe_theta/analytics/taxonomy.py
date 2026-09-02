"""Event taxonomy: is this a sports market?

V1 copies non-sports markets only, which makes this a **trading gate**,
not a label. That changes how it has to fail.

The rule that matters: **an unclassified event is not eligible.** Not
"assumed non-sports", not "probably fine" — ineligible. We cannot assert
non-sports from silence, and the cost of the two mistakes is asymmetric:
excluding a real non-sports market costs one missed copy, while admitting
a sports market breaks the stated scope of V1 and does it invisibly.

So `classify` returns `None` when it cannot decide, and every consumer
treats `None` as "no". The classifier is versioned because a
reclassification changes which wallets are eligible, and that has to be
auditable rather than a silent rewrite of history.

Polymarket does not expose a machine-readable sports flag on every event,
so this is keyword + category matching over the event title, slug, and
category. That is unglamorous and it is also honest: the matched terms
are stored as evidence on every row, so a wrong call is diagnosable
without re-running anything.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

CLASSIFIER_VERSION = "taxonomy-1"

# Category strings Polymarket uses for sports. Matched case-insensitively
# against `events.category`.
SPORTS_CATEGORIES: frozenset[str] = frozenset(
    {
        "sports",
        "nfl",
        "nba",
        "mlb",
        "nhl",
        "ncaa",
        "ncaab",
        "ncaaf",
        "soccer",
        "football",
        "basketball",
        "baseball",
        "hockey",
        "tennis",
        "golf",
        "mma",
        "ufc",
        "boxing",
        "f1",
        "formula 1",
        "formula1",
        "motorsport",
        "nascar",
        "cricket",
        "rugby",
        "olympics",
        "esports",
        "chess",
        "cycling",
    }
)

# Categories we affirmatively recognise as non-sports. Anything outside
# BOTH sets is undecidable — see the module docstring.
NON_SPORTS_CATEGORIES: frozenset[str] = frozenset(
    {
        "politics",
        "crypto",
        "culture",
        "mentions",
        "weather",
        "economics",
        "tech",
        "finance",
        "science",
        "business",
        "world",
        "elections",
        "geopolitics",
    }
)

# Title/slug terms. Word-boundary matched so "nba" does not fire on
# "urbanbank" and "open" does not fire on "openai".
_SPORTS_TERMS: tuple[str, ...] = (
    "nfl",
    "nba",
    "mlb",
    "nhl",
    "ncaa",
    "premier league",
    "la liga",
    "serie a",
    "bundesliga",
    "ligue 1",
    "champions league",
    "europa league",
    "world cup",
    "super bowl",
    "superbowl",
    "stanley cup",
    "world series",
    "playoffs",
    "grand slam",
    "wimbledon",
    "us open",
    "french open",
    "australian open",
    "masters tournament",
    "pga",
    "ufc",
    "mma",
    "boxing",
    "heavyweight",
    "formula 1",
    "grand prix",
    "nascar",
    "olympic",
    "olympics",
    "fifa",
    "uefa",
    "cricket",
    "ipl ",
    "rugby",
    "tour de france",
    "esports",
    "league of legends",
    "counter-strike",
    "dota",
    "valorant",
    # Match-shaped phrasing that is almost always a game.
    " vs. ",
    " vs ",
    "beat the spread",
    "point spread",
    "over/under",
    "moneyline",
    "to win the game",
    "mvp",
)

_SPORTS_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = tuple(
    (term, re.compile(r"(?<![a-z0-9])" + re.escape(term) + r"(?![a-z0-9])", re.IGNORECASE))
    if term.strip() == term
    else (term, re.compile(re.escape(term), re.IGNORECASE))
    for term in _SPORTS_TERMS
)


@dataclass(frozen=True)
class Classification:
    """A decided classification. ``None`` is returned instead of
    constructing one of these when the event cannot be decided."""

    venue_event_id: str
    is_sports: bool
    category: str | None
    classifier_version: str = CLASSIFIER_VERSION
    evidence: dict[str, Any] = field(default_factory=dict)


def _norm(v: Any) -> str:
    return v.strip().lower() if isinstance(v, str) else ""


def matched_sports_terms(text: str) -> list[str]:
    """Every sports term present in ``text``. Returned rather than a bool
    so the evidence column can show what fired."""

    if not text:
        return []
    return [term for term, pattern in _SPORTS_PATTERNS if pattern.search(text)]


def classify(
    *,
    venue_event_id: str,
    title: str | None = None,
    slug: str | None = None,
    category: str | None = None,
) -> Classification | None:
    """Decide whether an event is sports, or return None if undecidable.

    Order matters. Category is checked first because it is the venue's own
    assertion; title matching is a fallback with a real false-positive
    rate (an election market titled "Trump vs Biden" contains " vs ").

    That fallback is one-directional on purpose: a title match can only
    ever move an event to `is_sports=True`, never to False. Text that
    merely fails to look like sports is not evidence that it isn't.
    """

    cat = _norm(category)
    haystack = f"{_norm(title)} {_norm(slug)}"
    terms = matched_sports_terms(haystack)

    if cat and cat in SPORTS_CATEGORIES:
        return Classification(
            venue_event_id=venue_event_id,
            is_sports=True,
            category=cat,
            evidence={"reason": "category", "category": cat, "terms": terms},
        )

    if cat and cat in NON_SPORTS_CATEGORIES:
        # The venue says non-sports. A title term still overrides, because
        # miscategorised sports events exist and V1's scope is the thing
        # being protected.
        if terms:
            return Classification(
                venue_event_id=venue_event_id,
                is_sports=True,
                category=cat,
                evidence={
                    "reason": "title_override",
                    "category": cat,
                    "terms": terms,
                    "note": "category said non-sports; title matched sports terms",
                },
            )
        return Classification(
            venue_event_id=venue_event_id,
            is_sports=False,
            category=cat,
            evidence={"reason": "category", "category": cat},
        )

    # Unknown or absent category.
    if terms:
        return Classification(
            venue_event_id=venue_event_id,
            is_sports=True,
            category=cat or None,
            evidence={"reason": "title", "terms": terms},
        )

    # Undecidable. Deliberately NOT `is_sports=False` — see module
    # docstring. Returning None forces the caller to treat it as
    # ineligible rather than silently admitting it.
    return None


def is_eligible_category(classification: Classification | None) -> bool:
    """V1 eligibility: a decided, non-sports classification.

    The single place the fail-closed rule is expressed, so a caller
    cannot accidentally write `not c.is_sports` against a None.
    """

    return classification is not None and not classification.is_sports
