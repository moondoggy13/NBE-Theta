/**
 * High-level Webull-desktop skills exposed to the LLM as tools.
 *
 * Why skills instead of raw mouse coordinates: the model orchestrates a
 * small set of deterministic sub-recipes (open ticket, set qty, etc.)
 * rather than free-form clicking. Result: ~5x fewer screenshots per
 * order, fewer ways to go wrong, and a tight allow-list for audit.
 *
 * Each skill returns a structured outcome the model can read on the
 * next turn (e.g. "qty field now shows 1.00" or "submit button is
 * disabled because no symbol selected"). The actual implementations
 * live behind a platform adapter — accessibility APIs first (macOS AX,
 * Windows UIA), OCR second, pixel coords last.
 */
import { z } from "zod";

/** JSON schemas the driver will hand to the LLM as tool definitions. */
export const SKILL_SCHEMAS = {
  open_order_ticket: {
    description: "Open the order entry ticket for the given symbol.",
    input_schema: z.object({ symbol: z.string() }),
  },
  set_side: {
    description: "Toggle the order ticket between Buy and Sell.",
    input_schema: z.object({ side: z.enum(["buy", "sell"]) }),
  },
  set_order_type: {
    description: "Set order type. Limit/stop/stop_limit require a price.",
    input_schema: z.object({
      type: z.enum(["market", "limit", "stop", "stop_limit"]),
    }),
  },
  set_qty: {
    description: "Set the quantity field to an exact numeric value.",
    input_schema: z.object({ qty: z.number().positive() }),
  },
  set_limit_price: {
    description: "Set the limit/stop price field.",
    input_schema: z.object({ price: z.number().positive() }),
  },
  read_ticket: {
    description:
      "Return the current ticket field values as read by accessibility APIs / OCR. Use to verify before Submit.",
    input_schema: z.object({}),
  },
  read_positions: {
    description: "Return the positions panel snapshot for the active account.",
    input_schema: z.object({}),
  },
  read_balance: {
    description: "Return the account balance / buying power.",
    input_schema: z.object({}),
  },
  review_and_submit: {
    description:
      "Open the review modal then submit. The host runs preflight checks first and may refuse; in dry-run mode it never clicks Submit.",
    input_schema: z.object({}),
  },
  cancel_order: {
    description: "Cancel a working order by Webull's order id (as shown in the Orders panel).",
    input_schema: z.object({ orderId: z.string() }),
  },
  done: {
    description:
      "Signal completion. Pass a brief reason; the host uses this to close the task.",
    input_schema: z.object({ reason: z.string() }),
  },
} as const;

export type SkillName = keyof typeof SKILL_SCHEMAS;

export interface TicketSnapshot {
  symbol?: string;
  side?: "buy" | "sell";
  type?: "market" | "limit" | "stop" | "stop_limit";
  qty?: number;
  price?: number;
  estNotionalUsd?: number;
  submitEnabled: boolean;
}

export interface SkillRunner {
  open_order_ticket(args: { symbol: string }): Promise<TicketSnapshot>;
  set_side(args: { side: "buy" | "sell" }): Promise<TicketSnapshot>;
  set_order_type(args: { type: TicketSnapshot["type"] }): Promise<TicketSnapshot>;
  set_qty(args: { qty: number }): Promise<TicketSnapshot>;
  set_limit_price(args: { price: number }): Promise<TicketSnapshot>;
  read_ticket(): Promise<TicketSnapshot>;
  read_positions(): Promise<Array<{ symbol: string; qty: number; avgEntry: number }>>;
  read_balance(): Promise<{ equity: number; buyingPower: number; currency: string }>;
  review_and_submit(): Promise<{ submitted: boolean; webullOrderId?: string; reason?: string }>;
  cancel_order(args: { orderId: string }): Promise<{ canceled: boolean; reason?: string }>;
}

/**
 * Stub runner used by `COMPUTER_USE_DRY_RUN=true` boot. Returns plausible
 * shapes so the driver loop, audit pipeline, and verifier can be exercised
 * end-to-end without touching the real desktop. Replace per-platform with
 * concrete adapters under `webull/platforms/{macos,windows}.ts`.
 */
export function createStubRunner(): SkillRunner {
  let ticket: TicketSnapshot = { submitEnabled: false };
  return {
    async open_order_ticket({ symbol }) {
      ticket = { symbol, submitEnabled: false };
      return ticket;
    },
    async set_side({ side }) {
      ticket = { ...ticket, side };
      return ticket;
    },
    async set_order_type({ type }) {
      ticket = { ...ticket, type };
      return ticket;
    },
    async set_qty({ qty }) {
      ticket = { ...ticket, qty };
      return refresh(ticket);
    },
    async set_limit_price({ price }) {
      ticket = { ...ticket, price };
      return refresh(ticket);
    },
    async read_ticket() {
      return ticket;
    },
    async read_positions() {
      return [];
    },
    async read_balance() {
      return { equity: 0, buyingPower: 0, currency: "USD" };
    },
    async review_and_submit() {
      // The host's preflight + dry-run gate decides whether this is allowed
      // to do anything real. The stub never submits.
      return { submitted: false, reason: "stub runner: no desktop attached" };
    },
    async cancel_order() {
      return { canceled: false, reason: "stub runner" };
    },
  };

  function refresh(t: TicketSnapshot): TicketSnapshot {
    const haveBasics = !!t.symbol && !!t.side && !!t.type && !!t.qty;
    const needPrice = t.type === "limit" || t.type === "stop_limit" || t.type === "stop";
    const submitEnabled = haveBasics && (!needPrice || !!t.price);
    const estNotionalUsd = t.qty && t.price ? t.qty * t.price : undefined;
    return { ...t, submitEnabled, estNotionalUsd };
  }
}
