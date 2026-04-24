export type OrderSide = "buy" | "sell";
export type OrderType = "market" | "limit" | "stop" | "stop_limit";
export type OrderStatus =
  | "pending"
  | "submitted"
  | "partial"
  | "filled"
  | "canceled"
  | "rejected"
  | "expired";
export type BrokerMode = "backtest" | "paper" | "live";

export interface OrderRequest {
  clientOrderId?: string;
  symbol: string;            // e.g. "BTC-USD"
  side: OrderSide;
  type: OrderType;
  qty: number;               // base-asset units
  price?: number;            // required for limit / stop_limit
  stopPrice?: number;        // required for stop / stop_limit
  strategyId?: string;
  metadata?: Record<string, unknown>;
}

export interface Order {
  id: string;                // local uuid
  brokerOrderId?: string;    // coinbase order id
  mode: BrokerMode;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  qty: number;
  price?: number;
  status: OrderStatus;
  submittedAt: number;
  filledAt?: number;
  filledQty: number;
  filledPrice?: number;
  fees: number;
  strategyId?: string;
  metadata?: Record<string, unknown>;
}

export interface Fill {
  orderId: string;
  ts: number;
  price: number;
  qty: number;
  liquidity?: "maker" | "taker";
  fee: number;
}

export interface Account {
  equity: number;
  buyingPower: number;
  currency: string;
}

export interface PositionView {
  symbol: string;
  qty: number;
  avgEntry: number;
  unrealizedPnl: number;
  realizedPnl: number;
}

export interface BrokerClient {
  readonly mode: BrokerMode;
  readonly name: string;
  submitOrder(req: OrderRequest): Promise<Order>;
  cancelOrder(orderId: string): Promise<void>;
  getAccount(): Promise<Account>;
  getPositions(): Promise<PositionView[]>;
  onFill(handler: (fill: Fill, order: Order) => void): void;
}
