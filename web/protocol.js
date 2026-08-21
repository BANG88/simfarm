// Browser mirror of src/protocol.ts. Plain ESM, no build step.
//
// Kept byte-for-byte identical to the server codec by test/protocol-mirror.test.ts,
// which imports both modules and compares their output. If you change one, change
// the other or that test fails.

export const CHANNEL = { VIDEO: 0x01, INPUT: 0x02, CONTROL: 0x03, EVENT: 0x04 };
export const VIDEO_TAG = { CONFIG: 0x01, KEY: 0x02, DELTA: 0x03, SEED: 0x04 };
export const INPUT_KIND = {
  TOUCH: 0x10,
  MULTITOUCH: 0x11,
  KEY: 0x12,
  BUTTON: 0x13,
  SCROLL: 0x14,
  TEXT: 0x15,
};
export const TOUCH_PHASE = { BEGIN: 0, MOVE: 1, END: 2 };
export const KEY_PHASE = { DOWN: 0, UP: 1 };
export const TOUCH_EDGE = { NONE: 0, TOP: 1, BOTTOM: 2, LEFT: 3, RIGHT: 4 };
export const BUTTON_ID = {
  home: 0x01,
  lock: 0x02,
  volume_up: 0x03,
  volume_down: 0x04,
  back: 0x05,
  app_switch: 0x06,
  power: 0x07,
  siri: 0x08,
  menu: 0x09,
  camera: 0x0a,
  ringer_mute: 0x0b,
  action: 0x0c,
};

export function encodeControl(json) {
  return jsonFrame(CHANNEL.CONTROL, json);
}

export function encodeEvent(json) {
  return jsonFrame(CHANNEL.EVENT, json);
}

export function encodeVideoFrame(streamId, tag, data) {
  const out = new Uint8Array(3 + data.length);
  out[0] = CHANNEL.VIDEO;
  out[1] = streamId;
  out[2] = tag;
  out.set(data, 3);
  return out;
}

export function encodeInput(streamId, msg) {
  switch (msg.kind) {
    case "touch": {
      const b = header(streamId, INPUT_KIND.TOUCH, 12);
      const v = view(b);
      v.setUint8(3, msg.phase);
      v.setFloat32(4, msg.x);
      v.setFloat32(8, msg.y);
      v.setUint16(12, msg.seq & 0xffff);
      v.setUint8(14, msg.edge);
      return b;
    }
    case "multitouch": {
      const b = header(streamId, INPUT_KIND.MULTITOUCH, 19);
      const v = view(b);
      v.setUint8(3, msg.phase);
      v.setFloat32(4, msg.x1);
      v.setFloat32(8, msg.y1);
      v.setFloat32(12, msg.x2);
      v.setFloat32(16, msg.y2);
      v.setUint16(20, msg.seq & 0xffff);
      return b;
    }
    case "key": {
      const b = header(streamId, INPUT_KIND.KEY, 5);
      const v = view(b);
      v.setUint8(3, msg.phase);
      v.setUint32(4, msg.usage);
      return b;
    }
    case "button": {
      const b = header(streamId, INPUT_KIND.BUTTON, 2);
      const v = view(b);
      v.setUint8(3, msg.phase);
      v.setUint8(4, msg.buttonId);
      return b;
    }
    case "scroll": {
      const b = header(streamId, INPUT_KIND.SCROLL, 16);
      const v = view(b);
      v.setFloat32(3, msg.dx);
      v.setFloat32(7, msg.dy);
      v.setFloat32(11, msg.anchorX);
      v.setFloat32(15, msg.anchorY);
      return b;
    }
    case "text": {
      const bytes = new TextEncoder().encode(msg.text);
      const b = header(streamId, INPUT_KIND.TEXT, bytes.length);
      b.set(bytes, 3);
      return b;
    }
    default:
      throw new Error(`unknown input kind ${msg.kind}`);
  }
}

export function decodeFrame(buf) {
  if (buf.length < 1) throw new Error("empty frame");
  const channel = buf[0];
  switch (channel) {
    case CHANNEL.VIDEO:
      if (buf.length < 3) throw new Error("video frame too short");
      return {
        channel: "video",
        streamId: buf[1],
        tag: buf[2],
        data: buf.subarray(3),
      };
    case CHANNEL.CONTROL:
      return { channel: "control", json: parseJson(buf) };
    case CHANNEL.EVENT:
      return { channel: "event", json: parseJson(buf) };
    case CHANNEL.INPUT:
      // server -> client input frames are not part of the protocol
      return { channel: "input", streamId: buf[1], kind: buf[2] };
    default:
      throw new Error(`unknown channel 0x${channel.toString(16)}`);
  }
}

function header(streamId, kind, payloadLen) {
  const b = new Uint8Array(3 + payloadLen);
  b[0] = CHANNEL.INPUT;
  b[1] = streamId;
  b[2] = kind;
  return b;
}

function jsonFrame(channel, json) {
  const bytes = new TextEncoder().encode(JSON.stringify(json));
  const out = new Uint8Array(1 + bytes.length);
  out[0] = channel;
  out.set(bytes, 1);
  return out;
}

function parseJson(buf) {
  return JSON.parse(new TextDecoder().decode(buf.subarray(1)));
}

function view(b) {
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
}
