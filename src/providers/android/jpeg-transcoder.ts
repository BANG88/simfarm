/**
 * H.264 in, JPEG out, via ffmpeg — the WeChat encoder run backwards.
 *
 * Why this exists
 * ---------------
 * scrcpy hands us H.264 and nothing else. That is the right stream for a
 * browser on a secure origin, and useless to a client with no video decoder:
 * a plain-http page served from an IP (`VideoDecoder` is undefined there), or a
 * native app whose runtime cannot decode video at all. Both can draw a JPEG.
 * The WeChat backend already has the opposite problem and solves it with
 * ffmpeg; this is the same tool pointed the other way, behind the same kind
 * of process boundary — a wedged transcoder cannot take the server down, and
 * costs milliseconds to respawn.
 *
 * It runs only while a jpeg stream is attached. An h264 viewer never starts
 * it, so the default path costs nothing extra.
 *
 * The command
 * ----------
 *   ffmpeg -flags low_delay -threads 1 -probesize 32 -analyzeduration 0
 *          -f h264 -i pipe:0
 *          -c:v mjpeg -threads 1 -q:v <q> -pix_fmt yuvj420p -fps_mode passthrough
 *          -f image2pipe -flush_packets 1 pipe:1
 *
 * Every flag above is the difference between "a picture" and "a picture one
 * or more frames late", and each was measured against a recorded scrcpy stream
 * (traced stage by stage with `-debug_ts`):
 *
 * - **Every access unit we write gets an access-unit delimiter appended.** The
 *   raw H.264 parser only knows a picture is complete when it sees the start
 *   of the next one, so without the AUD the last frame of a gesture sits in
 *   the parser until the screen changes again — and scrcpy sends nothing at
 *   all while the screen is still, so "until the screen changes" can be
 *   forever. The AUD is a legal six-byte NAL the decoder ignores.
 * - `-threads 1` on the *decoder* and, separately, on the *encoder*. Both
 *   default to frame threading, and frame threading is a pipeline: the decoder
 *   released nothing until the stream ended, and the single-threaded decoder
 *   plus a default mjpeg encoder was still exactly one frame behind. With both
 *   at one thread a P frame is a JPEG two milliseconds after it is written.
 * - `-flags low_delay` for the decoder, `-probesize 32 -analyzeduration 0` so
 *   ffmpeg starts on the first packet instead of sniffing for five megabytes.
 * - **Not** `-fflags nobuffer`, which the WeChat encoder uses: with it, the
 *   packets read while probing are discarded rather than replayed. On a JPEG
 *   stream that loses a picture; on an H.264 stream it loses the parameter
 *   sets and the IDR, and nothing decodes until the next keyframe, which
 *   scrcpy emits every ten seconds.
 *
 * Frame rate
 * ----------
 * H.264 cannot be thinned before decoding — every P frame needs the one before
 * it — so the cap is applied to the JPEGs coming out, the same even spacing
 * the WeChat jpeg path uses. Decoding and re-encoding a frame that is then
 * dropped costs about a millisecond at emulator sizes, which is cheaper than
 * the ffmpeg-side `fps` filter, which has to see the *next* frame before it
 * will release the current one and so brings back the very latency the AUD
 * trick removes.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { logger } from "../../util/log.ts";
import { NAL_TYPE, parameterSetsFromAnnexB, splitAnnexB, nalType } from "../../util/h264.ts";

const log = logger("android/jpeg");

/** One access-unit delimiter, Annex-B framed. `primary_pic_type` 7 = anything. */
const AUD = new Uint8Array([0, 0, 0, 1, NAL_TYPE.AUD, 0xf0]);

/**
 * Bytes queued on ffmpeg's stdin above which we stop feeding it until the next
 * keyframe. An H.264 backlog cannot be thinned — dropping one P frame corrupts
 * every picture until the next IDR — so the only honest response to a
 * transcoder that has fallen a second behind is to skip forward to a keyframe
 * and ask the device for one.
 */
const BACKLOG_BYTES = 1024 * 1024;

/** Slack on the rate cap, matching the WeChat provider. */
const FRAME_GAP_TOLERANCE_MS = 8;

export interface TranscoderOptions {
  ffmpegPath: string;
  /** JPEG quality, 1-100, in the same units as `--wechat-quality` */
  quality: number;
  /** cap on JPEGs per second; 0 means uncapped */
  maxFps: number;
}

export const DEFAULT_TRANSCODER: TranscoderOptions = {
  ffmpegPath: "ffmpeg",
  quality: 70,
  /*
   * The same reasoning as the WeChat jpeg path: whole JPEGs have no interframe
   * compression, and the client is a phone on the far side of a tailnet. An
   * emulator delivers 15-20 fps at the default `--android-max-size` anyway
   * (android-provider.ts), so this mostly matters for a physical device, which
   * would otherwise send 60 full pictures a second.
   */
  maxFps: 20,
};

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
 * What the scrcpy session hands over, and all the transcoder needs to know
 * about a packet: whether it is the parameter sets, whether it can start a
 * decode, and the bytes.
 */
