"""Which outcome tokens the collector should subscribe to.

Not "every token on Polymarket" — that is tens of thousands of tokens
and almost all of them are irrelevant to a watchlist of a few dozen
wallets. The set that matters is:

1. tokens the watchlisted wallets currently hold, and
2. tokens they have traded recently,

both restricted to markets that are still open (a resolved market's
price stops moving, so streaming it buys nothing).

Ordering is deliberate and stable: current holdings first, then recent
activity. If the token cap truncates the list, it truncates the tail —
so the tokens we are actually exposed to survive, and the speculative
ones are what get dropped.
"""

from __future__ import annotations

from datetime import timedelta

import psycopg

# How far back a trade still counts as "recently active".
RECENT_ACTIVITY = timedelta(days=7)


def resolve_watchlist_tokens(
    conn: psycopg.Connection,
    *,
    pinned: list[str] | None = None,
    recent: timedelta = RECENT_ACTIVITY,
    statuses: tuple[str, ...] = ("watch", "copy"),
) -> list[str]:
    """Ordered, de-duplicated token ids to subscribe to.

    Pinned tokens come first and are never dropped by the caller's cap —
    an operator who names a token explicitly means it.
    """

    out: list[str] = []
    seen: set[str] = set()

    def add(token: str | None) -> None:
        if token and token not in seen:
            seen.add(token)
            out.append(token)

    for t in pinned or []:
        add(t)

    with conn.cursor() as cur:
        # 1. Current holdings of watchlisted wallets, biggest first — the
        #    positions whose price we most need to track.
        cur.execute(
            "select p.outcome_token_id "
            "from wallet_positions p "
            "join wallet_watchlist w on w.wallet = p.wallet "
            "left join markets m on m.condition_id = p.condition_id "
            "where w.status = any(%s) "
            "  and p.size <> 0 "
            "  and coalesce(m.resolved, false) = false "
            "group by p.outcome_token_id "
            "order by max(abs(p.current_value)) desc nulls last",
            (list(statuses),),
        )
        for row in cur.fetchall():
            add(row[0])

        # 2. Recently traded tokens, most recent first.
        cur.execute(
            "select t.outcome_token_id "
            "from venue_trades t "
            "join wallet_watchlist w on w.wallet = t.wallet "
            "left join markets m on m.condition_id = t.condition_id "
            "where w.status = any(%s) "
            "  and t.occurred_at >= now() - %s::interval "
            "  and coalesce(m.resolved, false) = false "
            "group by t.outcome_token_id "
            "order by max(t.occurred_at) desc",
            (list(statuses), f"{int(recent.total_seconds())} seconds"),
        )
        for row in cur.fetchall():
            add(row[0])

    return out
