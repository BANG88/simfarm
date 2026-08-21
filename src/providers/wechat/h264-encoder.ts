/**
 * JPEG frames in, H.264 out, via ffmpeg and VideoToolbox.
 *
 * Why this exists
 * ---------------
 * CDP only offers whole JPEGs. A 752x1618 frame is ~85 KB, so even a thinned
 * 20 fps costs ~14 Mbit/s of pictures that are each encoded from scratch — no
 * interframe compression at all, on a link measured at 61 Mbit/s to a remote
 * machine over the public internet (73 ms RTT) — that is the real ceiling, not
 * a misconfigured LAN. The iOS backend, streaming a *larger* screen at 60 fps,
 * costs 1.98 Mbit/s because it is H.264. Same picture, ~1/40th the bytes.
 *
 * Why ffmpeg rather than VideoToolbox directly
 * --------------------------------------------
 * serve-sim reaches VTCompressionSession through a node-swift addon. That is a
 * native build, a toolchain, and a rebuild every Node major — a lot of standing
 * cost for one pipeline. ffmpeg's `h264_videotoolbox` encoder is the same Apple
 * encoder behind a process boundary, and the process boundary is genuinely
 * useful here: a wedged encoder cannot take the server down with it, and it can
 * be killed and respawned in a few milliseconds.
 *
 * The parameters mirror serve-sim's H264Encoder (ARCHITECTURE.md) — realtime, no
 * frame reordering, high profile — because those are the settings that make an
 * encoder behave like a live stream instead of a file.
 *
 * Latency
 * -------
 * `-realtime 1` plus no B-frames means one frame in, one frame out. The mjpeg
 * demuxer is fed one complete image per write and flushed per packet, so ffmpeg
 * never sits on input waiting for a buffer to fill.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { VIDEO_TAG } from "../../protocol.ts";
import {
  NAL_TYPE,
  annexBToAvcc,
  buildAvcC,
  containsIdr,
  parameterSetsFromAnnexB,
} from "../../util/h264.ts";
import { logger } from "../../util/log.ts";

const log = logger("wechat/h264");

/**
 * Only the access-unit delimiter is stripped. The parameter sets stay in-band
 * on every IDR: they cost a few dozen bytes and let a decoder that has been
 * reset recover without waiting for a new CONFIG. This matches what the Android
 * provider ships, which is the combination already verified against the browser
 * client.
 */
const DROP_IN_AVCC = new Set<number>([NAL_TYPE.AUD]);

/**
 * A tiny fixed-cost distribution. An average hides exactly the thing worth
 * finding here: a stream that is smooth most of the time and stalls
 * periodically has a fine mean and a terrible p99.
 */
export interface Percentiles {
  n: number;
  max: number;
  /** millisecond buckets, last one is "everything above" */
  buckets: number[];
}

const BUCKET_EDGES = [10, 25, 50, 75, 100, 150, 200, 300, 500, 1000, 2000];

export function percentiles(): Percentiles {
  return { n: 0, max: 0, buckets: new Array(BUCKET_EDGES.length + 1).fill(0) };
}

export function record(p: Percentiles, ms: number): void {
  p.n++;
  if (ms > p.max) p.max = ms;
  let i = 0;
  while (i < BUCKET_EDGES.length && ms > BUCKET_EDGES[i]!) i++;
  p.buckets[i]!++;
}

/** @returns the bucket edge at or below which `q` of the samples fall. */
export function quantile(p: Percentiles, q: number): number {
  if (p.n === 0) return 0;
  const target = p.n * q;
  let seen = 0;
  for (let i = 0; i < p.buckets.length; i++) {
    seen += p.buckets[i]!;
    // Never report a percentile above the largest value actually seen: a bucket
    // edge of 2000 next to a max of 1807 reads as a measurement nobody took.
    if (seen >= target) return Math.min(BUCKET_EDGES[i] ?? p.max, p.max);
  }
  return p.max;
}

export interface EncoderOptions {
  width: number;
  height: number;
  /** nominal input rate; only sets timestamps, delivery is still push-driven */
  fps: number;
  bitRate: number;
  /** seconds between IDRs. A client attaching mid-stream waits this long. */
  keyframeIntervalSec: number;
  ffmpegPath: string;
  /** cap applied to the *stream* once h264 is chosen; 0 means uncapped */
  h264MaxFps: number;
}

