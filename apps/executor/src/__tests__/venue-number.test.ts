/**
 * `toVenueNumber` tests.
 *
 * The domain carries prices and sizes as strings so nothing rounds in
 * transit; the venue's `UserOrder` takes `number`. This conversion is
 * the one place that gap is crossed, and a silent rounding here is an
 * order for a quantity nobody authorised or a fill worse than the
 * signal allowed. So the rule is: convert exactly, or refuse.
 *
 * Importing this module does not load the venue SDK — `clob-client.ts`
 * imports it dynamically inside `createClobSigningClient` precisely so
 * that pure helpers stay testable without it.
 */

import { describe, expect, it } from "vitest";
import { OrderNotSentError, isApiCredentials, toVenueNumber } from "../venues/clob-client.js";

const PRICE_SCALE = 4;
const SIZE_SCALE = 6;

describe("exact conversions", () => {
  it("converts values the venue can represent", () => {
    expect(toVenueNumber("price", "0.43", PRICE_SCALE)).toBe(0.43);
    expect(toVenueNumber("price", "0.0001", PRICE_SCALE)).toBe(0.0001);
    expect(toVenueNumber("size", "250", SIZE_SCALE)).toBe(250);
    expect(toVenueNumber("size", "1234.567891", SIZE_SCALE)).toBe(1234.567891);
  });

  it("treats trailing zeros as the same number", () => {
    expect(toVenueNumber("price", "0.4300", PRICE_SCALE)).toBe(0.43);
    expect(toVenueNumber("price", "0.40", PRICE_SCALE)).toBe(
      toVenueNumber("price", "0.4", PRICE_SCALE),
    );
  });

  it("accepts a zero price without treating it as missing", () => {
    // A resolved-losing outcome token legitimately marks at exactly 0,
    // which is why the repo distinguishes [0,1] from (0,1].
    expect(toVenueNumber("price", "0", PRICE_SCALE)).toBe(0);
  });

  it("survives a value whose double is not exact in binary", () => {
    // 0.1 + 0.2 territory: the scaled-integer round-trip is what makes
    // this safe rather than lucky.
    expect(toVenueNumber("price", "0.3", PRICE_SCALE)).toBe(0.3);
    expect(toVenueNumber("size", "0.000003", SIZE_SCALE)).toBe(0.000003);
  });
});

describe("refusals", () => {
  it("refuses more precision than the venue accepts rather than rounding", () => {
    // Rounding 0.43005 to 0.4301 would pay more than authorised.
    expect(() => toVenueNumber("price", "0.43005", PRICE_SCALE)).toThrow(OrderNotSentError);
    expect(() => toVenueNumber("price", "0.43005", PRICE_SCALE)).toThrow(/at most 4/);
  });

  it("refuses a negative amount", () => {
    // Direction is `side`, never the sign of the quantity.
    expect(() => toVenueNumber("size", "-1", SIZE_SCALE)).toThrow(/non-negative decimal/);
  });

  it("refuses exponent notation, which would parse to something unintended", () => {
    expect(() => toVenueNumber("size", "1e3", SIZE_SCALE)).toThrow(OrderNotSentError);
  });

  it("refuses non-numeric input", () => {
    for (const bad of ["", " ", "abc", "0.4.3", "NaN", "Infinity", "0x10", "1,000"]) {
      expect(() => toVenueNumber("size", bad, SIZE_SCALE), bad).toThrow(OrderNotSentError);
    }
  });

  it("refuses a magnitude beyond exact double representation", () => {
    expect(() => toVenueNumber("size", "99999999999", SIZE_SCALE)).toThrow(
      /exactly-representable/,
    );
  });

  it("names the field it refused, so a log says which number was wrong", () => {
    expect(() => toVenueNumber("limitPrice", "0.123456", PRICE_SCALE)).toThrow(/limitPrice/);
  });
});

describe("isApiCredentials", () => {
  it("accepts a complete triple", () => {
    expect(isApiCredentials({ key: "k", secret: "s", passphrase: "p" })).toBe(true);
  });

  it("rejects the shapes a failed handshake actually produces", () => {
    // Each of these would otherwise be stored as credentials and
    // surface several calls later as a TypeError inside HMAC header
    // construction, which names neither the cause nor the account.
    for (const bad of [
      undefined,
      null,
      "",
      0,
      [],
      {},
      { key: "k" },
      { key: "k", secret: "s" },
      { key: "", secret: "s", passphrase: "p" },
      { key: "k", secret: "", passphrase: "p" },
      { key: "k", secret: "s", passphrase: "" },
      { key: 1, secret: "s", passphrase: "p" },
      { error: "unauthorized" },
    ]) {
      expect(isApiCredentials(bad), JSON.stringify(bad) ?? "undefined").toBe(false);
    }
  });
});
