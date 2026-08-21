/**
 * Parser for serve-sim's `/stream.avcc` framing.
 *
 *     [4B BE length (tag + payload)][1B tag][payload]
 *
 * The tag values are the ones simfarm's VIDEO tags were copied from, so they
 * line up 1:1 (serve-sim `AVCCEnvelope`: 0x01 description / 0x02 keyframe /
 * 0x03 delta / 0x04 seed; PROTOCOL §3: CONFIG / KEY / DELTA / SEED). The map
 * below is still explicit — "they happen to be equal today" is not something
 * to leave implicit across two repos.
 */

import { VIDEO_TAG } from "../../protocol.ts";

export const AVCC_TAG = {
  DESCRIPTION: 0x01,
  KEYFRAME: 0x02,
  DELTA: 0x03,
  SEED: 0x04,
} as const;

const TAG_MAP: Record<number, number> = {
  [AVCC_TAG.DESCRIPTION]: VIDEO_TAG.CONFIG,
  [AVCC_TAG.KEYFRAME]: VIDEO_TAG.KEY,
  [AVCC_TAG.DELTA]: VIDEO_TAG.DELTA,
  [AVCC_TAG.SEED]: VIDEO_TAG.SEED,
};

/** A frame with the tag already translated to PROTOCOL §3 values. */
export interface VideoFrame {
  tag: number;
  data: Uint8Array;
}

/** Refuse absurd lengths rather than allocating on a corrupt stream. */
const MAX_FRAME_BYTES = 32 * 1024 * 1024;

export class AvccParser {
  private buf: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

  /** Feed one chunk; returns every complete frame it completed. */
  push(chunk: Uint8Array): VideoFrame[] {
    this.buf = concat(this.buf, chunk);
    const out: VideoFrame[] = [];

    for (;;) {
      if (this.buf.length < 5) break;
      const view = new DataView(
        this.buf.buffer,
        this.buf.byteOffset,
        this.buf.byteLength,
      );
      const len = view.getUint32(0);
      if (len < 1 || len > MAX_FRAME_BYTES) {
        throw new Error(`avcc: implausible frame length ${len}`);
      }
      if (this.buf.length < 4 + len) break;

      const rawTag = this.buf[4]!;
      const data = this.buf.slice(5, 4 + len);
      this.buf = this.buf.subarray(4 + len);

      const tag = TAG_MAP[rawTag];
      // Unknown tags are dropped, not fatal: a newer serve-sim may add one and
      // the stream stays decodable without it.
      if (tag !== undefined) out.push({ tag, data });
    }

    // Keep the tail as its own allocation so we don't pin a huge ArrayBuffer.
    if (this.buf.byteOffset !== 0) this.buf = this.buf.slice();
    return out;
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