export interface H264Packet {
  config: boolean;
  key: boolean;
  data: Uint8Array;
}

export type JpegSink = (jpeg: Uint8Array) => void;

export class JpegTranscoder {
  private readonly opts: TranscoderOptions;
  private readonly onJpeg: JpegSink;

  private proc: ChildProcessWithoutNullStreams | null = null;
  private pending: Uint8Array = new Uint8Array(0);
  private closed = false;
  private stderr = "";

  /**
   * ffmpeg is fed nothing until it can decode what it gets: the parameter sets
   * first, then a keyframe. A P frame written before those is not merely
   * wasted, it makes the decoder complain on stderr for every slice.
   */
  private haveConfig = false;
  private primed = false;
  private lastEmitAt = 0;
  private readonly minGapMs: number;

  /** Called if ffmpeg dies; the handle uses it to report, not to fall back. */
  onFailure: ((reason: string) => void) | null = null;
  /**
   * Called when the transcoder had to skip forward to the next keyframe and
   * would rather not wait ten seconds for one. The handle answers by asking
   * scrcpy for a fresh IDR.
   */
  onKeyframeNeeded: (() => void) | null = null;

  /**
   * One counter per stage, for the same reason the WeChat encoder has them:
   * when the client sees nothing, exactly one of these is zero and it says
   * which boundary to look at.
   */
  readonly stats = {
    /** packets handed to us by the scrcpy session */
    packetsIn: 0,
    /** skipped because the decoder had not yet seen the parameter sets or a keyframe */
    skippedBeforeKey: 0,
    /** skipped because ffmpeg's stdin had fallen too far behind */
    backlogDropped: 0,
    /** H.264 bytes actually written to ffmpeg's stdin, delimiters included */
    bytesIn: 0,
    /** raw bytes read back from ffmpeg's stdout */
    stdoutBytes: 0,
    /** whole JPEGs cut out of that stream */
    jpegsDecoded: 0,
    /** of those, dropped to respect `maxFps` */
    rateLimited: 0,
    /** handed to the sink */
    framesOut: 0,
    bytesOut: 0,
  };

  constructor(opts: TranscoderOptions, onJpeg: JpegSink) {
    this.opts = opts;
    this.onJpeg = onJpeg;
    this.minGapMs = opts.maxFps > 0 ? 1000 / opts.maxFps : 0;
  }

  /** ffmpeg's own words, for a failure message. Empty when it said nothing. */
  get diagnostics(): string {
    return this.stderr.trim();
  }

  start(): void {
    const o = this.opts;
    const args = [
      "-hide_banner",
      "-loglevel", "error",
      "-flags", "low_delay",
      "-threads", "1",
      "-probesize", "32",
      "-analyzeduration", "0",
      "-f", "h264",
      "-i", "pipe:0",
      "-an",
      "-c:v", "mjpeg",
      "-threads", "1",
      "-q:v", String(mjpegQscale(o.quality)),
      "-pix_fmt", "yuvj420p",
      "-fps_mode", "passthrough",
      "-f", "image2pipe",
      "-flush_packets", "1",
      "pipe:1",
    ];

    log.debug(`spawning ${o.ffmpegPath} ${args.join(" ")}`);
    const proc = spawn(o.ffmpegPath, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.proc = proc;

    proc.stdout.on("data", (chunk: Buffer) => {
      this.stats.stdoutBytes += chunk.length;
      this.onMjpeg(chunk);
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-2000);
    });
    proc.stdin.on("error", () => {
      // EPIPE when ffmpeg exits first; the exit handler reports the real cause.
    });
    proc.on("error", (err) => this.fail(`could not run ffmpeg: ${String(err)}`));
    proc.on("exit", (code, signal) => {
      if (this.closed) return;
      this.fail(
        `ffmpeg exited (${signal ?? code})${this.stderr ? `: ${this.stderr.trim()}` : ""}`,
      );
    });
  }

  /** Hand one scrcpy video packet to the decoder. */
  push(packet: H264Packet): void {
    const proc = this.proc;
    if (!proc || this.closed || proc.stdin.destroyed) return;
    this.stats.packetsIn++;

    if (packet.config) {
      this.haveConfig = true;
      this.write(packet.data);
      return;
    }

    if (!this.primed) {
      // Parameter sets may also ride inside the keyframe itself, which is what
      // ffmpeg's own encoders produce; scrcpy sends them separately.
      if (!packet.key || (!this.haveConfig && !hasParameterSets(packet.data))) {
        this.stats.skippedBeforeKey++;
        return;
      }
      this.primed = true;
    } else if (proc.stdin.writableLength > BACKLOG_BYTES) {
      this.stats.backlogDropped++;
      this.primed = false;
      log.warn(
        `ffmpeg is ${proc.stdin.writableLength} bytes behind; skipping to the next keyframe`,
      );
      this.onKeyframeNeeded?.();
      return;
    }

    this.write(packet.data);
    this.write(AUD);
  }

