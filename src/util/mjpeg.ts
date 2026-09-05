/**
 * Pieces shared by every ffmpeg pipeline that emits MJPEG: the Android
 * transcoder (h264 -> jpeg) and the iOS scaler (jpeg -> smaller jpeg). Both
 * read whole pictures out of a pipe, speak libjpeg-style quality on their
 * flags, and cap the pictures per second the same way.
 */

/**
 * ffmpeg's mjpeg encoder takes a quantiser scale of 1-31 (lower is better),
 * not a libjpeg-style quality. Callers speak quality because the WeChat flag
 * does, so this converts.
 *
 * The mapping is calibrated, not guessed. libjpeg turns quality into a
 * percentage scale factor for the standard tables (`5000/q` below 50,
 * `200 - 2q` above); ffmpeg's encoder instead scales MPEG-1's intra matrix by
 * `qscale / 8`, and that matrix is roughly two-thirds the size of JPEG's. So
 * qscale ≈ scale × 8/100 × 1.5. Measured by PSNR against libjpeg output on a
 * 458×1018 launcher screenshot: libjpeg 70 ≈ qscale 7-8, 80 ≈ 5, 90 ≈ 2-3,
 * 50 ≈ 12 — and the ffmpeg file is ~40% smaller at equal PSNR.
 */
export function mjpegQscale(quality: number): number {
  const q = Math.min(100, Math.max(1, Math.round(quality)));
  const scale = q < 50 ? 5000 / q : 200 - 2 * q;
  return Math.min(31, Math.max(1, Math.round(scale * 0.12)));
}

/**
 * Cut a byte stream of concatenated JPEGs into whole images, keeping the tail.
 *
 * ffmpeg writes to a pipe, so a read can hold two pictures or a third of one.
 * A JPEG starts at `FF D8` and ends at `FF D9`, and the end marker cannot occur
 * inside the image: entropy-coded data escapes every `FF` as `FF 00`, and the
 * only other `FF xx` sequences in the scan are restart markers `D0`-`D7`.
 * ffmpeg's encoder writes no embedded thumbnails, which are the one place a
 * nested `FF D9` could otherwise appear.
 *
 * Bytes before a start marker are discarded: they can only be the tail of an
 * image whose head we never saw, which happens when a chunk is cut mid-marker
 * and is handled by carrying the last byte over.
 */
export function splitJpegs(buf: Uint8Array): { frames: Uint8Array[]; rest: Uint8Array } {
  const frames: Uint8Array[] = [];
  let from = 0;

  for (;;) {
    const start = indexOfMarker(buf, 0xd8, from);
    if (start === -1) {
      // Keep a trailing FF: the D8 may be the first byte of the next chunk.
      const keep = buf.length > 0 && buf[buf.length - 1] === 0xff ? buf.length - 1 : buf.length;
      return { frames, rest: buf.subarray(keep) };
    }
    const end = indexOfMarker(buf, 0xd9, start + 2);
    if (end === -1) return { frames, rest: buf.subarray(start) };
    frames.push(buf.subarray(start, end + 2));
    from = end + 2;
  }
}

function indexOfMarker(buf: Uint8Array, code: number, from: number): number {
  for (let i = from; i + 1 < buf.length; i++) {
    if (buf[i] === 0xff && buf[i + 1] === code) return i;
  }
  return -1;
}

export function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * Slack on the rate cap, matching the WeChat and Android jpeg paths: a frame
 * that lands a few milliseconds early is the same frame the cap asked for,
 * arriving a bit ahead of a timer that is itself only accurate to a few ms.
 */
export const FRAME_GAP_TOLERANCE_MS = 8;

/**
 * "At most N pictures a second, and never a queue."
 *
 * A frame that arrives sooner than the cap allows is dropped, not delayed:
 * whole JPEGs have no interframe state, so the next one is just as good a
 * picture and arrives with no backlog behind it. `maxFps` of 0 admits
 * everything.
 */
export class FrameRateGate {
  private readonly minGapMs: number;
  private lastAt: number | null = null;

  constructor(maxFps: number) {
    this.minGapMs = maxFps > 0 ? 1000 / maxFps : 0;
  }

  /** True if a frame arriving at `now` may go out; records it if so. */
  admit(now = Date.now()): boolean {
    if (
      this.minGapMs > 0 &&
      this.lastAt !== null &&
      now - this.lastAt < this.minGapMs - FRAME_GAP_TOLERANCE_MS
    ) {
      return false;
    }
    this.lastAt = now;
    return true;
  }
}
