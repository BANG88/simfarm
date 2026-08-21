/**
 * Byte-for-byte checks of the scrcpy v4.1 control protocol.
 *
 * Every expected layout below was read off `app/src/control_msg.c` and
 * cross-checked against the parser that has to accept it,
 * `server/.../ControlMessageReader.java`. A wrong offset here does not throw —
 * it silently taps the wrong pixel — so the sizes are asserted explicitly.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CONTROL_MSG,
  COPY_KEY,
  DEVICE_MSG,
  KEY_ACTION,
  MOTION_ACTION,
  POINTER_ID,
  encodeBackOrScreenOn,
  encodeEmpty,
  encodeGetClipboard,
  encodeInjectKeycode,
  encodeInjectScroll,
  encodeInjectText,
  encodeInjectTouch,
  encodeSetClipboard,
  encodeStartApp,
  floatToI16Fp,
  floatToU16Fp,
  parseDeviceMessage,
  truncateUtf8,
} from "../../../src/providers/android/scrcpy-control.ts";

const view = (b: Uint8Array): DataView =>
  new DataView(b.buffer, b.byteOffset, b.byteLength);

describe("fixed point", () => {
  it("maps [0,1] onto the full u16 range", () => {
    assert.equal(floatToU16Fp(0), 0);
    assert.equal(floatToU16Fp(1), 0xffff);
    assert.equal(floatToU16Fp(0.5), 0x8000);
  });

  it("clamps out-of-range pressure rather than throwing", () => {
    assert.equal(floatToU16Fp(-1), 0);
    assert.equal(floatToU16Fp(2), 0xffff);
  });

  it("maps [-1,1] onto i16, returned as an unsigned word", () => {
    assert.equal(floatToI16Fp(0), 0);
    assert.equal(floatToI16Fp(1), 0x7fff);
    assert.equal(floatToI16Fp(-1), 0x8000); // -32768 as two's complement
    assert.equal(floatToI16Fp(0.5), 0x4000);
  });
});

describe("encodeInjectKeycode", () => {
  it("is 14 bytes: type, action, keycode, repeat, metastate", () => {
    const b = encodeInjectKeycode(KEY_ACTION.DOWN, 4, 0, 0);
    assert.equal(b.length, 14);
    assert.equal(b[0], CONTROL_MSG.INJECT_KEYCODE);
    assert.equal(b[1], KEY_ACTION.DOWN);
    assert.equal(view(b).getUint32(2), 4);
    assert.equal(view(b).getUint32(6), 0);
    assert.equal(view(b).getUint32(10), 0);
  });

  it("carries repeat and metastate", () => {
    const b = encodeInjectKeycode(KEY_ACTION.UP, 66, 3, 0x1000);
    assert.equal(view(b).getUint32(6), 3);
    assert.equal(view(b).getUint32(10), 0x1000);
  });
});

describe("encodeInjectTouch", () => {
  it("is 32 bytes with the position block at offset 10", () => {
    const b = encodeInjectTouch({
      action: MOTION_ACTION.DOWN,
      pointerId: POINTER_ID.GENERIC_FINGER,
      position: { x: 100, y: 200, screenWidth: 458, screenHeight: 1024 },
      pressure: 1,
    });
    const v = view(b);
    assert.equal(b.length, 32);
    assert.equal(b[0], CONTROL_MSG.INJECT_TOUCH_EVENT);
    assert.equal(b[1], MOTION_ACTION.DOWN);
    assert.equal(v.getBigUint64(2), POINTER_ID.GENERIC_FINGER);
    assert.equal(v.getInt32(10), 100);
    assert.equal(v.getInt32(14), 200);
    assert.equal(v.getUint16(18), 458);
    assert.equal(v.getUint16(20), 1024);
    assert.equal(v.getUint16(22), 0xffff, "pressure 1.0");
    assert.equal(v.getUint32(24), 0, "action_button");
    assert.equal(v.getUint32(28), 0, "buttons must be 0 for a finger");
  });

  it("sends pressure 0 on release, which is how the device sees a lift", () => {
    const b = encodeInjectTouch({
      action: MOTION_ACTION.UP,
      pointerId: POINTER_ID.GENERIC_FINGER,
      position: { x: 0, y: 0, screenWidth: 1, screenHeight: 1 },
      pressure: 0,
    });
    assert.equal(view(b).getUint16(22), 0);
  });

  it("keeps the two fingers of a pinch on distinct pointer ids", () => {
    assert.notEqual(POINTER_ID.GENERIC_FINGER, POINTER_ID.VIRTUAL_FINGER);
  });
});

describe("encodeInjectScroll", () => {
  it("is 21 bytes and normalizes the scroll amount by 16", () => {
    const b = encodeInjectScroll({
      position: { x: 10, y: 20, screenWidth: 458, screenHeight: 1024 },
      hscroll: 0,
      vscroll: 16,
    });
    const v = view(b);
    assert.equal(b.length, 21);
    assert.equal(b[0], CONTROL_MSG.INJECT_SCROLL_EVENT);
    assert.equal(v.getInt32(1), 10);
    assert.equal(v.getInt32(5), 20);
    assert.equal(v.getUint16(9), 458);
    assert.equal(v.getUint16(11), 1024);
    assert.equal(v.getUint16(13), 0, "hscroll");
    assert.equal(v.getUint16(15), 0x7fff, "vscroll 16 -> +1.0 fixed point");
    assert.equal(v.getUint32(17), 0);
  });

  it("clamps beyond the device's [-16,16] range", () => {
    const b = encodeInjectScroll({
      position: { x: 0, y: 0, screenWidth: 1, screenHeight: 1 },
      hscroll: -1000,
      vscroll: 0,
    });
    assert.equal(view(b).getUint16(13), 0x8000);
  });
});

describe("encodeInjectText", () => {
  it("prefixes a 4-byte length", () => {
    const b = encodeInjectText("hi");
    assert.equal(b[0], CONTROL_MSG.INJECT_TEXT);
    assert.equal(view(b).getUint32(1), 2);
    assert.equal(Buffer.from(b.subarray(5)).toString("utf8"), "hi");
  });

  it("counts UTF-8 bytes, not code points", () => {
    const b = encodeInjectText("héllo");
    assert.equal(view(b).getUint32(1), 6);
    assert.equal(b.length, 11);
  });

  it("truncates at the device's 300-byte limit without splitting a character", () => {
    const b = encodeInjectText("é".repeat(200)); // 400 bytes
    const len = view(b).getUint32(1);
    assert.ok(len <= 300);
    assert.equal(len % 2, 0, "must not cut a 2-byte character in half");
    assert.equal(
      Buffer.from(b.subarray(5, 5 + len)).toString("utf8").includes("�"),
      false,
    );
  });
});

describe("truncateUtf8", () => {
  it("returns the input untouched when it fits", () => {
    assert.equal(truncateUtf8("abc", 10).length, 3);
  });

  it("backs up to a lead byte", () => {
    // "€" is 3 bytes; cutting at 2 must yield 0 bytes, not a broken prefix
    assert.equal(truncateUtf8("€", 2).length, 0);
    assert.equal(truncateUtf8("a€", 3).length, 1);
  });
});

describe("short messages", () => {
  it("back-or-screen-on is 2 bytes", () => {
    assert.deepEqual(
      [...encodeBackOrScreenOn(KEY_ACTION.DOWN)],
      [CONTROL_MSG.BACK_OR_SCREEN_ON, 0],
    );
  });

  it("get-clipboard carries the copy key", () => {
    assert.deepEqual(
      [...encodeGetClipboard(COPY_KEY.COPY)],
      [CONTROL_MSG.GET_CLIPBOARD, COPY_KEY.COPY],
    );
  });

  it("payload-free messages are a single type byte", () => {
    assert.deepEqual([...encodeEmpty(CONTROL_MSG.ROTATE_DEVICE)], [11]);
    assert.deepEqual([...encodeEmpty(CONTROL_MSG.RESET_VIDEO)], [17]);
  });

  it("start-app uses a 1-byte length prefix", () => {
    const b = encodeStartApp("com.android.settings");
    assert.equal(b[0], CONTROL_MSG.START_APP);
    assert.equal(b[1], 20);
    assert.equal(Buffer.from(b.subarray(2)).toString("utf8"), "com.android.settings");
  });

  it("set-clipboard is sequence, paste flag, then a 4-byte length", () => {
    const b = encodeSetClipboard(7n, "abc", true);
    const v = view(b);
    assert.equal(b[0], CONTROL_MSG.SET_CLIPBOARD);
    assert.equal(v.getBigUint64(1), 7n);
    assert.equal(b[9], 1);
    assert.equal(v.getUint32(10), 3);
    assert.equal(b.length, 17);
  });
});

describe("parseDeviceMessage", () => {
  it("waits for more bytes instead of guessing", () => {
    assert.equal(parseDeviceMessage(new Uint8Array(0)), null);
    assert.equal(parseDeviceMessage(new Uint8Array([DEVICE_MSG.CLIPBOARD, 0, 0])), null);
    const partial = new Uint8Array([DEVICE_MSG.CLIPBOARD, 0, 0, 0, 4, 0x61]);
    assert.equal(parseDeviceMessage(partial), null);
  });

  it("reads a clipboard message and reports its size", () => {
    const bytes = new Uint8Array([DEVICE_MSG.CLIPBOARD, 0, 0, 0, 2, 0x68, 0x69]);
    const parsed = parseDeviceMessage(bytes)!;
    assert.deepEqual(parsed.msg, { type: "clipboard", text: "hi" });
    assert.equal(parsed.size, 7);
  });

  it("reads an ack and leaves the following message alone", () => {
    const bytes = new Uint8Array([
      DEVICE_MSG.ACK_CLIPBOARD, 0, 0, 0, 0, 0, 0, 0, 9,
      DEVICE_MSG.CLIPBOARD, 0, 0, 0, 0,
    ]);
    const first = parseDeviceMessage(bytes)!;
    assert.deepEqual(first.msg, { type: "ack_clipboard", sequence: 9n });
    assert.equal(first.size, 9);
    const second = parseDeviceMessage(bytes.subarray(first.size))!;
    assert.deepEqual(second.msg, { type: "clipboard", text: "" });
  });

  it("rejects an unknown type rather than desynchronizing the stream", () => {
    assert.throws(() => parseDeviceMessage(new Uint8Array([0x7f])), /unknown/);
  });
});