export const DEFAULT_ENCODER: Omit<EncoderOptions, "width" | "height"> = {
  fps: 30,
  /*
   * The encoder spends whatever it is allowed, so this number *is* the
   * bandwidth. Measured on this picture: a 6 Mbit/s ceiling produced 5.0
   * Mbit/s, which is only 2.7x better than the jpeg path it replaces and well
   * short of what the link wants. serve-sim runs the iOS stream — a larger
   * screen, at 60 fps — inside 2.0 Mbit/s, so 2.5 is generous for a mini
   * program's flat UI.
   *
   * The source is already JPEG-compressed, and those artifacts cost real bits
   * to reproduce faithfully; there is no point paying for them.
   */
  bitRate: 2_500_000,
  keyframeIntervalSec: 2,
  ffmpegPath: "ffmpeg",
  h264MaxFps: 0,
};

export type EncodedSink = (tag: number, data: Uint8Array) => void;

export class H264Encoder {
  private readonly opts: EncoderOptions;
  private readonly onEncoded: EncodedSink;

  private proc: ChildProcessWithoutNullStreams | null = null;
  private pending: Buffer = Buffer.alloc(0);
  private avcC: Uint8Array | null = null;
  private closed = false;
  private stderr = "";

  /**
   * Whatever ffmpeg has said on stderr, most recent last.
   *
   * Kept rather than logged as it arrives because ffmpeg at `-loglevel error`
   * is silent when healthy, so this is empty in the normal case and is exactly
   * the thing worth printing when it is not. It used to be readable only from
   * the exit handler, which is no help for the failure that actually happens:
   * ffmpeg alive, swallowing frames, emitting nothing.
   */
  get diagnostics(): string {
    return this.stderr.trim();
  }

  /**
   * One counter per stage of the pipe. When the client sees nothing, exactly one
   * of these is zero and it says which side of which boundary to look at:
   * nothing written -> the provider never fed us; written but no stdout ->
   * ffmpeg is buffering or broken; stdout but no access units -> the bitstream
   * is not the shape the splitter expects; units but no framesOut -> the avcC
   * never got built.
   */
  readonly stats = {
    /** JPEGs handed to us by the provider */
    jpegIn: 0,
    /** dropped because the encoder had not drained the previous write */
    backlogDropped: 0,
    /** JPEG bytes actually written to ffmpeg's stdin */
    bytesIn: 0,
    /** raw bytes read back from ffmpeg's stdout */
    stdoutBytes: 0,
    stdoutChunks: 0,
    /** whole access units cut out of that stream */
    accessUnits: 0,
    /** access units turned into protocol frames (needs avcC first) */
    framesOut: 0,
    bytesOut: 0,
    /**
     * How long ffmpeg held a frame, ms — sampled only when exactly one frame
     * was outstanding, because that is the only time the pairing is certain.
     * Under load there are usually several in flight and this stays empty; the
     * in/out spacing pair below is what characterises the encoder then.
     */
    encodeMs: percentiles(),
    /** spacing of frames going in, ms */
    inGapMs: percentiles(),
    /** spacing of frames coming out, ms — this is what the client feels */
    outGapMs: percentiles(),
  };

  /**
   * Push timestamps, paired FIFO with output. `-bf 0` means no reordering, so
   * the nth picture out is the nth picture in and the difference is the time
   * ffmpeg actually spent holding it.
   */
  private readonly inFlight: number[] = [];
  private lastPushAt = 0;
  private lastEmitAt = 0;

  /** Called if ffmpeg dies; the handle uses it to fall back or report. */
  onFailure: ((reason: string) => void) | null = null;

  constructor(opts: EncoderOptions, onEncoded: EncodedSink) {
    this.opts = opts;
    this.onEncoded = onEncoded;
  }

