/**
 * Pixel dimensions of a JPEG, read from its SOF marker.
 *
 * The WeChat provider needs this because CDP's screencast reports the *CSS*
 * viewport in its metadata, never the pixel size of the image it just handed
 * us — and the ratio between the two is the `scale` the protocol has to report
 * (PROTOCOL §7). Decoding the whole image to learn two numbers would be absurd,
 * so this walks the marker chain instead.
 */

/** Frame markers that carry a frame header (SOF0..SOF15), minus the four that don't. */
function isStartOfFrame(marker: number): boolean {
  if (marker < 0xc0 || marker > 0xcf) return false;
  // DHT (c4), JPG (c8) and DAC (cc) live in the same range but are not frames.
  return marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

export interface JpegSize {
  width: number;
  height: number;
}

/**
 * @returns the image size, or null if `data` is not a JPEG we can read.
 * Never throws: a truncated or corrupt frame is a normal thing to receive off a
 * socket, and the caller's fallback (keep the previous size) is better than an
 * exception mid-stream.
 */
export function jpegSize(data: Uint8Array): JpegSize | null {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return null;

  let i = 2;
  while (i + 3 < data.length) {
    if (data[i] !== 0xff) {
      // Resync: fill bytes (0xff) and entropy-coded data can leave us adrift.
      i++;
      continue;
    }
    const marker = data[i + 1]!;
    // Padding fill bytes; the real marker is further along.
    if (marker === 0xff) {
      i++;
      continue;
    }
    // Standalone markers: no length field follows.
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) {
      i += 2;
      continue;
    }
    const length = (data[i + 2]! << 8) | data[i + 3]!;
    if (length < 2) return null;
    if (isStartOfFrame(marker)) {
      // SOF payload: [1B precision][2B height][2B width]...
      if (i + 9 >= data.length) return null;
      const height = (data[i + 5]! << 8) | data[i + 6]!;
      const width = (data[i + 7]! << 8) | data[i + 8]!;
      if (width <= 0 || height <= 0) return null;
      return { width, height };
    }
    // SOS: everything after is entropy-coded, so a frame header can no longer
    // appear. Give up rather than scan megabytes of scan data.
    if (marker === 0xda) return null;
    i += 2 + length;
  }
  return null;
}
