/**
 * Dashboard bridge.
 *
 * Outbound-only HTTPS to the dashboard. Two responsibilities:
 *   - poll /api/agent-host/control for live config (kill switch, dry-run,
 *     notional cap, driver selection);
 *   - POST each driver action to /api/agent-host/ingest so the dashboard
 *     can stream the live action feed and keep a forensic audit trail.
 *
 * Designed for laptops with no inbound network — nothing here listens.
 */
import { setTimeout as sleep } from "node:timers/promises";
import type { Logger } from "pino";

export interface ControlConfig {
  enabled: boolean;
  killSwitch: boolean;
  dryRun: boolean;
  requireConfirm: boolean;
  maxNotionalUsd: number;
  driver: "claude" | "openai";
}

export interface DashboardClientOpts {
  url: string;
  token: string;
  log: Logger;
  pollIntervalMs?: number;
}

export class DashboardClient {
  private current: ControlConfig = {
    enabled: false,
    killSwitch: false,
    dryRun: true,
    requireConfirm: true,
    maxNotionalUsd: 50,
    driver: "claude",
  };
  private listeners: Array<(c: ControlConfig) => void> = [];
  private readonly url: string;
  private readonly token: string;
  private readonly log: Logger;
  private readonly pollMs: number;
  private stopped = false;

  constructor(opts: DashboardClientOpts) {
    this.url = opts.url.replace(/\/+$/, "");
    this.token = opts.token;
    this.log = opts.log;
    this.pollMs = opts.pollIntervalMs ?? 5_000;
  }

  get config(): ControlConfig {
    return this.current;
  }

  onConfigChange(handler: (c: ControlConfig) => void): void {
    this.listeners.push(handler);
  }

  /** Long-running poll loop. Caller does NOT await; errors are logged. */
  start(): void {
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
  }

  /** Fire-and-forget action log. Failures never block the trade loop. */
  async logAction(row: {
    taskId?: string;
    clientOrderId?: string;
    skill: string;
    args?: unknown;
    reasoning?: string;
    screenshotUrl?: string;
    result?: unknown;
  }): Promise<void> {
    try {
      await fetch(`${this.url}/api/agent-host/ingest`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify(row),
        signal: AbortSignal.timeout(3_000),
      });
    } catch (err) {
      // Action logging is best-effort; the WS stream to the worker is the
      // authoritative path for fills, so a flaky dashboard never blocks a
      // trade. We do warn so operators notice prolonged outages.
      this.log.warn({ err }, "action log post failed");
    }
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        const r = await fetch(`${this.url}/api/agent-host/control`, {
          headers: { authorization: `Bearer ${this.token}` },
          cache: "no-store",
          signal: AbortSignal.timeout(5_000),
        });
        if (r.ok) {
          const next = (await r.json()) as Partial<ControlConfig>;
          const merged: ControlConfig = { ...this.current, ...next } as ControlConfig;
          if (!shallowEq(this.current, merged)) {
            this.current = merged;
            for (const h of this.listeners) h(merged);
          }
        }
      } catch (err) {
        this.log.warn({ err }, "dashboard control poll failed");
      }
      await sleep(this.pollMs);
    }
  }
}

function shallowEq(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if (a[k] !== b[k]) return false;
  return true;
}
