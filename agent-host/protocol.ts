/**
 * Wire contract between the worker's ComputerUseBrokerClient and this host.
 *
 * Kept as plain interfaces here so the host has no compile-time dependency
 * on the worker's `src/lib/broker/types.ts`. The shapes must stay in sync;
 * the test suite (worker side) is the source of truth.
 */
import { z } from "zod";

export const OrderSide = z.enum(["buy", "sell"]);
export const OrderType = z.enum(["market", "limit", "stop", "stop_limit"]);
export const OrderStatus = z.enum([
  "pending",
  "submitted",
  "partial",
  "filled",
  "canceled",
  "rejected",
  "expired",
]);

export const SubmitOrderBody = z.object({
  clientOrderId: z.string().min(1),
  symbol: z.string().min(1),
  side: OrderSide,
  type: OrderType,
  qty: z.number().positive(),
  price: z.number().positive().optional(),
  stopPrice: z.number().positive().optional(),
  dryRun: z.boolean().default(true),
  metadata: z.record(z.unknown()).optional(),
});
export type SubmitOrderBody = z.infer<typeof SubmitOrderBody>;

export const SubmitOrderResponse = z.object({
  ok: z.boolean(),
  taskId: z.string().optional(),
  status: OrderStatus.optional(),
  reason: z.string().optional(),
});
export type SubmitOrderResponse = z.infer<typeof SubmitOrderResponse>;

export interface HostFillEvent {
  type: "fill";
  clientOrderId: string;
  hostTaskId: string;
  ts: number;
  price: number;
  qty: number;
  fee?: number;
  liquidity?: "maker" | "taker";
}

export interface HostStatusEvent {
  type: "status";
  clientOrderId: string;
  status: z.infer<typeof OrderStatus>;
  reason?: string;
}

export type HostEvent = HostFillEvent | HostStatusEvent;
