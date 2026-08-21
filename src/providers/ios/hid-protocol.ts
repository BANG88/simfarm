/**
 * Translation between the simfarm INPUT channel (PROTOCOL §5) and serve-sim's
 * HID WebSocket protocol.
 *
 * serve-sim used to frame HID as packed binary — a 12/13-byte touch on opcode
 * `0x10`, a 20-byte two-finger message on `0x11`, JSON on `0x03`..`0x09`. Those
 * binary frames are **gone** as of serve-sim@0.1.45: every message is now
 *
 *     [1B opcode][UTF-8 JSON]
 *
 * with opcodes 3..12 (see HID_OP). Verified against the shipped
 * `DeviceSession.handleHidMessage` in dist/middleware.js.
 *
 * Two things matter more than the framing:
 *
 * 1. **Coordinates are normalized [0,1]**, not pixels. serve-sim passes them
 *    straight to `IndigoHIDMessageForMouseNSEvent` with NSSize(1,1), so the
 *    CGPoint *is* the ratio. Our wire format is normalized too, so no screen
 *    size is ever needed here — but the coordinates still have to be *rotated*,
 *    because the client normalizes against the upright picture while serve-sim
 *    wants the sideways framebuffer (PROTOCOL §6). `rotation.ts` is that
 *    inverse; `inputToHid` takes the handle's current `frameRotation` and
 *    applies it before anything else.
 *
 * 2. **The `edge` value is not our `edge` value.** Ours (PROTOCOL §5) is
 *    `0=none 1=top 2=bottom 3=left 4=right`; the IndigoHIDEdge enum serve-sim
 *    forwards is `0=none 1=left 2=top 3=bottom 4=right`. Passing our byte
 *    through unchanged would turn "swipe up from the bottom edge" (2) into a
 *    *top* edge gesture — the notification centre — and silently break the one
 *    capability iOS has that the other two platforms do not. Hence
 *    `toIndigoEdge`, and hence the test that pins it.
 *
 *    In landscape there is a second renumbering *underneath* that one: the
 *    edge the user swiped from is an edge of the picture, and the picture is a
 *    quarter turn away from the framebuffer. `toFramebufferEdge` runs first
 *    (still in PROTOCOL §5 numbering), `toIndigoEdge` second.
 */

import { KEY_PHASE, TOUCH_EDGE, TOUCH_PHASE } from "../../protocol.ts";
import type { InputMessage } from "../../protocol.ts";
import type { FrameRotation, Orientation } from "../../types.ts";
import { toFramebufferInput } from "./rotation.ts";

/** First byte of a client -> serve-sim HID message. */
export const HID_OP = {
  TOUCH: 3,
  BUTTON: 4,
  MULTITOUCH: 5,
  KEY: 6,
  ORIENTATION: 7,
  CA_DEBUG: 8,
  MEMORY_WARNING: 9,
  DIGITAL_CROWN: 10,
  SCROLL: 11,
  SOFTWARE_KEYBOARD: 12,
} as const;

/** First byte of a serve-sim -> client HID message (screen config push). */
export const HID_CONFIG_TAG = 0x82;

/**
 * `IndigoHIDEdge`, the 7th argument of `IndigoHIDMessageForMouseNSEvent`.
 * Values from serve-sim's HIDInjector.swift, which got them by disassembling
 * the private function and testing each against a booted Face ID simulator.
 */
export const INDIGO_EDGE = {
  NONE: 0,
  LEFT: 1,
  TOP: 2,
  BOTTOM: 3,
  RIGHT: 4,
} as const;

/** simfarm TOUCH_EDGE -> IndigoHIDEdge. Unknown values degrade to "no edge". */
export function toIndigoEdge(edge: number): number {
  switch (edge) {
    case TOUCH_EDGE.TOP:
      return INDIGO_EDGE.TOP;
    case TOUCH_EDGE.BOTTOM:
      return INDIGO_EDGE.BOTTOM;
    case TOUCH_EDGE.LEFT:
      return INDIGO_EDGE.LEFT;
    case TOUCH_EDGE.RIGHT:
      return INDIGO_EDGE.RIGHT;
    default:
      return INDIGO_EDGE.NONE;
  }
}

