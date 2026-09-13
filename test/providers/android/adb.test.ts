/**
 * `host:track-devices` payloads and `adb devices` output share a format; this
 * parser is the only thing standing between adb's text and the device list the
 * Omarchy client sees, so it is tested against the shapes adb really emits.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import os from "node:os";
import path from "node:path";
import { defaultSdkRoot, parseDeviceList, sdkRoots } from "../../../src/providers/android/adb.ts";

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

describe("sdkRoots", () => {
  const home = os.homedir();

  it("uses Android Studio's default per platform", () => {
    assert.equal(defaultSdkRoot("darwin", {}), path.join(home, "Library", "Android", "sdk"));
    assert.equal(defaultSdkRoot("linux", {}), path.join(home, "Android", "Sdk"));
    assert.equal(
      defaultSdkRoot("win32", { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" }),
      path.join("C:\\Users\\me\\AppData\\Local", "Android", "Sdk"),
    );
  });

  it("falls back to the home directory when LOCALAPPDATA is unset on Windows", () => {
    assert.equal(
      defaultSdkRoot("win32", {}),
      path.join(home, "AppData", "Local", "Android", "Sdk"),
    );
  });

  it("prefers the explicit roots, in order, over the default", () => {
    assert.deepEqual(
      sdkRoots("linux", { ANDROID_SDK_ROOT: "/opt/sdk", ANDROID_HOME: "/home/x/sdk" }),
      ["/opt/sdk", "/home/x/sdk", path.join(home, "Android", "Sdk")],
    );
    assert.deepEqual(sdkRoots("linux", { ANDROID_HOME: "/home/x/sdk" }), [
      "/home/x/sdk",
      path.join(home, "Android", "Sdk"),
    ]);
  });
});
