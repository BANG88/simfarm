/**
 * JPEG in, smaller JPEG out, via ffmpeg — the discipline the Android jpeg
 * path already has, applied to serve-sim's MJPEG.
 *
 * Why this exists
 * ---------------
 * serve-sim encodes the simulator's whole framebuffer: 1206x2622 for an
 * iPhone 17 Pro, 100-700 KB a picture, at whatever rate the guest redraws
 * (4-57 fps measured). A phone on the far end draws that at 402x874 points
 * and pays 35-116 ms per frame just to base64-decode it in its WebSocket
 * layer, so nine tenths of the pixels are pure waste — and there is nothing
 * upstream to turn down: the native capture takes no size or quality and
 * its `/stream.mjpeg` route takes no query. The h264 path is untouched.
 *
 * So the cap is applied here, on the Mac, with the same tool the Android
 * transcoder uses and behind the same kind of process boundary. It runs only
 * while a jpeg stream is attached and only when the picture is actually
 * larger than `maxSize`; a framebuffer already within the cap goes through
 * untouched, at serve-sim's own quality, with no process at all.
 *
 * The command
 * -----------
 *   ffmpeg -flags low_delay -threads 1 -probesize 32 -analyzeduration 0
 *          -f mjpeg -i pipe:0
 *          -vf scale=W:H:flags=area
 *          -c:v mjpeg -threads 1 -q:v <q> -pix_fmt yuvj420p -fps_mode passthrough
 *          -f image2pipe -flush_packets 1 pipe:1
 *
 * The decoder-side flags are the ones measured for the Android path
 * (jpeg-transcoder.ts). `W:H` is fixed rather than an expression: the
 * encoder is opened at the first picture's size, and a framebuffer that
 * changes shape gets a fresh process (the handle restarts us), exactly as
 * scrcpy's rotation does on Android. `area` is the resampler that keeps
 * text legible when shrinking by two to three times.
 *
 * **Every picture we write gets a delimiter appended** — the MJPEG cousin of
 * the access-unit delimiter the Android path needs. ffmpeg's mjpeg parser
 * does not end a picture at its EOI; it ends it when it sees the *next*
 * picture start (`FF D8 FF Cx..Fx`, four bytes), so without help the last
 * frame of every gesture sits in the parser until the screen changes again
 * — measured: one picture written, nothing out; a second one written, the
 * first comes out. The delimiter is an SOI followed by a COM segment whose
 * declared length (6: two for the length field, four of payload) swallows
 * the real next picture's own SOI and first marker. The parser therefore
 * sees delimiter + picture as one frame, and the decoder sees an empty
 * comment, a few stray bytes it skips while looking for the next marker,
 * and then the picture. A bare SOI, fill bytes, or a COM of any other
 * length either leaves the frame stuck or makes the delimiter a packet of
 * its own that the decoder rejects on stderr every time.
 *
 * Frame rate
 * ----------
 * Unlike H.264, MJPEG can be thinned *before* decoding, so the cap sits at
 * the input and a dropped picture costs nothing. Dropped, never queued: a
 * queue would only deliver old pictures late.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import jpeg from "jpeg-js";

import { jpegSize } from "../../util/jpeg-size.ts";
import { logger } from "../../util/log.ts";
import { FrameRateGate, concatBytes, mjpegQscale, splitJpegs } from "../../util/mjpeg.ts";

const log = logger("ios/jpeg");

/**
 * Bytes queued on ffmpeg's stdin above which a picture is dropped rather than
 * written. A whole JPEG is at most a few hundred KB, so one megabyte means
 * ffmpeg is several pictures behind and the honest response is to skip.
 */
const BACKLOG_BYTES = 1024 * 1024;

/**
 * Written after every picture so ffmpeg's parser releases it at once; see
 * the file comment. SOI, COM, length 6.
 */
export const FRAME_DELIMITER = new Uint8Array([0xff, 0xd8, 0xff, 0xfe, 0x00, 0x06]);

export interface ScalerOptions {
  ffmpegPath: string;
  /** Longest side of the delivered picture, px; 0 disables scaling. */
  maxSize: number;
  /** JPEG quality of re-encoded pictures, 1-100, same units as `--android-jpeg-quality`. */
  quality: number;
  /** Cap on pictures per second; 0 means uncapped. */
  maxFps: number;
}

