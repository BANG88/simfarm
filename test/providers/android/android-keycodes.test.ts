/**
 * HID usage (what the wire protocol carries) -> Android keycode (what scrcpy
 * injects). The interesting part is that the two encodings order digits
 * differently.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AKEYCODE,
  ANDROID_BUTTONS,
  BUTTON_KEYCODE,
  keycodeForHidUsage,
} from "../../../src/providers/android/android-keycodes.ts";
import { BUTTON_ID } from "../../../src/protocol.ts";

describe("keycodeForHidUsage", () => {
  it("maps the contiguous letter block", () => {
    assert.equal(keycodeForHidUsage(0x04), AKEYCODE.A); // a
    assert.equal(keycodeForHidUsage(0x1d), AKEYCODE.A + 25); // z
  });

  it("handles HID's 1..9,0 digit order vs Android's 0..9", () => {
    assert.equal(keycodeForHidUsage(0x1e), AKEYCODE.DIGIT_1);
    assert.equal(keycodeForHidUsage(0x26), AKEYCODE.DIGIT_1 + 8); // 9
    assert.equal(keycodeForHidUsage(0x27), AKEYCODE.DIGIT_0);
  });

  it("maps the keys the test page's hidUsage() table can produce", () => {
    assert.equal(keycodeForHidUsage(0x28), AKEYCODE.ENTER);
    assert.equal(keycodeForHidUsage(0x2a), AKEYCODE.DEL, "backspace");
    assert.equal(keycodeForHidUsage(0x2c), AKEYCODE.SPACE);
    assert.equal(keycodeForHidUsage(0x29), AKEYCODE.ESCAPE);
    assert.equal(keycodeForHidUsage(0x4f), AKEYCODE.DPAD_RIGHT);
    assert.equal(keycodeForHidUsage(0x50), AKEYCODE.DPAD_LEFT);
    assert.equal(keycodeForHidUsage(0x51), AKEYCODE.DPAD_DOWN);
    assert.equal(keycodeForHidUsage(0x52), AKEYCODE.DPAD_UP);
    assert.equal(keycodeForHidUsage(0x3a), AKEYCODE.F1);
    assert.equal(keycodeForHidUsage(0x45), AKEYCODE.F1 + 11, "F12");
  });

  it("returns undefined for usages with no Android equivalent", () => {
    assert.equal(keycodeForHidUsage(0x00), undefined);
    assert.equal(keycodeForHidUsage(0x65), undefined, "application key");
  });
});

describe("declared buttons", () => {
  it("covers everything ARCHITECTURE.md requires", () => {
    for (const name of [
      "back",
      "home",
      "app_switch",
      "power",
      "volume_up",
      "volume_down",
    ]) {
      assert.ok(
        (ANDROID_BUTTONS as readonly string[]).includes(name),
        `capabilities.buttons must include "${name}"`,
      );
    }
  });

  it("every declared button has a keycode and a wire id", () => {
    for (const name of ANDROID_BUTTONS) {
      assert.equal(
        typeof BUTTON_KEYCODE[name],
        "number",
        `no keycode for "${name}"`,
      );
      assert.equal(
        typeof (BUTTON_ID as Record<string, number>)[name],
        "number",
        `"${name}" is not in the protocol's buttonId table`,
      );
    }
  });

  it("lock and power are the same physical key on Android", () => {
    assert.equal(BUTTON_KEYCODE.lock, BUTTON_KEYCODE.power);
  });
});
