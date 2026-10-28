/**
 * Credential-loading tests.
 *
 * Every case here is a configuration mistake that would otherwise be
 * discovered from a rejected real order. No network, no filesystem — the
 * file reader is injected.
 *
 * The fixture key is a deliberately recognisable pattern
 * (`0xdead…beef`-style repeats) rather than anything that looks like a
 * real key: this file is committed, and CI runs a secret scan over every
 * commit.
 */

import { describe, expect, it } from "vitest";
import {
  CredentialError,
  Secret,
  SIGNATURE_TYPES,
  describeCredentials,
  isProxiedScheme,
  loadCredentials,
  normalizeHex,
} from "../venues/credentials.js";

/** 64 hex chars, obviously synthetic. */
const KEY = `0x${"ab".repeat(32)}`;
const PROXY = `0x${"11".repeat(20)}`;

function env(over: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    SIGNER_PRIVATE_KEY: KEY,
    POLYMARKET_SIGNATURE_TYPE: "poly-proxy",
    POLYMARKET_FUNDER_ADDRESS: PROXY,
    ...over,
  };
}

const noFiles = (): never => {
  throw new Error("no filesystem in this test");
};

describe("Secret", () => {
  it("does not render its value through any ordinary path", () => {
    const s = new Secret("super-secret-value");
    expect(String(s)).toBe("[redacted]");
    expect(`${s}`).toBe("[redacted]");
    expect(JSON.stringify({ k: s })).toBe('{"k":"[redacted]"}');
    expect(JSON.stringify({ k: s })).not.toContain("super-secret");
    // The Node inspect hook is what console.log uses.
    const inspect = Symbol.for("nodejs.util.inspect.custom");
    const hook = (s as unknown as { [inspect]?: () => string })[inspect];
    expect(hook).toBeTypeOf("function");
    expect(hook?.call(s)).toBe("[redacted]");
  });

  it("is invisible to spread, so a shallow copy cannot leak it", () => {
    const s = new Secret("super-secret-value");
    expect(JSON.stringify({ ...s })).toBe("{}");
  });

  it("still yields the plaintext to an explicit reveal()", () => {
    expect(new Secret("v").reveal()).toBe("v");
  });
});

describe("private key loading", () => {
  it("accepts a well-formed key and normalises its case", () => {
    const c = loadCredentials(env({ SIGNER_PRIVATE_KEY: KEY.toUpperCase() }), noFiles);
    expect(c.privateKey.reveal()).toBe(KEY);
  });

  it("tolerates the trailing newline a shell `echo` leaves in a file", () => {
    const c = loadCredentials(
      env({ SIGNER_PRIVATE_KEY: undefined, SIGNER_PRIVATE_KEY_FILE: "/run/secrets/signer" }),
      (p) => {
        expect(p).toBe("/run/secrets/signer");
        return `${KEY}\n`;
      },
    );
    expect(c.privateKey.reveal()).toBe(KEY);
  });

  it("adds the 0x prefix when a file holds bare hex", () => {
    const c = loadCredentials(
      env({ SIGNER_PRIVATE_KEY: undefined, SIGNER_PRIVATE_KEY_FILE: "/k" }),
      () => "ab".repeat(32),
    );
    expect(c.privateKey.reveal()).toBe(KEY);
  });

  it("refuses both sources at once rather than picking one", () => {
    // A precedence rule would let a stale env var silently beat a freshly
    // rotated file, which is the failure a rotation exists to prevent.
    expect(() => loadCredentials(env({ SIGNER_PRIVATE_KEY_FILE: "/k" }), () => KEY)).toThrow(
      /set exactly one/,
    );
  });

  it("refuses a truncated key and reports the length, never the value", () => {
    const short = `0x${"ab".repeat(16)}`;
    try {
      loadCredentials(env({ SIGNER_PRIVATE_KEY: short }), noFiles);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CredentialError);
      expect((err as Error).message).toContain("34 chars");
      expect((err as Error).message).not.toContain("abab");
    }
  });

  it("refuses a key that is not hex at all (e.g. a keystore JSON)", () => {
    expect(() =>
      loadCredentials(env({ SIGNER_PRIVATE_KEY: '{"crypto":{}}' }), noFiles),
    ).toThrow(CredentialError);
  });

  it("reports an unreadable secret file by path without inventing a key", () => {
    expect(() =>
      loadCredentials(env({ SIGNER_PRIVATE_KEY: undefined, SIGNER_PRIVATE_KEY_FILE: "/nope" }), () => {
        throw new Error("ENOENT");
      }),
    ).toThrow(/\/nope.*ENOENT/);
  });

  it("refuses to run with no key configured", () => {
    expect(() => loadCredentials(env({ SIGNER_PRIVATE_KEY: undefined }), noFiles)).toThrow(
      /no signer key/,
    );
  });
});

