/**
 * The Android jpeg path: cutting ffmpeg's MJPEG output into pictures, the
 * quality mapping, and — when an ffmpeg is on the box — the real pipeline
 * fed the real sample and required to hand back the pictures it encodes.
 *
 * The splitter is the piece that fails invisibly: a JPEG cut in the wrong
 * place is not an exception here, it is a client that decodes nothing and a
 * readout that says frames are arriving.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import jpeg from "jpeg-js";

import {
  JpegTranscoder,
  DEFAULT_TRANSCODER,
  mjpegQscale,
  probeSamplePackets,
  probeTranscoder,
  splitJpegs,
} from "../../../src/providers/android/jpeg-transcoder.ts";
import { jpegSize } from "../../../src/util/jpeg-size.ts";

/** A stand-in JPEG: SOI, some body bytes that must survive, EOI. */
function fakeJpeg(body: number[]): Uint8Array {
  return Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...body, 0xff, 0xd9]);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

describe("splitJpegs", () => {
  it("returns a complete image and nothing left over", () => {
    const one = fakeJpeg([1, 2, 3]);
    const { frames, rest } = splitJpegs(one);
    assert.equal(frames.length, 1);
    assert.deepEqual(frames[0], one);
    assert.equal(rest.length, 0);
  });

  it("holds back an image whose end has not arrived", () => {
    const partial = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]);
    const { frames, rest } = splitJpegs(partial);
    assert.deepEqual(frames, []);
    assert.deepEqual(rest, partial);
  });

  it("splits several images out of one read", () => {
    const a = fakeJpeg([1]);
    const b = fakeJpeg([2, 2]);
    const c = fakeJpeg([3, 3, 3]);
    const { frames, rest } = splitJpegs(concat(a, b, c));
    assert.deepEqual(frames, [a, b, c]);
    assert.equal(rest.length, 0);
  });

  it("does not end an image on an escaped FF or a restart marker", () => {
    // FF 00 is a stuffed byte and FF D0-D7 are restart markers; neither is EOI.
    const one = fakeJpeg([0xff, 0x00, 0xff, 0xd3, 0x44]);
    const { frames } = splitJpegs(concat(one, fakeJpeg([9])));
    assert.equal(frames.length, 2);
    assert.deepEqual(frames[0], one);
  });

  it("discards bytes before the first start marker", () => {
    const one = fakeJpeg([7]);
    const { frames, rest } = splitJpegs(concat(Uint8Array.from([0x11, 0x22]), one));
    assert.deepEqual(frames, [one]);
    assert.equal(rest.length, 0);
  });

  it("reassembles correctly however the pipe chops the bytes", () => {
    // The real failure mode: a read ending between the FF and the D8 or D9.
    const a = fakeJpeg([1, 0xff, 0x00]);
    const b = fakeJpeg([2, 2]);
    const whole = concat(a, b);

    for (let cut = 1; cut < whole.length; cut++) {
      const got: Uint8Array[] = [];
      let step = splitJpegs(whole.subarray(0, cut));
      got.push(...step.frames);
      step = splitJpegs(concat(step.rest, whole.subarray(cut)));
      got.push(...step.frames);
      assert.deepEqual(got, [a, b], `wrong frames when split at byte ${cut}`);
      assert.equal(step.rest.length, 0, `bytes left over when split at byte ${cut}`);
    }
  });

  it("keeps a trailing FF that may be the start of the next marker", () => {
    const { frames, rest } = splitJpegs(Uint8Array.from([0xff]));
    assert.deepEqual(frames, []);
    assert.deepEqual(rest, Uint8Array.from([0xff]));
  });
});

describe("mjpegQscale", () => {
  it("maps libjpeg-style quality onto ffmpeg's 1-31 scale, calibrated by PSNR", () => {
    // Measured pairs, see the function's comment.
    assert.equal(mjpegQscale(DEFAULT_TRANSCODER.quality), 7);
    assert.equal(mjpegQscale(80), 5);
    assert.equal(mjpegQscale(90), 2);
    assert.equal(mjpegQscale(50), 12);
  });

  it("stays inside what the encoder accepts", () => {
    assert.equal(mjpegQscale(100), 1);
    assert.equal(mjpegQscale(1), 31);
    assert.equal(mjpegQscale(-5), 31);
    assert.equal(mjpegQscale(1000), 1);
  });

  it("is monotonic: higher quality never means a coarser quantiser", () => {
    let last = Infinity;
    for (let q = 1; q <= 100; q++) {
      const scale = mjpegQscale(q);
      assert.ok(scale <= last, `quality ${q} -> ${scale} coarser than ${last}`);
      last = scale;
    }
  });
});

