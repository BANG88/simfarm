/**
 * INPUT messages -> CDP commands.
 *
 * Two things here are easy to get wrong and invisible once wrong:
 *
 * 1. **Which pixels.** The client normalizes against the picture it was sent —
 *    752x1618 device pixels — while CDP input is in the 376x809 CSS viewport.
 *    Dispatching frame coordinates would put every touch off the bottom-right
 *    of a page that is half the size, i.e. nothing would ever be hit and the
 *    logs would be clean.
 * 2. **Which way scroll goes.** PROTOCOL §5 defines dx/dy as content
 *    displacement; a wheel delta is the opposite sign. Inverted scrolling looks
 *    like a preference, not a bug, so it is pinned here.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  KEYS,
  inputToCdp,
  type CdpCommand,
} from "../../../src/providers/wechat/wechat-input.ts";
import {
  KEY_PHASE,
  TOUCH_EDGE,
  TOUCH_PHASE,
  type InputMessage,
} from "../../../src/protocol.ts";

/** The measured layout viewport of the WeChat simulator (HUAWEI Mate 70 Pro). */
const VIEWPORT = { width: 376, height: 809 };

function one(msg: InputMessage): CdpCommand {
  const out = inputToCdp(msg, VIEWPORT);
  assert.equal(out.length, 1, `expected exactly one command for ${msg.kind}`);
  return out[0]!;
}

function points(cmd: CdpCommand): Array<{ x: number; y: number; id: number }> {
  return cmd.params.touchPoints as Array<{ x: number; y: number; id: number }>;
}

describe("touch", () => {
  it("maps the phases onto CDP's touch event types", () => {
    const at = (phase: 0 | 1 | 2): string =>
      one({ kind: "touch", phase, x: 0.5, y: 0.5, seq: 1, edge: 0 }).params
        .type as string;
    assert.equal(at(TOUCH_PHASE.BEGIN), "touchStart");
    assert.equal(at(TOUCH_PHASE.MOVE), "touchMove");
    assert.equal(at(TOUCH_PHASE.END), "touchEnd");
  });

  it("dispatches in CSS pixels, not frame pixels", () => {
    const cmd = one({
      kind: "touch",
      phase: TOUCH_PHASE.BEGIN,
      x: 0.5,
      y: 0.5,
      seq: 1,
      edge: 0,
    });
    const [p] = points(cmd);
    // Half of the 376x809 viewport — not half of the 752x1618 frame.
    assert.deepEqual({ x: p!.x, y: p!.y }, { x: 188, y: 404 });
  });

  it("puts the corners on the corners", () => {
    const corner = (x: number, y: number): { x: number; y: number } => {
      const p = points(
        one({ kind: "touch", phase: TOUCH_PHASE.BEGIN, x, y, seq: 1, edge: 0 }),
      )[0]!;
      return { x: p.x, y: p.y };
    };
    assert.deepEqual(corner(0, 0), { x: 0, y: 0 });
    // 1.0 lands on the last pixel, never one past the edge.
    assert.deepEqual(corner(1, 1), { x: 375, y: 808 });
    assert.deepEqual(corner(1, 0), { x: 375, y: 0 });
    assert.deepEqual(corner(0, 1), { x: 0, y: 808 });
  });

  it("clamps out-of-range coordinates instead of dispatching them", () => {
    const p = points(
      one({ kind: "touch", phase: TOUCH_PHASE.BEGIN, x: -3, y: 9, seq: 1, edge: 0 }),
    )[0]!;
    assert.deepEqual({ x: p.x, y: p.y }, { x: 0, y: 808 });
  });

  it("sends no touch points on touchEnd", () => {
    // Chromium rejects a touchEnd that still lists the finger being lifted.
    const cmd = one({
      kind: "touch",
      phase: TOUCH_PHASE.END,
      x: 0.5,
      y: 0.5,
      seq: 2,
      edge: 0,
    });
    assert.deepEqual(points(cmd), []);
  });

  it("ignores `edge` — the simulator has no system gestures", () => {
    // capabilities.edgeGesture is false, so a client should send 0; if one
    // sends something else it must not change where the touch lands.
    const plain = points(
      one({ kind: "touch", phase: TOUCH_PHASE.BEGIN, x: 0.5, y: 0.99, seq: 1, edge: TOUCH_EDGE.NONE }),
    )[0]!;
    const edged = points(
      one({ kind: "touch", phase: TOUCH_PHASE.BEGIN, x: 0.5, y: 0.99, seq: 1, edge: TOUCH_EDGE.BOTTOM }),
    )[0]!;
    assert.deepEqual(plain, edged);
  });
});

describe("multitouch", () => {
  it("sends both fingers with distinct ids", () => {
    const cmd = one({
      kind: "multitouch",
      phase: TOUCH_PHASE.BEGIN,
      x1: 0.25,
      y1: 0.25,
      x2: 0.75,
      y2: 0.75,
      seq: 1,
    });
    const [a, b] = points(cmd);
    assert.equal(cmd.params.type, "touchStart");
    assert.deepEqual({ x: a!.x, y: a!.y, id: a!.id }, { x: 94, y: 202, id: 0 });
    assert.deepEqual({ x: b!.x, y: b!.y, id: b!.id }, { x: 281, y: 606, id: 1 });
  });

  it("lifts both fingers at once", () => {
    const cmd = one({
      kind: "multitouch",
      phase: TOUCH_PHASE.END,
      x1: 0.25,
      y1: 0.25,
      x2: 0.75,
      y2: 0.75,
      seq: 3,
    });
    assert.deepEqual(points(cmd), []);
  });
});

