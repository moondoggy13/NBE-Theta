/**
 * agent-host entrypoint.
 *
 * Fastify HTTP + WS server that the worker's ComputerUseBrokerClient calls.
 * Orders are serialized through a single p-queue (concurrency 1) — there
 * is exactly ONE Webull window, so parallelizing trades is just a recipe
 * for crossed tickets.
 *
 * Boot defaults are deliberately safe:
 *   - dry-run on unless DRY_RUN=false
 *   - human confirm required unless REQUIRE_CONFIRM=false
 *   - stub SkillRunner unless WEBULL_PLATFORM is set
 */
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import PQueue from "p-queue";
import pino from "pino";
import { z } from "zod";
import {
  SubmitOrderBody,
  type HostEvent,
  type HostFillEvent,
  type HostStatusEvent,
  type SubmitOrderResponse,
} from "./protocol";
import { createClaudeDriver } from "./drivers/claude";
import { createOpenAIDriver } from "./drivers/openai";
import type { CUADriver, FillReport } from "./drivers/types";
import { createStubRunner, type SkillRunner } from "./webull/skills";
import { verifyFill } from "./webull/verifier";
import { autoConfirm, stdinConfirm, type ConfirmFn } from "./safety/two-person";

const HostEnv = z.object({
  HOST_PORT: z.coerce.number().default(7331),
  HOST_TOKEN: z.string().min(16),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  DRIVER: z.enum(["claude", "openai"]).default("claude"),
  DRY_RUN: z.enum(["true", "false"]).default("true"),
  REQUIRE_CONFIRM: z.enum(["true", "false"]).default("true"),
  MAX_NOTIONAL_USD: z.coerce.number().default(50),
  EXPECTED_ACCOUNT_LABEL: z.string().optional(),
  WEBULL_PLATFORM: z.enum(["stub", "macos", "windows"]).default("stub"),
  STEP_TIMEOUT_MS: z.coerce.number().default(15_000),
  TOTAL_TIMEOUT_MS: z.coerce.number().default(120_000),
});

const log = pino({ name: "agent-host", level: process.env.LOG_LEVEL ?? "info" });

