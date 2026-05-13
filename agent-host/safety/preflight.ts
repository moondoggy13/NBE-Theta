/**
 * Synchronous invariants that MUST hold before a Submit click is allowed.
 * Every check returns a reason on failure; the driver loop turns the first
 * non-null reason into a rejected order.
 *
 * These guards are the difference between a $50 mis-trade and a $29k one
 * (see worker/execution.ts:8-19 for the war story that motivates them).
 * If any field on screen disagrees with what was requested, refuse.
 */
import type { SubmitOrderBody } from "../protocol";
import type { TicketSnapshot } from "../webull/skills";

export interface PreflightInput {
  order: SubmitOrderBody;
  ticket: TicketSnapshot;
  maxNotionalUsd: number;
  expectedAccountLabel?: string;
  observedAccountLabel?: string;
  /** Webull window present, focused, no modal covering the ticket. */
  windowReady: boolean;
}

/** Returns null if all checks pass, otherwise a human-readable reason. */
export function preflight(input: PreflightInput): string | null {
  const { order, ticket, maxNotionalUsd } = input;

  if (!input.windowReady) return "webull window not ready (missing, unfocused, or modal blocking)";

  if (input.expectedAccountLabel && input.expectedAccountLabel !== input.observedAccountLabel) {
    return `wrong account: expected "${input.expectedAccountLabel}" got "${input.observedAccountLabel}"`;
  }

  if (!ticket.submitEnabled) return "ticket submit button is disabled";
  if (ticket.symbol !== order.symbol) {
    return `ticket symbol mismatch: ticket="${ticket.symbol}" order="${order.symbol}"`;
  }
  if (ticket.side !== order.side) {
    return `ticket side mismatch: ticket="${ticket.side}" order="${order.side}"`;
  }
  if (ticket.type !== order.type) {
    return `ticket type mismatch: ticket="${ticket.type}" order="${order.type}"`;
  }
  if (!approxEq(ticket.qty, order.qty)) {
    return `ticket qty mismatch: ticket=${ticket.qty} order=${order.qty}`;
  }
  const needPrice = order.type === "limit" || order.type === "stop_limit" || order.type === "stop";
  if (needPrice) {
    const orderPrice = order.price ?? order.stopPrice;
    if (!approxEq(ticket.price, orderPrice)) {
      return `ticket price mismatch: ticket=${ticket.price} order=${orderPrice}`;
    }
  }

  const notional = ticket.estNotionalUsd ?? (ticket.qty && ticket.price ? ticket.qty * ticket.price : undefined);
  if (notional !== undefined && notional > maxNotionalUsd) {
    return `estimated notional $${notional.toFixed(2)} exceeds cap $${maxNotionalUsd.toFixed(2)}`;
  }

  return null;
}

function approxEq(a: number | undefined, b: number | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  // Tight tolerance — UI rounding only, not "close enough to count."
  return Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 1e-6);
}
