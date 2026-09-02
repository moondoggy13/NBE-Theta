# ADR-0005: The alpha gate gets a verdict, an interval, and event clustering

- **Status**: Accepted
- **Date**: 2026-09-02
- **Deciders**: repository owner
- **Extends**: ADR-0002 (the alpha gate as the plan's decision point),
  ADR-0003 (the three-outcome pattern)

## Context

`theta-score-wallets walkforward` produces **lift** — selected wallets'
forward edge minus the universe baseline. The README calls it "the
decision point the whole plan is organized around" and a non-positive
value a STOP. Every subsequent investment — the chain indexer, the
execution stack — is conditioned on it.

It has never been run against real data. That turns out to be an egress
allowlist in the build sandbox rather than anything about Polymarket:
the proxy answers `403` to the `CONNECT`, so the request never leaves.
Which means the gate will be run, probably soon, and probably once, and
whatever it prints will be believed.

Reviewing it before that happens surfaced three defects. Each is a rule
this codebase already applies elsewhere and had failed to apply to its
own headline number.

**1. Lift was a bare point estimate.** No interval, anywhere. The scorer
refuses to bootstrap below three event clusters; the shadow gate carries
a bootstrap on its P&L; a missing price is `NULL` rather than `0.0`. But
a lift of `+0.004` over two folds and nine episodes printed identically
to the same lift over forty folds and nine thousand. One is noise and the
other is a finding.

**2. Forward edges averaged episodes, not event clusters.**
`ScoredEpisode` carries `event_cluster_id`, the scorer's bootstrap
resamples by it, and CLAUDE.md states the rule outright — "correlated
markets are not independent evidence". `_mean_edge` ignored it. A wallet
that split one opinion across ten outcome tokens on the same election got
ten times the weight of a wallet that expressed one opinion once. That is
market structure being read as forecasting skill, and it biases toward
whoever fragments positions most.

**3. No minimum evidence and no way to decline.** `run_walk_forward`
would produce a result from a single fold. There was no analogue of the
shadow gate's `insufficient_evidence`, so "we cannot tell yet" and "we
measured, and the answer is yes" rendered the same.

There is also a fourth problem in the opposite direction. Selecting the
top 10 from a 12-wallet universe makes lift near zero *by construction* —
"selected" and "everyone" are almost the same set. Reported as-is that
reads as "selection adds nothing", which under the README's rule is a
STOP. A false stop is as expensive as a false go.

## Decision

Give the alpha gate the same shape as ADR-0003's shadow gate:
`python/nbe_theta/backtest/alpha_gate.py`, four named criteria, three
outcomes each, `fail` > `insufficient_evidence` > `pass`.

| Criterion | Insufficient when |
|---|---|
| `sufficient_folds` | fewer than 3 folds |
| `sufficient_evidence` | fewer than 30 forward episodes, or fewer than 3 event clusters |
| `selection_is_selective` | the selected set is more than half the universe |
| `positive_lift` | no fold produced both a selected and a baseline edge |

`selection_is_selective` returning `insufficient_evidence` rather than
`fail` is the deliberate handling of the fourth problem: a cohort too
small to distinguish selection from the universe has not disproved
anything.

**`_mean_edge` now averages over event clusters**, and `cluster_ids` is
exported beside it so the interval and the point estimate can never
disagree about what counts as a block.

**The interval resamples event clusters, not folds.** Consecutive folds
share settled episodes — overlapping horizons — so folds are not
independent draws, and there are rarely more than a handful. Event
clusters are the block the codebase already treats as approximately
independent.

**The interval reports; it does not gate.** The stated bar is a positive
lift, so that is what `positive_lift` tests. But a lift whose interval
spans zero is flagged, in the CLI output as well as the packet, because
someone about to commit the next phase of the project should see that
before deciding rather than after.

The interval holds the baseline fixed rather than resampling it, which
makes it slightly narrower than the truth. The direction is stated in the
code because it matters: narrow is the optimistic direction, so a result
whose interval *already* spans zero definitely does.

**The CLI exits non-zero unless the verdict passes**, so the gate can
guard a script rather than needing a human to read it.

## Consequences

- **Positive**: the number the project turns on now carries its own
  uncertainty and refuses to answer when it cannot. The most expensive
  possible mistake here is a false "go" read off four correlated trades,
  and that is now structurally unavailable.
- **Positive**: the clustering fix removes a bias toward wallets that
  fragment positions — which, given copy-trading selects *for* activity,
  was a bias toward exactly the wrong wallets.
- **Negative**: the thresholds (3 folds, 30 episodes, 3 clusters, 50 %
  selection share) are judgement, not derivation. They are deliberately
  low — this gate should refuse obvious noise, not demand certainty
  nobody could reach — and they are one frozen policy object so a run
  records the bar it was judged against.
- **Negative**: `FoldResult` now retains its forward episodes so the
  gate can bootstrap over the same observations that produced the point
  estimate. That costs memory proportional to the corpus. At the cohort
  sizes ADR-0002 describes (~1,000 wallets) this is not a concern; at a
  much larger universe it would need revisiting.

## What this ADR does *not* do

It does not make the gate runnable offline, and it deliberately does not
add synthetic fixtures that could produce a lift. A number computed from
invented data would be indistinguishable in the output from a real one,
and this repository's whole discipline is about not manufacturing
evidence. The gate stays unrun until it can read real history.

## Related documents

- `docs/adr/0002-overlord-copy-trading.md` — the alpha gate as the plan's
  decision point
- `docs/adr/0003-shadow-gate-enforcement.md` — the three-outcome pattern
  this follows
- `python/nbe_theta/backtest/alpha_gate.py`
