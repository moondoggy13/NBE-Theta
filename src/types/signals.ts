export type SignalLayerName = "catalyst" | "technical" | "options_flow" | "sentiment" | "economic";

export interface SignalLayer {
  name: SignalLayerName;
  score: number;
  signals: string[];
  dataSource: string;
  updatedAt: string;
}

export interface StockSignal {
  ticker: string;
  name: string;
  convictionScore: number;
  layers: SignalLayer[];
  inUniverse: boolean;
  sector: string;
  marketCap: number;
  avgVolume: number;
  currentPrice: number;
  catalyst: string;
}
