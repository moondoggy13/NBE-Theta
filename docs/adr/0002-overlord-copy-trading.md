# ADR-0002: Adopt NBE-Overlord as the copy-trading spec, on the existing stack

- **Status**: Accepted
- **Date**: 2026-08-10
- **Deciders**: repository owner
- **Extends**: ADR-0001 (Polymarket pivot)

## Context

A spec arrived — "NBE-Overlord: Polymarket Copy-Trading Engine" — describing
a system that monitors ~1,000 high-performing Polymarket wallets, promotes
the most repeatable and *copyable* into an active feeder set, and mirrors
qualified position changes into one wallet.

It restates the goal more sharply than ADR-0001 did, and the sharpening
matters:

> The goal is not to predict things and make money. The goal is to copy the
> people who do know what they're doing. Only the top handful of Polymarket
> traders make all the money and we simply want to copy what they are
> betting on.

That is a **selection-and-mirroring** problem, not a forecasting problem. We
do not need a view on any market. We need to answer two questions well:

1. *Who actually knows something* — separable from luck, and
2. *Whose knowledge we can actually capture* — after latency, spread, and
   our own market impact.

The existing system answers (1) with real statistical machinery and does not
address (2) at all. NBE-Overlord's central contribution is (2).

## Decision

Adopt NBE-Overlord's **policy** — cohort, eligibility, copyability,
clustering, materiality, risk envelope, shadow gate, compliance posture —
and reject its **infrastructure** proposal, which would rebuild what
PRs 0–6 already ship and pass.

### Adopted from the spec