  start(): void {
    const o = this.opts;
    const gop = Math.max(1, Math.round(o.fps * o.keyframeIntervalSec));
    const args = [
      "-hide_banner",
      "-loglevel", "error",
      "-fflags", "nobuffer",
      /*
       * Stop ffmpeg sniffing the input before it will start work. It defaults
       * to filling a 5 MB probe buffer, which at this bitrate is about three
       * seconds of the picture simply not appearing after an attach.
       *
       * It cannot go arbitrarily low: the demuxer still has to parse one whole
       * JPEG to learn the frame size, and at 32 bytes it never settles at all
       * (measured: 11 seconds to the first frame, worse than the default).
       * ~200 KB is two frames' worth — enough to decide, small enough to be
       * immediate.
       */
      "-probesize", "200000",
      "-analyzeduration", "0",
      // Input: a stream of concatenated JPEGs on stdin.
      "-f", "mjpeg",
      "-framerate", String(o.fps),
      "-i", "pipe:0",
      "-an",
      "-c:v", "h264_videotoolbox",
      "-realtime", "1",
      "-profile:v", "high",
      "-b:v", String(o.bitRate),
      "-g", String(gop),
      // No B-frames: reordering trades latency for compression, and this is a
      // remote control, not a download.
      "-bf", "0",
      "-flags", "+low_delay",
      "-flush_packets", "1",
      // Annex-B on stdout; util/h264.ts turns it into what the protocol wants.
      "-f", "h264",
      "pipe:1",
    ];

    log.debug(`spawning ${o.ffmpegPath} ${args.join(" ")}`);
    const proc = spawn(o.ffmpegPath, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.proc = proc;

    proc.stdout.on("data", (chunk: Buffer) => {
      this.stats.stdoutChunks++;
      this.stats.stdoutBytes += chunk.length;
      if (this.stats.stdoutChunks === 1) {
        // What ffmpeg is actually handing back. If the splitter finds nothing,
        // this line says whether the problem is the bitstream or the parser.
        log.debug(
          `first stdout chunk (${chunk.length} bytes): ${chunk.subarray(0, 64).toString("hex")}`,
        );
      }
      this.onAnnexB(chunk);
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      // ffmpeg says nothing at this log level unless something is wrong, so
      // anything here is worth keeping for the failure message.
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

  /**
   * Hand one JPEG to the encoder.
   *
   * Drops the frame rather than queueing when stdin is already backed up: a
   * queue here would show up as latency, and for a live picture a frame that is
   * late is worth less than the one behind it.
   */
  push(jpeg: Uint8Array): void {
    const proc = this.proc;
    if (!proc || this.closed || proc.stdin.destroyed) return;
    this.stats.jpegIn++;
    if (proc.stdin.writableLength > 0) {
      this.stats.backlogDropped++;
      return;
    }
    this.stats.bytesIn += jpeg.length;
    if (this.stats.jpegIn === 1) log.debug(`first JPEG written (${jpeg.length} bytes)`);
    const now = Date.now();
    if (this.lastPushAt > 0) record(this.stats.inGapMs, now - this.lastPushAt);
    this.lastPushAt = now;
    this.inFlight.push(now);
    // Never let this grow without bound if the encoder stops answering.
    if (this.inFlight.length > 240) this.inFlight.shift();
    proc.stdin.write(jpeg);
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
    // Give it a moment to flush, then make sure it is really dead: a stranded
    // ffmpeg holding a pipe is a leak that only shows up after a day of use.
    const kill = setTimeout(() => proc.kill("SIGKILL"), 500);
    kill.unref?.();
    proc.once("exit", () => clearTimeout(kill));
  }

  // -------------------------------------------------------------------------

  /**
   * Annex-B arrives in arbitrary chunks. Accumulate, then cut on access-unit
   * boundaries — an AUD or an SPS begins a new one — so each protocol frame we
   * emit is exactly one picture.
   */
  private onAnnexB(chunk: Buffer): void {
    this.pending =
      this.pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.pending, chunk]);
    const { units, rest } = splitAccessUnits(this.pending);
    this.pending = Buffer.from(rest);
    this.stats.accessUnits += units.length;
    for (const unit of units) this.emit(unit);
  }

  private emit(unit: Uint8Array): void {
    // Pair with its push *before* any early return. Skipping this on the frames
    // that precede the first avcC leaves the queue permanently offset, and the
    // encode time then reads as a steadily growing constant — which looks
    // exactly like a slow encoder and is not one.
    const pushedAt = this.inFlight.shift();

    // The parameter sets arrive in-band ahead of the first IDR. CONFIG has to
    // reach the client before any sample it describes (PROTOCOL §3).
    if (!this.avcC) {
      try {
        this.avcC = buildAvcC(parameterSetsFromAnnexB(unit));
      } catch {
        // No SPS/PPS yet — normal for anything before the first IDR.
        return;
      }
      this.onEncoded(VIDEO_TAG.CONFIG, this.avcC);
      log.debug(`avcC ready (${this.avcC.length} bytes)`);
    }

    const sample = annexBToAvcc(unit, DROP_IN_AVCC);
    if (sample.length === 0) return;

    const now = Date.now();
    // Only time a frame when the pairing is certain — nothing else outstanding.
    // Not every push produces an output (ffmpeg swallows some, and the units
    // before the first avcC produce none), so a FIFO that is even one entry out
    // of step reports the drift as encoder latency and makes a healthy encoder
    // look like it is holding frames for a second.
    if (pushedAt !== undefined && this.inFlight.length === 0) {
      record(this.stats.encodeMs, now - pushedAt);
    }
    if (this.lastEmitAt > 0) record(this.stats.outGapMs, now - this.lastEmitAt);
    this.lastEmitAt = now;

    this.stats.framesOut++;
    this.stats.bytesOut += sample.length;
    this.onEncoded(containsIdr(unit) ? VIDEO_TAG.KEY : VIDEO_TAG.DELTA, sample);
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

/**
 * Cut a buffer of Annex-B into whole access units, keeping the tail back.
 *
 * ffmpeg writes to a pipe, so chunks arrive on no particular boundary — one
 * read can hold two pictures, or a third of one. Emitting those chunks directly
 * would put fragments of a picture into separate protocol frames, which a
 * decoder cannot reassemble because our framing carries no continuation flag.
 *
 * An access unit opens at an AUD, an SPS, or a slice; the second such marker
 * *after a slice has been seen* is where the next one begins. The last unit is
 * always held back — until the following one starts there is no way to know it
 * is complete.
 */
export function splitAccessUnits(buf: Uint8Array): {
  units: Uint8Array[];
  rest: Uint8Array;
} {
  const units: Uint8Array[] = [];
  let from = 0;
  let seenPicture = false;

  // Scan for the 3-byte pattern. A 4-byte start code *contains* a 3-byte one at
  // its second byte, so a naive scan finds every long code twice and would cut
  // one byte into the picture — the same trap util/h264.ts documents for the
  // AVCC conversion. The leading zero belongs to the code, so the unit boundary
  // is one byte earlier when it is there.
  for (let i = 0; i + 2 < buf.length; i++) {
    if (buf[i] !== 0 || buf[i + 1] !== 0 || buf[i + 2] !== 1) continue;
    const codeStart = i > 0 && buf[i - 1] === 0 ? i - 1 : i;
    const payload = i + 3;
    i += 2; // never re-examine the bytes of a code we have just matched
    if (payload >= buf.length) break;

    const type = buf[payload]! & 0x1f;
    const isPicture = type === NAL_TYPE.IDR || type === NAL_TYPE.NON_IDR;
    if (type !== NAL_TYPE.AUD && type !== NAL_TYPE.SPS && !isPicture) continue;

    if (seenPicture && codeStart > from) {
      units.push(buf.subarray(from, codeStart));
      from = codeStart;
      seenPicture = isPicture;
      continue;
    }
    if (isPicture) seenPicture = true;
  }

  return { units, rest: buf.subarray(from) };
}

/**
 * Can this machine actually turn our JPEGs into H.264?
 *
 * Deliberately not a capability check. `ffmpeg -encoders` listing
 * h264_videotoolbox proves the binary was built with it, not that the pipeline
 * works — and the failure mode when it does not is the worst kind: the codec
 * negotiates, the attach succeeds, and the client sits on the SEED frame
 * forever with nothing in any log to say why. Declaring h264 also *commits* us,
 * because PROTOCOL §4 has the server prefer it over jpeg.
 *
 * So push real frames through the real command and require real output.
 */
export async function probeEncoder(
  ffmpegPath: string,
  timeoutMs = 6000,
): Promise<boolean> {
  const { Raster, encodeJpeg } = await import("../../util/raster.ts");
  // Two visibly different frames: an encoder can emit nothing for a single
  // still image and still be perfectly healthy.
  const frames = [0, 1].map((i) => {
    const raster = new Raster(320, 640);
    raster.clear(i === 0 ? [20, 90, 200] : [200, 90, 20]);
    raster.fillRect(40 + i * 60, 80, 120, 200, [250, 250, 250]);
    return encodeJpeg(raster, 70);
  });

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      encoder.stop();
      resolve(ok);
    };

    const encoder = new H264Encoder(
      { ...DEFAULT_ENCODER, ffmpegPath, width: 320, height: 640, keyframeIntervalSec: 1 },
      () => done(true),
    );
    encoder.onFailure = (reason) => {
      log.debug(`h264 probe failed: ${reason}`);
      done(false);
    };

    const timer = setTimeout(() => {
      log.debug(
        `h264 probe produced nothing in ${timeoutMs}ms ` +
          `(wrote ${encoder.stats.bytesIn} bytes, read ${encoder.stats.stdoutBytes})`,
      );
      done(false);
    }, timeoutMs);
    timer.unref?.();

    try {
      encoder.start();
    } catch (err) {
      log.debug(`h264 probe could not start: ${String(err)}`);
      done(false);
      return;
    }
    // Feed steadily rather than in one burst: the demuxer needs to see frame
    // boundaries the way it will in production.
    let n = 0;
    const feed = setInterval(() => {
      if (settled) {
        clearInterval(feed);
        return;
      }
      encoder.push(frames[n % frames.length]!);
      n++;
    }, 33);
    feed.unref?.();
  });
}
