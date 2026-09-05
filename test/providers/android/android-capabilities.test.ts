/**
 * What an Android device advertises, and what the session then picks from it.
 *
 * The order matters as much as the contents: PROTOCOL §4 has the server
 * prefer h264 whenever a device offers it, so adding jpeg must never change
 * what a browser on a secure origin gets — and a jpeg-only client must be
 * able to ask for jpeg and get it.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { androidCapabilities } from "../../../src/providers/android/android-provider.ts";
import { pickCodec } from "../../../src/session.ts";

describe("android capabilities", () => {
  it("offers h264 first and jpeg second when ffmpeg can transcode", () => {
    assert.deepEqual(androidCapabilities(true).video, ["h264", "jpeg"]);
  });

  it("offers h264 only when it cannot", () => {
    assert.deepEqual(androidCapabilities(false).video, ["h264"]);
  });

  it("changes nothing else", () => {
    const { video: _a, ...withJpeg } = androidCapabilities(true);
    const { video: _b, ...without } = androidCapabilities(false);
    assert.deepEqual(withJpeg, without);
  });

  it("keeps h264 as the default pick and serves jpeg on request", () => {
    const video = androidCapabilities(true).video;
    assert.equal(pickCodec(video), "h264");
    assert.equal(pickCodec(video, "h264"), "h264");
    assert.equal(pickCodec(video, "jpeg"), "jpeg");
  });

  it("refuses jpeg, with the codec list, when ffmpeg was not usable", () => {
    const video = androidCapabilities(false).video;
    assert.equal(pickCodec(video), "h264");
    assert.throws(() => pickCodec(video, "jpeg"), /jpeg.*not supported.*h264/);
  });
});
