import pino from "pino";
import { loadEnv } from "./env";

const env = loadEnv();

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { component: "worker" },
  timestamp: pino.stdTimeFunctions.isoTime,
  transport:
    env.NODE_ENV === "development"
      ? { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss.l" } }
      : undefined,
});

export type Logger = typeof logger;
