/**
 * Signer credentials for the Polymarket CLOB.
 *
 * This module is where the operator's account becomes a value the
 * executor can use, and it is deliberately the only place that reads
 * key material. It does no network and no chain access, so it is fully
 * unit-testable — which matters, because every failure mode here is
 * silent and expensive:
 *
 * - A key with a stray newline (the classic `echo` into a file) signs
 *   nothing; you get an opaque 401 from an endpoint that will not tell
 *   you why.
 * - A **funder address that is not the wallet holding the collateral**
 *   produces correctly-signed orders against an account with no money.
 *   The venue rejects them, which looks like a connectivity fault and is
 *   not.
 * - Worse, a funder address belonging to a *different* wallet you
 *   control trades the wrong account, successfully, with no error at
 *   all.
 *
 * So the rule here is that an ambiguous configuration is a startup
 * failure, never a default. There is no "best guess" branch in this
 * file.
 *
 * ## Why signature type is explicit and has no default
 *
 * Polymarket accounts come in two shapes that are indistinguishable
 * from the key alone:
 *
 * - A plain EOA trades its own balance. Signer address == funder
 *   address.
 * - An account created through polymarket.com trades a **proxy** the
 *   EOA controls. Signer address != funder address, and the funder is
 *   the proxy. This is what almost every human account is.
 *
 * Both configurations are valid; guessing between them is not. Pick the
 * wrong one and the orders are signed under a scheme the exchange
 * resolves to the wrong owner. `POLYMARKET_SIGNATURE_TYPE` is therefore
 * required, and `preflight.ts` cross-checks the declared type against
 * the addresses that actually derive.
 *
 * ## Secret handling
 *
 * The key is wrapped in `Secret`, which renders as `[redacted]` through
 * `String()`, template interpolation, `JSON.stringify` and
 * `console.log`. That is not a substitute for not logging it — it is the
 * backstop for the one line that eventually does, because structured
 * loggers serialise whole config objects and a `catch` block will
 * happily print the thing it was handed.
 */

import { readFileSync } from "node:fs";

/** The three environment keys (plus the file variant) that carry secrets. */
export const SECRET_ENV_KEYS = [
  "SIGNER_PRIVATE_KEY",
  "SIGNER_PRIVATE_KEY_FILE",
  "POLYMARKET_API_SECRET",
  "POLYMARKET_API_PASSPHRASE",
] as const;

/**
 * A string that does not print.
 *
 * `#value` is a true private field, so it is invisible to
 * `JSON.stringify` and to object spread. `toString`/`toJSON` and the
 * Node inspect hook cover the three ways a value reaches a log line.
 * Read it with `reveal()` — a verb, so a reviewer can grep for every
 * place the plaintext is actually taken out.
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return "[redacted]";
  }

  toJSON(): string {
    return "[redacted]";
  }

  /**
   * `util.inspect` (and therefore `console.log`) honours this symbol.
   * Referenced via `Symbol.for` so this module needs no `node:util`
   * import and stays runtime-agnostic.
   */
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "[redacted]";
  }
}

/**
 * Polymarket's signature schemes, by name rather than by magic number.
 *
 * The numeric values are the venue's (`SignatureType` in
 * `@polymarket/clob-client`) and must not be renumbered. Names exist
 * because `POLYMARKET_SIGNATURE_TYPE=1` in a deploy config is
 * unreviewable — `poly-proxy` is not.
 */
export const SIGNATURE_TYPES = {
  /** Plain EOA signing for its own balance. Funder == signer. */
  eoa: 0,
  /** EOA signing for the Polymarket proxy it controls (web signups). */
  "poly-proxy": 1,
  /** EOA signing for a Gnosis Safe it controls. */
  "gnosis-safe": 2,
  /** Contract account implementing EIP-1271. */
  "poly-1271": 3,
} as const;

export type SignatureTypeName = keyof typeof SIGNATURE_TYPES;

/** Schemes whose collateral lives at an address other than the signer's. */
const PROXIED_SCHEMES: ReadonlySet<SignatureTypeName> = new Set([
  "poly-proxy",
  "gnosis-safe",
  "poly-1271",
]);

export interface ApiCredentials {
  key: string;
  secret: Secret;
  passphrase: Secret;
}

export interface ResolvedCredentials {
  /** EIP-712 signing key. Never leaves this process. */
  privateKey: Secret;
  signatureType: SignatureTypeName;
  /** Numeric form the venue client wants. */
  signatureTypeValue: number;
  /**
   * The wallet that holds the collateral and the positions. Absent only
   * for `eoa`, where it is the signer's own address and is filled in
   * once the key is loaded (see `preflight.ts`).
   */
  funderAddress: string | null;
  /**
   * L2 credentials. Absent means "derive them from the key at startup",
   * which is supported and idempotent for an account that already has
   * them.
   */
  apiCredentials: ApiCredentials | null;
  clobBaseUrl: string;
  dataApiBaseUrl: string;
  chainId: number;
}

export class CredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialError";
  }
}

export type EnvLike = Readonly<Record<string, string | undefined>>;

