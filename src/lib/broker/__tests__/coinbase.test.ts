import { describe, expect, it } from "vitest";
import { CoinbaseAdvancedClient } from "../coinbase-advanced";

describe("CoinbaseAdvancedClient", () => {
  it("refuses construction when live gate is off", () => {
    expect(
      () =>
        new CoinbaseAdvancedClient({
          apiKeyName: "x",
          apiPrivateKey: "y",
          symbol: "BTC-USD",
          liveEnabled: false,
        }),
    ).toThrow(/gates not set/);
  });

  it("refuses construction when credentials are missing", () => {
    expect(
      () =>
        new CoinbaseAdvancedClient({
          apiKeyName: "",
          apiPrivateKey: "",
          symbol: "BTC-USD",
          liveEnabled: true,
        }),
    ).toThrow(/credentials missing/);
  });
});
