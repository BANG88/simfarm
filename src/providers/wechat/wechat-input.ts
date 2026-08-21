/**
 * simfarm INPUT messages -> Chrome DevTools Protocol input commands.
 *
 * Pure translation, no sockets, so every coordinate and key mapping is
 * unit-testable. Two things are worth knowing before reading:
 *
 * 1. **CDP input is in CSS pixels**, not device pixels. The frames we ship are
 *    the *device* pixels of the same viewport (752x1618 for a 376x809 layout on
 *    a 2x display), so the scale factor between what the client sees and what we
 *    dispatch is real and has to be divided out — hence `viewport` here is the
 *    CSS viewport, never the frame size.
 *
 * 2. **Touch works, and so does mouse.** Both were measured against a live mini
 *    program: a `dispatchTouchEvent` tap on the tab bar navigates. Touch is what
 *    we use, because mini program components bind `bindtap` / `bindtouchstart`
 *    and a real device only ever produces touches. Scrolling is the exception —
 *    it goes out as a wheel event, since there is no touch equivalent that does
 *    not require synthesising an entire drag.
 */

import {
  TOUCH_PHASE,
  KEY_PHASE,
  toDevicePixels,
  type InputMessage,
} from "../../protocol.ts";

export interface CdpCommand {
  method: string;
  params: Record<string, unknown>;
}

/** CSS viewport of the page frame — `Page.getLayoutMetrics().cssLayoutViewport`. */
export interface Viewport {
  width: number;
  height: number;
}

const TOUCH_TYPE: Record<number, string> = {
  [TOUCH_PHASE.BEGIN]: "touchStart",
  [TOUCH_PHASE.MOVE]: "touchMove",
  [TOUCH_PHASE.END]: "touchEnd",
};

/**
 * @returns the commands to dispatch, in order. Empty when the message is
 * something this backend has no way to express (a hardware button, say — WeChat
 * declares `buttons: []`), which is not an error: the client is allowed to send
 * anything and we simply do not act on what we cannot do.
 */
export function inputToCdp(
  msg: InputMessage,
  viewport: Viewport,
): CdpCommand[] {
  switch (msg.kind) {
    case "touch": {
      const type = TOUCH_TYPE[msg.phase];
      if (!type) return [];
      const p = point(msg.x, msg.y, viewport);
      return [
        {
          method: "Input.dispatchTouchEvent",
          params: {
            type,
            // touchEnd carries the points still down — none, for a single
            // finger. Sending the released point instead makes Chromium reject
            // the whole event.
            touchPoints:
              msg.phase === TOUCH_PHASE.END ? [] : [touchPoint(p, 0)],
          },
        },
      ];
    }

    case "multitouch": {
      const type = TOUCH_TYPE[msg.phase];
      if (!type) return [];
      const a = point(msg.x1, msg.y1, viewport);
      const b = point(msg.x2, msg.y2, viewport);
      return [
        {
          method: "Input.dispatchTouchEvent",
          params: {
            type,
            touchPoints:
              msg.phase === TOUCH_PHASE.END
                ? []
                : [touchPoint(a, 0), touchPoint(b, 1)],
          },
        },
      ];
    }

    case "scroll": {
      const anchor = point(msg.anchorX, msg.anchorY, viewport);
      // PROTOCOL §5: dx/dy are normalized displacement of the *content*, so a
      // positive dy means the content moved down — which is a negative wheel
      // delta. Getting this backwards produces a client that scrolls the wrong
      // way, which looks like a broken trackpad rather than a bug.
      return [
        {
          method: "Input.dispatchMouseEvent",
          params: {
            type: "mouseWheel",
            x: anchor.x,
            y: anchor.y,
            button: "none",
            buttons: 0,
            deltaX: -msg.dx * viewport.width,
            deltaY: -msg.dy * viewport.height,
          },
        },
      ];
    }

    case "key": {
      const key = KEYS[msg.usage];
      if (!key) return [];
      const down = msg.phase === KEY_PHASE.DOWN;
      return [
        {
          method: "Input.dispatchKeyEvent",
          params: {
            // "keyDown" without text is a rawKeyDown as far as Chromium is
            // concerned; carrying the text is what actually inserts a character.
            type: down && key.text ? "keyDown" : down ? "rawKeyDown" : "keyUp",
            key: key.key,
            code: key.code,
            windowsVirtualKeyCode: key.vk,
            nativeVirtualKeyCode: key.vk,
            ...(down && key.text ? { text: key.text } : {}),
          },
        },
      ];
    }

    case "text":
      if (!msg.text) return [];
      // insertText goes in as composed text, so CJK and emoji survive — the
      // per-key HID path the iOS provider has to use cannot do that.
      return [{ method: "Input.insertText", params: { text: msg.text } }];

    case "button":
      // `capabilities.buttons` is empty for this backend; there is no home or
      // back key in the WeChat simulator to press.
      return [];
  }
}

