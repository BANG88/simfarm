/**
 * The Annex-B -> avcC conversion is the one place where a subtle byte error
 * shows up as "black screen" rather than as an exception, so it gets the
 * closest scrutiny. The SPS/PPS fixture is the real config packet scrcpy v4.1
 * emitted for the Pixel_10_Pro AVD.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  NAL_TYPE,
  annexBToAvcc,
  avcCodecString,
  buildAvcC,
  containsIdr,
  nalType,
  parameterSetsFromAnnexB,
  splitAnnexB,
} from "../../src/util/h264.ts";

/**
 * The literal 33-byte config packet scrcpy-server v4.1 sent for
 * `emulator-5554` (Pixel_10_Pro, 458x1024 encoded): a 4-byte start code, a
 * 19-byte SPS, another start code, and a 6-byte PPS.
 */
const REAL_CONFIG = Buffer.from(
  "00000001" +
    "6742c0298d681d0207939080808083c2211a80" +
    "00000001" +
    "68ce01a835c8",
  "hex",
);

const b = (...bytes: number[]): Uint8Array => new Uint8Array(bytes);

describe("splitAnnexB", () => {
  it("splits on 4-byte start codes", () => {
    const nals = splitAnnexB(b(0, 0, 0, 1, 0x67, 0xaa, 0, 0, 0, 1, 0x68, 0xbb));
    assert.deepEqual(nals.map((n) => [...n]), [
      [0x67, 0xaa],
      [0x68, 0xbb],
    ]);
  });

  it("splits on 3-byte start codes", () => {
    const nals = splitAnnexB(b(0, 0, 1, 0x65, 1, 2, 0, 0, 1, 0x61, 3));
    assert.deepEqual(nals.map((n) => [...n]), [
      [0x65, 1, 2],
      [0x61, 3],
    ]);
  });

  it("does not mistake payload bytes for a start code", () => {
    // 0x00 0x00 0x03 0x01 is an emulation-prevention sequence, not a start code
    const nals = splitAnnexB(b(0, 0, 0, 1, 0x61, 0, 0, 3, 1, 0x99));
    assert.equal(nals.length, 1);
    assert.deepEqual([...nals[0]!], [0x61, 0, 0, 3, 1, 0x99]);
  });

  it("drops the trailing zero of a 4-byte start code from the previous NAL", () => {
    // ...0xaa | 00 00 00 01 | 0x68 -> the first NAL must end at 0xaa
    const nals = splitAnnexB(b(0, 0, 1, 0x67, 0xaa, 0, 0, 0, 1, 0x68));
    assert.deepEqual([...nals[0]!], [0x67, 0xaa]);
  });

  it("returns nothing for a buffer with no start code", () => {
    assert.deepEqual(splitAnnexB(b(1, 2, 3, 4)), []);
    assert.deepEqual(splitAnnexB(new Uint8Array(0)), []);
  });

  it("reads NAL types", () => {
    assert.equal(nalType(b(0x67)), NAL_TYPE.SPS);
    assert.equal(nalType(b(0x68)), NAL_TYPE.PPS);
    assert.equal(nalType(b(0x65)), NAL_TYPE.IDR);
    assert.equal(nalType(b(0x61)), NAL_TYPE.NON_IDR);
    assert.equal(nalType(new Uint8Array(0)), -1);
  });
});

describe("annexBToAvcc", () => {
  it("replaces every start code with a 4-byte big-endian length", () => {
    const out = annexBToAvcc(b(0, 0, 0, 1, 0x65, 0xaa, 0xbb, 0, 0, 1, 0x61, 0xcc));
    assert.deepEqual(
      [...out],
      [0, 0, 0, 3, 0x65, 0xaa, 0xbb, 0, 0, 0, 2, 0x61, 0xcc],
    );
  });

  it("lengths cover exactly the payload, so the sample is self-describing", () => {
    const out = annexBToAvcc(REAL_CONFIG);
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
    let o = 0;
    const seen: number[] = [];
    while (o < out.length) {
      const len = view.getUint32(o);
      seen.push(out[o + 4]! & 0x1f);
      o += 4 + len;
    }
    assert.equal(o, out.length, "lengths must tile the buffer exactly");
    assert.deepEqual(seen, [NAL_TYPE.SPS, NAL_TYPE.PPS]);
  });

  it("drops NAL types the caller asks it to drop", () => {
    const withAud = b(0, 0, 0, 1, 0x09, 0x10, 0, 0, 0, 1, 0x65, 0xaa);
    const out = annexBToAvcc(withAud, new Set([NAL_TYPE.AUD]));
    assert.deepEqual([...out], [0, 0, 0, 2, 0x65, 0xaa]);
  });

  it("is empty when everything is dropped", () => {
    const out = annexBToAvcc(b(0, 0, 0, 1, 0x09, 0x10), new Set([NAL_TYPE.AUD]));
    assert.equal(out.length, 0);
  });
});

describe("parameterSetsFromAnnexB / buildAvcC", () => {
  it("extracts the SPS and PPS from a real scrcpy config packet", () => {
    const { sps, pps } = parameterSetsFromAnnexB(REAL_CONFIG);
    assert.equal(nalType(sps), NAL_TYPE.SPS);
    assert.equal(nalType(pps), NAL_TYPE.PPS);
    assert.equal(sps.length, 19);
    assert.equal(pps.length, 6);
  });

  it("throws a useful error when a parameter set is missing", () => {
    assert.throws(
      () => parameterSetsFromAnnexB(b(0, 0, 0, 1, 0x65, 1, 2, 3)),
      /missing an SPS/,
    );
    assert.throws(
      () => parameterSetsFromAnnexB(b(0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x29)),
      /missing a PPS/,
    );
  });

  it("builds an avcC record WebCodecs can consume", () => {
    const sets = parameterSetsFromAnnexB(REAL_CONFIG);
    const avcC = buildAvcC(sets);
    const view = new DataView(avcC.buffer);

    assert.equal(avcC[0], 1, "configurationVersion");
    assert.equal(avcC[1], 0x42, "profile_idc copied from the SPS");
    assert.equal(avcC[2], 0xc0, "profile_compatibility");
    assert.equal(avcC[3], 0x29, "level_idc");
    assert.equal(avcC[4], 0xff, "lengthSizeMinusOne = 3 (4-byte lengths)");
    assert.equal(avcC[5], 0xe1, "one SPS");

    assert.equal(view.getUint16(6), sets.sps.length);
    assert.deepEqual([...avcC.subarray(8, 8 + sets.sps.length)], [...sets.sps]);

    const o = 8 + sets.sps.length;
    assert.equal(avcC[o], 1, "one PPS");
    assert.equal(view.getUint16(o + 1), sets.pps.length);
    assert.deepEqual([...avcC.subarray(o + 3)], [...sets.pps]);
    assert.equal(avcC.length, 11 + sets.sps.length + sets.pps.length);
  });

  it("derives the WebCodecs codec string", () => {
    assert.equal(
      avcCodecString(buildAvcC(parameterSetsFromAnnexB(REAL_CONFIG))),
      "avc1.42c029",
    );
  });

  it("rejects a truncated SPS instead of building a bogus record", () => {
    assert.throws(() => buildAvcC({ sps: b(0x67, 0x42), pps: b(0x68) }), /too short/);
  });
});

describe("containsIdr", () => {
  it("recognises a key frame", () => {
    assert.equal(containsIdr(b(0, 0, 0, 1, 0x65, 0xaa)), true);
    assert.equal(containsIdr(b(0, 0, 0, 1, 0x61, 0xaa)), false);
  });
});
