/**
 * H.264 bitstream plumbing.
 *
 * Encoders hand us **Annex-B** — NAL units separated by `00 00 01` /
 * `00 00 00 01` start codes. That is what scrcpy's MediaCodec produces on the
 * device and what ffmpeg writes with `-f h264`. Our wire protocol
 * (PROTOCOL.md §3) wants what `VideoDecoder.configure({description})` wants: an
 * **avcC** record for CONFIG, and length-prefixed ("AVCC") samples for
 * KEY/DELTA.
 *
 * Converting between the two is the whole job of this file. It lived under the
 * Android provider until the WeChat provider needed the identical conversion for
 * its VideoToolbox encoder; nothing in it was ever Android-specific.
 *
 * Pure byte shuffling, no I/O, unit tested directly (test/util/h264.test.ts).
 */

export const NAL_TYPE = {
  /** coded slice of a non-IDR picture */
  NON_IDR: 1,
  /** coded slice of an IDR picture */
  IDR: 5,
  SEI: 6,
  SPS: 7,
  PPS: 8,
  AUD: 9,
} as const;

export interface ParameterSets {
  sps: Uint8Array;
  pps: Uint8Array;
}

/** NAL unit type of a NAL that does *not* include its start code. */
export function nalType(nal: Uint8Array): number {
  return nal.length === 0 ? -1 : nal[0]! & 0x1f;
}

/**
 * Split an Annex-B buffer into NAL units, start codes removed.
 *
 * Trailing zero bytes of a NAL are part of the next start code, never of the
 * payload, so they are trimmed — otherwise a re-serialized avcC length would
 * cover bytes the decoder never saw.
 */
export function splitAnnexB(buf: Uint8Array): Uint8Array[] {
  const nals: Uint8Array[] = [];
  let i = 0;
  let start = -1;

  // Three-at-a-time scan: a start code's third byte is 0x01, so any window
  // whose third byte is >1 cannot overlap one and can be skipped whole.
  while (i + 2 < buf.length) {
    const third = buf[i + 2]!;
    if (third > 1) {
      i += 3;
    } else if (third === 0) {
      i += 1;
    } else if (buf[i] === 0 && buf[i + 1] === 0) {
      if (start >= 0) nals.push(trimTrailingZeros(buf.subarray(start, i)));
      i += 3;
      start = i;
    } else {
      i += 3;
    }
  }
  if (start >= 0 && start < buf.length) {
    nals.push(trimTrailingZeros(buf.subarray(start, buf.length)));
  }
  return nals.filter((n) => n.length > 0);
}

function trimTrailingZeros(nal: Uint8Array): Uint8Array {
  let end = nal.length;
  while (end > 0 && nal[end - 1] === 0) end--;
  return nal.subarray(0, end);
}

/**
 * Annex-B frame -> AVCC sample (each NAL prefixed with its 4-byte big-endian
 * length). `drop` lets the caller strip NAL types that only make sense in an
 * Annex-B stream.
 */
export function annexBToAvcc(
  buf: Uint8Array,
  drop: ReadonlySet<number> = new Set(),
): Uint8Array {
  const nals = splitAnnexB(buf).filter((n) => !drop.has(nalType(n)));
  let total = 0;
  for (const n of nals) total += 4 + n.length;

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let o = 0;
  for (const n of nals) {
    view.setUint32(o, n.length);
    out.set(n, o + 4);
    o += 4 + n.length;
  }
  return out;
}

/** Pull the SPS and PPS out of an Annex-B buffer (scrcpy's config packet). */
export function parameterSetsFromAnnexB(buf: Uint8Array): ParameterSets {
  let sps: Uint8Array | null = null;
  let pps: Uint8Array | null = null;
  for (const nal of splitAnnexB(buf)) {
    const t = nalType(nal);
    if (t === NAL_TYPE.SPS && !sps) sps = nal;
    else if (t === NAL_TYPE.PPS && !pps) pps = nal;
  }
  if (!sps || !pps) {
    throw new Error(
      `h264 config packet is missing ${!sps ? "an SPS" : "a PPS"} (${buf.length} bytes)`,
    );
  }
  return { sps, pps };
}

/**
 * Build an ISO/IEC 14496-15 AVCDecoderConfigurationRecord ("avcC") — exactly
 * the blob `VideoDecoder.configure({description})` expects.
 *
 *   [0]    configurationVersion = 1
 *   [1..3] profile_idc / profile_compatibility / level_idc, copied from the SPS
 *   [4]    0b111111 reserved | lengthSizeMinusOne = 3  (4-byte NAL lengths)
 *   [5]    0b111    reserved | numOfSequenceParameterSets = 1
 *   ...    u16 length + SPS, then u8 count + u16 length + PPS
 */
export function buildAvcC({ sps, pps }: ParameterSets): Uint8Array {
  if (sps.length < 4) throw new Error(`SPS too short: ${sps.length} bytes`);

  const out = new Uint8Array(11 + sps.length + pps.length);
  const view = new DataView(out.buffer);
  out[0] = 0x01;
  out[1] = sps[1]!; // profile_idc
  out[2] = sps[2]!; // constraint flags / profile_compatibility
  out[3] = sps[3]!; // level_idc
  out[4] = 0xff;
  out[5] = 0xe1;
  view.setUint16(6, sps.length);
  out.set(sps, 8);
  let o = 8 + sps.length;
  out[o++] = 0x01;
  view.setUint16(o, pps.length);
  o += 2;
  out.set(pps, o);
  return out;
}

/** `avc1.42c029` — the WebCodecs codec string implied by an avcC record. */
export function avcCodecString(avcC: Uint8Array): string {
  if (avcC.length < 4) throw new Error("avcC too short");
  return `avc1.${[...avcC.subarray(1, 4)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;
}

/** True if the frame carries an IDR slice (a decodable-from-scratch picture). */
export function containsIdr(buf: Uint8Array): boolean {
  return splitAnnexB(buf).some((n) => nalType(n) === NAL_TYPE.IDR);
}