// ---------------------------------------------------------------------------

function point(
  nx: number,
  ny: number,
  viewport: Viewport,
): { x: number; y: number } {
  return toDevicePixels(nx, ny, viewport);
}

function touchPoint(p: { x: number; y: number }, id: number): object {
  return { x: p.x, y: p.y, radiusX: 2, radiusY: 2, force: 1, id };
}

interface KeySpec {
  key: string;
  code: string;
  vk: number;
  /** the character this key inserts, if any */
  text?: string;
}

/**
 * USB HID Usage Page 0x07 -> the fields CDP wants. This is the inverse of
 * `hidUsage()` in `web/app.js`; the two are a pair and a gap in either one
 * silently drops keystrokes.
 */
export const KEYS: Record<number, KeySpec> = buildKeys();

function buildKeys(): Record<number, KeySpec> {
  const keys: Record<number, KeySpec> = {};

  for (let i = 0; i < 26; i++) {
    const lower = String.fromCharCode(97 + i);
    const upper = String.fromCharCode(65 + i);
    keys[0x04 + i] = { key: lower, code: `Key${upper}`, vk: 65 + i, text: lower };
  }
  for (let i = 0; i < 9; i++) {
    const d = String(i + 1);
    keys[0x1e + i] = { key: d, code: `Digit${d}`, vk: 49 + i, text: d };
  }
  keys[0x27] = { key: "0", code: "Digit0", vk: 48, text: "0" };
  for (let i = 0; i < 12; i++) {
    keys[0x3a + i] = { key: `F${i + 1}`, code: `F${i + 1}`, vk: 112 + i };
  }

  const named: Array<[number, KeySpec]> = [
    [0x28, { key: "Enter", code: "Enter", vk: 13, text: "\r" }],
    [0x29, { key: "Escape", code: "Escape", vk: 27 }],
    [0x2a, { key: "Backspace", code: "Backspace", vk: 8 }],
    [0x2b, { key: "Tab", code: "Tab", vk: 9, text: "\t" }],
    [0x2c, { key: " ", code: "Space", vk: 32, text: " " }],
    [0x2d, { key: "-", code: "Minus", vk: 189, text: "-" }],
    [0x2e, { key: "=", code: "Equal", vk: 187, text: "=" }],
    [0x2f, { key: "[", code: "BracketLeft", vk: 219, text: "[" }],
    [0x30, { key: "]", code: "BracketRight", vk: 221, text: "]" }],
    [0x31, { key: "\\", code: "Backslash", vk: 220, text: "\\" }],
    [0x33, { key: ";", code: "Semicolon", vk: 186, text: ";" }],
    [0x34, { key: "'", code: "Quote", vk: 222, text: "'" }],
    [0x35, { key: "`", code: "Backquote", vk: 192, text: "`" }],
    [0x36, { key: ",", code: "Comma", vk: 188, text: "," }],
    [0x37, { key: ".", code: "Period", vk: 190, text: "." }],
    [0x38, { key: "/", code: "Slash", vk: 191, text: "/" }],
    [0x39, { key: "CapsLock", code: "CapsLock", vk: 20 }],
    [0x4a, { key: "Home", code: "Home", vk: 36 }],
    [0x4b, { key: "PageUp", code: "PageUp", vk: 33 }],
    [0x4c, { key: "Delete", code: "Delete", vk: 46 }],
    [0x4d, { key: "End", code: "End", vk: 35 }],
    [0x4e, { key: "PageDown", code: "PageDown", vk: 34 }],
    [0x4f, { key: "ArrowRight", code: "ArrowRight", vk: 39 }],
    [0x50, { key: "ArrowLeft", code: "ArrowLeft", vk: 37 }],
    [0x51, { key: "ArrowDown", code: "ArrowDown", vk: 40 }],
    [0x52, { key: "ArrowUp", code: "ArrowUp", vk: 38 }],
  ];
  for (const [usage, spec] of named) keys[usage] = spec;

  return keys;
}