describe("signature type", () => {
  it("has no default — guessing trades the wrong account", () => {
    expect(() =>
      loadCredentials(env({ POLYMARKET_SIGNATURE_TYPE: undefined }), noFiles),
    ).toThrow(/required and has no default/);
  });

  it("accepts the venue's numeric form and normalises it to a name", () => {
    const c = loadCredentials(env({ POLYMARKET_SIGNATURE_TYPE: "1" }), noFiles);
    expect(c.signatureType).toBe("poly-proxy");
    expect(c.signatureTypeValue).toBe(SIGNATURE_TYPES["poly-proxy"]);
  });

  it("rejects an unknown scheme", () => {
    expect(() =>
      loadCredentials(env({ POLYMARKET_SIGNATURE_TYPE: "magic" }), noFiles),
    ).toThrow(/not a known scheme/);
  });

  it("pins the numeric values the venue assigned", () => {
    // Renumbering these would silently re-point every signed order at a
    // different ownership scheme.
    expect(SIGNATURE_TYPES).toEqual({
      eoa: 0,
      "poly-proxy": 1,
      "gnosis-safe": 2,
      "poly-1271": 3,
    });
  });

  it("knows which schemes hold collateral away from the signer", () => {
    expect(isProxiedScheme("eoa")).toBe(false);
    expect(isProxiedScheme("poly-proxy")).toBe(true);
    expect(isProxiedScheme("gnosis-safe")).toBe(true);
    expect(isProxiedScheme("poly-1271")).toBe(true);
  });
});

describe("funder address", () => {
  it("is required for a proxied scheme", () => {
    expect(() =>
      loadCredentials(env({ POLYMARKET_FUNDER_ADDRESS: undefined }), noFiles),
    ).toThrow(/required for signature type 'poly-proxy'/);
  });

  it("is optional for eoa, where the signer is the funder", () => {
    const c = loadCredentials(
      env({ POLYMARKET_SIGNATURE_TYPE: "eoa", POLYMARKET_FUNDER_ADDRESS: undefined }),
      noFiles,
    );
    expect(c.funderAddress).toBeNull();
  });

  it("lowercases a checksum-cased address so one wallet is one identity", () => {
    const mixed = "0xAbC1000000000000000000000000000000000001";
    const c = loadCredentials(env({ POLYMARKET_FUNDER_ADDRESS: mixed }), noFiles);
    expect(c.funderAddress).toBe(mixed.toLowerCase());
  });

  it("rejects something that is not a 20-byte address", () => {
    expect(() => loadCredentials(env({ POLYMARKET_FUNDER_ADDRESS: "0xAbC" }), noFiles)).toThrow(
      /not a 20-byte address/,
    );
  });
});

describe("API credentials", () => {
  it("are absent when none are set, meaning derive-at-startup", () => {
    expect(loadCredentials(env(), noFiles).apiCredentials).toBeNull();
  });

  it("are accepted as a complete triple", () => {
    const c = loadCredentials(
      env({
        POLYMARKET_API_KEY: "key-id",
        POLYMARKET_API_SECRET: "secret-material",
        POLYMARKET_API_PASSPHRASE: "passphrase-material",
      }),
      noFiles,
    );
    expect(c.apiCredentials?.key).toBe("key-id");
    expect(c.apiCredentials?.secret.reveal()).toBe("secret-material");
    expect(String(c.apiCredentials?.passphrase)).toBe("[redacted]");
  });

  it("refuse a partial triple instead of silently deriving a fresh set", () => {
    // The dangerous case: the two values that were set get ignored, and
    // the mismatch surfaces later as an opaque signing failure.
    expect(() =>
      loadCredentials(env({ POLYMARKET_API_KEY: "key-id" }), noFiles),
    ).toThrow(/missing: POLYMARKET_API_SECRET, POLYMARKET_API_PASSPHRASE/);
  });
});