/** Reads a mounted secret file. Injected so tests need no filesystem. */
export type FileReader = (path: string) => string;

const PRIVATE_KEY_RE = /^0x[0-9a-f]{64}$/;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;

/** Polygon mainnet. Amoy (80002) is the only other value the venue knows. */
export const POLYGON_CHAIN_ID = 137;
const KNOWN_CHAIN_IDS = new Set([POLYGON_CHAIN_ID, 80002]);

const DEFAULT_CLOB_BASE_URL = "https://clob.polymarket.com";
const DEFAULT_DATA_API_BASE_URL = "https://data-api.polymarket.com";

function trimmed(env: EnvLike, key: string): string | null {
  const raw = env[key];
  if (raw === undefined) return null;
  const value = raw.trim();
  return value === "" ? null : value;
}

/**
 * Normalises a hex string for comparison: lowercased, `0x`-prefixed.
 *
 * Addresses are reported in mixed EIP-55 checksum case by nearly every
 * tool a human copies from, and `"0xAbC…" !== "0xabc…"` is a comparison
 * that silently fails open — it would let the funder/signer consistency
 * check in `preflight.ts` pass two different-looking spellings of one
 * address, or fail two identical ones. One address, one identity.
 */
export function normalizeHex(value: string): string {
  const s = value.trim().toLowerCase();
  return s.startsWith("0x") ? s : `0x${s}`;
}

/**
 * Loads the private key from `SIGNER_PRIVATE_KEY_FILE` (preferred) or
 * `SIGNER_PRIVATE_KEY`.
 *
 * The file form is preferred because an env var is visible to anything
 * that can read the process table or run `docker inspect`, is inherited
 * by every child process, and lands in crash dumps. A mounted file is
 * readable by the process and nothing else. Both are supported because
 * not every host offers file mounts.
 *
 * Setting both is an error rather than a precedence rule: two sources
 * of one secret means nobody can say from the config which key is in
 * use, and a stale env var silently winning over a freshly rotated file
 * is the exact failure a rotation is supposed to prevent.
 */
function loadPrivateKey(env: EnvLike, readFile: FileReader): Secret {
  const inline = trimmed(env, "SIGNER_PRIVATE_KEY");
  const path = trimmed(env, "SIGNER_PRIVATE_KEY_FILE");

  if (inline && path) {
    throw new CredentialError(
      "both SIGNER_PRIVATE_KEY and SIGNER_PRIVATE_KEY_FILE are set; " +
        "set exactly one so the key in use is unambiguous",
    );
  }
  if (!inline && !path) {
    throw new CredentialError(
      "no signer key: set SIGNER_PRIVATE_KEY_FILE (preferred) or SIGNER_PRIVATE_KEY",
    );
  }

  let raw: string;
  if (path) {
    try {
      raw = readFile(path);
    } catch (err) {
      // The path is safe to echo; the contents are not.
      throw new CredentialError(
        `SIGNER_PRIVATE_KEY_FILE (${path}) could not be read: ` +
          (err instanceof Error ? err.message : "unknown error"),
      );
    }
  } else {
    raw = inline as string;
  }

  // Trimming is deliberate and is the single most common fix: a file
  // written with `echo` ends in a newline, and a key with a trailing
  // \n fails signature verification with no diagnostic from the venue.
  const key = normalizeHex(raw);
  if (!PRIVATE_KEY_RE.test(key)) {
    // Length is safe to report and is almost always the actual problem
    // (truncated paste, 0x missing, whole keystore JSON in the file).
    // The value itself is never included.
    throw new CredentialError(
      `signer key is not a 32-byte hex key: expected 0x + 64 hex chars, got ${key.length} chars`,
    );
  }
  return new Secret(key);
}

function loadSignatureType(env: EnvLike): SignatureTypeName {
  const raw = trimmed(env, "POLYMARKET_SIGNATURE_TYPE");
  if (!raw) {
    throw new CredentialError(
      "POLYMARKET_SIGNATURE_TYPE is required and has no default. " +
        "Use 'poly-proxy' for an account created on polymarket.com, " +
        "'eoa' for a key that holds its own USDC, 'gnosis-safe' for a Safe. " +
        "Guessing trades the wrong account.",
    );
  }
  const name = raw.toLowerCase();
  if (name in SIGNATURE_TYPES) return name as SignatureTypeName;

  // Numeric form is accepted so the venue's own documentation can be
  // followed literally, but it is normalised to a name immediately.
  const asNumber = Number(name);
  if (Number.isInteger(asNumber)) {
    for (const [key, value] of Object.entries(SIGNATURE_TYPES)) {
      if (value === asNumber) return key as SignatureTypeName;
    }
  }
  throw new CredentialError(
    `POLYMARKET_SIGNATURE_TYPE=${raw} is not a known scheme; ` +
      `expected one of ${Object.keys(SIGNATURE_TYPES).join(", ")}`,
  );
}

