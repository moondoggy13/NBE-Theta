/**
 * `pnpm executor:preflight` — verify the Polymarket connection.
 *
 * Read-only. Places no order, signs no transaction, moves no funds.
 * Exits non-zero unless every check passed, so it can gate a deploy.
 *
 * This is the only entrypoint in `apps/executor` that constructs a real
 * signing client, and it is deliberately not the one that trades:
 * `index.ts` still has no `main()`, because wiring the outbox loop to a
 * live venue is a separate decision with its own prerequisites
 * (ADR-0002, ADR-0007).
 */

import { createClobSigningClient } from "../venues/clob-client.js";
import { exitCode, formatReport, runPreflight, type PreflightTarget } from "../preflight.js";
import type { ResolvedCredentials } from "../venues/credentials.js";

async function connect(credentials: ResolvedCredentials): Promise<PreflightTarget> {
  const handle = await createClobSigningClient(credentials);
  return {
    signerAddress: handle.signerAddress,
    accountId: handle.accountId,
    apiCredentialsDerived: handle.apiCredentialsDerived,
    collateral: () => handle.collateral(),
    listOpenOrders: () => handle.client.openOrders(),
  };
}

const report = await runPreflight(connect);
// Written to stdout as a block so a CI log keeps it together.
process.stdout.write(`${formatReport(report)}\n`);
process.exit(exitCode(report));
