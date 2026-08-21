/**
 * The test page ships its own copy of the codec (web/protocol.js) because it
 * runs in a browser with no build step. This test is what keeps the two copies
 * honest: same constants, same bytes.
 */

import test from "node:test";
import assert from "node:assert/strict";

import * as server from "../src/protocol.ts";
import { asFloat32 } from "./helpers.ts";
// @ts-expect-error — plain JS mirror, no types
import * as browser from "../web/protocol.js";

test("constants match between server and browser codecs", () => {
  assert.deepEqual(browser.CHANNEL, server.CHANNEL);
  assert.deepEqual(browser.VIDEO_TAG, server.VIDEO_TAG);
  assert.deepEqual(browser.INPUT_KIND, server.INPUT_KIND);
  assert.deepEqual(browser.TOUCH_PHASE, server.TOUCH_PHASE);
  assert.deepEqual(browser.KEY_PHASE, server.KEY_PHASE);
  assert.deepEqual(browser.TOUCH_EDGE, server.TOUCH_EDGE);
  assert.deepEqual(browser.BUTTON_ID, server.BUTTON_ID);
});

const CASES: server.InputMessage[] = [
  { kind: "touch", phase: 0, x: 0.123456, y: 0.987654, seq: 1, edge: 0 },
  { kind: "touch", phase: 2, x: 1, y: 0, seq: 65535, edge: 2 },
  { kind: "multitouch", phase: 1, x1: 0.1, y1: 0.2, x2: 0.3, y2: 0.4, seq: 9 },
  { kind: "key", phase: 0, usage: 0x0028 },
  { kind: "button", phase: 1, buttonId: 1 },
  { kind: "scroll", dx: 0.01, dy: -0.02, anchorX: 0.5, anchorY: 0.25 },
  { kind: "text", text: "abc 中文 🐟" },
];

test("browser encoder produces bytes the server decodes back", () => {
  for (const msg of CASES) {
    const fromBrowser: Uint8Array = browser.encodeInput(3, msg);
    assert.deepEqual(
      [...fromBrowser],
      [...server.encodeInput(3, msg)],
      `byte mismatch for ${msg.kind}`,
    );

    const decoded = server.decodeFrame(fromBrowser);
    assert.equal(decoded.channel, "input");
    if (decoded.channel !== "input") continue;
    assert.equal(decoded.streamId, 3);
    assert.deepEqual(decoded.msg, asFloat32(msg));
  }
});

test("browser decoder reads server video and JSON frames", () => {
  const video = server.encodeVideoFrame(1, server.VIDEO_TAG.SEED, new Uint8Array([7, 8]));
  const decodedVideo = browser.decodeFrame(video);
  assert.equal(decodedVideo.channel, "video");
  assert.equal(decodedVideo.streamId, 1);
  assert.equal(decodedVideo.tag, server.VIDEO_TAG.SEED);
  assert.deepEqual([...decodedVideo.data], [7, 8]);

  const control = server.encodeControl({ id: 1, ok: true, streamId: 0 });
  assert.deepEqual(browser.decodeFrame(control).json, {
    id: 1,
    ok: true,
    streamId: 0,
  });

  const event = server.encodeEvent({ ev: "screen", streamId: 0, width: 390 });
  assert.equal(browser.decodeFrame(event).channel, "event");
});