describe("endpoints and chain", () => {
  it("defaults to the production hosts on Polygon", () => {
    const c = loadCredentials(env(), noFiles);
    expect(c.clobBaseUrl).toBe("https://clob.polymarket.com");
    expect(c.dataApiBaseUrl).toBe("https://data-api.polymarket.com");
    expect(c.chainId).toBe(137);
  });

  it("strips a trailing slash so paths do not double up", () => {
    const c = loadCredentials(env({ CLOB_BASE_URL: "https://clob.example.com/" }), noFiles);
    expect(c.clobBaseUrl).toBe("https://clob.example.com");
  });

  it("strips a long run of trailing slashes", () => {
    const host = "https://clob.example.com";
    const c = loadCredentials(env({ CLOB_BASE_URL: `${host}${"/".repeat(5_000)}` }), noFiles);
    expect(c.clobBaseUrl).toBe(host);
  });

  it("handles a long slash run followed by a non-slash in linear time", () => {
    // Regression for a CodeQL polynomial-ReDoS finding. This was
    // `replace(/\/+$/, "")`. The pathological input is NOT a run of
    // slashes at the end — that matches on the first attempt — but a
    // run followed by something else, so `$` fails and the engine
    // retries the run from every starting position. Measured on the old
    // implementation: 20k slashes 538ms, 40k 2159ms, 80k 8227ms, a
    // clean O(n^2). The linear scan is ~0.01ms at every size.
    //
    // `new URL()` accepts this form, so it really does reach the strip
    // step rather than being rejected first.
    const raw = `https://clob.example.com/${"/".repeat(40_000)}x`;
    const started = Date.now();
    const c = loadCredentials(env({ CLOB_BASE_URL: raw }), noFiles);
    // Nothing to strip: the value ends in a non-slash.
    expect(c.clobBaseUrl).toBe(raw);
    // The old code took ~2.2s here; the ceiling leaves ample room for a
    // slow CI runner while still failing a reintroduced regex.
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("leaves an interior slash alone", () => {
    const c = loadCredentials(env({ CLOB_BASE_URL: "https://clob.example.com/v2/" }), noFiles);
    expect(c.clobBaseUrl).toBe("https://clob.example.com/v2");
  });

  it("refuses a plaintext endpoint, which would leak the L2 HMAC headers", () => {
    expect(() => loadCredentials(env({ CLOB_BASE_URL: "http://clob.example.com" }), noFiles)).toThrow(
      /must be https/,
    );
  });

  it("refuses a chain the venue does not serve", () => {
    expect(() => loadCredentials(env({ POLYMARKET_CHAIN_ID: "1" }), noFiles)).toThrow(
      /not a chain the venue serves/,
    );
  });
});

describe("describeCredentials", () => {
  it("is log-safe: no key material in the output", () => {
    const c = loadCredentials(
      env({
        POLYMARKET_API_KEY: "key-id",
        POLYMARKET_API_SECRET: "secret-material",
        POLYMARKET_API_PASSPHRASE: "passphrase-material",
      }),
      noFiles,
    );
    const serialised = JSON.stringify(describeCredentials(c));
    expect(serialised).not.toContain("ab".repeat(32));
    expect(serialised).not.toContain("secret-material");
    expect(serialised).not.toContain("passphrase-material");
    // The key id is an identifier, not a secret, and is what you quote
    // when asking the venue about a request.
    expect(serialised).toContain("key-id");
    expect(serialised).toContain("poly-proxy");
  });
});

describe("normalizeHex", () => {
  it("produces one spelling for the many a human can paste", () => {
    expect(normalizeHex("0xAbCd")).toBe("0xabcd");
    expect(normalizeHex("AbCd")).toBe("0xabcd");
    expect(normalizeHex("  0xABCD \n")).toBe("0xabcd");
  });
});
