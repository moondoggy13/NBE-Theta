# ADR-0003: The shadow gate becomes a machine-checked condition

- **Status**: Accepted
- **Date**: 2026-09-02
- **Deciders**: repository owner
- **Extends**: ADR-0002 (Overlord copy-trading spec), ADR-0001 (pivot)
- **Risk gate**: yes. Regression test
  `src/app/api/__tests__/risk-gate-shadow-gate.test.ts`. Per AGENTS.md
  this change **also requires review by someone other than its author**
  before it is relied on.

## Context

ADR-0002 adopted the spec's step 6 as the promotion gate:

> Run the 30-day/100-signal shadow gate; require net-positive modeled
> results after dynamic fees/slippage, p95 detection freshness below 90
> seconds, zero duplicate orders, and zero unresolved critical incidents.

PR 9 built `/api/console/mode` with four documented conditions for going
live. It *enforced* two of them — two-step operator confirmation, and the
executor's three-flag env gate — and left the other two, the shadow gate
and compliance approval, as prose in a docstring.

That asymmetry is the problem this ADR fixes. The two enforced conditions
are the ones you cannot satisfy by accident: nobody sets
`CONFIRM_LIVE=YES` while thinking they are being careful. The shadow gate
is the opposite. Skipping it does not feel like disabling a safety check;
it feels like impatience, on a day when the numbers look good and waiting
is annoying. A comment cannot refuse, and the condition most likely to be
skipped was the one with nothing behind it.

There was a second, quieter problem. "The shadow gate passed" was not a
statement anything could be checked against. There was no artifact, no
window, no thresholds — nothing an auditor (or the author, six months
later) could point at.

## Decision

**1. The shadow gate produces a durable decision packet.**

`theta-signals gate` evaluates a trailing window and writes a row to
`shadow_gate_runs` (migration 018): the window, every criterion's outcome
and the number that decided it, the thresholds it was judged against, the
policy versions in force, and the ADR-0002 §G headline (fill rate and the
rejection histogram). Packets are insert-only. Re-running the gate writes
a new row; editing an old verdict would destroy the audit trail that is
the table's reason for existing.

**2. `/api/console/mode` refuses `live` without a passing packet.**

Condition 3 becomes a query. The check fails closed: an error reading
`shadow_gate_runs` is not "no passing run", it is "we cannot tell", and
both must read as unauthorised. The `operator_actions` audit row for a
promotion now names the packet that authorised it, so "the gate passed"
is replaced by "gate run `<id>`, window `<start>`–`<end>`".

**3. Every criterion has three outcomes, not two.**

`pass`, `fail`, and `insufficient_evidence`. Only an all-`pass` packet
authorises promotion.

This is the substantive design decision, and it is worth stating why a
boolean would have been dangerous rather than merely coarse. Consider a
system that has never traded. Over its empty window:

- "zero duplicate orders" — **true**, nothing could have duplicated;
- "zero unresolved critical incidents" — **true**, nothing has run;
- "net-positive modeled results" — a net P&L of exactly zero is not
  negative, so under `>= 0` it is **true**;
- "p95 detection freshness below 90 s" — no observations, so under any
  `max(values, default=0)` idiom it is **true**.

Four vacuous truths, and a two-valued gate opens. The system promotes
itself to live on the strength of never having done anything. This is not
a hypothetical bug class for this repository — it is the same error the
analytics layer already guards against in two places: the bootstrap
refuses below three event clusters rather than reporting a zero-width
interval, and a missing price is stored as SQL `NULL` rather than `0.0`,
because *unmeasured* and *fine* are different claims. The gate applies the
same rule to the promotion decision itself.

So each criterion states whether it had enough evidence to be asked:

| Criterion | Insufficient when |
|---|---|
| `window_duration` | fewer than 30 days |
| `qualified_signal_count` | fewer than 100 qualified signals |
| `net_positive_after_costs` | fewer than 3 settled lots, or under 60 % of opened lots settled |
| `detection_freshness_p95` | no latency observations |
| `zero_duplicate_orders` | no qualified signals — nothing could have duplicated |
| `zero_unresolved_incidents` | *never* — see below |

`zero_unresolved_incidents` is deliberately the exception. "Nothing is
broken" is a real answer over an empty window, because an unresolved
reconciliation break means local state and venue truth disagree **now**,
whatever the window contains. It is also the only criterion not scoped to
the window at all, for the same reason.

**4. Verdict precedence: `fail` > `insufficient_evidence` > `pass`.**

A measured failure is reported as a failure even when another criterion
lacks evidence. A negative result is not softened by an unfinished one
sitting beside it.

**5. Compliance approval stays a human judgement.**

Condition 4 is *not* modelled as a boolean, and that is deliberate. A
checkbox labelled "compliance approved" is worse than an honest gap: one
click would stand in for a legal opinion about a specific jurisdiction,
and the stored `true` would look identical whether or not anyone had read
one. The gap is documented in the route and in the README instead.

## Consequences

- **Positive**: the promotion argument is now auditable end to end. A
  verdict names its window, its thresholds, and the evidence behind each
  criterion; a promotion names the verdict.
- **Positive**: a system with no track record cannot promote itself. That
  is the failure this ADR exists to prevent, and it is covered by
  negative controls — each safety branch was deleted in turn and the
  corresponding test confirmed to fail.
- **Negative**: `theta-signals gate --record` is a manual step. A packet
  is not produced automatically, so the console can show "no gate run
  recorded" simply because nobody ran it. That is the safe direction —
  the absence of a packet blocks rather than permits — but it does mean
  the console's amber banner is not by itself evidence of a problem.
- **Known limitation, accepted for now**: a passing packet does not
  expire. A gate that passed in May still authorises promotion in
  September under the rule as written. The console surfaces this (it
  warns when the newest packet is not the newest *passing* one), but the
  route does not enforce a freshness bound. Adding a maximum packet age
  is a risk-gate change and therefore needs its own ADR, test, and
  review; it should not be smuggled in with this one. Until then,
  **re-record the gate immediately before promoting.**

## Related documents

- `docs/adr/0002-overlord-copy-trading.md` — §A (gates over weighted
  scores), §G (fill rate as a first-class result), and the roadmap entry
  for PR 11
- `python/nbe_theta/signals/gate.py` — the criteria
- `AGENTS.md` — risk-gate change requirements
