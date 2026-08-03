# NBE-Theta — Polymarket Quant Copy-Trading Platform

Systematic copy trading of top Polymarket traders. Rank on-chain leaders by risk-adjusted edge, mirror their positions through a quant filter, and size every follow with hard risk controls — all observable from a real-time HUD dashboard.

> **Status — reorientation in progress.** The mission is Polymarket quant copy trading. The engine, dashboard, worker, and research sidecar you see here were built for a 24/7 BTC tick-stream strategy on Coinbase Advanced Trade, and **that BTC path is what actually runs today.** The Polymarket leader-ranking, position-mirroring, and CLOB execution layers are being built on top of this same infrastructure. Sections below are tagged **[live]** for what works now and **[building]** for what's incoming, so nothing here overstates what ships. Old BTC/Coinbase commands remain until the Polymarket execution path replaces them.

## What we're building

- **Leader discovery & tracking** — candidate seeding from leaderboards/holders, resumable trade-history backfill, live position + activity tracking for a curated watchlist (`theta-wallet-backfill`, `theta-live-monitor`). _[live]_
- **Leader ranking** — statistically-validated wallet scoring against contemporaneous executable prices (FDR-controlled, walk-forward). _[building — a leaderboard-PnL prior tiers wallets today]_
- **Copy filter** — don't blindly mirror. Pass every candidate follow through a quant layer (regime, sizing, correlation, staleness) before it becomes an order. _[building]_
- **Execution** — place and manage follows on the Polymarket CLOB with the same paper/live safety gating the BTC engine already enforces. _[building]_
- **Risk-first sizing** — fractional-Kelly / vol-targeted position sizing, per-trade risk caps, and an automatic drawdown kill switch. _[live — reusable as-is]_
- **Observability** — real-time dashboard plus the **Smart Money cockpit**: leader roster, conviction board (per-market smart-money consensus with entry-vs-current price rails), and live tape. _[live]_
- **Research** — deterministic backtests and parameter sweeps offline before anything touches capital. _[live for the BTC engine]_

## Stack

- **Next.js 16** (App Router, Turbopack) — HUD dashboard at `http://localhost:4200` _[live]_
- **Node worker** (`worker/`) — long-lived loop: feed → ring-buffer state → strategies → ensemble → risk → execution _[live, BTC feed today]_
- **Python sidecar** (`python/`) — offline backtesting, parameter sweeps, research _[live]_
- **Supabase** (Postgres + Realtime) — orders, fills, positions, signals, backtest runs, logs _[live]_
- **Redis** — hot cache for latest price / book top / equity _[live]_
- **Polymarket CLOB + Gamma APIs** — market data, leader activity, and order placement _[building]_

## Getting started

```bash
# 1. install node deps
pnpm install

# 2. copy and fill env
cp .env.example .env.local

# 3. apply schema (requires supabase CLI linked)
supabase db push

# 4. run dashboard + worker concurrently
pnpm dev:all
# ── dashboard: http://localhost:4200
# ── worker:    headless (currently connects to the Coinbase WS feed)
```

### Commands

| Command | What it does | Status |
| --- | --- | --- |
| `pnpm dev` | Next.js dashboard on **:4200** | live |
| `pnpm dev:worker` | Worker loop with hot reload | live |
| `pnpm paper` | Worker in paper mode (real feed + mock broker, no real orders) | live |
| `pnpm backtest -- --strategy mean-reversion-bb --from 2024-01-01 --to 2024-12-31` | JS backtest | live |
| `pnpm fetch-history -- --symbol BTC-USD --interval 1m --from 2024-01-01` | Pull historical candles | live (BTC) |
| `pnpm test` | Vitest unit tests (indicators, strategies, risk, execution) | live |
| `cd python && uv run backtest --strategy mean_reversion_bb --sweep sweeps/bb.yaml` | Python backtest + parameter sweep | live |

## Trading safety

The worker is **paper by default** — every order routes to the mock broker unless you explicitly opt into live execution. Live orders require **both** gates to agree:

```bash
COINBASE_MODE=live
COINBASE_LIVE=true
CONFIRM_LIVE=YES
```

Missing any gate routes every order to the mock broker. The dashboard's Settings tab has a second, independent `autonomousExecution` toggle that must also be on. The same dual-gate discipline carries over to the Polymarket execution path as it lands.

Risk defaults (preset: `Aggressive`, see `src/lib/risk/config.ts`):

- $25,000 starting equity
- 2% risk per trade
- 10% daily drawdown → automatic kill switch

Day boundaries use **UTC**.

## Architecture

```
┌──────────────────────────┐       ┌────────────────────────┐
│ Next.js dashboard :4200  │       │ Python sidecar         │
│ Supabase Realtime        │       │  (offline)             │
│ Redis reads              │       │  backtests, sweeps,    │
└────────────┬─────────────┘       │  research              │
             │                     └───────────┬────────────┘
             ▼                                 │
   ┌─────────────────────┐                     │
   │ Supabase + Redis    │◀────────────────────┘
   └─────────┬───────────┘
             │
             ▼
   ┌─────────────────────────────────────────────┐
   │ worker/  (Node, long-lived)                 │
   │  feed → ring-buffers → strategies →         │
   │  ensemble → risk → execution → broker       │
   │                                             │
   │  feed:   Coinbase WS  [live]                │
   │          Polymarket leader stream [building]│
   │  broker: Coinbase Advanced / mock [live]    │
   │          Polymarket CLOB [building]         │
   └─────────────────────────────────────────────┘
```

The worker pipeline (feed → state → signals → risk → execution) is intentionally source- and venue-agnostic. Reorienting to Polymarket means swapping the **feed** (candles → leader activity) and the **broker** (Coinbase → CLOB) while the risk, sizing, kill-switch, ensemble, and observability layers stay put.

## Layout

```
src/
├── app/                    Next.js dashboard + API routes
├── components/dashboard/   Glass HUD (Overview, Positions, Signals, Risk, Settings)
├── lib/
│   ├── signals/            Indicators, strategies, ensemble, master, ring-buffer
│   ├── regime/             Regime classifier + Gaussian HMM
│   ├── risk/               Config, sizer, kill-switch, vol-targeting, fractional-Kelly
│   ├── broker/             BrokerClient interface + Coinbase Advanced + mock
│   ├── feed/               Coinbase WS + historical replay
│   ├── backtest/           Deterministic JS replay + metrics
│   ├── redis/              Hot-cache client
│   └── supabase/           Clients
worker/                     Live worker loop (feed, engine, execution, Supabase sink)
python/                     Offline backtesting + research (uv)
scripts/                    fetch-history, backtest, preflight CLIs
supabase/migrations/        SQL schema
ONCHAIN_THETA_AGENT/        Coinbase AgentKit MCP server (on-chain wallet actions)
```

## Roadmap to Polymarket copy trading

1. **Data** — Polymarket Gamma/CLOB clients for markets, prices, and leader trade history.
2. **Leaders** — wallet discovery + risk-adjusted ranking, persisted to Supabase.
3. **Feed** — replace the Coinbase candle feed with a leader-activity stream into the worker.
4. **Copy filter** — quant gate (regime, correlation, staleness, sizing) between a leader's fill and our follow.
5. **Execution** — CLOB order placement behind the existing dual-gate paper/live safety.
6. **Dashboard** — leaders board, per-leader attribution, and follow ledger in the HUD.

Steps 1–5 build on the risk, sizing, and observability layers that already ship today.
