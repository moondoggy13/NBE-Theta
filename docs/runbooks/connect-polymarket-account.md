# Runbook: connect a Polymarket account and wallet

Connects the executor to a real Polymarket account so it can place CLOB
orders. Read-only verification is safe to run at any time; the steps
that arm live trading are marked and are deliberately separate.

**Who runs this:** an operator with access to the executor's host.

**What this runbook does NOT do:** it does not start copy trading. The
account being connected and the system being allowed to trade are two
different things, and the second has prerequisites that are not met yet
— see [What still gates live trading](#what-still-gates-live-trading) at
the end. Read that section before step 5.

---

## Rule zero: the key never leaves the host

The signer's private key is the account. Anyone holding it can move the
funds, and there is no revocation.

- It goes **only** onto the executor's host, as a mounted file or an env
  var in that container.
- It never goes into the repository, a commit, a pull request, a chat
  session, a CI secret, an issue, or the web process. `apps/web` must
  never hold a private key (AGENTS.md).
- Do not paste it into a terminal where shell history is on, and do not
  send it to anyone — including an AI assistant working on this
  repository. Nothing in this system ever needs to be shown the key;
  everything below is verified from the *derived* address.

CI runs a secret scan over every commit on every push, and
`.gitignore` covers `*.key`, `*.pem`, `**/signer*.json`,
`**/keystore*.json`, `**/wallet-secret*`, `apps/executor/.secrets/` and
`secret*/`. Those are a backstop, not permission to be careless: a key
committed and then removed is still a leaked key, because the object
stays in the history.

---

## Step 1 — Work out which account shape you have

Polymarket accounts come in two shapes, and **the key alone cannot tell
you which you have.** Choosing wrong signs technically valid orders for
the wrong owner, so this is the first thing to establish.

| How the account was made | `POLYMARKET_SIGNATURE_TYPE` | Who holds the collateral |
| --- | --- | --- |
| Signed up on polymarket.com (email, Google, or wallet connect) | `poly-proxy` | A **proxy** wallet the signer controls |
| A bare key you funded with USDC directly | `eoa` | The signer's own address |
| A Gnosis Safe you control | `gnosis-safe` | The Safe |

Almost every human account is `poly-proxy`.

To confirm: open your Polymarket account page and find the **deposit
address**. If it is *not* the address of the key you are about to use,
you have a proxied account and that deposit address is your funder
address.

There is no default for this setting. Omitting it is a startup error on
purpose.

---

## Step 2 — Put the key on the host

Preferred — a mounted file:

```bash
# On the executor host, as the user that runs the executor.
install -d -m 700 /run/secrets
umask 077
cat > /run/secrets/polymarket-signer      # paste the key, then Ctrl-D
chmod 400 /run/secrets/polymarket-signer
```

Using `cat` rather than `echo "$KEY" > file` keeps the key out of shell
history. A trailing newline is fine — the loader trims it, because a
file written with `echo` always has one and a key with a stray `\n`
fails signature verification with no useful diagnostic from the venue.

A file is preferred over an env var because an env var is visible to
anything that can read the process table or run `docker inspect`, is
inherited by every child process, and lands in crash dumps. If your host
cannot mount files, `SIGNER_PRIVATE_KEY` is supported instead.

Set exactly one of the two. Setting both is a startup error rather than
a precedence rule: a stale env var silently beating a freshly rotated
file is the exact failure a rotation exists to prevent.

---

## Step 3 — Configure the executor

In the executor's environment only (see `.env.example` for the annotated
list):

```bash
SIGNER_PRIVATE_KEY_FILE=/run/secrets/polymarket-signer
POLYMARKET_SIGNATURE_TYPE=poly-proxy
POLYMARKET_FUNDER_ADDRESS=<the deposit address from step 1>
```

Leave `POLYMARKET_API_KEY` / `_SECRET` / `_PASSPHRASE` unset. The
executor performs the L1 → L2 handshake at startup: the signer proves
control of the address with an EIP-712 signature and the venue returns
HMAC credentials. That call is idempotent, so an account that already
has credentials gets the same ones back and this is safe on every boot.

Set all three or none. A partial triple is a startup error, because the
two values you did set would otherwise be silently ignored and the
mismatch would surface later as an opaque signing failure.

The host must be able to reach `clob.polymarket.com` and
`data-api.polymarket.com` over HTTPS. Both URLs are required to be
`https` — the L2 auth headers are HMACs and would otherwise travel in
clear text.

---

## Step 4 — Verify, before anything can trade

```bash
pnpm executor:preflight
```

This is read-only. It places no order, signs no transaction and moves no
funds. It exits non-zero unless every check passes, so it can gate a
deploy.

It deliberately does **not** require the three live flags. Reading your
own balance is not an order, and requiring the flags to verify a
connection would force you to arm live trading in order to find out
whether your key even works.

A healthy run:

```
Polymarket connection preflight

[  ok  ] credentials_resolved: signature type 'poly-proxy', chain 137
[  ok  ] venue_handshake: signer 0x… completed the L1 handshake
[  ok  ] account_identity: signer 0x… trades for funder 0x…
[  ok  ] api_credentials: derived from the signer key at startup (idempotent)
[  ok  ] l2_authentication: authenticated read succeeded; 0 open order(s)
[  ok  ] collateral_funded: 250.5 USDC available
[  ok  ] collateral_allowance: exchange allowance 1000000…

verdict: connected
account_id: 0x…
  (pass this to the Python signal producer; it is not defaulted)

live gate: not armed (missing: EXECUTION_PROVIDER=polymarket-clob, …)
```

