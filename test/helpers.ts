import type { InputMessage } from "../src/protocol.ts";

/**
 * Coordinates travel as float32, so a round trip is only exact to ~7 digits.
 * That is far finer than one pixel on any screen we stream, but tests have to
 * compare against the float32 value, not the float64 literal.
 */
export function asFloat32(msg: InputMessage): InputMessage {
  const out = { ...msg } as Record<string, unknown>;
  for (const k of [
    "x",
    "y",
    "x1",
    "y1",
    "x2",
    "y2",
    "dx",
    "dy",
    "anchorX",
    "anchorY",
  ]) {
    if (typeof out[k] === "number") out[k] = Math.fround(out[k] as number);
  }
  return out as InputMessage;
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

export const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};