function loadFunderAddress(env: EnvLike, signatureType: SignatureTypeName): string | null {
  const raw = trimmed(env, "POLYMARKET_FUNDER_ADDRESS");
  const proxied = PROXIED_SCHEMES.has(signatureType);

  if (!raw) {
    if (proxied) {
      throw new CredentialError(
        `POLYMARKET_FUNDER_ADDRESS is required for signature type '${signatureType}': ` +
          "the collateral lives at the proxy, not at the signer's address. " +
          "It is the deposit address shown on your Polymarket account page.",
      );
    }
    // eoa: the funder IS the signer. Derived from the key rather than
    // trusted from config, so the two cannot disagree.
    return null;
  }

  const address = normalizeHex(raw);
  if (!ADDRESS_RE.test(address)) {
    throw new CredentialError(
      `POLYMARKET_FUNDER_ADDRESS is not a 20-byte address: got ${address.length} chars`,
    );
  }
  return address;
}

/**
 * API credentials are all-or-nothing.
 *
 * A partial triple is the dangerous case: the client would fall back to
 * deriving a fresh set, so the two keys you set are silently ignored
 * and the failure surfaces later as a signing mismatch far from its
 * cause.
 */
function loadApiCredentials(env: EnvLike): ApiCredentials | null {
  const key = trimmed(env, "POLYMARKET_API_KEY");
  const secret = trimmed(env, "POLYMARKET_API_SECRET");
  const passphrase = trimmed(env, "POLYMARKET_API_PASSPHRASE");

  const present = [key, secret, passphrase].filter((v) => v !== null).length;
  if (present === 0) return null;
  if (present < 3) {
    const missing = [
      key ? null : "POLYMARKET_API_KEY",
      secret ? null : "POLYMARKET_API_SECRET",
      passphrase ? null : "POLYMARKET_API_PASSPHRASE",
    ].filter((v): v is string => v !== null);
    throw new CredentialError(
      `incomplete Polymarket API credentials; missing: ${missing.join(", ")}. ` +
        "Set all three or none (none derives them from the signer key).",
    );
  }
  return {
    key: key as string,
    secret: new Secret(secret as string),
    passphrase: new Secret(passphrase as string),
  };
}

function loadChainId(env: EnvLike): number {
  const raw = trimmed(env, "POLYMARKET_CHAIN_ID");
  if (!raw) return POLYGON_CHAIN_ID;
  const id = Number(raw);
  if (!Number.isInteger(id) || !KNOWN_CHAIN_IDS.has(id)) {
    throw new CredentialError(
      `POLYMARKET_CHAIN_ID=${raw} is not a chain the venue serves ` +
        `(${[...KNOWN_CHAIN_IDS].join(" or ")})`,
    );
  }
  return id;
}

function loadBaseUrl(env: EnvLike, key: string, fallback: string): string {
  const raw = trimmed(env, key);
  if (!raw) return fallback;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new CredentialError(`${key}=${raw} is not a valid URL`);
  }
  if (parsed.protocol !== "https:") {
    // An http endpoint would carry the L2 HMAC headers in clear text.
    throw new CredentialError(`${key} must be https, got ${parsed.protocol}`);
  }
  return raw.replace(/\/+$/, "");
}

/**
 * Resolves every credential the CLOB client needs, or throws.
 *
 * Throwing rather than returning a partial result is the point: there is
 * no useful degraded mode between "we know which account we are" and
 * "we do not".
 */
export function loadCredentials(
  env: EnvLike = process.env,
  readFile: FileReader = defaultFileReader,
): ResolvedCredentials {
  const signatureType = loadSignatureType(env);
  return {
    privateKey: loadPrivateKey(env, readFile),
    signatureType,
    signatureTypeValue: SIGNATURE_TYPES[signatureType],
    funderAddress: loadFunderAddress(env, signatureType),
    apiCredentials: loadApiCredentials(env),
    clobBaseUrl: loadBaseUrl(env, "CLOB_BASE_URL", DEFAULT_CLOB_BASE_URL),
    dataApiBaseUrl: loadBaseUrl(env, "DATA_API_BASE_URL", DEFAULT_DATA_API_BASE_URL),
    chainId: loadChainId(env),
  };
}

/** True when collateral is expected at an address other than the signer's. */
export function isProxiedScheme(signatureType: SignatureTypeName): boolean {
  return PROXIED_SCHEMES.has(signatureType);
}

/**
 * A log-safe description of the configuration.
 *
 * Includes everything needed to debug a connection and nothing that
 * grants access to it. `apiKey` is included because it is an
 * identifier, not a secret — the secret and passphrase are what sign.
 */
export function describeCredentials(c: ResolvedCredentials): Record<string, unknown> {
  return {
    signatureType: c.signatureType,
    funderAddress: c.funderAddress ?? "(signer address)",
    apiCredentials: c.apiCredentials ? `derived:false key=${c.apiCredentials.key}` : "derived:true",
    clobBaseUrl: c.clobBaseUrl,
    dataApiBaseUrl: c.dataApiBaseUrl,
    chainId: c.chainId,
  };
}

/**
 * Default file reader. Separated so every test injects its own and no
 * unit test can read a real key off the host by accident.
 */
function defaultFileReader(path: string): string {
  return readFileSync(path, "utf8");
}