Three verdicts, and the precedence is `blocked` > `incomplete` >
`connected` — the same ordering as the shadow gate (ADR-0003) and the
alpha gate (ADR-0005), for the same reason. A check that could not run
has not passed: if `incomplete` collapsed into `connected`, a venue
outage during preflight would read as a clean bill of health.

### Reading a failure

| Check | Failure means | Fix |
| --- | --- | --- |
| `credentials_resolved` | The environment is wrong or incomplete. The message names the variable. | Re-read step 3. Key-length errors are almost always a truncated paste or a missing `0x`. |
| `venue_handshake` | The signer could not complete L1 against the CLOB. | Check egress from the host to `clob.polymarket.com` **before** suspecting the key. A blocked or geo-restricted network presents here. |
| `account_identity` | The signature type and the funder address contradict each other. | The dangerous one. A proxied scheme pointed at the signer's own address signs valid orders against an account holding nothing. Go back to step 1. |
| `l2_authentication` | The venue rejected a signed request. | A 401 with a valid key usually means the signature type or funder address does not match the account the credentials belong to. |
| `collateral_funded` | No USDC at the funder address. | Deposit USDC to the address the report prints. |
| `collateral_allowance` | **The account holds USDC the exchange cannot spend.** | Approve the exchange contracts — see below. |

### The allowance check

An account can hold USDC and still be unable to trade, because the
exchange contracts were never approved to move it. The venue reports
that as a rejected order rather than as a configuration problem, which
is why preflight checks it up front.

Three contracts need approval: the **CTF Exchange**, the **Neg Risk CTF
Exchange** and the **Neg Risk Adapter**. Neg-risk markets settle through
a different contract, so an account approved for only the first cannot
trade a large share of the venue.

The simplest way to set all of them is to **place one small trade
manually on polymarket.com with the same account**. The web app prompts
for every approval it needs on first trade. Do that once, then re-run
preflight.

A partial allowance (`incomplete`, not a failure) trades until the
allowance is exhausted and then starts refusing mid-session, which looks
like an outage. Re-approve for an unlimited allowance.

### `account_id`

The report prints the `account_id` every durable row is keyed by
(`venue_orders`, `venue_positions`, `account_snapshots`) and that the
Python signal producer takes. It is the **funder** address — the wallet
that actually holds the collateral.

It is not defaulted anywhere, deliberately (ADR-0007): an intent
submitted against the wrong account should not be reachable by
forgetting an argument.

---

## Step 5 — Arming live trading (do not do this yet)

Connecting the account does not arm it. The executor's venue adapter
refuses to even construct unless all three of these are present:

```bash
EXECUTION_PROVIDER=polymarket-clob
POLYMARKET_LIVE=true
CONFIRM_LIVE=YES
```

Checked at construction rather than at submit, on purpose: an adapter
that exists but refuses individual orders is a loaded gun with the
safety on; one that cannot be built at all is unloaded. CI never sets
any of the three.

The flags are necessary and **not sufficient**. ADR-0002 also requires
the console's operating mode set to `live` with two-step confirmation, a
recorded `shadow_gate_runs` row whose verdict is `pass`, and documented
compliance approval for the operating jurisdiction. `/api/console/mode`
enforces the gate row and fails closed on a query error.

---

## What still gates live trading

Connecting the account closes the credential gap. These remain, and none
is a configuration change:

1. **The return half of the execution seam does not exist.**
   `venue_orders` and `venue_fills` are written by nothing and read by
   nothing (ADR-0007, "The other half is still open"). An intent can be
   enqueued, claimed and dispatched, but the resulting order and fill
   never land in the database, so **no live lot is ever opened from a
   real fill**. Until that is built, `mode = 'live'` produces orders the
   system does not record — and every cap, drawdown halt and NAV figure
   is computed against the lot book.

2. **The shadow gate has no passing run.** Promotion needs a recorded
   `shadow_gate_runs` row with verdict `pass`, over a window in which
   the system actually did something. The gate's third state exists
   precisely so an empty window cannot promote anything.

3. **The alpha gate has not been run against real history**
   (ADR-0005). It stays unrun rather than being fed synthetic fixtures,
   because a lift computed from invented data is indistinguishable in
   the output from a real one.

4. **The producer has never run against a live signal stream.** ADR-0007
   records this as the known cost of shadow not enqueuing, and
   prescribes the drill: set mode to `live` with the executor's
   three-flag gate **unset**, let intents accumulate and expire
   unclaimed, and inspect them. Run that before arming.

Item 1 is the next piece of work.

---

## Rotating or revoking the key

There is no venue-side revocation for a signer key — the key *is* the
account. To rotate:

1. Move the funds to a new wallet (on Polymarket, withdraw and deposit
   to the new account).
2. Put the new key on the host as in step 2, overwriting the old file.
3. Unset `POLYMARKET_API_KEY` / `_SECRET` / `_PASSPHRASE` if they were
   set explicitly, so the L2 credentials are re-derived for the new
   signer. Credentials derived for the old key will not authenticate
   for the new one.
4. Update `POLYMARKET_FUNDER_ADDRESS` to the new account's deposit
   address.
5. Re-run `pnpm executor:preflight` and confirm the printed
   `account_id` is the new one before restarting the executor.

If you believe the key has leaked, move the funds first and worry about
the configuration second.

## Related

- `.env.example` — the annotated variable list
- `docs/adr/0002-overlord-copy-trading.md` — the execution seam, and the live gate
- `docs/adr/0007-intent-producer.md` — what `mode = 'live'` does, and what is still missing
- `docs/runbooks/executor-recovery.md` — recovering a stuck executor
- `apps/executor/src/venues/credentials.ts` — the loader, and why each rule exists