  stop(): void {
    if (this.closed) return;
    this.closed = true;
    const proc = this.proc;
    this.proc = null;
    if (!proc) return;
    try {
      proc.stdin.end();
    } catch {
      /* already gone */
    }
    // As in the WeChat encoder: give it a moment, then make sure it is gone. A
    // stranded ffmpeg holding a pipe is a leak that shows up a day later.
    const kill = setTimeout(() => proc.kill("SIGKILL"), 500);
    kill.unref?.();
    proc.once("exit", () => clearTimeout(kill));
  }

  // -------------------------------------------------------------------------

  private write(bytes: Uint8Array): void {
    const proc = this.proc;
    if (!proc || proc.stdin.destroyed) return;
    this.stats.bytesIn += bytes.length;
    proc.stdin.write(bytes);
  }

  private onMjpeg(chunk: Uint8Array): void {
    const { frames, rest } = splitJpegs(concat(this.pending, chunk));
    this.pending = rest;
    for (const jpeg of frames) {
      this.stats.jpegsDecoded++;
      const now = Date.now();
      if (
        this.minGapMs > 0 &&
        this.lastEmitAt > 0 &&
        now - this.lastEmitAt < this.minGapMs - FRAME_GAP_TOLERANCE_MS
      ) {
        this.stats.rateLimited++;
        continue;
      }
      this.lastEmitAt = now;
      this.stats.framesOut++;
      this.stats.bytesOut += jpeg.length;
      this.onJpeg(jpeg);
    }
  }

  private fail(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    log.warn(reason);
    const cb = this.onFailure;
    this.onFailure = null;
    cb?.(reason);
  }
}

function hasParameterSets(annexB: Uint8Array): boolean {
  try {
    parameterSetsFromAnnexB(annexB);
    return true;
  } catch {
    return false;
  }
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

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * A complete, tiny H.264 stream for the probe and the tests: SPS, PPS, one
 * 32×32 IDR of a blue picture, one P frame that turns it red. 123 bytes,
 * Constrained Baseline, produced by libx264 with its SEI stripped. Embedded
 * rather than kept as a fixture file so the probe needs no filesystem and a
 * test can never lose it.
 */
export const PROBE_SAMPLE_HEX =
  "000000016742c00ada25b011000003000100000300148f1226a00000000168ce0fc8" +
  "0000016588843a118a000211f1c000419a3800081bc9d75e" +
  "00000001419a202ebc29140018a000c5000628003140018a000c5000628003140018a000c5000628003140018a000c50006280031c00047763800094e627cfe7f0";

/** The sample above cut into the packets a scrcpy session would deliver. */
export function probeSamplePackets(): H264Packet[] {
  const bytes = Buffer.from(PROBE_SAMPLE_HEX, "hex");
  const packets: H264Packet[] = [];
  let unit: Uint8Array[] = [];
  const startCode = new Uint8Array([0, 0, 0, 1]);
  const flush = (config: boolean, key: boolean): void => {
    if (unit.length === 0) return;
    let data: Uint8Array = new Uint8Array(0);
    for (const nal of unit) data = concat(concat(data, startCode), nal);
    packets.push({ config, key, data });
    unit = [];
  };
  for (const nal of splitAnnexB(bytes)) {
    const type = nalType(nal);
    unit.push(nal);
    if (type === NAL_TYPE.PPS) flush(true, false);
    else if (type === NAL_TYPE.IDR) flush(false, true);
    else if (type === NAL_TYPE.NON_IDR) flush(false, false);
  }
  flush(false, false);
  return packets;
}

/**
 * Can this machine actually turn H.264 into JPEG?
 *
 * The same rule as the WeChat probe: push a real stream through the real
 * command and require a real picture back, because declaring `jpeg` commits
 * every jpeg-only client to it, and a pipeline that fails at runtime looks
 * identical to a working one right up until the picture never appears.
 */
export async function probeTranscoder(ffmpegPath: string, timeoutMs = 6000): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      transcoder.stop();
      resolve(ok);
    };

    const transcoder = new JpegTranscoder(
      { ...DEFAULT_TRANSCODER, ffmpegPath, maxFps: 0 },
      () => done(true),
    );
    transcoder.onFailure = (reason) => {
      log.debug(`jpeg probe failed: ${reason}`);
      done(false);
    };

    const timer = setTimeout(() => {
      log.debug(
        `jpeg probe produced nothing in ${timeoutMs}ms ` +
          `(wrote ${transcoder.stats.bytesIn} bytes, read ${transcoder.stats.stdoutBytes})`,
      );
      done(false);
    }, timeoutMs);
    timer.unref?.();

    try {
      transcoder.start();
    } catch (err) {
      log.debug(`jpeg probe could not start: ${String(err)}`);
      done(false);
      return;
    }
    for (const packet of probeSamplePackets()) transcoder.push(packet);
  });
}
