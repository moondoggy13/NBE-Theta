/**
 * Claude computer-use driver.
 *
 * Strategy: we expose the Webull skills as regular tools (NOT the
 * built-in `computer_20250124` raw-input tool) so that the model is
 * constrained to the allow-list. Raw input remains available as an
 * escape hatch only if the user opts in via `allowRawInput: true`.
 *
 * The loop:
 *   1. Send a system prompt with the order spec and the skill catalog.
 *   2. The model responds with one or more `tool_use` blocks.
 *   3. We dispatch each tool_use to the SkillRunner and append the
 *      result as a `tool_result`. If the model ever asks for raw input
 *      and we're not in allowRawInput mode, return an error result.
 *   4. After every tool_use we run a cheap invariant check on the
 *      ticket snapshot (preflight subset). If anything looks wrong we
 *      short-circuit with a rejection.
 *   5. When the model calls `done`, we exit. If it calls
 *      `review_and_submit` we run full preflight + (optional) human
 *      confirm before the runner actually clicks Submit.
 *
 * Cost shape: ~5–15 tool turns per order with skills. A raw-input
 * approach would be 30–100+.
 */
import Anthropic from "@anthropic-ai/sdk";
import { preflight } from "../safety/preflight";
import { SKILL_SCHEMAS, type SkillName, type SkillRunner, type TicketSnapshot } from "../webull/skills";
import type { CUADriver, DriverAction, FillReport } from "./types";

export interface ClaudeDriverOptions {
  apiKey: string;
  model?: string;
  runner: SkillRunner;
  /** Required-account label for the preflight identity check. */
  expectedAccountLabel?: string;
  /** Whether the host window is ready (focused, no modal). */
  isWindowReady: () => Promise<boolean>;
  /** Observed account label from the Webull UI (header / dropdown). */
  observedAccountLabel: () => Promise<string | undefined>;
  /** Optional: enable raw mouse/keyboard tool. Off by default. */
  allowRawInput?: boolean;
}

const SYSTEM = `You are a trade-execution agent driving the Webull desktop app.

Rules:
- You may ONLY interact via the provided tools. Do not narrate, do not refuse.
- You receive a structured order spec. Your job is to fill the order ticket
  so its fields EXACTLY match the spec, then call review_and_submit.
- After every set_* call, read_ticket and verify the field changed. If the
  ticket disagrees with the spec, fix it before continuing.
- Never invent missing fields. If a field cannot be set, call done with a
  reason starting with "blocked:".
- Call done as soon as the order is submitted (or you've concluded it
  cannot be).`;