| Idea | Why |
|---|---|
| **Copyability as a first-class dimension** | The keystone. A wallet can be genuinely skilled and completely uncopyable: it trades thin books, its own entry moves the price, and by the time we see the fill the edge is gone. Our scorer would rank it Tier A and we would bleed on every mirror. We had *zero* of this. |
| **Correlated-wallet clustering as a sizing constraint** | Five wallets run by one desk are one opinion. Without clustering, "independent consensus" is a lie that multiplies size on a single source. |
| **Strategy-lot accounting with source attribution** | Exits mirror only the lots we opened *from that source*. Correct, and it makes "do not infer reversals, do not create shorts" enforceable rather than aspirational. |
| **Materiality thresholds** (≥ $250 **and** ≥ 2.5 % of source's pre-trade exposure) | Both halves are needed: absolute size alone copies a whale's rounding error; relative size alone copies a small account's entire bankroll. |
| **Bounded FOK only, never market orders; no resting copy orders** | Matches ADR-0001. A resting copy order is a free option written to the market. |
| **Depth caps** (20× book depth inside the limit; 5 % participation) | Our own impact is a cost we control by not being large relative to the book. |
| **Reject-reason logging on every evaluation** | The system's most valuable output early on is *why it did nothing*. |
| **Risk stops block entries; they do not liquidate** | Subtle and right. Forced liquidation on a drawdown converts a paper loss into a realized one at the worst price. |
| **Non-sports V1** | Scope discipline. |
| **Shadow gate with concrete numbers**; **compliance gate; no geo-evasion** | Kept verbatim in spirit. |

### Rejected, with reasons

**1. "Create a TypeScript monorepo."** We have one. It has Next.js, Supabase,
`packages/contracts`, migrations `001`–`014`, and a mypy-strict Python worker
of ~4,000 tested lines. The spec's four adapters already exist in substance:

| Spec adapter | Already shipped |
|---|---|
| `LeaderboardProvider` | `ingest/dataapi.py` (`leaderboard`, `holders`) |
| `WalletActivityProvider` | `ingest/backfill.py`, `positions.py`, `monitor.py` |
| `MarketDataProvider` | `ingest/gamma.py`, `clob.py`, `marketstream.py`, `collector.py` |
| `ExecutionBroker` | **genuinely missing** — build it |

Rebuilding the first three costs weeks and buys nothing.

**2. A TypeScript worker for collection and scoring.** The statistics
(empirical-Bayes shrinkage, event-block bootstrap, Benjamini–Hochberg) are
built, tested, and strict-typed in Python. Porting them is pure risk.

The spec *is* right that **execution** belongs in TypeScript: Polymarket's
supported CLOB client is TS, and hand-rolling EIP-712 order signing is a
footgun. ADR-0001 already put the signer in `apps/executor` for this reason.

**Resolution: Python owns Intelligence + Signal. TypeScript owns Execution.**
The seam is the durable `execution_intents` outbox, which already exists.

**3. Redis** — for queues, locks, rate limiting, retries, dashboard state.
Every one of those already has a Postgres answer that is *better* for this
workload:

- Queue → `execution_intents` + `FOR UPDATE SKIP LOCKED`. A financial intent
  must be enqueued in the same transaction that records why it exists.
  Redis cannot do that; a crash between the two writes is a lost or
  duplicated order.
- Locks/leases → advisory locks + `process_heartbeats`.
- Watermarks → `ingest_cursors`.
- Rate limiting → `ingest/ratelimit.py`.
- Dashboard state → Supabase Realtime, already wired.

Adding Redis adds a second source of truth that must not diverge from the
first. ADR-0001's "no Redis" stands.

### Corrections to the spec

**A. The signal-confidence formula is arithmetically unreachable.**

The spec defines

```
S = 0.45·Q + 0.20·materiality + 0.20·consensus + 0.15·execution_quality,  execute at S ≥ 0.75
```

and separately says *"Sources with Q ≥ 0.85 may act alone."* Acting alone
means `consensus = 0`. The maximum achievable score for such a source, with
**perfect** materiality and **perfect** execution quality, is

```
0.45(0.85) + 0.20(1.0) + 0 + 0.15(1.0) = 0.3825 + 0.20 + 0.15 = 0.7325  <  0.75
```

A Q = 0.85 source can therefore *never* trade alone. Solving
`0.45Q + 0.35 ≥ 0.75` gives `Q ≥ 0.889` — so the stated 0.85 threshold is
wrong by construction, and the rule it belongs to is dead code.

This is not a tuning problem. It is what happens when incommensurable
quantities are summed and compared to a magic constant.

**Replacement: gates + an independent size multiplier.**

- **Gates** are boolean and each logs its own reason. A signal executes only
  if every gate passes. No weighted trade-off can let a failing liquidity
  check be "made up for" by a high-quality source.
- **Size** is a product of factors in `[0,1]` — quality, materiality,
  liquidity headroom. A product means any weak factor shrinks the position
  rather than being averaged away.

This cannot produce the contradiction above, and every decision stays
attributable to a named condition.

**B. The scoring model drops the correction that makes scores meaningful.**

The spec's *performance* term is "60- and 180-day capital-weighted realized
returns, net of known fees, with Bayesian shrinkage." Two problems:

- **No price adjustment.** A wallet that buys 0.90 favorites and wins 90 % of
  the time has excellent realized returns and has demonstrated nothing. Our
  `excess_edge` (`payoff − entry price − fees`) is exactly the correction the
  spec omits, and it is already enforced by tests.
- **No multiple-testing correction.** Screening 1,000 wallets and keeping the
  top 150 at any per-wallet threshold selects roughly 50 pure-noise wallets
  at α = 0.05. For a cohort this size that is *the* central statistical
  failure mode, and the spec does not mention it. We already run
  Benjamini–Hochberg across the universe.

**Resolution: keep our statistical core as the skill estimate. Add the
spec's copyability, recency decay, and clustering around it.**

**C. Copyability is a veto, not a weighted term.** The spec folds it in at
0.20 of a weighted sum, which lets a very skilled but uncopyable wallet
average its way through. Skill and tradability are different kinds of claim.
Copyability gates promotion and scales size; it does not add to skill.

**D. Wallets must be scored on their non-sports subset.** The spec excludes
sports *markets* but selects wallets on `OVERALL` leaderboards. A wallet
whose PnL is 90 % sports will rank high and be a poor non-sports source. The
scored population must be filtered before scoring, not after.

**E. The polling budget is over-subscribed as specified.** Against the
spec's own 250 req / 10 s cap:

```
feeder      150 wallets / 10 s               = 150.0 req/10s
cohort      850 wallets / 120 s              =  70.8
positions   150 / 5 min                      =   5.0
positions   850 / 30 min                     =   4.7
                                        total ≈ 230.5 / 250  (92 %)
```

That leaves no headroom for 180-day backfill of new entrants, retries, the
six-hour cohort refresh, or a single `Retry-After` pause. **Feeder polling
moves to 15 s** (total ≈ 180/10 s, 72 %), with the budget enforced by
`RateLimiter` and the arithmetic asserted in a test so it cannot silently
regress.

**F. Missing rules, added.**

- **Neg-risk markets are excluded in V1.** In a neg-risk (multi-outcome)
  market, buying NO on one outcome is economically close to buying YES
  across the others; mirroring naively can double real exposure while the
  per-market cap reads as satisfied. `markets.neg_risk` already exists.
- **Settlement closes strategy lots.** Nothing in the spec says what happens
  when a copied market resolves. Lots must be closed at
  `outcomes.resolution_price` (migration 012) and the P&L realized, or the
  book silently drifts from reality.
- **Size against the position delta over the detection window**, not a single
  fill. A source scaling in over minutes produces several fills; copying each
  one independently multiplies exposure. Our episode model already groups
  these.

**G. Fill rate is a measured output, not an assumption.** Copying is a
latency race we will frequently lose: at 15 s polling plus processing, the
mirror routinely arrives 20–60 s after the source, in a market the source's
own trade may have moved. The spec's price cap —
`min($0.02, max($0.005, 8 % × min(p, 1−p)))` — will reject a large share of
signals. **That is correct behaviour**, and it is also the product's central
risk. The shadow gate therefore reports **qualified-signal fill rate and the
distribution of rejection reasons** as first-class results. If the answer is
"we can detect the good traders but almost never get their price," that is a
finding, and it should arrive as a number rather than a surprise.

## Revised roadmap

Spec steps 1–2 are largely delivered. Remapping onto what exists:

| Spec step | State |
|---|---|
| 1. Scaffold, migrations, secrets, auth | **done** (PRs 0–2) |
| 2. Ingestion, cohort discovery, backfill, dedup, positions | **mostly done** (PRs 3, 4, 4b, 6). Gaps: category leaderboards, non-sports classification, cohort membership. |
| 3. Scores, clustering, walk-forward, policy versioning | **partly done** (PR 5). Gaps: copyability, clustering, policy approval. |
| 4. Signal qualification, risk, shadow broker, lots, console | not started |
| 5. Signed CLOB execution, user WS, recovery, kill switch, audit | not started |
| 6. Shadow gate | not started |
| 7. Legal/compliance approval | owner action |

Remaining PRs:

- **PR 7 — Selection layer.** Cohort discovery (category leaderboards,
  non-sports classification, membership + eligibility), **copyability**,
  correlated-wallet clustering, versioned scoring policies. *This is the
  layer that decides whom we follow, so everything downstream inherits its
  quality.*
- **PR 8 — Signal qualification + risk engine + shadow broker + strategy
  lots.** Produces the evidence the shadow gate consumes.
- **PR 9 — Operator console.** Mode control, signal feed with reject
  reasons, portfolio and lot lineage, health, kill switch.
- **PR 10 — `apps/executor`.** TypeScript, holds the signer, consumes the
  intent outbox, official CLOB client, user-stream reconciliation.
- **PR 11 — Shadow-gate reporting.** The 30-day / 100-signal decision packet.
  *Delivered.* The packet turned out to need a third per-criterion
  outcome — `insufficient_evidence` — because four of the spec's six
  conditions are vacuously true over an empty window, which would have
  let a system with no track record promote itself. See
  `docs/adr/0003-shadow-gate-enforcement.md`, which also makes the gate a
  machine-checked precondition in `/api/console/mode` rather than a
  documented one.

## Consequences

- **Positive**: keeps six merged PRs of tested infrastructure; adds the one
  dimension (copyability) that separates "a good trader" from "a trader we
  can profitably mirror"; replaces an unreachable scalar threshold with
  auditable gates; keeps one language per concern.
- **Negative**: two languages across the seam, which is a real cost paid for
  a real reason (statistics in Python, official signing SDK in TypeScript).
  The spec's Redis-based operational conveniences are re-implemented on
  Postgres instead of adopted.
- **Risk**: the fill-rate question in **G** may be answered unfavourably. The
  shadow gate is designed to answer it early and cheaply, before the executor
  is trusted with capital.

## Related documents

- `docs/adr/0001-polymarket-pivot.md` — the three-layer architecture
- `AGENTS.md`, `CLAUDE.md` — the development contract
