# agent-host

Runs on your **trading workstation** — the machine that has Webull desktop
installed and signed in. This is the only process with OS-level input
access; the rest of the NBE-Theta repo treats it as an opaque RPC target.

## Architecture

```
worker (any machine)
  └── ComputerUseBrokerClient ──HTTP POST /orders──► agent-host
                              ◄────WS /events fills─┘
                                                    │
                                                    ▼
                                          driver (claude | openai)
                                              screenshot → tool call → ...
                                                    │
                                                    ▼
                                            Webull desktop window
```

See `src/lib/broker/computer-use.ts` for the client side and the wire
contract.

## Why a separate process

1. **Credentials boundary** — Webull session / 2FA stays on this box.
2. **OS access** — needs accessibility APIs and window capture, which
   the Next.js worker doesn't have in containerized deploys.
3. **Driver swap** — switching Claude ↔ OpenAI is a one-config change
   here without touching the worker.

## Layout (scaffolded; some files are placeholders)

- `index.ts` — HTTP + WS server, order queue.
- `drivers/types.ts` — `CUADriver` interface (provider-agnostic).
- `drivers/claude.ts` — Anthropic computer-use loop.
- `drivers/openai.ts` — OpenAI computer-use loop (stub).
- `webull/skills.ts` — high-level Webull actions exposed to the model.
- `webull/verifier.ts` — OCR/accessibility check that the ticket fields
  match the order before Submit, and that the fill matches after.
- `safety/preflight.ts` — invariants checked synchronously before any
  click reaches Submit.
- `safety/two-person.ts` — optional manual-confirm gate.

## Rollout

1. `COMPUTER_USE_DRY_RUN=true` — driver fills the ticket but never clicks
   Submit. Run for ≥ 1 week against paper trading.
2. `COMPUTER_USE_MAX_NOTIONAL_USD=50` — un-gate Submit at micro-size.
   Manual confirm required.
3. Raise cap to preset; manual confirm still default-on.

## Running locally

```
cd agent-host
pnpm install
HOST_TOKEN=... ANTHROPIC_API_KEY=... pnpm dev
```