describe("probe sample", () => {
  it("is cut into the packets scrcpy would send: config, keyframe, delta", () => {
    const packets = probeSamplePackets();
    assert.deepEqual(
      packets.map((p) => [p.config, p.key]),
      [
        [true, false],
        [false, true],
        [false, false],
      ],
    );
    // Each packet begins with a start code; the config carries SPS then PPS.
    for (const p of packets) assert.deepEqual([...p.data.subarray(0, 4)], [0, 0, 0, 1]);
    assert.equal(packets[0]!.data[4]! & 0x1f, 7);
  });
});

/**
 * The real pipeline. Skipped, not failed, without ffmpeg: the capability is
 * probed at startup for exactly this reason, and a machine without it is
 * a machine where Android is h264-only rather than broken.
 */
describe("JpegTranscoder against ffmpeg", { concurrency: false }, async () => {
  const available = await probeTranscoder("ffmpeg", 8000);

  it("turns the sample into one JPEG per picture, in order, at the right size", { skip: !available }, async () => {
    const frames: Uint8Array[] = [];
    const transcoder = new JpegTranscoder({ ...DEFAULT_TRANSCODER, maxFps: 0 }, (f) => frames.push(f));
    let failure = "";
    transcoder.onFailure = (r) => (failure = r);
    transcoder.start();
    for (const packet of probeSamplePackets()) transcoder.push(packet);

    await waitFor(() => frames.length >= 2, 8000);
    transcoder.stop();
    assert.equal(failure, "");
    assert.equal(frames.length, 2, `got ${frames.length} frames; ffmpeg said: ${transcoder.diagnostics}`);

    for (const f of frames) assert.deepEqual(jpegSize(f), { width: 32, height: 32 });

    // First picture blue, second red — the sample is built that way so a
    // swapped or duplicated frame shows up as the wrong colour.
    const first = centrePixel(frames[0]!);
    const second = centrePixel(frames[1]!);
    assert.ok(first.b > first.r + 60, `first frame is not blue: ${JSON.stringify(first)}`);
    assert.ok(second.r > second.b + 60, `second frame is not red: ${JSON.stringify(second)}`);

    assert.equal(transcoder.stats.packetsIn, 3);
    assert.equal(transcoder.stats.skippedBeforeKey, 0);
    assert.equal(transcoder.stats.framesOut, 2);
  });

  it("skips packets that arrive before the parameter sets and a keyframe", { skip: !available }, async () => {
    const frames: Uint8Array[] = [];
    const transcoder = new JpegTranscoder({ ...DEFAULT_TRANSCODER, maxFps: 0 }, (f) => frames.push(f));
    transcoder.start();
    const [config, key, delta] = probeSamplePackets();
    // A delta first — as when a viewer attaches mid-stream — must not reach
    // ffmpeg, which would otherwise complain about every slice of it.
    transcoder.push(delta!);
    transcoder.push(config!);
    transcoder.push(key!);
    transcoder.push(delta!);

    await waitFor(() => frames.length >= 2, 8000);
    transcoder.stop();
    assert.equal(transcoder.stats.skippedBeforeKey, 1);
    assert.equal(frames.length, 2);
    assert.equal(transcoder.diagnostics, "", "ffmpeg should have had nothing to complain about");
  });

  it("thins the output to the frame cap", { skip: !available }, async () => {
    const frames: Uint8Array[] = [];
    // Two pictures written back to back; at 1 fps the second is too soon.
    const transcoder = new JpegTranscoder({ ...DEFAULT_TRANSCODER, maxFps: 1 }, (f) => frames.push(f));
    transcoder.start();
    for (const packet of probeSamplePackets()) transcoder.push(packet);

    await waitFor(() => transcoder.stats.jpegsDecoded >= 2, 8000);
    transcoder.stop();
    assert.equal(transcoder.stats.jpegsDecoded, 2);
    assert.equal(transcoder.stats.rateLimited, 1);
    assert.equal(frames.length, 1);
  });

  it("reports a binary that does not exist through onFailure, not as a throw", async () => {
    const ok = await probeTranscoder("/nonexistent/ffmpeg-for-this-test", 3000);
    assert.equal(ok, false);
  });
});

function centrePixel(data: Uint8Array): { r: number; g: number; b: number } {
  const img = jpeg.decode(data, { useTArray: true });
  const i = ((img.height >> 1) * img.width + (img.width >> 1)) * 4;
  return { r: img.data[i]!, g: img.data[i + 1]!, b: img.data[i + 2]! };
}

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (!cond()) {
    if (Date.now() - started > timeoutMs) return;
    await new Promise((r) => setTimeout(r, 20));
  }
}
