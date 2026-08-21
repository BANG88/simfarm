/**
 * One live scrcpy-server connection to one device.
 *
 * Everything here is transcribed from the pinned v4.1 sources, because the
 * server protocol is neither documented nor stable across versions:
 *
 *   app/src/server.c                   launch args + socket order
 *   app/src/demuxer.c                  12-byte packet header, session packet
 *   server/.../DesktopConnection.java   dummy byte + 64-byte device name
 *
 * Startup sequence in `tunnel_forward` mode (the mode we use, because it needs
 * no listening socket on our side):
 *
 *   1. push the jar, `adb forward tcp:0 -> localabstract:scrcpy_<scid>`
 *   2. `adb shell CLASSPATH=... app_process / com.genymobile.scrcpy.Server <version> ...`
 *   3. connect the video socket, retrying until it yields the one **dummy
 *      byte** — a plain connect succeeds even before the server listens, since
 *      adb accepts eagerly and only then hangs up, which is exactly what the
 *      dummy byte is there to detect
 *   4. connect the control socket (order is video, [audio], control)
 *   5. read the 64-byte device-name field — it goes to the *first* socket only,
 *      and only after every socket has been accepted, so it must be read after
 *      step 4, not between 3 and 4
 *   6. video stream: 4-byte codec id, then a session packet, then media packets
 */

import net from "node:net";
import type { ChildProcess } from "node:child_process";
import { adbSpawn, forwardToAbstract, push, removeForward } from "./adb.ts";
import { parseDeviceMessage, type DeviceMessage } from "./scrcpy-control.ts";

const DEVICE_JAR_PATH = "/data/local/tmp/scrcpy-server-simfarm.jar";
const DEVICE_NAME_FIELD_LENGTH = 64;
const PACKET_HEADER_SIZE = 12;

const FLAG_CONFIG = 1n << 62n;
const FLAG_KEY_FRAME = 1n << 61n;
const PTS_MASK = FLAG_KEY_FRAME - 1n;

export interface VideoSize {
  width: number;
  height: number;
}

export interface VideoPacket {
  /** codec config (SPS/PPS in Annex-B), not a displayable frame */
  config: boolean;
  /** IDR */
  key: boolean;
  ptsUs: bigint;
  data: Uint8Array;
}

export interface ScrcpySessionOptions {
  serial: string;
  /** local path of the already-verified jar */
  jarPath: string;
  /** must equal the pinned release version; the server rejects a mismatch */
  version: string;
  maxSize?: number;
  maxFps?: number;
  videoBitRate?: number;
  stayAwake?: boolean;
  logLevel?: "verbose" | "debug" | "info" | "warn" | "error";
}

export interface ScrcpySessionHandlers {
  onVideoPacket?: (packet: VideoPacket) => void;
  /** initial video size, and again on every rotation / resize */
  onVideoSize?: (size: VideoSize) => void;
  onDeviceMessage?: (msg: DeviceMessage) => void;
  onLog?: (level: "debug" | "info" | "warn" | "error", text: string) => void;
  onClosed?: (reason: string) => void;
}

export class ScrcpySession {
  readonly serial: string;
  /** `Build.MODEL`, as reported by the device over the socket */
  deviceName = "";
  /** four ASCII bytes, e.g. "h264" */
  codecId = "";
  videoSize: VideoSize = { width: 0, height: 0 };

  private readonly opts: ScrcpySessionOptions;
  private readonly handlers: ScrcpySessionHandlers;

  private proc: ChildProcess | null = null;
  private videoSocket: net.Socket | null = null;
  private controlSocket: net.Socket | null = null;
  private localPort = 0;
  private closed = false;
  private closeReason = "";

  private videoBuf: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private controlBuf: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private pendingHeader: Buffer<ArrayBufferLike> | null = null;

  constructor(opts: ScrcpySessionOptions, handlers: ScrcpySessionHandlers = {}) {
    this.opts = opts;
    this.serial = opts.serial;
    this.handlers = handlers;
  }

