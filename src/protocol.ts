/**
 * simfarm wire protocol — single WebSocket, 4 multiplexed channels.
 *
 * Frame layout (binary WebSocket messages only; text messages are ignored):
 *
 *   [1B channel][payload...]
 *
 *   0x01 VIDEO    [1B streamId][1B tag][data...]
 *   0x02 INPUT    [1B streamId][1B kind][...]
 *   0x03 CONTROL  UTF-8 JSON   client -> server (request) / server -> client (response)
 *   0x04 EVENT    UTF-8 JSON   server -> client (push)
 *
 * All multi-byte integers and floats are BIG-ENDIAN. (ARCHITECTURE.md left this
 * unstated; big-endian is chosen to match the 4B BE length prefix of the
 * serve-sim avcc stream we interoperate with in M1.)
 *
 * Touch/scroll coordinates on the wire are normalized floats in [0,1] relative
 * to the *displayed* frame (already rotated). The server converts them to
 * device pixels — see `toDevicePixels`.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CHANNEL = {
  VIDEO: 0x01,
  INPUT: 0x02,
  CONTROL: 0x03,
  EVENT: 0x04,
} as const;

export const VIDEO_TAG = {
  /** codec config: h264 avcC parameter sets (SPS/PPS). jpeg never sends this. */
  CONFIG: 0x01,
  /** h264 IDR, or one complete jpeg image. */
  KEY: 0x02,
  /** h264 P frame. jpeg never sends this. */
  DELTA: 0x03,
  /** one jpeg delivered immediately on attach so the client is never black. */
  SEED: 0x04,
} as const;

export const INPUT_KIND = {
  TOUCH: 0x10,
  MULTITOUCH: 0x11,
  KEY: 0x12,
  BUTTON: 0x13,
  SCROLL: 0x14,
  TEXT: 0x15,
} as const;

export const TOUCH_PHASE = { BEGIN: 0, MOVE: 1, END: 2 } as const;
/** KEY and BUTTON share this phase enum. */
export const KEY_PHASE = { DOWN: 0, UP: 1 } as const;

/** `edge` byte of a TOUCH frame (ARCHITECTURE.md: iOS system gestures). */
export const TOUCH_EDGE = {
  NONE: 0,
  TOP: 1,
  BOTTOM: 2,
  LEFT: 3,
  RIGHT: 4,
} as const;

/**
 * Button name <-> id table.
 *
 * `capabilities.buttons` is declared as strings, while the BUTTON input frame
 * carries a single byte. This table is the mapping between them, and it is part
 * of the protocol contract — see PROTOCOL §5.
 */
export const BUTTON_ID = {
  home: 0x01,
  lock: 0x02,
  volume_up: 0x03,
  volume_down: 0x04,
  back: 0x05,
  app_switch: 0x06,
  power: 0x07,
  siri: 0x08,
  menu: 0x09,
  camera: 0x0a,
  ringer_mute: 0x0b,
  action: 0x0c,
} as const;

export type ButtonName = keyof typeof BUTTON_ID;

export const BUTTON_NAME_BY_ID: Record<number, ButtonName> = Object.fromEntries(
  Object.entries(BUTTON_ID).map(([name, id]) => [id, name as ButtonName]),
);

export const MAX_STREAMS = 256;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Channel = (typeof CHANNEL)[keyof typeof CHANNEL];
export type VideoTag = (typeof VIDEO_TAG)[keyof typeof VIDEO_TAG];
export type TouchPhase = (typeof TOUCH_PHASE)[keyof typeof TOUCH_PHASE];
export type KeyPhase = (typeof KEY_PHASE)[keyof typeof KEY_PHASE];

export type InputMessage =
  | {
      kind: "touch";
      phase: TouchPhase;
      x: number;
      y: number;
      seq: number;
      edge: number;
    }
  | {
      kind: "multitouch";
      phase: TouchPhase;
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      seq: number;
    }
  | { kind: "key"; phase: KeyPhase; usage: number }
  | { kind: "button"; phase: KeyPhase; buttonId: number }
  | { kind: "scroll"; dx: number; dy: number; anchorX: number; anchorY: number }
  | { kind: "text"; text: string };

export type WireFrame =
  | { channel: "video"; streamId: number; tag: number; data: Uint8Array }
  | { channel: "input"; streamId: number; msg: InputMessage }
  | { channel: "control"; json: unknown }
  | { channel: "event"; json: unknown };

export class ProtocolError extends Error {}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

