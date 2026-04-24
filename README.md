# NBE-Theta — BTC Tick-Stream Quant Trading Platform

24/7 high-frequency Bitcoin trading on Coinbase Advanced Trade. Pure-math signal engine, Node tick loop for execution, Python sidecar for research, Next.js HUD dashboard for observability.

## Stack

- **Next.js 16** (App Router, Turbopack) — dashboard at `http://localhost:4200`
- **Node worker** (`worker/`) — long-lived WebSocket ingest → ring-buffer state → strategies → ensemble → execution
- **Python sidecar** (`python/`) — offline backtesting, parameter sweeps, research
- **Supabase** (Postgres + Realtime) — orders, fills, positions, signals, backtest runs, logs
- **Redis** — hot cache for latest price / order-book top / equity

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
# ── worker:    headless, connects to Coinbase WS
```

### Individual commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | Next.js dashboard on **:4200** |
| `pnpm dev:worker` | Tick loop with hot reload |
| `pnpm paper` | Worker in paper-trading mode (Coinbase WS + mock broker) |
| `pnpm backtest -- --strategy mean-reversion-bb --from 2024-01-01 --to 2024-12-31` | JS backtest |
| `pnpm fetch-history -- --symbol BTC-USD --interval 1m --from 2024-01-01` | Pull historical candles |
| `pnpm test` | Vitest unit tests (indicators + strategies) |
| `cd python && uv run backtest --strategy mean_reversion_bb --sweep params.yaml` | Python backtest + parameter sweep |

## Trading safety

Live orders require **both** flags:

```bash
COINBASE_LIVE=true
CONFIRM_LIVE=YES
```

Missing either flag routes every order to the mock broker. The dashboard's Settings tab has a second, independent toggle (`autonomousExecution`) that must also be on.

Risk defaults (preset: `Aggressive`):

- $25,000 starting equity
- 2% risk per trade
- 10% daily drawdown → automatic kill switch

Day boundaries use **UTC** (crypto is 24/7). See `src/lib/risk/config.ts`.

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
   ┌─────────────────────────────────────────┐
   │ worker/  (Node, long-lived)             │
   │  feed → ring-buffers → strategies →     │
   │  ensemble → risk → execution → broker   │
   └─────────────────────────────────────────┘
```

See `.claude/plans/in-this-project-we-breezy-reddy.md` for the full design.

## Layout

```
src/
├── app/                    Next.js dashboard
├── components/dashboard/   Delta Core glass HUD
├── lib/
│   ├── signals/            Indicators, strategies, ensemble, ring-buffer
│   ├── risk/               Config, sizer, kill-switch
│   ├── broker/             BrokerClient interface + Coinbase + mock
│   ├── feed/               Coinbase WS + historical replay
│   ├── backtest/           Deterministic JS replay + metrics
│   └── supabase/           Clients
worker/                     Live tick loop
python/                     Offline backtesting + research (uv)
scripts/                    fetch-history, backtest, paper CLIs
supabase/migrations/        SQL schema
```
