/**
 * scrcpy control-message encoders (client -> device) and device-message decoder
 * (device -> client), pinned to **scrcpy v4.1**.
 *
 * Layouts transcribed from the v4.1 sources, not from the wiki:
 *   app/src/control_msg.c                       (serialization)
 *   server/.../control/ControlMessageReader.java (the parser that must agree)
 *   server/.../control/DeviceMessageWriter.java  (the reverse direction)
 *
 * All integers are big-endian. This file is pure byte layout with no I/O so it
 * is unit tested directly (test/providers/android/scrcpy-control.test.ts).
 */

export const CONTROL_MSG = {
  INJECT_KEYCODE: 0,
  INJECT_TEXT: 1,
  INJECT_TOUCH_EVENT: 2,
  INJECT_SCROLL_EVENT: 3,
  BACK_OR_SCREEN_ON: 4,
  EXPAND_NOTIFICATION_PANEL: 5,
  EXPAND_SETTINGS_PANEL: 6,
  COLLAPSE_PANELS: 7,
  GET_CLIPBOARD: 8,
  SET_CLIPBOARD: 9,
  SET_DISPLAY_POWER: 10,
  ROTATE_DEVICE: 11,
  UHID_CREATE: 12,
  UHID_INPUT: 13,
  UHID_DESTROY: 14,
  OPEN_HARD_KEYBOARD_SETTINGS: 15,
  START_APP: 16,
  RESET_VIDEO: 17,
  CAMERA_SET_TORCH: 18,
  CAMERA_ZOOM_IN: 19,
  CAMERA_ZOOM_OUT: 20,
  RESIZE_DISPLAY: 21,
  SCAN_FILE: 22,
} as const;

export const DEVICE_MSG = {
  CLIPBOARD: 0,
  ACK_CLIPBOARD: 1,
  UHID_OUTPUT: 2,
} as const;

/** android.view.KeyEvent actions. */
export const KEY_ACTION = { DOWN: 0, UP: 1 } as const;

/** android.view.MotionEvent actions we use (see control_msg.c). */
export const MOTION_ACTION = {
  DOWN: 0,
  UP: 1,
  MOVE: 2,
  CANCEL: 3,
} as const;

/**
 * Well-known pointer ids. The device side keys its pointer table on these, so
 * two concurrent fingers just need two different values — the server derives
 * ACTION_POINTER_DOWN/UP and the pointer index itself (Controller.injectTouch).
 */
export const POINTER_ID = {
  MOUSE: 0xffffffffffffffffn,
  GENERIC_FINGER: 0xfffffffffffffffen,
  VIRTUAL_FINGER: 0xfffffffffffffffdn,
} as const;

export const COPY_KEY = { NONE: 0, COPY: 1, CUT: 2 } as const;

/** ControlMessageReader caps INJECT_TEXT at 300 bytes; longer is a hard error. */
export const INJECT_TEXT_MAX_BYTES = 300;

export interface Position {
  x: number;
  y: number;
  /** dimensions of the video the coordinates were taken from */
  screenWidth: number;
  screenHeight: number;
}

// ---------------------------------------------------------------------------
// fixed-point helpers (util/binary.h)
// ---------------------------------------------------------------------------

/** float in [0,1] -> u16 fixed point. */
export function floatToU16Fp(f: number): number {
  const clamped = f < 0 ? 0 : f > 1 ? 1 : f;
  const u = Math.round(clamped * 0x10000);
  return u >= 0xffff ? 0xffff : u;
}

/** float in [-1,1] -> i16 fixed point (returned as an unsigned 16-bit word). */
export function floatToI16Fp(f: number): number {
  const clamped = f < -1 ? -1 : f > 1 ? 1 : f;
  let i = Math.round(clamped * 0x8000);
  if (i >= 0x7fff) i = 0x7fff;
  if (i < -0x8000) i = -0x8000;
  return i & 0xffff;
}

// ---------------------------------------------------------------------------
// encoders
// ---------------------------------------------------------------------------

export function encodeInjectKeycode(
  action: number,
  keycode: number,
  repeat = 0,
  metaState = 0,
): Uint8Array {
  const b = new Uint8Array(14);
  const v = new DataView(b.buffer);
  b[0] = CONTROL_MSG.INJECT_KEYCODE;
  b[1] = action;
  v.setUint32(2, keycode);
  v.setUint32(6, repeat);
  v.setUint32(10, metaState);
  return b;
}

export function encodeInjectText(text: string): Uint8Array {
  const bytes = truncateUtf8(text, INJECT_TEXT_MAX_BYTES);
  const b = new Uint8Array(5 + bytes.length);
  new DataView(b.buffer).setUint32(1, bytes.length);
  b[0] = CONTROL_MSG.INJECT_TEXT;
  b.set(bytes, 5);
  return b;
}

