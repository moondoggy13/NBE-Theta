export interface ProviderInput {
  ticker: string;
  name: string;
  sector: string;
  marketCap: number;
  avgVolume: number;
  currentPrice: number;
  runDate: string;
}

export interface LayerResult {
  score: number;
  signals: string[];
  dataSource: string;
  updatedAt: string;
}

export interface EconomicEvent {
  time: string;
  currency: string;
  event: string;
  impact: "high" | "medium" | "low";
  forecast?: string;
  previous?: string;
  actual?: string;
}

export interface ICatalystProvider {
  getLayer(input: ProviderInput): Promise<LayerResult>;
}

export interface ITechnicalProvider {
  getLayer(input: ProviderInput): Promise<LayerResult>;
}

export interface IOptionsFlowProvider {
  getLayer(input: ProviderInput): Promise<LayerResult>;
}

export interface ISentimentProvider {
  getLayer(input: ProviderInput): Promise<LayerResult>;
}

export interface IEconomicProvider {
  getTodayEvents(): Promise<EconomicEvent[]>;
  getLayer(input: ProviderInput, events: EconomicEvent[]): Promise<LayerResult>;
}