describe("scroll", () => {
  it("inverts the sign: content displacement is not wheel delta", () => {
    // dy > 0 means the content moved down, which is a wheel scroll upwards.
    const cmd = one({
      kind: "scroll",
      dx: 0,
      dy: 0.5,
      anchorX: 0.5,
      anchorY: 0.5,
    });
    assert.equal(cmd.method, "Input.dispatchMouseEvent");
    assert.equal(cmd.params.type, "mouseWheel");
    assert.equal(cmd.params.deltaY, -0.5 * 809);
    assert.equal(cmd.params.deltaX, -0);
  });

  it("scales each axis by its own extent", () => {
    const cmd = one({
      kind: "scroll",
      dx: 0.25,
      dy: -0.25,
      anchorX: 0.5,
      anchorY: 0.5,
    });
    assert.equal(cmd.params.deltaX, -0.25 * 376);
    assert.equal(cmd.params.deltaY, 0.25 * 809);
  });

  it("anchors the wheel where the pointer is", () => {
    const cmd = one({
      kind: "scroll",
      dx: 0,
      dy: 0.1,
      anchorX: 0.25,
      anchorY: 0.75,
    });
    assert.equal(cmd.params.x, 94);
    assert.equal(cmd.params.y, 606);
  });
});

describe("keys", () => {
  it("carries text on the way down so the character is inserted", () => {
    const cmd = one({ kind: "key", phase: KEY_PHASE.DOWN, usage: 0x04 });
    assert.equal(cmd.method, "Input.dispatchKeyEvent");
    assert.equal(cmd.params.type, "keyDown");
    assert.equal(cmd.params.key, "a");
    assert.equal(cmd.params.code, "KeyA");
    assert.equal(cmd.params.text, "a");
    assert.equal(cmd.params.windowsVirtualKeyCode, 65);
  });

  it("uses rawKeyDown for keys that insert nothing", () => {
    // A Backspace that arrives as a keyDown carrying text would type a
    // character instead of deleting one.
    const cmd = one({ kind: "key", phase: KEY_PHASE.DOWN, usage: 0x2a });
    assert.equal(cmd.params.type, "rawKeyDown");
    assert.equal(cmd.params.text, undefined);
    assert.equal(cmd.params.windowsVirtualKeyCode, 8);
  });

  it("never carries text on the way up", () => {
    const cmd = one({ kind: "key", phase: KEY_PHASE.UP, usage: 0x04 });
    assert.equal(cmd.params.type, "keyUp");
    assert.equal(cmd.params.text, undefined);
  });

  it("drops usages it has no mapping for rather than sending a broken event", () => {
    assert.deepEqual(inputToCdp({ kind: "key", phase: KEY_PHASE.DOWN, usage: 0xffff }, VIEWPORT), []);
  });

  it("covers every usage web/app.js can produce", () => {
    // The browser half and this half are a pair; a hole in either drops
    // keystrokes silently. These are exactly the codes `hidUsage()` emits.
    const fromBrowser = [
      ...range(0x04, 26), // KeyA..KeyZ
      ...range(0x1e, 9), // Digit1..Digit9
      0x27, // Digit0
      ...range(0x3a, 12), // F1..F12
      0x28, 0x29, 0x2a, 0x2b, 0x2c, 0x2d, 0x2e, 0x2f, 0x30, 0x31,
      0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39,
      0x4a, 0x4b, 0x4c, 0x4d, 0x4e, 0x4f, 0x50, 0x51, 0x52,
    ];
    for (const usage of fromBrowser) {
      assert.ok(KEYS[usage], `no CDP mapping for HID usage 0x${usage.toString(16)}`);
    }
  });
});

describe("text", () => {
  it("goes in as composed text, so Chinese survives", () => {
    const cmd = one({ kind: "text", text: "中文输入" });
    assert.equal(cmd.method, "Input.insertText");
    assert.equal(cmd.params.text, "中文输入");
  });

  it("does nothing for an empty string", () => {
    assert.deepEqual(inputToCdp({ kind: "text", text: "" }, VIEWPORT), []);
  });
});

describe("button", () => {
  it("produces no CDP input: buttons are navigations, not events", () => {
    // The one button this backend declares is `back`, and it is wx.navigateBack
    // in the logic layer — there is nothing to dispatch into the page frame. The
    // provider handles it before it reaches here; this pins that nothing leaks
    // through as a stray event.
    for (const buttonId of [0x01, 0x05, 0x0c]) {
      assert.deepEqual(
        inputToCdp({ kind: "button", phase: KEY_PHASE.DOWN, buttonId }, VIEWPORT),
        [],
      );
    }
  });
});

function range(start: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => start + i);
}