/** TOUCH/MULTITOUCH phase -> serve-sim touch type. */
export function touchType(phase: number): "begin" | "move" | "end" {
  switch (phase) {
    case TOUCH_PHASE.BEGIN:
      return "begin";
    case TOUCH_PHASE.MOVE:
      return "move";
    default:
      return "end";
  }
}

/**
 * Buttons serve-sim drives through `IndigoHIDMessageForButton` / SpringBoard.
 * These are momentary: a press is a complete gesture, so we emit on DOWN only.
 */
const NAMED_BUTTONS: Record<number, string> = {
  0x01: "home",
  0x02: "lock",
  0x06: "app_switcher",
  0x08: "siri",
};

/**
 * Buttons serve-sim drives through `IndigoHIDMessageForHIDArbitrary`, which
 * honours a real down/up. Usage pairs come from DeviceKit's chrome.json
 * (`/Library/Developer/DeviceKit/Chrome/*.devicechrome/Contents/Resources/chrome.json`).
 */
const HID_BUTTONS: Record<number, { page: number; usage: number }> = {
  0x03: { page: 0x0c, usage: 0xe9 }, // volume_up
  0x04: { page: 0x0c, usage: 0xea }, // volume_down
  0x07: { page: 0x0c, usage: 0x30 }, // power
  0x0c: { page: 0x0b, usage: 0x2d }, // action
};

/** Button names this provider can actually deliver, for `capabilities.buttons`. */
export const SUPPORTED_BUTTONS = [
  "home",
  "lock",
  "app_switch",
  "siri",
  "power",
  "volume_up",
  "volume_down",
  "action",
];

export interface HidFrame {
  op: number;
  payload: unknown;
}

export function encodeHidFrame(frame: HidFrame): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(frame.payload ?? {}));
  const out = new Uint8Array(1 + body.length);
  out[0] = frame.op;
  out.set(body, 1);
  return out;
}

/**
 * One simfarm INPUT message -> zero or more serve-sim HID frames.
 *
 * `frameRotation` is the handle's current value (PROTOCOL §6): the client sent
 * coordinates normalized against the *upright* picture, and this is the only
 * place that knows how to put them back into framebuffer space. Defaulting it
 * to 0 keeps portrait — and every other backend's semantics — untouched.
 *
 * Pure, so the interesting parts (rotation, edge mapping, text expansion,
 * button routing) are unit-testable without a simulator.
 */
export function inputToHid(
  input: InputMessage,
  frameRotation: FrameRotation = 0,
): HidFrame[] {
  const msg = toFramebufferInput(input, frameRotation);
  switch (msg.kind) {
    case "touch":
      return [
        {
          op: HID_OP.TOUCH,
          payload: {
            type: touchType(msg.phase),
            x: clamp01(msg.x),
            y: clamp01(msg.y),
            edge: toIndigoEdge(msg.edge),
          },
        },
      ];

    case "multitouch":
      return [
        {
          op: HID_OP.MULTITOUCH,
          payload: {
            type: touchType(msg.phase),
            x1: clamp01(msg.x1),
            y1: clamp01(msg.y1),
            x2: clamp01(msg.x2),
            y2: clamp01(msg.y2),
          },
        },
      ];

    case "key":
      return [
        {
          op: HID_OP.KEY,
          payload: {
            type: msg.phase === KEY_PHASE.DOWN ? "down" : "up",
            usage: msg.usage,
          },
        },
      ];

    case "button": {
      const hid = HID_BUTTONS[msg.buttonId];
      if (hid) {
        return [
          {
            op: HID_OP.BUTTON,
            payload: {
              page: hid.page,
              usage: hid.usage,
              phase: msg.phase === KEY_PHASE.DOWN ? "down" : "up",
            },
          },
        ];
      }
      const named = NAMED_BUTTONS[msg.buttonId];
      // Named buttons are a complete press on the serve-sim side; firing again
      // on UP would double-press (and double-press of home = app switcher).
      if (named && msg.phase === KEY_PHASE.DOWN) {
        return [{ op: HID_OP.BUTTON, payload: { button: named } }];
      }
      return [];
    }

    case "scroll":
      // serve-sim multiplies dx/dy by the screen size itself, so these stay
      // normalized. Sign convention matches: positive = content moves right/down.
      return [
        {
          op: HID_OP.SCROLL,
          payload: {
            dx: msg.dx,
            dy: msg.dy,
            x: clamp01(msg.anchorX),
            y: clamp01(msg.anchorY),
          },
        },
      ];

    case "text":
      return textToHid(msg.text);
  }
}

