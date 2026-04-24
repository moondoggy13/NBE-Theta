import type { Logger } from "./logger";

export function installShutdown(logger: Logger, onShutdown: () => Promise<void>): void {
  let shuttingDown = false;
  const handle = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutdown initiated");
    try {
      await Promise.race([onShutdown(), timeout(10_000)]);
    } catch (err) {
      logger.error({ err }, "shutdown hook error");
    }
    logger.flush?.();
    process.exit(0);
  };
  process.on("SIGINT", () => void handle("SIGINT"));
  process.on("SIGTERM", () => void handle("SIGTERM"));
  process.on("unhandledRejection", (reason) => {
    logger.error({ reason }, "unhandledRejection");
  });
  process.on("uncaughtException", (err) => {
    logger.fatal({ err }, "uncaughtException");
    process.exit(1);
  });
}

function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error("shutdown timeout")), ms));
}