export const DEFAULT_SCALER: ScalerOptions = {
  ffmpegPath: "ffmpeg",
  /*
   * The same figure as `--android-max-size`, for the same reader: a phone
   * viewer draws the picture at a few hundred points either way, and 1024 is
   * where it stops being able to tell.
   */
  maxSize: 1024,
  /* Matches the Android transcoder; serve-sim itself encodes at 0.7. */
  quality: 70,
  /*
   * The same reasoning as the Android and WeChat jpeg paths: whole JPEGs
   * have no interframe compression, and the client is a phone on the far
   * side of a tailnet. The simulator can redraw at 60; nobody needs that in
   * JPEG.
   */
  maxFps: 20,
};

export interface Size {
  width: number;
  height: number;
}

/**
 * The size a `width`x`height` picture is delivered at under `maxSize`.
 *
 * Longest side capped at `maxSize`, aspect kept, both sides rounded to even
 * (a 4:2:0 JPEG wants even dimensions and swscale is happier with them). A
 * picture already within the cap comes back unchanged, odd sides and all —
 * it is not going to be re-encoded, so there is nothing to round. `maxSize`
 * of 0 means no cap.
 */
export function fitWithin(width: number, height: number, maxSize: number): Size {
  if (maxSize <= 0 || width <= 0 || height <= 0) return { width, height };
  const longest = Math.max(width, height);
  if (longest <= maxSize) return { width, height };
  const factor = maxSize / longest;
  const even = (v: number): number => Math.max(2, Math.round((v * factor) / 2) * 2);
  return width >= height
    ? { width: maxSize - (maxSize % 2), height: even(height) }
    : { width: even(width), height: maxSize - (maxSize % 2) };
}

export type JpegSink = (jpeg: Uint8Array) => void;

export class JpegScaler {
  private readonly opts: ScalerOptions;
  private readonly onJpeg: JpegSink;
  /** The framebuffer size this process was opened for. */
  readonly source: Size;
  /** What comes out; equals `source` when nothing is scaled. */
  readonly target: Size;
  /** False when pictures go straight through — within the cap, or ffmpeg is gone. */
  get scaling(): boolean {
    return this.proc !== null;
  }

  /**
   * Where pictures go. Settable so a handle that restarts the scaler on a
   * framebuffer change can carry the same sink over; defaults to the
   * constructor's callback.
   */
  sink: JpegSink | null = null;

  private proc: ChildProcessWithoutNullStreams | null = null;
  private pending: Uint8Array = new Uint8Array(0);
  private closed = false;
  private failed = false;
  private stderr = "";
  private readonly gate: FrameRateGate;

  /**
   * Called if ffmpeg dies. The handle answers by letting the rest of the
   * stream through at full size, so the viewer keeps a picture; the log says
   * why it got bigger.
   */
  onFailure: ((reason: string) => void) | null = null;

  /**
   * One counter per stage, for the same reason the Android transcoder has
   * them: when the client sees nothing, exactly one of these is zero and it
   * says which boundary to look at.
   */
  readonly stats = {
    /** pictures handed to us by the MJPEG parser */
    framesIn: 0,
    /** of those, dropped to respect `maxFps` */
    rateLimited: 0,
    /** dropped because ffmpeg's stdin had fallen too far behind */
    backlogDropped: 0,
    /** delivered untouched: within the cap, or ffmpeg unavailable */
    passedThrough: 0,
    /** JPEG bytes written to ffmpeg's stdin */
    bytesIn: 0,
    /** raw bytes read back from ffmpeg's stdout */
    stdoutBytes: 0,
    /** handed to the sink, scaled or not */
    framesOut: 0,
    bytesOut: 0,
  };

  constructor(opts: ScalerOptions, source: Size, onJpeg: JpegSink) {
    this.opts = opts;
    this.onJpeg = onJpeg;
    this.source = { ...source };
    this.target = fitWithin(source.width, source.height, opts.maxSize);
    this.gate = new FrameRateGate(opts.maxFps);
  }

  /** True when the cap actually changes the picture, i.e. ffmpeg is wanted. */
  get needsScaling(): boolean {
    return this.target.width !== this.source.width || this.target.height !== this.source.height;
  }

  /** The size pictures are really leaving at: `target`, unless ffmpeg has died. */
  get delivered(): Size {
    return this.failed ? this.source : this.target;
  }

  /** ffmpeg's own words, for a failure message. Empty when it said nothing. */
  get diagnostics(): string {
    return this.stderr.trim();
  }

