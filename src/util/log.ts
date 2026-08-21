/** Minimal leveled logger. Log rotation / file sinks arrive with M4. */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type Level = keyof typeof LEVELS;

let threshold: number = LEVELS[(process.env.SIMFARM_LOG as Level) ?? "info"] ?? LEVELS.info;

export function setLevel(level: Level): void {
  threshold = LEVELS[level];
}

export interface Logger {
  debug(msg: string, ...rest: unknown[]): void;
  info(msg: string, ...rest: unknown[]): void;
  warn(msg: string, ...rest: unknown[]): void;
  error(msg: string, ...rest: unknown[]): void;
}

export function logger(scope: string): Logger {
  const emit =
    (level: Level) =>
    (msg: string, ...rest: unknown[]) => {
      if (LEVELS[level] < threshold) return;
      const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
      if (level === "error" || level === "warn") console.error(line, ...rest);
      else console.log(line, ...rest);
    };
  return {
    debug: emit("debug"),
    info: emit("info"),
    warn: emit("warn"),
    error: emit("error"),
  };
}