async function main() {
  const env = HostEnv.parse(process.env);
  const dryRun = env.DRY_RUN === "true";
  const requireConfirm = env.REQUIRE_CONFIRM === "true";

  const runner: SkillRunner = await buildRunner(env.WEBULL_PLATFORM);
  const driver: CUADriver = buildDriver(env, runner);
  const confirmFn: ConfirmFn = requireConfirm ? stdinConfirm() : autoConfirm;

  const queue = new PQueue({ concurrency: 1 });
  const tasks = new Map<
    string,
    { status: "queued" | "running" | "done"; report?: FillReport; hostTaskId: string }
  >();
  const wsClients = new Set<WSClient>();

  const app = Fastify({ logger: false });
  await app.register(websocket);

  app.addHook("onRequest", async (req, reply) => {
    if (req.url === "/healthz") return;
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${env.HOST_TOKEN}`) {
      reply.code(401).send({ error: "unauthorized" });
    }
  });

  app.get("/healthz", async () => ({
    ok: true,
    driver: driver.name,
    dryRun,
    platform: env.WEBULL_PLATFORM,
  }));

  app.post("/orders", async (req, reply) => {
    const parsed = SubmitOrderBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { ok: false, reason: parsed.error.message } satisfies SubmitOrderResponse;
    }
    const order = parsed.data;
    if (tasks.has(order.clientOrderId)) {
      const t = tasks.get(order.clientOrderId)!;
      return { ok: true, taskId: t.hostTaskId, status: "submitted" } satisfies SubmitOrderResponse;
    }
    const hostTaskId = `t-${Math.random().toString(36).slice(2, 10)}`;
    tasks.set(order.clientOrderId, { status: "queued", hostTaskId });
    log.info({ order, hostTaskId }, "order enqueued");

    queue
      .add(async () => {
        tasks.set(order.clientOrderId, { status: "running", hostTaskId });
        broadcast({
          type: "status",
          clientOrderId: order.clientOrderId,
          status: "submitted",
        });
        const report = await driver.runOrder(order, {
          dryRun: order.dryRun ?? dryRun,
          maxNotionalUsd: env.MAX_NOTIONAL_USD,
          requireConfirm: requireConfirm ? () => confirmFn(order) : undefined,
          stepTimeoutMs: env.STEP_TIMEOUT_MS,
          totalTimeoutMs: env.TOTAL_TIMEOUT_MS,
        });
        log.info({ clientOrderId: order.clientOrderId, report }, "driver returned");
        tasks.set(order.clientOrderId, { status: "done", report, hostTaskId });

        if (report.reason?.startsWith("submitted") && !order.dryRun) {
          const fill = await verifyFill(order, hostTaskId, { runner });
          if ("error" in fill) {
            broadcast({
              type: "status",
              clientOrderId: order.clientOrderId,
              status: "rejected",
              reason: fill.error,
            });
          } else {
            broadcast(fill);
          }
        } else {
          broadcast({
            type: "status",
            clientOrderId: order.clientOrderId,
            status: order.dryRun || dryRun ? "canceled" : "rejected",
            reason: report.reason,
          });
        }
      })
      .catch((err) => log.error({ err }, "queue task failed"));

    return { ok: true, taskId: hostTaskId, status: "submitted" } satisfies SubmitOrderResponse;
  });

  app.post("/orders/:id/cancel", async (req) => {
    const { id } = req.params as { id: string };
    const result = await runner.cancel_order({ orderId: id });
    return { ok: result.canceled, reason: result.reason };
  });

  app.get("/orders/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const t = tasks.get(id);
    if (!t) {
      reply.code(404);
      return { error: "not found" };
    }
    return t;
  });

  app.get("/account", async () => runner.read_balance());
  app.get("/positions", async () => runner.read_positions());

  app.register(async (fastify) => {
    fastify.get("/events", { websocket: true }, (socket /* WebSocket */) => {
      const client: WSClient = { send: (msg) => socket.send(JSON.stringify(msg)) };
      wsClients.add(client);
      socket.on("close", () => wsClients.delete(client));
    });
  });

  function broadcast(event: HostEvent) {
    for (const c of wsClients) {
      try {
        c.send(event);
      } catch (err) {
        log.warn({ err }, "ws broadcast failed");
      }
    }
  }

  await app.listen({ port: env.HOST_PORT, host: "127.0.0.1" });
  log.info(
    { port: env.HOST_PORT, dryRun, driver: driver.name, platform: env.WEBULL_PLATFORM },
    "agent-host listening on loopback",
  );
}

interface WSClient {
  send(msg: HostFillEvent | HostStatusEvent): void;
}

function buildDriver(env: z.infer<typeof HostEnv>, runner: SkillRunner): CUADriver {
  if (env.DRIVER === "claude") {
    if (!env.ANTHROPIC_API_KEY) throw new Error("DRIVER=claude requires ANTHROPIC_API_KEY");
    return createClaudeDriver({
      apiKey: env.ANTHROPIC_API_KEY,
      runner,
      expectedAccountLabel: env.EXPECTED_ACCOUNT_LABEL,
      isWindowReady: async () => env.WEBULL_PLATFORM !== "stub",
      observedAccountLabel: async () => env.EXPECTED_ACCOUNT_LABEL,
    });
  }
  if (!env.OPENAI_API_KEY) throw new Error("DRIVER=openai requires OPENAI_API_KEY");
  return createOpenAIDriver({ apiKey: env.OPENAI_API_KEY, runner });
}

async function buildRunner(platform: "stub" | "macos" | "windows"): Promise<SkillRunner> {
  if (platform === "stub") return createStubRunner();
  // Platform adapters land in webull/platforms/{macos,windows}.ts in the
  // first iteration of the live work. For now boot fails fast so nobody
  // accidentally runs against an unimplemented adapter.
  throw new Error(`WEBULL_PLATFORM=${platform} not yet implemented; use "stub" for now`);
}

main().catch((err) => {
  log.error({ err }, "agent-host failed to start");
  process.exit(1);
});