export function encodeInjectTouch(opts: {
  action: number;
  pointerId: bigint;
  position: Position;
  /** 0..1; the device treats pressure 0 as "finger lifted" */
  pressure: number;
  actionButton?: number;
  buttons?: number;
}): Uint8Array {
  const b = new Uint8Array(32);
  const v = new DataView(b.buffer);
  b[0] = CONTROL_MSG.INJECT_TOUCH_EVENT;
  b[1] = opts.action;
  v.setBigUint64(2, opts.pointerId);
  writePosition(v, 10, opts.position);
  v.setUint16(22, floatToU16Fp(opts.pressure));
  v.setUint32(24, opts.actionButton ?? 0);
  v.setUint32(28, opts.buttons ?? 0);
  return b;
}

export function encodeInjectScroll(opts: {
  position: Position;
  /** scroll units, clamped to [-16,16] like the reference client */
  hscroll: number;
  vscroll: number;
  buttons?: number;
}): Uint8Array {
  const b = new Uint8Array(21);
  const v = new DataView(b.buffer);
  b[0] = CONTROL_MSG.INJECT_SCROLL_EVENT;
  writePosition(v, 1, opts.position);
  v.setUint16(13, floatToI16Fp(opts.hscroll / 16));
  v.setUint16(15, floatToI16Fp(opts.vscroll / 16));
  v.setUint32(17, opts.buttons ?? 0);
  return b;
}

export function encodeBackOrScreenOn(action: number): Uint8Array {
  return new Uint8Array([CONTROL_MSG.BACK_OR_SCREEN_ON, action]);
}

export function encodeGetClipboard(copyKey: number = COPY_KEY.NONE): Uint8Array {
  return new Uint8Array([CONTROL_MSG.GET_CLIPBOARD, copyKey]);
}

export function encodeSetClipboard(
  sequence: bigint,
  text: string,
  paste: boolean,
): Uint8Array {
  const bytes = new TextEncoder().encode(text);
  const b = new Uint8Array(14 + bytes.length);
  const v = new DataView(b.buffer);
  b[0] = CONTROL_MSG.SET_CLIPBOARD;
  v.setBigUint64(1, sequence);
  b[9] = paste ? 1 : 0;
  v.setUint32(10, bytes.length);
  b.set(bytes, 14);
  return b;
}

export function encodeSetDisplayPower(on: boolean): Uint8Array {
  return new Uint8Array([CONTROL_MSG.SET_DISPLAY_POWER, on ? 1 : 0]);
}

/** Payload-free messages: rotate, panels, reset video, keyboard settings. */
export function encodeEmpty(type: number): Uint8Array {
  return new Uint8Array([type]);
}

/** START_APP takes a 1-byte-length string; a `+` prefix means "force stop first". */
export function encodeStartApp(name: string): Uint8Array {
  const bytes = truncateUtf8(name, 255);
  const b = new Uint8Array(2 + bytes.length);
  b[0] = CONTROL_MSG.START_APP;
  b[1] = bytes.length;
  b.set(bytes, 2);
  return b;
}

function writePosition(v: DataView, off: number, p: Position): void {
  v.setInt32(off, Math.round(p.x));
  v.setInt32(off + 4, Math.round(p.y));
  v.setUint16(off + 8, p.screenWidth);
  v.setUint16(off + 10, p.screenHeight);
}

/** Cut a string to at most `max` UTF-8 bytes without splitting a code point. */
export function truncateUtf8(text: string, max: number): Uint8Array {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= max) return bytes;
  let end = max;
  // 0b10xxxxxx is a continuation byte — back up until we are on a lead byte.
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end);
}

// ---------------------------------------------------------------------------
// device -> client
// ---------------------------------------------------------------------------

export type DeviceMessage =
  | { type: "clipboard"; text: string }
  | { type: "ack_clipboard"; sequence: bigint }
  | { type: "uhid_output"; id: number; data: Uint8Array };

export interface DeviceMessageParse {
  msg: DeviceMessage;
  /** bytes consumed */
  size: number;
}

/**
 * Try to parse one device message from the head of `buf`.
 * Returns null when more bytes are needed (the caller keeps buffering).
 */
export function parseDeviceMessage(buf: Uint8Array): DeviceMessageParse | null {
  if (buf.length < 1) return null;
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  switch (buf[0]) {
    case DEVICE_MSG.CLIPBOARD: {
      if (buf.length < 5) return null;
      const len = v.getUint32(1);
      if (buf.length < 5 + len) return null;
      return {
        msg: {
          type: "clipboard",
          text: new TextDecoder().decode(buf.subarray(5, 5 + len)),
        },
        size: 5 + len,
      };
    }
    case DEVICE_MSG.ACK_CLIPBOARD: {
      if (buf.length < 9) return null;
      return {
        msg: { type: "ack_clipboard", sequence: v.getBigUint64(1) },
        size: 9,
      };
    }
    case DEVICE_MSG.UHID_OUTPUT: {
      if (buf.length < 5) return null;
      const len = v.getUint16(3);
      if (buf.length < 5 + len) return null;
      return {
        msg: {
          type: "uhid_output",
          id: v.getUint16(1),
          data: buf.slice(5, 5 + len),
        },
        size: 5 + len,
      };
    }
    default:
      throw new Error(`unknown scrcpy device message type ${buf[0]}`);
  }
}
