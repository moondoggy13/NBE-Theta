# ADR-0001: Pivot NBE-Theta to a Polymarket wallet-intelligence platform

- **Status**: Accepted
- **Date**: 2026-07-18
- **Deciders**: repository owner
- **Supersedes**: implicit "BTC candle system" architecture in `main` at `btc-v1-final`

## Context

NBE-Theta was built as a single-symbol BTC trading system: Coinbase tick
feed → single-symbol ring buffers → BTC strategies + ensemble → global
risk state → single-position `ExecutionManager` → Coinbase or synchronous
mock broker → Supabase. It works, but the shape of the data it consumes
(OHLC on a continuously-marked asset) is not where the interesting edge
lives for us.

Polymarket is a public prediction market where:

- every trade is signed on-chain (Polygon), so wallet histories are
  fully reconstructable from public data;
- outcomes resolve to a known truth, so trader skill can be measured
  against ground truth rather than only against price movement;
- the CLOB V2 order book is public and well-documented, so paper
  simulation with realistic latency and slippage is feasible.

The hypothesis worth investigating is whether a subset of Polymarket
wallets consistently forecast outcomes better than the market implies,
and whether their trades — combined with statistical validation — can
inform conservative copy-signals.

## Decision

Reorient NBE-Theta into a Polymarket-focused three-layer platform:

1. **Intelligence** — collect market/wallet/trade/on-chain data from
   Polymarket's Gamma API, Data API, CLOB V2 API, and Polygon settlement
   logs. Full-chain indexing is targeted (only for meaningful wallets)
   in the initial cut; a full historical Polygon backfill is deferred
   behind wallet-validation evidence.
2. **Signal** — score wallets against contemporaneous executable prices,
   not raw hit rates. Uses empirical Bayesian priors, event-block
   bootstrap, Benjamini–Hochberg FDR, and out-of-sample walk-forward.
   Explicit strategy families (`wallet_follow`,
   `wallet_cluster_confirmation`, `fast_information_alert`,
   `market_microstructure`, later `news_probability` and
   `future_cross_venue_arbitrage`) emit typed signal envelopes with
   `schema_version`, evidence lineage, and `model_version`.
3. **Execution** — independently approves and places CLOB orders through
   a durable execution-intent outbox, with strict per-instrument locks
   and an explicit emergency state machine (`RUNNING →
   PAUSE_NEW_ENTRIES → CANCEL_OPEN_ORDERS → REDUCE_ONLY →
   EMERGENCY_FLATTEN → HALTED`). No reflexive flatten; kill sequence
   only reduces when it improves expected worst-case loss.

The rebuild is a modular monolith with separate processes (web,
executor, Python worker) sharing one PostgreSQL and one repository —
not a microservice system. Redis is deferred until measured need.

## Rollout constraint (additive only)

Nothing destructive lands until replacements exist and are tested. The
current BTC system is frozen behind the git tag `btc-v1-final`. The
rebuild happens on `rebuild/polymarket-v2` via additive migrations
(`007_*` and onward) and new process directories. Existing tables
(`orders`, `fills`, `positions`, `pnl_snapshots`, `risk_state`, etc.)
remain in place; the new executor writes to new tables
(`venue_orders`, `venue_fills`, `venue_positions`, `execution_intents`,
etc.). A follow-up PR after Phase 6 archives the BTC tables once the
new execution path has run under paper conditions for a validation
window.

## Consequences

- **Positive**: separates concerns cleanly; validates the central
  hypothesis (wallet-follow alpha) before spending on a full Polygon
  indexer; keeps the dashboard shell + Supabase realtime; keeps the
  race-condition lessons from the v3 `ExecutionManager` (`worker/execution.ts:1-23`)
  as regression tests against a new coordinator; keeps a Git-history
  path back to a known-good BTC state.
- **Negative**: two-language stack (TS + Python) with a shared-contract
  seam adds moving parts; walk-forward + FDR analysis is nontrivial and
  slows the first useful backtest; no ability to trade live until the
  composite live-capability gate passes.
- **Risk**: the wallet-follow hypothesis may not survive out-of-sample
  validation. PR 5 has an explicit "stop-and-evaluate" gate. If the
  evidence isn't there, we halt further investment before building the
  chain indexer or execution stack.

## Non-goals for this rebuild

- No polymarket.com computer-use driver (framework kept dormant).
- No multi-chain support (Polygon only).
- No Kalshi / other venues (domain stays neutral; second venue not
  implemented in this rebuild).
- No LLM-based signal ideation (news intelligence lands as a later
  strategy, not as an undocumented modifier on wallet scores).

## Related documents

- Plan file: `/root/.claude/plans/binary-discovering-church.md`
  (approved plan for this rebuild)
- `AGENTS.md`, `CLAUDE.md` — the development contract enforced by
  reviewers and CI
- Successor ADRs will live under `docs/adr/000N-*.md`
