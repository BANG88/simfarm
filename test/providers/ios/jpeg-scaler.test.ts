/**
 * The iOS jpeg cap: the size arithmetic, the rate gate, and — when an ffmpeg
 * is on the box — the real pipeline fed a real picture and required to hand
 * back a smaller one promptly.
 *
 * The arithmetic is the piece that fails invisibly: a picture one pixel off
 * the promised size is not an exception, it is a client drawing into a
 * rectangle that does not quite fit, and `scale` lying by a fraction.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_SCALER,
  JpegScaler,
  fitWithin,
  probePicture,
  probeScaler,
} from "../../../src/providers/ios/jpeg-scaler.ts";
import { jpegSize } from "../../../src/util/jpeg-size.ts";
import { FRAME_GAP_TOLERANCE_MS, FrameRateGate } from "../../../src/util/mjpeg.ts";
import { sleep } from "../../helpers.ts";

describe("fitWithin", () => {
  it("caps the longest side and keeps the aspect, rounded to even", () => {
    // iPhone 17 Pro portrait framebuffer, the one measured on the phone.
    // 1206 * 1024 / 2622 = 470.99, rounded to the nearest even side.
    assert.deepEqual(fitWithin(1206, 2622, 1024), { width: 470, height: 1024 });
    // The same framebuffer lying on its side.
    assert.deepEqual(fitWithin(2622, 1206, 1024), { width: 1024, height: 470 });
    // A 4:3 tablet.
    assert.deepEqual(fitWithin(1536, 2048, 1024), { width: 768, height: 1024 });
  });

  it("leaves a picture already within the cap alone, odd sides included", () => {
    assert.deepEqual(fitWithin(751, 1024, 1024), { width: 751, height: 1024 });
    assert.deepEqual(fitWithin(320, 480, 1024), { width: 320, height: 480 });
  });

  it("treats 0 as no cap", () => {
    assert.deepEqual(fitWithin(1206, 2622, 0), { width: 1206, height: 2622 });
  });

  it("never produces an odd or zero side when it does scale", () => {
    for (const [w, h] of [
      [1206, 2622],
      [1179, 2556],
      [1290, 2796],
      [2048, 2732],
      [750, 1334],
    ]) {
      for (const max of [1024, 640, 333, 100]) {
        const s = fitWithin(w!, h!, max);
        assert.ok(s.width > 0 && s.height > 0, `${w}x${h} @${max}`);
        assert.equal(s.width % 2, 0, `${w}x${h} @${max} width`);
        assert.equal(s.height % 2, 0, `${w}x${h} @${max} height`);
        assert.ok(Math.max(s.width, s.height) <= max, `${w}x${h} @${max} exceeds cap`);
        // Aspect within one even step of the source: rounding a side to even
        // moves it by at most one pixel.
        const want = w! / h!;
        const got = s.width / s.height;
        // moves it by at most one pixel on each side.
        const step = 2 / Math.min(s.width, s.height);
        assert.ok(Math.abs(got - want) / want <= step, `${w}x${h} @${max} aspect ${got} vs ${want}`);
      }
    }
  });
});

describe("FrameRateGate", () => {
  it("admits at most maxFps a second and drops the rest rather than delaying", () => {
    const gate = new FrameRateGate(20);
    let t = 1_000_000;
    let admitted = 0;
    // A 60 fps source for one second.
    for (let i = 0; i < 60; i++, t += 1000 / 60) {
      if (gate.admit(t)) admitted++;
    }
    assert.ok(admitted >= 19 && admitted <= 21, `admitted ${admitted}`);
  });

  it("keeps the admitted frames at least the cap's spacing apart, minus the tolerance", () => {
    const gate = new FrameRateGate(20);
    const times: number[] = [];
    let t = 0;
    for (let i = 0; i < 200; i++, t += 7) if (gate.admit(t)) times.push(t);
    for (let i = 1; i < times.length; i++) {
      assert.ok(times[i]! - times[i - 1]! >= 50 - FRAME_GAP_TOLERANCE_MS, `gap ${times[i]! - times[i - 1]!}`);
    }
  });

  it("admits everything when uncapped", () => {
    const gate = new FrameRateGate(0);
    let admitted = 0;
    for (let i = 0; i < 100; i++) if (gate.admit(1000 + i)) admitted++;
    assert.equal(admitted, 100);
  });

  it("always admits the first frame", () => {
    assert.equal(new FrameRateGate(1).admit(5), true);
  });
});

describe("JpegScaler", () => {
  it("passes a picture within the cap through untouched, with no ffmpeg", () => {
    const out: Uint8Array[] = [];
    const scaler = new JpegScaler(
      { ...DEFAULT_SCALER, ffmpegPath: "/nonexistent/ffmpeg", maxSize: 1024, maxFps: 0 },
      { width: 64, height: 128 },
      (p) => out.push(p),
    );
    assert.equal(scaler.needsScaling, false);
    scaler.start();
    assert.equal(scaler.scaling, false);
    const picture = probePicture();
    scaler.push(picture);
    assert.equal(out.length, 1);
    assert.equal(out[0], picture);
    assert.equal(scaler.stats.passedThrough, 1);
    scaler.stop();
  });

  it("drops, never queues, above the fps cap", () => {
    const out: Uint8Array[] = [];
    const scaler = new JpegScaler(
      { ...DEFAULT_SCALER, maxSize: 0, maxFps: 20 },
      { width: 64, height: 128 },
      (p) => out.push(p),
    );
    scaler.start();
    const picture = probePicture();
    // Three pictures in the same millisecond: one goes out, two are dropped on
    // the spot — nothing is held back for later.
    scaler.push(picture);
    scaler.push(picture);
    scaler.push(picture);
    assert.equal(out.length, 1);
    assert.equal(scaler.stats.framesIn, 3);
    assert.equal(scaler.stats.rateLimited, 2);
    scaler.stop();
  });

  it("falls back to pass-through, at the source size, when ffmpeg cannot run", async () => {
    const out: Uint8Array[] = [];
    const scaler = new JpegScaler(
      { ...DEFAULT_SCALER, ffmpegPath: "/nonexistent/ffmpeg", maxSize: 32, maxFps: 0 },
      { width: 64, height: 128 },
      (p) => out.push(p),
    );
    let failure = "";
    scaler.onFailure = (reason) => {
      failure = reason;
    };
    assert.equal(scaler.needsScaling, true);
    assert.deepEqual(scaler.target, { width: 16, height: 32 });
    scaler.start();
    await sleep(100);
    assert.match(failure, /could not run ffmpeg/);
    assert.deepEqual(scaler.delivered, { width: 64, height: 128 });
    scaler.push(probePicture());
    assert.equal(out.length, 1);
    assert.equal(scaler.stats.passedThrough, 1);
    scaler.stop();
  });

  it("through a real ffmpeg, returns each picture at the promised size, one for one", async (t) => {
    if (!(await probeScaler("ffmpeg", 4000))) {
      t.skip("no usable ffmpeg on this machine");
      return;
    }
    const out: Uint8Array[] = [];
    const scaler = new JpegScaler(
      { ...DEFAULT_SCALER, maxSize: 64, maxFps: 0 },
      { width: 128, height: 256 },
      (p) => out.push(p),
    );
    scaler.start();
    assert.equal(scaler.scaling, true);
    // One picture in, one picture out, without waiting for a second one: a
    // scaler that holds the frame until the next arrives would leave the last
    // frame of every gesture in the pipe.
    scaler.push(probePicture(128, 256));
    const deadline = Date.now() + 4000;
    while (out.length < 1 && Date.now() < deadline) await sleep(20);
    assert.equal(out.length, 1, `no picture back; ffmpeg said: ${scaler.diagnostics}`);
    assert.deepEqual(jpegSize(out[0]!), { width: 32, height: 64 });
    scaler.push(probePicture(128, 256));
    while (out.length < 2 && Date.now() < deadline) await sleep(20);
    assert.equal(out.length, 2);
    assert.equal(scaler.stats.framesOut, 2);
    scaler.stop();
  });
});