export function orientationFrame(orientation: Orientation): HidFrame {
  return { op: HID_OP.ORIENTATION, payload: { orientation } };
}

// ---------------------------------------------------------------------------
// text -> per-key HID
// ---------------------------------------------------------------------------

const LEFT_SHIFT_USAGE = 0xe1;

/** Unshifted US-layout punctuation, keyed by character. */
const PUNCT: Record<string, number> = {
  " ": 0x2c,
  "-": 0x2d,
  "=": 0x2e,
  "[": 0x2f,
  "]": 0x30,
  "\\": 0x31,
  ";": 0x33,
  "'": 0x34,
  "`": 0x35,
  ",": 0x36,
  ".": 0x37,
  "/": 0x38,
  "\n": 0x28,
  "\t": 0x2b,
};

/** Shifted characters -> the unshifted character on the same physical key. */
const SHIFTED: Record<string, string> = {
  "!": "1",
  "@": "2",
  "#": "3",
  $: "4",
  "%": "5",
  "^": "6",
  "&": "7",
  "*": "8",
  "(": "9",
  ")": "0",
  _: "-",
  "+": "=",
  "{": "[",
  "}": "]",
  "|": "\\",
  ":": ";",
  '"': "'",
  "~": "`",
  "<": ",",
  ">": ".",
  "?": "/",
};

/**
 * USB HID Usage Page 0x07 code for one character, plus whether Shift is needed.
 * Returns null for anything outside the US keyboard (emoji, CJK, …) — serve-sim
 * has no text-injection path, only per-key HID, so those simply cannot be typed.
 */
export function usageForChar(ch: string): { usage: number; shift: boolean } | null {
  if (ch >= "a" && ch <= "z") {
    return { usage: 0x04 + (ch.charCodeAt(0) - 97), shift: false };
  }
  if (ch >= "A" && ch <= "Z") {
    return { usage: 0x04 + (ch.charCodeAt(0) - 65), shift: true };
  }
  if (ch >= "1" && ch <= "9") {
    return { usage: 0x1e + (ch.charCodeAt(0) - 49), shift: false };
  }
  if (ch === "0") return { usage: 0x27, shift: false };

  const plain = PUNCT[ch];
  if (plain !== undefined) return { usage: plain, shift: false };

  const base = SHIFTED[ch];
  if (base !== undefined) {
    const mapped = usageForChar(base);
    if (mapped) return { usage: mapped.usage, shift: true };
  }
  return null;
}

/** Expand a string into the key-down/key-up frames that type it. */
export function textToHid(text: string): HidFrame[] {
  const frames: HidFrame[] = [];
  const key = (type: "down" | "up", usage: number): HidFrame => ({
    op: HID_OP.KEY,
    payload: { type, usage },
  });
  for (const ch of text) {
    const mapped = usageForChar(ch);
    if (!mapped) continue;
    if (mapped.shift) frames.push(key("down", LEFT_SHIFT_USAGE));
    frames.push(key("down", mapped.usage), key("up", mapped.usage));
    if (mapped.shift) frames.push(key("up", LEFT_SHIFT_USAGE));
  }
  return frames;
}

// ---------------------------------------------------------------------------
// serve-sim -> us
// ---------------------------------------------------------------------------

export interface SimScreenConfig {
  width: number;
  height: number;
  orientation: Orientation;
}

/**
 * Decode the `[0x82][JSON]` screen-config frame serve-sim pushes on the HID
 * socket when a viewer attaches and whenever the framebuffer changes shape.
 * Returns null for anything else on the socket.
 */
export function decodeConfigFrame(buf: Uint8Array): SimScreenConfig | null {
  if (buf.length < 2 || buf[0] !== HID_CONFIG_TAG) return null;
  try {
    const json = JSON.parse(new TextDecoder().decode(buf.subarray(1))) as
      | Partial<SimScreenConfig>
      | null;
    if (!json || typeof json.width !== "number" || typeof json.height !== "number") {
      return null;
    }
    return {
      width: json.width,
      height: json.height,
      orientation: (json.orientation as Orientation) ?? "portrait",
    };
  } catch {
    return null;
  }
}

function clamp01(v: number): number {
  if (Number.isNaN(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
