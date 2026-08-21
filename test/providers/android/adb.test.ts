/**
 * `host:track-devices` payloads and `adb devices` output share a format; this
 * parser is the only thing standing between adb's text and the device list the
 * Omarchy client sees, so it is tested against the shapes adb really emits.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseDeviceList } from "../../../src/providers/android/adb.ts";

describe("parseDeviceList", () => {
  it("parses a track-devices payload", () => {
    assert.deepEqual(parseDeviceList("emulator-5554\tdevice\n"), [
      { serial: "emulator-5554", state: "device" },
    ]);
  });

  it("skips the header that `adb devices` prints and track-devices does not", () => {
    const out = "List of devices attached\nemulator-5554\tdevice\n\n";
    assert.deepEqual(parseDeviceList(out), [
      { serial: "emulator-5554", state: "device" },
    ]);
  });

  it("keeps non-usable states so the UI can show why a device is unusable", () => {
    const out = "emulator-5554\tdevice\n192.168.1.5:5555\toffline\nABC123\tunauthorized\n";
    assert.deepEqual(parseDeviceList(out), [
      { serial: "emulator-5554", state: "device" },
      { serial: "192.168.1.5:5555", state: "offline" },
      { serial: "ABC123", state: "unauthorized" },
    ]);
  });

  it("is empty when no device is connected", () => {
    assert.deepEqual(parseDeviceList(""), []);
    assert.deepEqual(parseDeviceList("List of devices attached\n\n"), []);
  });

  it("ignores trailing whitespace and blank lines", () => {
    assert.deepEqual(parseDeviceList("\n  \nemulator-5554\tdevice  \n"), [
      { serial: "emulator-5554", state: "device" },
    ]);
  });
});
