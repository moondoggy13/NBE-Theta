/**
 * Connection preflight: prove the account is wired correctly *before*
 * anything can place an order.
 *
 * Every check here is read-only. Nothing in this file signs an order,
 * and nothing in it moves funds.
 *
 * ## Why this does not require the live gate
 *
 * `PolymarketClobVenue` refuses to construct without
 * `EXECUTION_PROVIDER=polymarket-clob && POLYMARKET_LIVE=true &&
 * CONFIRM_LIVE=YES`, and that stays true. Preflight deliberately does
 * not go through it. Reading your own balance is not an order, and
 * requiring the three flags to *verify* a connection would force an
 * operator to arm live trading in order to find out whether their
 * credentials were even valid — discovering a mistyped funder address
 * from a rejected real order instead of from a check. The flags gate
 * placing orders; they do not gate looking.
 *
 * The gate's state is still reported, because an operator reading this
 * output wants to know both "is the account connected" and "would it
 * trade". They are separate questions and conflating them is how a
 * system gets armed by accident.
 *
 * ## Three states, same reason as the gates
 *
 * ADR-0003 and ADR-0005 both refuse a two-valued verdict, and the
 * arithmetic is the same here. A check that could not run has not
 * passed. If `unknown` collapsed into `ok`, a venue outage during
 * preflight would read as a clean bill of health — every probe returns
 * nothing, nothing contradicts anything, and the report says ready.
 * `unknown` is therefore its own state and it blocks "connected".
 *
 * Precedence is `fail` > `unknown` > `ok`, matching
 * `signals/gate.py`'s `fail` > `insufficient_evidence` > `pass`.
 */

import { readLiveGate, type EnvLike, type LiveGate } from "./config.js";
import {
  CredentialError,
  describeCredentials,
  isProxiedScheme,
  loadCredentials,
  type ResolvedCredentials,
} from "./venues/credentials.js";

export type CheckState = "ok" | "fail" | "unknown";

export interface Check {
  name: string;
  state: CheckState;
  detail: string;
  /** What to do about it. Absent when the check passed. */
  remedy?: string;
}

export type PreflightVerdict = "connected" | "incomplete" | "blocked";

export interface PreflightReport {
  verdict: PreflightVerdict;
  checks: Check[];
  /** Present once the key has been loaded and the address derived. */
  signerAddress: string | null;
  /**
   * The value to pass to the Python producer as `account_id`, and the
   * key every `venue_orders` / `venue_positions` row carries. Null until
   * identity resolves.
   */
  accountId: string | null;
  /** Reported, never required by this report's verdict. */
  liveGate: LiveGate;
  /** Log-safe echo of the configuration. Never contains key material. */
  configuration: Record<string, unknown> | null;
}

/**
 * What preflight needs from a connected client.
 *
 * Narrower than `ClobSigningClient` on purpose: a test fake for this is
 * four members, so there is no excuse for skipping the test, and nothing
 * in this interface can place an order even by accident.
 */
export interface PreflightTarget {
  signerAddress: string;
  accountId: string;
  apiCredentialsDerived: boolean;
  collateral(): Promise<{ balance: string; allowance: string }>;
  listOpenOrders(): Promise<unknown[]>;
}

export type Connect = (credentials: ResolvedCredentials) => Promise<PreflightTarget>;

