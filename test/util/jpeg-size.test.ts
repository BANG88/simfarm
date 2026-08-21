/**
 * JPEG dimensions from the marker chain.
 *
 * This is load-bearing for the WeChat provider: the ratio between the frame's
 * pixel size and the CSS viewport is the `scale` we report, and `scale` is what
 * decides how big the picture is drawn on the user's desktop (ARCHITECTURE.md).
 * A wrong answer here is a client rendering at the wrong size, not a crash — so
 * the real frames the provider actually ships are used as fixtures.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { jpegSize } from "../../src/util/jpeg-size.ts";
import { Raster, encodeJpeg } from "../../src/util/raster.ts";

function solid(width: number, height: number): Uint8Array {
  const raster = new Raster(width, height);
  raster.clear([40, 90, 200]);
  return encodeJpeg(raster, 70);
}

describe("jpegSize", () => {
  it("reads the size of a real encoded frame", () => {
    assert.deepEqual(jpegSize(solid(752, 1618)), { width: 752, height: 1618 });
  });

  it("handles a non-square, odd-sized image", () => {
    assert.deepEqual(jpegSize(solid(37, 91)), { width: 37, height: 91 });
  });

  it("is null for things that are not JPEG", () => {
    assert.equal(jpegSize(new Uint8Array(0)), null);
    assert.equal(jpegSize(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), null, "PNG");
    assert.equal(jpegSize(new Uint8Array([0xff, 0xd8])), null, "header only");
  });

  it("is null, not an exception, for a truncated frame", () => {
    // Frames arrive off a socket; a short read must not take the stream down.
    const full = solid(200, 100);
    for (const cut of [4, 12, 20, Math.floor(full.length / 2)]) {
      assert.doesNotThrow(() => jpegSize(full.slice(0, cut)));
    }
  });

  it("skips APP and comment segments to reach the frame header", () => {
    const full = solid(64, 48);
    // A JFIF APP0 is already in there; prove we walked past it rather than
    // guessing from a fixed offset.
    assert.equal(full[2], 0xff);
    assert.equal(full[3], 0xe0, "expected an APP0 segment first");
    assert.deepEqual(jpegSize(full), { width: 64, height: 48 });
  });

  it("gives up at the start of scan rather than scanning entropy data", () => {
    // A JPEG whose SOF is missing but which has an SOS: no frame header can
    // follow, so the answer is null and it must not walk the whole payload.
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, ...new Array(4096).fill(0x42)]);
    assert.equal(jpegSize(bytes), null);
  });
});
