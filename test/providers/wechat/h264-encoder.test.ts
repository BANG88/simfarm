/**
 * Cutting ffmpeg's Annex-B output into whole pictures.
 *
 * This is the one piece of the encoder that is pure logic, and it is the piece
 * that fails invisibly: our wire framing has no continuation flag, so half a
 * picture in a protocol frame is not a decode error at the client, it is a
 * smear that clears on the next keyframe. Bytes arrive from a pipe on no
 * boundary at all, so every split below is a shape a real read can produce.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { splitAccessUnits } from "../../../src/providers/wechat/h264-encoder.ts";
import { NAL_TYPE } from "../../../src/util/h264.ts";

/** An Annex-B NAL with a 4-byte start code. */
function nal(type: number, payload = 3): Uint8Array {
  const body = new Uint8Array(payload).fill(0x42);
  // The first byte carries the type in its low 5 bits.
  return Uint8Array.from([0, 0, 0, 1, type & 0x1f, ...body]);
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

const AUD = () => nal(NAL_TYPE.AUD);
const SPS = () => nal(NAL_TYPE.SPS);
const PPS = () => nal(NAL_TYPE.PPS);
const IDR = () => nal(NAL_TYPE.IDR, 12);
const SLICE = () => nal(NAL_TYPE.NON_IDR, 8);

describe("splitAccessUnits", () => {
  it("holds back a lone unit — it cannot know the picture is finished", () => {
    // Nothing has come along to prove this slice is complete, so emitting it
    // would be a guess.
    const { units, rest } = splitAccessUnits(concat(AUD(), SLICE()));
    assert.deepEqual(units, []);
    assert.equal(rest.length, AUD().length + SLICE().length);
  });

  it("emits a unit once the next one starts", () => {
    const first = concat(AUD(), SLICE());
    const { units, rest } = splitAccessUnits(concat(first, AUD(), SLICE()));
    assert.equal(units.length, 1);
    assert.deepEqual(units[0], first);
    assert.equal(rest.length, first.length);
  });

  it("keeps the parameter sets with the keyframe they describe", () => {
    // SPS/PPS/IDR is one access unit. Splitting between them would send a
    // keyframe whose parameter sets arrived in a different protocol frame.
    const key = concat(AUD(), SPS(), PPS(), IDR());
    const { units } = splitAccessUnits(concat(key, AUD(), SLICE()));
    assert.equal(units.length, 1);
    assert.deepEqual(units[0], key);
  });

  it("splits a run of several pictures", () => {
    const a = concat(AUD(), SPS(), PPS(), IDR());
    const b = concat(AUD(), SLICE());
    const c = concat(AUD(), SLICE());
    const { units, rest } = splitAccessUnits(concat(a, b, c));
    assert.equal(units.length, 2);
    assert.deepEqual(units[0], a);
    assert.deepEqual(units[1], b);
    assert.deepEqual(rest, c);
  });

  it("survives a stream with no access-unit delimiters", () => {
    // Not every encoder emits AUDs; a slice then has to be what opens a unit.
    const a = concat(SLICE());
    const b = concat(SLICE());
    const { units, rest } = splitAccessUnits(concat(a, b));
    assert.equal(units.length, 1);
    assert.deepEqual(units[0], a);
    assert.deepEqual(rest, b);
  });

  it("reassembles correctly however the pipe chops the bytes", () => {
    // The real failure mode: a read that ends mid-start-code or mid-NAL.
    const a = concat(AUD(), SPS(), PPS(), IDR());
    const b = concat(AUD(), SLICE());
    const c = concat(AUD(), SLICE());
    const whole = concat(a, b, c);

    for (let cut = 1; cut < whole.length; cut++) {
      let carry = whole.subarray(0, cut);
      const got: Uint8Array[] = [];

      let step = splitAccessUnits(carry);
      got.push(...step.units);
      carry = concat(step.rest, whole.subarray(cut));

      step = splitAccessUnits(carry);
      got.push(...step.units);

      assert.deepEqual(
        concat(...got, step.rest),
        whole,
        `a split at byte ${cut} lost or duplicated bytes`,
      );
      assert.deepEqual(got[0], a, `wrong first unit when split at byte ${cut}`);
    }
  });

  it("treats 3-byte start codes the same as 4-byte ones", () => {
    const short = (type: number): Uint8Array =>
      Uint8Array.from([0, 0, 1, type & 0x1f, 0x42, 0x42]);
    const a = concat(short(NAL_TYPE.AUD), short(NAL_TYPE.NON_IDR));
    const { units } = splitAccessUnits(concat(a, short(NAL_TYPE.AUD), short(NAL_TYPE.NON_IDR)));
    assert.equal(units.length, 1);
    assert.deepEqual(units[0], a);
  });

  it("returns everything as rest when there is no start code at all", () => {
    const junk = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const { units, rest } = splitAccessUnits(junk);
    assert.deepEqual(units, []);
    assert.deepEqual(rest, junk);
  });

  it("does not split on SEI or PPS alone", () => {
    // Those live inside an access unit; cutting there would break the picture.
    const one = concat(AUD(), SLICE(), nal(NAL_TYPE.SEI), PPS());
    const { units, rest } = splitAccessUnits(one);
    assert.deepEqual(units, []);
    assert.deepEqual(rest, one);
  });
});
