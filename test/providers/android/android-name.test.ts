/**
 * What an Android device is called in the picker.
 *
 * The old string was `sdk_gphone16k_arm64 (Android 17) — emulator-5554`:
 * accurate, and three technical tokens wide where iOS manages
 * `iPhone 17 Pro (iOS 26.5)`. It filled the device pill and pushed the status
 * dot and the caret out.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { deviceName } from "../../../src/providers/android/android-provider.ts";

describe("deviceName", () => {
  it("prefers the AVD name, which is the one a person chose", () => {
    assert.equal(
      deviceName({ avd: "Pixel_10_Pro", model: "sdk_gphone16k_arm64", release: "17" }, "emulator-5554"),
      "Pixel 10 Pro (Android 17)",
    );
  });

  it("falls back to the model on a real phone, which has no AVD name", () => {
    assert.equal(
      deviceName({ avd: "", model: "Pixel 8", release: "16" }, "39281FDJH000AB"),
      "Pixel 8 (Android 16)",
    );
  });

  it("keeps the serial out of it — that is what a tooltip is for", () => {
    const name = deviceName({ avd: "Tablet_API_34", model: "x", release: "17" }, "emulator-5554");
    assert.ok(!name.includes("emulator-5554"), name);
  });

  it("still says something when the device tells us nothing", () => {
    assert.equal(deviceName({ avd: "", model: "", release: "?" }, "emulator-5554"), "emulator-5554 (Android ?)");
  });
});