function worst(checks: readonly Check[]): PreflightVerdict {
  if (checks.some((c) => c.state === "fail")) return "blocked";
  if (checks.some((c) => c.state === "unknown")) return "incomplete";
  return "connected";
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Parses a decimal amount reported by the venue.
 *
 * Returns `null` rather than 0 when the value is unusable. The
 * distinction matters for exactly the reason CLAUDE.md gives for
 * `clv`/`markout_*`: "unmeasured" and "zero" are different claims, and
 * a missing balance read as zero would report a funded account as
 * empty.
 */
function parseAmount(raw: string): number | null {
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Runs every check and returns a report. Never throws for a failed
 * check — a thrown preflight tells the operator nothing about which
 * part is wrong, which is the whole value of running it.
 */
export async function runPreflight(
  connect: Connect,
  env: EnvLike = process.env,
): Promise<PreflightReport> {
  const liveGate = readLiveGate(env);
  const checks: Check[] = [];

  // ── 1. credentials ───────────────────────────────────────────────
  let credentials: ResolvedCredentials;
  try {
    credentials = loadCredentials(env);
    checks.push({
      name: "credentials_resolved",
      state: "ok",
      detail: `signature type '${credentials.signatureType}', chain ${credentials.chainId}`,
    });
  } catch (err) {
    const detail = message(err);
    return {
      verdict: "blocked",
      checks: [
        {
          name: "credentials_resolved",
          state: "fail",
          detail,
          remedy:
            err instanceof CredentialError
              ? "fix the executor's environment; see docs/runbooks/connect-polymarket-account.md"
              : "unexpected failure reading credentials",
        },
      ],
      signerAddress: null,
      accountId: null,
      liveGate,
      configuration: null,
    };
  }

  const configuration = describeCredentials(credentials);

  // ── 2. connect (derives the signer address, completes L1 → L2) ───
  let target: PreflightTarget;
  try {
    target = await connect(credentials);
    checks.push({
      name: "venue_handshake",
      state: "ok",
      detail: `signer ${target.signerAddress} completed the L1 handshake`,
    });
  } catch (err) {
    // One check rather than two because the local step (deriving an
    // address from the key) cannot realistically fail once the key has
    // been validated — the failure that lands here is almost always the
    // network one, so the name reflects that.
    checks.push({
      name: "venue_handshake",
      state: "fail",
      detail: message(err),
      remedy:
        `the signer could not complete the L1 handshake against ${credentials.clobBaseUrl}. ` +
        "Check egress from this host to the venue before suspecting the key",
    });
    return {
      verdict: "blocked",
      checks,
      signerAddress: null,
      accountId: null,
      liveGate,
      configuration,
    };
  }

  // ── 3. account identity ──────────────────────────────────────────
  // The single most consequential misconfiguration: a valid key paired
  // with the wrong funder signs perfectly good orders for an account
  // that is not the one holding the money.
  const proxied = isProxiedScheme(credentials.signatureType);
  if (proxied) {
    checks.push(
      target.accountId === target.signerAddress
        ? {
            name: "account_identity",
            state: "fail",
            detail:
              `signature type '${credentials.signatureType}' expects the collateral at a proxy, ` +
              "but the funder address is the signer's own",
            remedy:
              "set POLYMARKET_FUNDER_ADDRESS to the deposit address on your Polymarket account page",
          }
        : {
            name: "account_identity",
            state: "ok",
            detail: `signer ${target.signerAddress} trades for funder ${target.accountId}`,
          },
    );
  } else {
    // eoa: the funder is the signer by definition. A configured funder
    // that disagrees is a contradiction, not a preference.
    const configured = credentials.funderAddress;
    checks.push(
      configured && configured !== target.signerAddress
        ? {
            name: "account_identity",
            state: "fail",
            detail:
              `signature type 'eoa' trades the signer's own balance (${target.signerAddress}), ` +
              `but POLYMARKET_FUNDER_ADDRESS is ${configured}`,
            remedy:
              "either unset POLYMARKET_FUNDER_ADDRESS, or switch POLYMARKET_SIGNATURE_TYPE to " +
              "'poly-proxy' if the collateral really does live at a proxy",
          }
        : {
            name: "account_identity",
            state: "ok",
            detail: `eoa trades its own balance at ${target.signerAddress}`,
          },
    );
  }

  checks.push({
    name: "api_credentials",
    state: "ok",
    detail: target.apiCredentialsDerived
      ? "derived from the signer key at startup (idempotent)"
      : "supplied via POLYMARKET_API_KEY/_SECRET/_PASSPHRASE",
  });

  // ── 4. L2 authentication ─────────────────────────────────────────
  // An authenticated read is the cheapest proof that the HMAC
  // credentials actually work against this account. Placing and
  // cancelling a test order would prove more and is explicitly not done.
  try {
    const open = await target.listOpenOrders();
    checks.push({
      name: "l2_authentication",
      state: "ok",
      detail: `authenticated read succeeded; ${open.length} open order(s)`,
    });
  } catch (err) {
    checks.push({
      name: "l2_authentication",
      state: "fail",
      detail: message(err),
      remedy:
        "the venue rejected the signed request. A 401 here with a valid key usually means the " +
        "signature type or funder address does not match the account the credentials belong to",
    });
  }

  // ── 5. collateral and allowance ──────────────────────────────────
  try {
    const { balance, allowance } = await target.collateral();
    const bal = parseAmount(balance);
    const allow = parseAmount(allowance);

    if (bal === null || allow === null) {
      checks.push({
        name: "collateral",
        state: "unknown",
        detail: `venue returned unparseable amounts (balance=${balance}, allowance=${allowance})`,
        remedy: "re-run; if it persists the venue's response shape has changed",
      });
    } else {
      checks.push(
        bal > 0
          ? { name: "collateral_funded", state: "ok", detail: `${balance} USDC available` }
          : {
              name: "collateral_funded",
              state: "fail",
              detail: "no USDC collateral at the funder address",
              remedy: `deposit USDC to ${target.accountId}`,
            },
      );

      // The approval check. An unapproved account holds money it cannot
      // spend, and the venue reports that as a rejected order rather
      // than as a configuration problem — so it belongs here, before
      // any order exists.
      if (allow <= 0) {
        checks.push({
          name: "collateral_allowance",
          state: "fail",
          detail: "the exchange has no allowance over this account's USDC",
          remedy:
            "approve the CTF Exchange, Neg Risk CTF Exchange and Neg Risk Adapter to spend USDC. " +
            "Placing one manual trade on polymarket.com sets all three; see the runbook",
        });
      } else if (bal > 0 && allow < bal) {
        // Not a failure: a partial allowance trades until it is
        // exhausted. It is reported because the resulting rejection
        // arrives mid-session and looks like an outage.
        checks.push({
          name: "collateral_allowance",
          state: "unknown",
          detail: `allowance ${allowance} is below the balance ${balance}; orders will be refused once it is used up`,
          remedy: "re-approve the exchange contracts for an unlimited allowance",
        });
      } else {
        checks.push({
          name: "collateral_allowance",
          state: "ok",
          detail: `exchange allowance ${allowance}`,
        });
      }
    }
  } catch (err) {
    checks.push({
      name: "collateral",
      state: "unknown",
      detail: message(err),
      remedy: "the balance endpoint could not be reached; this check did not run",
    });
  }

  return {
    verdict: worst(checks),
    checks,
    signerAddress: target.signerAddress,
    accountId: target.accountId,
    liveGate,
    configuration,
  };
}

/**
 * Renders a report for a terminal.
 *
 * Kept separate from `runPreflight` so the report stays a value — it can
 * be asserted on in a test, written to `account_snapshots`, or shown in
 * the console without going through a string.
 */
export function formatReport(report: PreflightReport): string {
  const mark = (s: CheckState): string =>
    s === "ok" ? "  ok  " : s === "fail" ? " FAIL " : "  ??  ";

  const lines: string[] = ["Polymarket connection preflight", ""];
  for (const c of report.checks) {
    lines.push(`[${mark(c.state)}] ${c.name}: ${c.detail}`);
    if (c.remedy && c.state !== "ok") lines.push(`           → ${c.remedy}`);
  }

  lines.push("");
  lines.push(`verdict: ${report.verdict}`);
  if (report.accountId) {
    lines.push(`account_id: ${report.accountId}`);
    lines.push("  (pass this to the Python signal producer; it is not defaulted)");
  }

  lines.push("");
  lines.push(
    report.liveGate.satisfied
      ? "live gate: ARMED — this environment is allowed to place real orders"
      : `live gate: not armed (missing: ${report.liveGate.missing.join(", ")})`,
  );
  if (report.verdict === "connected" && !report.liveGate.satisfied) {
    lines.push(
      "  The account is connected. Arming live trading is a separate, deliberate step and",
      "  has its own prerequisites — see docs/runbooks/connect-polymarket-account.md.",
    );
  }
  return lines.join("\n");
}

/** Exit code for a shell: 0 only when every check passed. */
export function exitCode(report: PreflightReport): number {
  return report.verdict === "connected" ? 0 : 1;
}