  /** Spawns ffmpeg when the picture needs shrinking; a no-op otherwise. */
  start(): void {
    if (!this.needsScaling || this.proc || this.closed) return;
    const o = this.opts;
    const args = [
      "-hide_banner",
      "-loglevel", "error",
      "-flags", "low_delay",
      "-threads", "1",
      "-probesize", "32",
      "-analyzeduration", "0",
      "-f", "mjpeg",
      "-i", "pipe:0",
      "-an",
      "-vf", `scale=${this.target.width}:${this.target.height}:flags=area`,
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
      if (this.closed || this.proc !== proc) return;
      this.fail(
        `ffmpeg exited (${signal ?? code})${this.stderr ? `: ${this.stderr.trim()}` : ""}`,
      );
    });
  }

  /** Hand one whole JPEG from serve-sim to the pipeline. */
  push(picture: Uint8Array): void {
    if (this.closed) return;
    this.stats.framesIn++;
    if (!this.gate.admit()) {
      this.stats.rateLimited++;
      return;
    }

    const proc = this.proc;
    if (!proc || proc.stdin.destroyed) {
      this.stats.passedThrough++;
      this.emit(picture);
      return;
    }
    if (proc.stdin.writableLength > BACKLOG_BYTES) {
      this.stats.backlogDropped++;
      return;
    }
    this.stats.bytesIn += picture.length + FRAME_DELIMITER.length;
    proc.stdin.write(picture);
    proc.stdin.write(FRAME_DELIMITER);
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
    // As in the Android transcoder: give it a moment, then make sure it is
    // gone. A stranded ffmpeg holding a pipe is a leak that shows up a day
    // later.
    const kill = setTimeout(() => proc.kill("SIGKILL"), 500);
    kill.unref?.();
    proc.once("exit", () => clearTimeout(kill));
  }

  // -------------------------------------------------------------------------

  private onMjpeg(chunk: Uint8Array): void {
    const { frames, rest } = splitJpegs(concatBytes(this.pending, chunk));
    this.pending = rest;
    for (const picture of frames) this.emit(picture);
  }

  private emit(picture: Uint8Array): void {
    this.stats.framesOut++;
    this.stats.bytesOut += picture.length;
    (this.sink ?? this.onJpeg)(picture);
  }

  /**
   * ffmpeg is gone. Unlike the Android transcoder there is still a picture
   * to show — the input *is* a JPEG — so this does not close the stream: it
   * drops to pass-through and tells the handle, which re-reports the screen
   * at its full size.
   */
  private fail(reason: string): void {
    if (this.closed || !this.proc) return;
    this.proc = null;
    this.failed = true;
    this.pending = new Uint8Array(0);
    log.warn(`${reason}; delivering iOS jpeg frames at full size`);
    const cb = this.onFailure;
    this.onFailure = null;
    cb?.(reason);
  }
}

/**
 * Can this machine actually shrink a JPEG?
 *
 * The same rule as the Android and WeChat probes: push a real picture through
 * the real command and require a real, correctly sized picture back. A
 * binary that merely exists is not enough, because a pipeline that fails at
 * runtime looks identical to a working one right up until the viewer's
 * frames come out three times larger than promised.
 */
export async function probeScaler(ffmpegPath: string, timeoutMs = 6000): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      scaler.stop();
      resolve(ok);
    };

    const scaler = new JpegScaler(
      { ...DEFAULT_SCALER, ffmpegPath, maxSize: 32, maxFps: 0 },
      { width: 64, height: 128 },
      (picture) => {
        const size = jpegSize(picture);
        if (size?.width !== 16 || size.height !== 32) {
          log.debug(`jpeg probe returned ${size?.width}x${size?.height}, wanted 16x32`);
        }
        done(size?.width === 16 && size.height === 32);
      },
    );
    scaler.onFailure = (reason) => {
      log.debug(`jpeg probe failed: ${reason}`);
      done(false);
    };

    const timer = setTimeout(() => {
      log.debug(
        `jpeg probe produced nothing in ${timeoutMs}ms ` +
          `(wrote ${scaler.stats.bytesIn} bytes, read ${scaler.stats.stdoutBytes})`,
      );
      done(false);
    }, timeoutMs);
    timer.unref?.();

    try {
      scaler.start();
    } catch (err) {
      log.debug(`jpeg probe could not start: ${String(err)}`);
      done(false);
      return;
    }
    scaler.push(probePicture());
  });
}

/** A 64x128 JPEG for the probe and the tests: a flat colour, made in-process. */
export function probePicture(width = 64, height = 128): Uint8Array {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 0x20;
    data[i + 1] = 0x60;
    data[i + 2] = 0xc0;
    data[i + 3] = 0xff;
  }
  return new Uint8Array(jpeg.encode({ data, width, height }, 80).data);
}
