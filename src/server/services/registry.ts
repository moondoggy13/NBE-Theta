import type {
  ICatalystProvider,
  ITechnicalProvider,
  IOptionsFlowProvider,
  ISentimentProvider,
  IEconomicProvider,
} from "./types";
import type { IMacroProvider } from "./macro/types";

import { MockCatalystProvider } from "./catalyst/mock";
import { PerplexityCatalystProvider } from "./catalyst/perplexity";
import { MockTechnicalProvider } from "./technical/mock";
import { AlpacaTechnicalProvider } from "./technical/alpaca";
import { MockOptionsFlowProvider } from "./options-flow/mock";
import { MockSentimentProvider } from "./sentiment/mock";
import { MockEconomicProvider } from "./economic/mock";
import { ForexFactoryProvider } from "./economic/forex-factory";
import { MockMacroProvider } from "./macro/mock";
import { FredMacroProvider } from "./macro/fred";

function resolve<T>(MockCtor: new () => T, LiveCtor: new () => T, envKey: string): T {
  return process.env[envKey] ? new LiveCtor() : new MockCtor();
}

export const catalystProvider: ICatalystProvider = resolve(
  MockCatalystProvider,
  PerplexityCatalystProvider,
  "PERPLEXITY_API_KEY"
);

export const technicalProvider: ITechnicalProvider = resolve(
  MockTechnicalProvider,
  AlpacaTechnicalProvider,
  "ALPACA_API_KEY"
);

// Unusual Whales has no live provider yet — always mock
export const optionsProvider: IOptionsFlowProvider = new MockOptionsFlowProvider();

// Sentiment uses Supabase pgvector — mock until embeddings are populated
export const sentimentProvider: ISentimentProvider = new MockSentimentProvider();

export const economicProvider: IEconomicProvider = resolve(
  MockEconomicProvider,
  ForexFactoryProvider,
  "ECONOMIC_CALENDAR_ENABLED"
);

export const macroProvider: IMacroProvider = resolve(
  MockMacroProvider,
  FredMacroProvider,
  "FRED_API_KEY"
);
