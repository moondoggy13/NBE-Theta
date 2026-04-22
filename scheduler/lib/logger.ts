const COLORS = { reset: "\x1b[0m", yellow: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m", dim: "\x1b[2m" };

function ts() {
  return new Date().toLocaleTimeString("en-US", { hour12: false, timeZone: "America/New_York" });
}

export const logger = {
  info: (msg: string, ...args: unknown[]) =>
    console.log(`${COLORS.dim}[${ts()}]${COLORS.reset} ${COLORS.cyan}[sched]${COLORS.reset} ${msg}`, ...args),
  warn: (msg: string, ...args: unknown[]) =>
    console.warn(`${COLORS.dim}[${ts()}]${COLORS.reset} ${COLORS.yellow}[sched]${COLORS.reset} ${msg}`, ...args),
  error: (msg: string, ...args: unknown[]) =>
    console.error(`${COLORS.dim}[${ts()}]${COLORS.reset} ${COLORS.red}[sched]${COLORS.reset} ${msg}`, ...args),
};