  /** Resolves once the video size is known — i.e. once frames can flow. */
  async start(): Promise<void> {
    const scid = randomScid();
    const socketName = `scrcpy_${scid}`;

    await push(this.serial, this.opts.jarPath, DEVICE_JAR_PATH);
    this.localPort = await forwardToAbstract(this.serial, socketName);

    try {
      this.proc = this.spawnServer(scid);

      const video = await connectForDummyByte(this.localPort, 150, 100, () =>
        this.closed ? this.closeReason || "session closed" : "",
      );
      this.videoSocket = video.socket;

      const control = await connectOnce(this.localPort);
      // Nagle would coalesce a touch-down with the next touch-move and make a
      // drag feel like it runs at 20 Hz (server.c sets this on this socket too).
      control.setNoDelay(true);
      this.controlSocket = control;

      const header = await video.reader.read(
        DEVICE_NAME_FIELD_LENGTH + 4 + PACKET_HEADER_SIZE,
      );
      this.deviceName = header
        .subarray(0, DEVICE_NAME_FIELD_LENGTH)
        .toString("utf8")
        .replace(/\0[\s\S]*$/, "");
      this.codecId = header
        .subarray(DEVICE_NAME_FIELD_LENGTH, DEVICE_NAME_FIELD_LENGTH + 4)
        .toString("ascii");
      if (this.codecId !== "h264") {
        throw new Error(
          `scrcpy negotiated codec "${this.codecId}", expected "h264"`,
        );
      }

      const session = header.subarray(DEVICE_NAME_FIELD_LENGTH + 4);
      if ((session[0]! & 0x80) === 0) {
        throw new Error(
          "scrcpy sent a media packet where the session packet was expected",
        );
      }
      this.applySession(session);

      video.reader.pipeTo(
        (chunk) => this.onVideoData(chunk),
        (reason) => this.fail(`video ${reason}`),
      );

      const controlReader = new SocketReader(control);
      controlReader.pipeTo(
        (chunk) => this.onControlData(chunk),
        (reason) => this.fail(`control ${reason}`),
      );
    } catch (err) {
      await this.close(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      // The tunnel has done its job once the sockets exist; leaving it
      // registered would leak one adb forward per attach.
      await removeForward(this.serial, this.localPort);
    }
  }

  /** Write one already-encoded scrcpy control message. */
  send(msg: Uint8Array): void {
    if (this.closed || !this.controlSocket) return;
    this.controlSocket.write(msg);
  }

  async close(reason = "closed"): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;

    this.videoSocket?.destroy();
    this.controlSocket?.destroy();
    this.videoSocket = null;
    this.controlSocket = null;

    if (this.proc) {
      this.proc.kill("SIGTERM");
      this.proc = null;
    }
    if (this.localPort) await removeForward(this.serial, this.localPort);
    this.handlers.onClosed?.(reason);
  }

  // -------------------------------------------------------------------------

  private spawnServer(scid: string): ChildProcess {
    const o = this.opts;
    const args = [
      "shell",
      `CLASSPATH=${DEVICE_JAR_PATH}`,
      "app_process",
      "/",
      "com.genymobile.scrcpy.Server",
      o.version,
      `scid=${scid}`,
      `log_level=${o.logLevel ?? "warn"}`,
      "audio=false",
      "video_codec=h264",
      "video_source=display",
      "tunnel_forward=true",
      "control=true",
      "cleanup=true",
    ];
    if (o.maxSize) args.push(`max_size=${o.maxSize}`);
    if (o.maxFps) args.push(`max_fps=${o.maxFps}`);
    if (o.videoBitRate) args.push(`video_bit_rate=${o.videoBitRate}`);
    if (o.stayAwake) args.push("stay_awake=true");

    const proc = adbSpawn(args, this.serial);
    const relay =
      (fallback: "info" | "error") =>
      (chunk: Buffer): void => {
        for (const line of chunk.toString("utf8").split("\n")) {
          const text = line.trim();
          if (!text) continue;
          this.handlers.onLog?.(levelOf(text) ?? fallback, `scrcpy: ${text}`);
        }
      };
    proc.stdout?.on("data", relay("info"));
    proc.stderr?.on("data", relay("error"));
    proc.on("exit", (code, signal) => {
      if (this.closed) return;
      this.fail(`scrcpy server exited (code=${code} signal=${signal})`);
    });
    return proc;
  }

  private onVideoData(chunk: Buffer): void {
    this.videoBuf =
      this.videoBuf.length === 0 ? chunk : Buffer.concat([this.videoBuf, chunk]);

    for (;;) {
      if (!this.pendingHeader) {
        if (this.videoBuf.length < PACKET_HEADER_SIZE) return;
        const header = this.videoBuf.subarray(0, PACKET_HEADER_SIZE);
        this.videoBuf = this.videoBuf.subarray(PACKET_HEADER_SIZE);
        if ((header[0]! & 0x80) !== 0) {
          this.applySession(header);
          continue;
        }
        this.pendingHeader = header;
      }

      const len = this.pendingHeader.readUInt32BE(8);
      if (this.videoBuf.length < len) return;

      const ptsFlags = this.pendingHeader.readBigUInt64BE(0);
      const data = this.videoBuf.subarray(0, len);
      this.videoBuf = this.videoBuf.subarray(len);
      this.pendingHeader = null;

      const config = (ptsFlags & FLAG_CONFIG) !== 0n;
      this.handlers.onVideoPacket?.({
        config,
        key: (ptsFlags & FLAG_KEY_FRAME) !== 0n,
        ptsUs: config ? 0n : ptsFlags & PTS_MASK,
        // copy: callers keep frames past this socket buffer's lifetime
        data: new Uint8Array(data),
      });
    }
  }

  private onControlData(chunk: Buffer): void {
    this.controlBuf =
      this.controlBuf.length === 0
        ? chunk
        : Buffer.concat([this.controlBuf, chunk]);
    for (;;) {
      let parsed;
      try {
        parsed = parseDeviceMessage(this.controlBuf);
      } catch (err) {
        this.handlers.onLog?.("warn", String(err));
        this.controlBuf = Buffer.alloc(0);
        return;
      }
      if (!parsed) return;
      this.controlBuf = this.controlBuf.subarray(parsed.size);
      this.handlers.onDeviceMessage?.(parsed.msg);
    }
  }

