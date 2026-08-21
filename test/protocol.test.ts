import test from "node:test";
import assert from "node:assert/strict";

import {
  BUTTON_ID,
  BUTTON_NAME_BY_ID,
  CHANNEL,
  INPUT_KIND,
  ProtocolError,
  TOUCH_EDGE,
  VIDEO_TAG,
  appearanceMode,
  decodeFrame,
  encodeControl,
  encodeEvent,
  encodeInput,
  encodeVideoFrame,
  seqIsNewer,
  toDevicePixels,
  type InputMessage,
} from "../src/protocol.ts";
import { asFloat32 } from "./helpers.ts";

test("video frame round trip", () => {
  const payload = new Uint8Array([1, 2, 3, 4, 5]);
  const frame = encodeVideoFrame(7, VIDEO_TAG.KEY, payload);

  assert.equal(frame[0], CHANNEL.VIDEO);
  assert.equal(frame[1], 7);
  assert.equal(frame[2], VIDEO_TAG.KEY);

  const decoded = decodeFrame(frame);
  assert.equal(decoded.channel, "video");
  if (decoded.channel !== "video") return;
  assert.equal(decoded.streamId, 7);
  assert.equal(decoded.tag, VIDEO_TAG.KEY);
  assert.deepEqual([...decoded.data], [...payload]);
});

test("decoded video data is a copy, not a view of the socket buffer", () => {
  const frame = encodeVideoFrame(0, VIDEO_TAG.SEED, new Uint8Array([9, 9]));
  const decoded = decodeFrame(frame);
  if (decoded.channel !== "video") throw new Error("wrong channel");
  frame[3] = 0;
  assert.equal(decoded.data[0], 9);
});

test("control and event frames round trip as JSON", () => {
  const req = { id: 3, op: "attach", deviceId: "ios:ABC", codec: "h264" };
  const decodedReq = decodeFrame(encodeControl(req));
  assert.equal(decodedReq.channel, "control");
  assert.deepEqual(decodedReq.json, req);

  const ev = { ev: "devices", devices: [] };
  const decodedEv = decodeFrame(encodeEvent(ev));
  assert.equal(decodedEv.channel, "event");
  assert.deepEqual(decodedEv.json, ev);
});

const INPUT_CASES: Array<[string, InputMessage, number]> = [
  [
    "touch",
    {
      kind: "touch",
      phase: 1,
      x: 0.25,
      y: 0.75,
      seq: 65535,
      edge: TOUCH_EDGE.BOTTOM,
    },
    15,
  ],
  [
    "multitouch",
    { kind: "multitouch", phase: 0, x1: 0.1, y1: 0.2, x2: 0.8, y2: 0.9, seq: 5 },
    22,
  ],
  ["key", { kind: "key", phase: 0, usage: 0x0004 }, 8],
  ["button", { kind: "button", phase: 1, buttonId: BUTTON_ID.home }, 5],
  [
    "scroll",
    { kind: "scroll", dx: -0.5, dy: 0.5, anchorX: 0.5, anchorY: 0.5 },
    19,
  ],
  ["text", { kind: "text", text: "hello 世界 🐟" }, -1],
];

for (const [name, msg, size] of INPUT_CASES) {
  test(`input ${name} round trips`, () => {
    const frame = encodeInput(2, msg);
    assert.equal(frame[0], CHANNEL.INPUT);
    assert.equal(frame[1], 2);
    if (size > 0) assert.equal(frame.length, size);

    const decoded = decodeFrame(frame);
    assert.equal(decoded.channel, "input");
    if (decoded.channel !== "input") return;
    assert.equal(decoded.streamId, 2);
    assert.deepEqual(decoded.msg, asFloat32(msg));
  });
}

test("input frames use the documented wire layout", () => {
  // [1B channel][1B streamId][1B kind][1B phase][f32 x][f32 y][u16 seq][1B edge]
  const frame = encodeInput(0, {
    kind: "touch",
    phase: 2,
    x: 1,
    y: 0,
    seq: 0x1234,
    edge: TOUCH_EDGE.NONE,
  });
  assert.equal(frame[2], INPUT_KIND.TOUCH);
  assert.equal(frame[3], 2);
  const v = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  assert.equal(v.getFloat32(4), 1, "x is big-endian float32");
  assert.equal(v.getUint16(12), 0x1234, "seq is big-endian uint16");
  assert.equal(frame[12], 0x12, "u16 high byte comes first");
});