export function encodeVideoFrame(
  streamId: number,
  tag: number,
  data: Uint8Array,
): Uint8Array {
  assertByte(streamId, "streamId");
  assertByte(tag, "tag");
  const out = new Uint8Array(3 + data.length);
  out[0] = CHANNEL.VIDEO;
  out[1] = streamId;
  out[2] = tag;
  out.set(data, 3);
  return out;
}

export function encodeControl(json: unknown): Uint8Array {
  return jsonFrame(CHANNEL.CONTROL, json);
}

export function encodeEvent(json: unknown): Uint8Array {
  return jsonFrame(CHANNEL.EVENT, json);
}

export function encodeInput(streamId: number, msg: InputMessage): Uint8Array {
  assertByte(streamId, "streamId");

  switch (msg.kind) {
    case "touch": {
      const b = frameHeader(streamId, INPUT_KIND.TOUCH, 12);
      const v = view(b);
      v.setUint8(3, msg.phase);
      v.setFloat32(4, msg.x);
      v.setFloat32(8, msg.y);
      v.setUint16(12, msg.seq & 0xffff);
      v.setUint8(14, msg.edge);
      return b;
    }
    case "multitouch": {
      const b = frameHeader(streamId, INPUT_KIND.MULTITOUCH, 19);
      const v = view(b);
      v.setUint8(3, msg.phase);
      v.setFloat32(4, msg.x1);
      v.setFloat32(8, msg.y1);
      v.setFloat32(12, msg.x2);
      v.setFloat32(16, msg.y2);
      v.setUint16(20, msg.seq & 0xffff);
      return b;
    }
    case "key": {
      const b = frameHeader(streamId, INPUT_KIND.KEY, 5);
      const v = view(b);
      v.setUint8(3, msg.phase);
      v.setUint32(4, msg.usage);
      return b;
    }
    case "button": {
      const b = frameHeader(streamId, INPUT_KIND.BUTTON, 2);
      const v = view(b);
      v.setUint8(3, msg.phase);
      v.setUint8(4, msg.buttonId);
      return b;
    }
    case "scroll": {
      const b = frameHeader(streamId, INPUT_KIND.SCROLL, 16);
      const v = view(b);
      v.setFloat32(3, msg.dx);
      v.setFloat32(7, msg.dy);
      v.setFloat32(11, msg.anchorX);
      v.setFloat32(15, msg.anchorY);
      return b;
    }
    case "text": {
      const bytes = new TextEncoder().encode(msg.text);
      const b = frameHeader(streamId, INPUT_KIND.TEXT, bytes.length);
      b.set(bytes, 3);
      return b;
    }
  }
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

export function decodeFrame(buf: Uint8Array): WireFrame {
  if (buf.length < 1) throw new ProtocolError("empty frame");
  const channel = buf[0]!;

  switch (channel) {
    case CHANNEL.VIDEO: {
      need(buf, 3, "video");
      return {
        channel: "video",
        streamId: buf[1]!,
        tag: buf[2]!,
        // copy: callers may retain the frame past the socket buffer's lifetime
        data: buf.slice(3),
      };
    }
    case CHANNEL.INPUT: {
      need(buf, 3, "input");
      return {
        channel: "input",
        streamId: buf[1]!,
        msg: decodeInputPayload(buf),
      };
    }
    case CHANNEL.CONTROL:
      return { channel: "control", json: parseJson(buf) };
    case CHANNEL.EVENT:
      return { channel: "event", json: parseJson(buf) };
    default:
      throw new ProtocolError(`unknown channel 0x${hex(channel)}`);
  }
}

function decodeInputPayload(buf: Uint8Array): InputMessage {
  const kind = buf[2]!;
  const v = view(buf);

  switch (kind) {
    case INPUT_KIND.TOUCH:
      need(buf, 15, "touch");
      return {
        kind: "touch",
        phase: asTouchPhase(v.getUint8(3)),
        x: v.getFloat32(4),
        y: v.getFloat32(8),
        seq: v.getUint16(12),
        edge: v.getUint8(14),
      };
    case INPUT_KIND.MULTITOUCH:
      need(buf, 22, "multitouch");
      return {
        kind: "multitouch",
        phase: asTouchPhase(v.getUint8(3)),
        x1: v.getFloat32(4),
        y1: v.getFloat32(8),
        x2: v.getFloat32(12),
        y2: v.getFloat32(16),
        seq: v.getUint16(20),
      };
    case INPUT_KIND.KEY:
      need(buf, 8, "key");
      return {
        kind: "key",
        phase: asKeyPhase(v.getUint8(3)),
        usage: v.getUint32(4),
      };
    case INPUT_KIND.BUTTON:
      need(buf, 5, "button");
      return {
        kind: "button",
        phase: asKeyPhase(v.getUint8(3)),
        buttonId: v.getUint8(4),
      };
    case INPUT_KIND.SCROLL:
      need(buf, 19, "scroll");
      return {
        kind: "scroll",
        dx: v.getFloat32(3),
        dy: v.getFloat32(7),
        anchorX: v.getFloat32(11),
        anchorY: v.getFloat32(15),
      };
    case INPUT_KIND.TEXT:
      return {
        kind: "text",
        text: new TextDecoder("utf-8", { fatal: false }).decode(buf.subarray(3)),
      };
    default:
      throw new ProtocolError(`unknown input kind 0x${hex(kind)}`);
  }
}

// ---------------------------------------------------------------------------
// Coordinate mapping
// ---------------------------------------------------------------------------

export interface PixelSize {
  width: number;
  height: number;
}

/**
 * Normalized [0,1] -> device pixels, clamped and rounded.
 *
 * `width`/`height` must be the *pixel* dimensions of the currently displayed
 * (already rotated) frame, so this is orientation-agnostic by construction.
 */
export function toDevicePixels(
  x: number,
  y: number,
  screen: PixelSize,
): { x: number; y: number } {
  return {
    x: mapAxis(x, screen.width),
    y: mapAxis(y, screen.height),
  };
}

function mapAxis(v: number, extent: number): number {
  if (Number.isNaN(v)) return 0;
  // Infinities clamp to the far edge like any other out-of-range value.
  const clamped = v < 0 ? 0 : v > 1 ? 1 : v;
  // Max index is extent-1: a normalized 1.0 must not land one pixel outside.
  return Math.min(extent - 1, Math.max(0, Math.round(clamped * (extent - 1))));
}

/**
 * True if `seq` is newer than `prev`, tolerant of the 16-bit wraparound.
 * Used to drop out-of-order / stale moves within one gesture.
 */
/** The two values PROTOCOL §4's `appearance` op takes. */
export type Appearance = "light" | "dark";

/**
 * Validate an `appearance` op's `mode` before it reaches a shell command.
 *
 * Both backends implement this by interpolating into a command line
 * (`simctl ui <udid> appearance <mode>`, `cmd uimode night <yes|no>`), so the
 * value has to be one of two literals before it gets anywhere near one. Not a
 * theoretical worry: the op is reachable from any client on the WebSocket, and
 * the first version of PROTOCOL says there is no authentication (ARCHITECTURE.md).
 */
export function appearanceMode(args: unknown): Appearance {
  const mode = (args as { mode?: unknown } | null | undefined)?.mode;
  if (mode !== "light" && mode !== "dark") {
    throw new ProtocolError(`appearance needs mode "light" or "dark"`);
  }
  return mode;
}

export function seqIsNewer(seq: number, prev: number): boolean {
  return ((seq - prev) & 0xffff) < 0x8000 && seq !== prev;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function frameHeader(
  streamId: number,
  kind: number,
  payloadLen: number,
): Uint8Array {
  const b = new Uint8Array(3 + payloadLen);
  b[0] = CHANNEL.INPUT;
  b[1] = streamId;
  b[2] = kind;
  return b;
}

function jsonFrame(channel: number, json: unknown): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify(json));
  const out = new Uint8Array(1 + bytes.length);
  out[0] = channel;
  out.set(bytes, 1);
  return out;
}

function parseJson(buf: Uint8Array): unknown {
  const text = new TextDecoder().decode(buf.subarray(1));
  try {
    return JSON.parse(text);
  } catch {
    throw new ProtocolError(`invalid JSON payload: ${text.slice(0, 120)}`);
  }
}

function view(b: Uint8Array): DataView {
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
}

function need(buf: Uint8Array, len: number, what: string): void {
  if (buf.length < len) {
    throw new ProtocolError(
      `${what} frame too short: ${buf.length} < ${len} bytes`,
    );
  }
}

function assertByte(v: number, what: string): void {
  if (!Number.isInteger(v) || v < 0 || v > 255) {
    throw new ProtocolError(`${what} out of range: ${v}`);
  }
}

function asTouchPhase(v: number): TouchPhase {
  if (v !== 0 && v !== 1 && v !== 2) {
    throw new ProtocolError(`bad touch phase ${v}`);
  }
  return v;
}

function asKeyPhase(v: number): KeyPhase {
  if (v !== 0 && v !== 1) throw new ProtocolError(`bad key phase ${v}`);
  return v;
}

function hex(n: number): string {
  return n.toString(16).padStart(2, "0");
}