  private applySession(header: Buffer): void {
    const size = {
      width: header.readUInt32BE(4),
      height: header.readUInt32BE(8),
    };
    if (!size.width || !size.height) return;
    if (
      size.width === this.videoSize.width &&
      size.height === this.videoSize.height
    ) {
      return;
    }
    this.videoSize = size;
    this.handlers.onVideoSize?.(size);
  }

  private fail(reason: string): void {
    if (this.closed) return;
    void this.close(reason);
  }
}

// ---------------------------------------------------------------------------
// socket helpers
// ---------------------------------------------------------------------------

/**
 * Buffers a socket so the handshake can be read as fixed-size fields and the
 * rest handed straight to the packet parser — no `unshift()` games, and no
 * chance of losing the bytes that arrive in the same TCP segment as the header.
 */
class SocketReader {
  private buf: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private waiter: {
    n: number;
    resolve: (b: Buffer<ArrayBufferLike>) => void;
    reject: (e: Error) => void;
  } | null = null;
  private sink: ((chunk: Buffer) => void) | null = null;
  private onEnd: ((reason: string) => void) | null = null;
  private ended: string | null = null;
  private readonly sock: net.Socket;

  constructor(sock: net.Socket) {
    this.sock = sock;
    sock.on("data", (chunk: Buffer) => {
      if (this.sink) {
        this.sink(chunk);
        return;
      }
      this.buf = Buffer.concat([this.buf, chunk]);
      this.pump();
    });
    sock.on("error", (err) => this.end(String(err)));
    sock.on("close", () => this.end("stream ended"));
  }

  read(n: number): Promise<Buffer<ArrayBufferLike>> {
    return new Promise((resolve, reject) => {
      if (this.waiter) {
        reject(new Error("concurrent reads are not supported"));
        return;
      }
      this.waiter = { n, resolve, reject };
      this.pump();
    });
  }

  /** Stop buffering; replay what is buffered and forward everything after. */
  pipeTo(sink: (chunk: Buffer) => void, onEnd: (reason: string) => void): void {
    this.sink = sink;
    this.onEnd = onEnd;
    if (this.buf.length) {
      const pending = this.buf;
      this.buf = Buffer.alloc(0);
      sink(pending);
    }
    if (this.ended) onEnd(this.ended);
  }

  private pump(): void {
    const w = this.waiter;
    if (!w) return;
    if (this.buf.length >= w.n) {
      this.waiter = null;
      const out = this.buf.subarray(0, w.n);
      this.buf = this.buf.subarray(w.n);
      w.resolve(out);
      return;
    }
    if (this.ended) {
      this.waiter = null;
      w.reject(new Error(`${this.ended} after ${this.buf.length}/${w.n} bytes`));
    }
  }

  private end(reason: string): void {
    if (this.ended) return;
    this.ended = reason;
    this.pump();
    this.onEnd?.(reason);
  }

  destroy(): void {
    this.sock.destroy();
  }
}

function connectOnce(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1");
    sock.once("connect", () => {
      sock.removeAllListeners("error");
      resolve(sock);
    });
    sock.once("error", (err) => {
      sock.destroy();
      reject(err);
    });
  });
}

/**
 * Connect and wait for scrcpy's one-byte "I am really here" marker.
 *
 * `adb forward` accepts our connection before the device-side socket exists and
 * only then hangs up, so a successful `connect()` proves nothing. The dummy
 * byte does — same trick as `connect_and_read_byte()` in server.c.
 */
async function connectForDummyByte(
  port: number,
  attempts: number,
  delayMs: number,
  abortReason: () => string,
): Promise<{ socket: net.Socket; reader: SocketReader }> {
  let lastErr: unknown = null;
  for (let i = 0; i < attempts; i++) {
    const reason = abortReason();
    if (reason) throw new Error(reason);
    let sock: net.Socket | null = null;
    try {
      sock = await connectOnce(port);
      const reader = new SocketReader(sock);
      await reader.read(1);
      return { socket: sock, reader };
    } catch (err) {
      lastErr = err;
      sock?.destroy();
    }
    await sleep(delayMs);
  }
  throw new Error(
    `scrcpy server never accepted a connection on port ${port}: ${String(lastErr)}`,
  );
}

function randomScid(): string {
  // 31 bits: the server formats the scid as %08x, and -1 means "no scid"
  return Math.floor(Math.random() * 0x7fffffff)
    .toString(16)
    .padStart(8, "0");
}

function levelOf(line: string): "debug" | "info" | "warn" | "error" | null {
  if (line.startsWith("ERROR:")) return "error";
  if (line.startsWith("WARN:")) return "warn";
  if (line.startsWith("INFO:")) return "info";
  if (line.startsWith("DEBUG:") || line.startsWith("VERBOSE:")) return "debug";
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
