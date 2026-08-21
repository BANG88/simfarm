/**
 * The two stream parsers. Both run against byte streams that arrive in
 * arbitrary chunks off a socket, so the split-across-chunk cases are the ones
 * worth pinning.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AVCC_TAG, AvccParser } from "../../../src/providers/ios/avcc.ts";
import { MjpegParser } from "../../../src/providers/ios/mjpeg.ts";
import { VIDEO_TAG } from "../../../src/protocol.ts";

function avccFrame(tag: number, payload: number[]): Uint8Array {
  const out = new Uint8Array(5 + payload.length);
  new DataView(out.buffer).setUint32(0, payload.length + 1);
  out[4] = tag;
  out.set(payload, 5);
  return out;
}

function bytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

describe("AvccParser", () => {
  it("maps serve-sim's envelope tags onto PROTOCOL §3 video tags", () => {
    const parser = new AvccParser();
    const frames = parser.push(
      bytes(
        avccFrame(AVCC_TAG.SEED, [0xff, 0xd8]),
        avccFrame(AVCC_TAG.DESCRIPTION, [1, 2, 3]),
        avccFrame(AVCC_TAG.KEYFRAME, [4]),
        avccFrame(AVCC_TAG.DELTA, [5]),
      ),
    );
    assert.deepEqual(
      frames.map((f) => f.tag),
      [VIDEO_TAG.SEED, VIDEO_TAG.CONFIG, VIDEO_TAG.KEY, VIDEO_TAG.DELTA],
    );
    assert.deepEqual([...frames[0]!.data], [0xff, 0xd8]);
    assert.deepEqual([...frames[1]!.data], [1, 2, 3]);
  });

  it("reassembles a frame split across chunks, one byte at a time", () => {
    const whole = avccFrame(AVCC_TAG.KEYFRAME, [9, 8, 7, 6, 5]);
    const parser = new AvccParser();
    const got: number[][] = [];
    for (const b of whole) {
      for (const f of parser.push(new Uint8Array([b]))) got.push([...f.data]);
    }
    assert.deepEqual(got, [[9, 8, 7, 6, 5]]);
  });

  it("handles several frames arriving in one chunk and a partial tail", () => {
    const parser = new AvccParser();
    const a = avccFrame(AVCC_TAG.DELTA, [1]);
    const b = avccFrame(AVCC_TAG.DELTA, [2, 2]);
    const c = avccFrame(AVCC_TAG.DELTA, [3, 3, 3]);
    const stream = bytes(a, b, c);
    const first = parser.push(stream.subarray(0, a.length + b.length + 2));
    assert.equal(first.length, 2);
    const second = parser.push(stream.subarray(a.length + b.length + 2));
    assert.equal(second.length, 1);
    assert.deepEqual([...second[0]!.data], [3, 3, 3]);
  });

  it("drops tags it does not recognise instead of desynchronising", () => {
    const parser = new AvccParser();
    const frames = parser.push(
      bytes(avccFrame(0x7f, [1, 2]), avccFrame(AVCC_TAG.KEYFRAME, [3])),
    );
    assert.equal(frames.length, 1);
    assert.equal(frames[0]!.tag, VIDEO_TAG.KEY);
  });

  it("refuses an implausible length rather than allocating it", () => {
    const parser = new AvccParser();
    const bad = new Uint8Array(8);
    new DataView(bad.buffer).setUint32(0, 0xffffffff);
    assert.throws(() => parser.push(bad), /implausible frame length/);
  });

  it("treats a zero length as corrupt (the tag byte is mandatory)", () => {
    const parser = new AvccParser();
    const bad = new Uint8Array(8);
    assert.throws(() => parser.push(bad), /implausible frame length/);
  });
});

function mjpegPart(payload: number[]): Uint8Array {
  const header = new TextEncoder().encode(
    `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${payload.length}\r\n\r\n`,
  );
  return bytes(header, new Uint8Array(payload), new Uint8Array([0x0d, 0x0a]));
}

describe("MjpegParser", () => {
  it("extracts frames using Content-Length", () => {
    const parser = new MjpegParser();
    const out = parser.push(bytes(mjpegPart([1, 2, 3]), mjpegPart([4, 5])));
    assert.deepEqual(
      out.map((f) => [...f]),
      [
        [1, 2, 3],
        [4, 5],
      ],
    );
  });

  it("is not confused by a payload containing the boundary bytes", () => {
    // A real JPEG can contain anything, including "--frame" and CRLFCRLF.
    const evil = [...new TextEncoder().encode("--frame\r\n\r\nContent-Length: 9")];
    const parser = new MjpegParser();
    const out = parser.push(bytes(mjpegPart(evil), mjpegPart([7])));
    assert.deepEqual([...out[0]!], evil);
    assert.deepEqual([...out[1]!], [7]);
  });

  it("reassembles across arbitrary chunk boundaries", () => {
    const whole = bytes(mjpegPart([1, 2, 3, 4]), mjpegPart([5, 6]));
    for (const size of [1, 3, 7, 13]) {
      const parser = new MjpegParser();
      const got: number[][] = [];
      for (let i = 0; i < whole.length; i += size) {
        for (const f of parser.push(whole.subarray(i, i + size))) got.push([...f]);
      }
      assert.deepEqual(got, [[1, 2, 3, 4], [5, 6]], `chunk size ${size}`);
    }
  });

  it("rejects a part with no Content-Length", () => {
    const parser = new MjpegParser();
    assert.throws(
      () => parser.push(new TextEncoder().encode("--frame\r\nX: 1\r\n\r\nzz")),
      /Content-Length/,
    );
  });

  it("refuses an unterminated header rather than buffering forever", () => {
    const parser = new MjpegParser();
    assert.throws(
      () => parser.push(new Uint8Array(5000).fill(0x41)),
      /never terminated/,
    );
  });
});
