/**
 * Manual confirm gate. Default-on; lets you press a key (or click a button
 * on a local web prompt) before the agent clicks Submit. Bypass only by
 * setting COMPUTER_USE_REQUIRE_CONFIRM=false.
 *
 * The default implementation prints to stdout and reads a line from stdin.
 * Replace with an OS-native notification + click prompt on the trading PC.
 */
import readline from "node:readline";
import type { SubmitOrderBody } from "../protocol";

export type ConfirmFn = (order: SubmitOrderBody, notionalUsd?: number) => Promise<boolean>;

export function stdinConfirm(timeoutMs = 15_000): ConfirmFn {
  return (order, notional) =>
    new Promise((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const prompt =
        `\n[CONFIRM] ${order.side.toUpperCase()} ${order.qty} ${order.symbol}` +
        (order.price ? ` @ ${order.price}` : "") +
        (notional ? `  (~$${notional.toFixed(2)})` : "") +
        `\nType "yes" within ${(timeoutMs / 1000).toFixed(0)}s to submit: `;
      const timer = setTimeout(() => {
        rl.close();
        resolve(false);
      }, timeoutMs);
      rl.question(prompt, (ans) => {
        clearTimeout(timer);
        rl.close();
        resolve(ans.trim().toLowerCase() === "yes");
      });
    });
}

export const autoConfirm: ConfirmFn = async () => true;