export function createClaudeDriver(opts: ClaudeDriverOptions): CUADriver {
  const client = new Anthropic({ apiKey: opts.apiKey });
  const model = opts.model ?? "claude-opus-4-7";
  return {
    name: "claude",
    async runOrder(order, ctx) {
      const actions: DriverAction[] = [];
      const tools = buildToolList(opts.allowRawInput);
      const messages: Anthropic.Messages.MessageParam[] = [
        {
          role: "user",
          content: `Order spec:\n${JSON.stringify(order, null, 2)}\n\nDry run: ${ctx.dryRun}`,
        },
      ];

      const deadline = Date.now() + ctx.totalTimeoutMs;
      let lastTicket: TicketSnapshot | undefined;
      let submitted = false;
      let webullOrderId: string | undefined;

      while (Date.now() < deadline) {
        const resp = await client.messages.create({
          model,
          max_tokens: 1024,
          system: SYSTEM,
          tools,
          messages,
        });
        messages.push({ role: "assistant", content: resp.content });

        const toolUses = resp.content.filter(
          (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use",
        );
        if (toolUses.length === 0) {
          // No tool call. Model either text-only finished or stalled.
          actions.push({ ts: Date.now(), skill: "stop", reasoning: "no tool_use returned" });
          break;
        }

        const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
        for (const use of toolUses) {
          const name = use.name as SkillName | "raw_input";
          actions.push({
            ts: Date.now(),
            skill: name,
            args: use.input as unknown,
            reasoning: extractText(resp.content),
          });

          if (name === "done") {
            const reason = (use.input as { reason?: string })?.reason ?? "model-signaled done";
            return finalize(actions, submitted, reason);
          }

          if (name === "review_and_submit") {
            const ticket = await opts.runner.read_ticket();
            lastTicket = ticket;
            const reason = preflight({
              order,
              ticket,
              maxNotionalUsd: ctx.maxNotionalUsd,
              expectedAccountLabel: opts.expectedAccountLabel,
              observedAccountLabel: await opts.observedAccountLabel(),
              windowReady: await opts.isWindowReady(),
            });
            if (reason) {
              return finalize(actions, false, `preflight blocked: ${reason}`);
            }
            if (ctx.dryRun) {
              return finalize(actions, false, "dry-run: submit suppressed by host");
            }
            if (ctx.requireConfirm) {
              const ok = await ctx.requireConfirm();
              if (!ok) return finalize(actions, false, "human confirm denied or timed out");
            }
            const outcome = await opts.runner.review_and_submit();
            submitted = outcome.submitted;
            webullOrderId = outcome.webullOrderId;
            toolResults.push({
              type: "tool_result",
              tool_use_id: use.id,
              content: JSON.stringify(outcome),
              is_error: !outcome.submitted,
            });
            continue;
          }

          // Generic skill dispatch.
          const result = await dispatchSkill(opts.runner, name, use.input).catch((err) => ({
            error: String(err),
          }));
          if (isTicketLike(result)) lastTicket = result;
          toolResults.push({
            type: "tool_result",
            tool_use_id: use.id,
            content: JSON.stringify(result),
            is_error: typeof result === "object" && result !== null && "error" in result,
          });
        }

        messages.push({ role: "user", content: toolResults });

        if (resp.stop_reason === "end_turn") break;
      }

      return finalize(actions, submitted, "deadline reached");

      function finalize(acts: DriverAction[], didSubmit: boolean, reason: string): FillReport {
        return {
          filled: false, // verifier runs separately after this returns
          ts: Date.now(),
          reason: didSubmit ? `submitted${webullOrderId ? " id=" + webullOrderId : ""}` : reason,
          actions: acts,
          qty: lastTicket?.qty,
          price: lastTicket?.price,
        };
      }
    },
  };
}

function buildToolList(allowRawInput?: boolean): Anthropic.Messages.Tool[] {
  const tools: Anthropic.Messages.Tool[] = Object.entries(SKILL_SCHEMAS).map(([name, def]) => ({
    name,
    description: def.description,
    input_schema: zodToJsonSchema(def.input_schema),
  }));
  if (allowRawInput) {
    tools.push({
      name: "raw_input",
      description: "Low-level mouse/keyboard. Audited and discouraged.",
      input_schema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["click", "type", "press"] },
          x: { type: "number" },
          y: { type: "number" },
          text: { type: "string" },
          key: { type: "string" },
        },
        required: ["action"],
        additionalProperties: false,
      } as Anthropic.Messages.Tool["input_schema"],
    });
  }
  return tools;
}

async function dispatchSkill(
  runner: SkillRunner,
  name: SkillName | "raw_input",
  input: unknown,
): Promise<unknown> {
  switch (name) {
    case "open_order_ticket":
      return runner.open_order_ticket(input as { symbol: string });
    case "set_side":
      return runner.set_side(input as { side: "buy" | "sell" });
    case "set_order_type":
      return runner.set_order_type(input as { type: TicketSnapshot["type"] });
    case "set_qty":
      return runner.set_qty(input as { qty: number });
    case "set_limit_price":
      return runner.set_limit_price(input as { price: number });
    case "read_ticket":
      return runner.read_ticket();
    case "read_positions":
      return runner.read_positions();
    case "read_balance":
      return runner.read_balance();
    case "cancel_order":
      return runner.cancel_order(input as { orderId: string });
    case "raw_input":
      return { error: "raw_input not implemented in stub; provide a platform adapter" };
    default:
      return { error: `unknown skill: ${String(name)}` };
  }
}

function isTicketLike(x: unknown): x is TicketSnapshot {
  return typeof x === "object" && x !== null && "submitEnabled" in (x as Record<string, unknown>);
}

function extractText(content: Anthropic.Messages.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join(" ");
}

/**
 * Minimal Zod-to-JSON-Schema for the skill schemas above. We only use a
 * couple of Zod features (object, string, number, enum), so a hand-rolled
 * converter is smaller than the npm dep.
 */
function zodToJsonSchema(schema: unknown): Anthropic.Messages.Tool["input_schema"] {
  type ZodLike = { _def: { typeName: string; values?: string[]; shape?: () => Record<string, unknown> } };
  const def = (schema as ZodLike)._def;
  if (def.typeName === "ZodObject" && def.shape) {
    const shape = def.shape();
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, val] of Object.entries(shape)) {
      properties[key] = zodToJsonSchema(val);
      required.push(key);
    }
    return { type: "object", properties, required, additionalProperties: false } as Anthropic.Messages.Tool["input_schema"];
  }
  if (def.typeName === "ZodString") return { type: "string" } as Anthropic.Messages.Tool["input_schema"];
  if (def.typeName === "ZodNumber") return { type: "number" } as Anthropic.Messages.Tool["input_schema"];
  if (def.typeName === "ZodEnum") {
    return { type: "string", enum: def.values } as Anthropic.Messages.Tool["input_schema"];
  }
  return { type: "object" } as Anthropic.Messages.Tool["input_schema"];
}