test("button id table is a bijection", () => {
  for (const [name, id] of Object.entries(BUTTON_ID)) {
    assert.equal(BUTTON_NAME_BY_ID[id], name);
  }
  assert.equal(
    new Set(Object.values(BUTTON_ID)).size,
    Object.keys(BUTTON_ID).length,
  );
});

test("malformed frames are rejected, not silently misread", () => {
  assert.throws(() => decodeFrame(new Uint8Array([])), ProtocolError);
  assert.throws(() => decodeFrame(new Uint8Array([0xff, 1, 2])), ProtocolError);
  assert.throws(
    () => decodeFrame(new Uint8Array([CHANNEL.VIDEO, 0])),
    ProtocolError,
  );
  // TOUCH truncated by one byte
  assert.throws(
    () =>
      decodeFrame(
        new Uint8Array([CHANNEL.INPUT, 0, INPUT_KIND.TOUCH, 0, 0, 0, 0, 0]),
      ),
    ProtocolError,
  );
  // unknown input kind
  assert.throws(
    () => decodeFrame(new Uint8Array([CHANNEL.INPUT, 0, 0x7f, 0])),
    ProtocolError,
  );
  // bad touch phase
  assert.throws(
    () =>
      decodeFrame(
        new Uint8Array([
          CHANNEL.INPUT, 0, INPUT_KIND.TOUCH, 9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        ]),
      ),
    ProtocolError,
  );
  assert.throws(
    () => decodeFrame(new Uint8Array([CHANNEL.CONTROL, 0x7b, 0x7b])),
    ProtocolError,
  );
  assert.throws(() => encodeVideoFrame(256, 1, new Uint8Array()), ProtocolError);
});

test("normalized coordinates map to device pixels", () => {
  const screen = { width: 390, height: 844 };
  assert.deepEqual(toDevicePixels(0, 0, screen), { x: 0, y: 0 });
  assert.deepEqual(toDevicePixels(1, 1, screen), { x: 389, y: 843 });
  assert.deepEqual(toDevicePixels(0.5, 0.5, screen), { x: 195, y: 422 });
  // out of range input must clamp, never index outside the framebuffer
  assert.deepEqual(toDevicePixels(-3, 42, screen), { x: 0, y: 843 });
  assert.deepEqual(toDevicePixels(NaN, Infinity, screen), { x: 0, y: 843 });
  assert.deepEqual(toDevicePixels(-Infinity, NaN, screen), { x: 0, y: 0 });
});

test("seq comparison tolerates 16-bit wraparound", () => {
  assert.ok(seqIsNewer(5, 4));
  assert.ok(!seqIsNewer(4, 5));
  assert.ok(!seqIsNewer(5, 5));
  assert.ok(seqIsNewer(2, 65534), "wrapped forward");
  assert.ok(!seqIsNewer(65534, 2), "wrapped backward");
});

/**
 * `appearance` (PROTOCOL §4) reaches a shell command on both backends that
 * support it — `simctl ui <udid> appearance <mode>` and
 * `cmd uimode night <yes|no>` — and the first version of the protocol has no
 * authentication (ARCHITECTURE.md). So the value is narrowed to one of two literals
 * before a provider ever sees it, and that narrowing is pinned here rather
 * than trusted to each provider's own `switch`.
 */
test("appearanceMode takes the two values the protocol defines", () => {
  assert.equal(appearanceMode({ mode: "light" }), "light");
  assert.equal(appearanceMode({ mode: "dark" }), "dark");
});

test("appearanceMode rejects anything else, including shell metacharacters", () => {
  for (const mode of [
    "dark; id",
    "dark && whoami",
    "light dark",
    "DARK",
    "",
    "auto",
    0,
    null,
    { mode: "dark" },
    ["dark"],
  ]) {
    assert.throws(() => appearanceMode({ mode }), /light.*dark/s);
  }
});

test("appearanceMode rejects a missing mode rather than picking one", () => {
  assert.throws(() => appearanceMode({}), /light.*dark/s);
  assert.throws(() => appearanceMode(undefined), /light.*dark/s);
  assert.throws(() => appearanceMode(null), /light.*dark/s);
});
