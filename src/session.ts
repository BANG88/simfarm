/**
 * One Session per client WebSocket. Owns stream ids, attached handles, control
 * request/response and input routing. Deliberately transport-agnostic so it can
 * be tested without a socket.
 */

import {
  MAX_STREAMS,
  VIDEO_TAG,
  decodeFrame,
  encodeControl,
  encodeEvent,
  encodeVideoFrame,
  seqIsNewer,
  type InputMessage,
} from "./protocol.ts";
import type { DeviceRegistry } from "./registry.ts";
import type {
  Codec,
  Device,
  DeviceHandle,
  Orientation,
  Screen,
} from "./types.ts";

export interface Transport {
  send(data: Uint8Array): void;
  /** bytes queued but not yet flushed; used to drop video under backpressure */
  bufferedAmount(): number;
  close(code?: number, reason?: string): void;
}

export interface SessionLogger {
  debug(msg: string, ...rest: unknown[]): void;
  info(msg: string, ...rest: unknown[]): void;
  warn(msg: string, ...rest: unknown[]): void;
  error(msg: string, ...rest: unknown[]): void;
}

/** Above this many queued bytes we drop video frames instead of piling up. */
const BACKPRESSURE_BYTES = 4 * 1024 * 1024;

interface Stream {
  streamId: number;
  device: Device;
  handle: DeviceHandle;
  stopVideo: (() => void) | null;
  codec: Codec;
  lastSeq: number | null;
  /** video frames the provider handed us */
  offered: number;
  /** of those, discarded because the socket was already too far behind */
  dropped: number;
  /** high water mark of the transport's queue, bytes */
  peakBuffered: number;
}

export class Session {
  private readonly streams = new Map<number, Stream>();
  private unwatch: (() => void) | null = null;
  private closed = false;

  private readonly transport: Transport;
  private readonly registry: DeviceRegistry;
  private readonly log: SessionLogger;

  constructor(
    transport: Transport,
    registry: DeviceRegistry,
    log: SessionLogger,
  ) {
    this.transport = transport;
    this.registry = registry;
    this.log = log;
  }

  /** Push the initial device list and subscribe to changes. */
  start(): void {
    this.unwatch = this.registry.watch((devices) => {
      this.sendEvent({ ev: "devices", devices });
    });
    void this.registry
      .list()
      .then((devices) => this.sendEvent({ ev: "devices", devices }))
      .catch((err) => this.log.warn("initial list failed", err));
  }

  /** Feed one binary WebSocket message. */
  async handleMessage(buf: Uint8Array): Promise<void> {
    if (this.closed) return;
    let frame;
    try {
      frame = decodeFrame(buf);
    } catch (err) {
      this.log.warn(`bad frame: ${String(err)}`);
      this.sendEvent({ ev: "error", message: `bad frame: ${String(err)}` });
      return;
    }

    switch (frame.channel) {
      case "control":
        await this.handleControl(frame.json);
        return;
      case "input":
        await this.handleInput(frame.streamId, frame.msg);
        return;
      case "video":
      case "event":
        // client -> server on these channels is not part of the protocol
        this.log.warn(`ignoring client frame on channel ${frame.channel}`);
        return;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.unwatch?.();
    this.unwatch = null;
    for (const stream of [...this.streams.values()]) {
      await this.teardown(stream);
    }
    this.streams.clear();
  }

  // -------------------------------------------------------------------------
  // control
  // -------------------------------------------------------------------------

  private async handleControl(json: unknown): Promise<void> {
    const req = json as { id?: unknown; op?: unknown } | null;
    const id = typeof req?.id === "number" ? req.id : null;
    const op = typeof req?.op === "string" ? req.op : null;

    if (id === null || op === null) {
      this.sendControl({ id: id ?? 0, ok: false, error: "missing id or op" });
      return;
    }

    try {
      const result = await this.dispatch(op, req as Record<string, unknown>);
      this.sendControl({ id, ok: true, ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn(`control op "${op}" failed: ${message}`);
      this.sendControl({ id, ok: false, error: message });
    }
  }

  private async dispatch(
    op: string,
    req: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    switch (op) {
      case "list":
        return { devices: await this.registry.list() };

      case "attach":
        return await this.attach(
          str(req.deviceId, "deviceId"),
          (req.codec as Codec | undefined) ?? undefined,
        );

      case "detach": {
        await this.detach(num(req.streamId, "streamId"));
        return {};
      }

      case "rotate": {
        const stream = this.stream(num(req.streamId, "streamId"));
        const orientation = str(req.orientation, "orientation") as Orientation;
        const result = (await stream.handle.control("rotate", {
          orientation,
        })) as { screen?: Screen } | undefined;
        if (result?.screen) this.emitScreen(stream.streamId, result.screen);
        return {};
      }

      case "launch": {
        const stream = this.stream(num(req.streamId, "streamId"));
        return {
          result: await stream.handle.control("launch", {
            target: str(req.target, "target"),
          }),
        };
      }

      case "boot":
      case "shutdown": {
        const deviceId = str(req.deviceId, "deviceId");
        const provider = this.registry.providerFor(deviceId);
        if (!provider.control) {
          throw new Error(`provider "${provider.kind}" cannot ${op} devices`);
        }
        return { result: await provider.control(op, { deviceId }) };
      }

      default: {
        // Anything else goes to the handle as a provider-specific op.
        const stream = this.stream(num(req.streamId, "streamId"));
        return { result: await stream.handle.control(op, req) };
      }
    }
  }

  private async attach(
    deviceId: string,
    requested?: Codec,
  ): Promise<Record<string, unknown>> {
    const streamId = this.allocStreamId();
    const handle = await this.registry.open(deviceId);
    const device = handle.device;

    const codec = pickCodec(device.capabilities.video, requested);
    const stream: Stream = {
      streamId,
      device,
      handle,
      stopVideo: null,
      codec,
      lastSeq: null,
      offered: 0,
      dropped: 0,
      peakBuffered: 0,
    };
    this.streams.set(streamId, stream);

    handle.subscribe?.({
      onScreen: (screen) => this.emitScreen(streamId, screen),
      onLog: (level, text) =>
        this.sendEvent({ ev: "log", streamId, level, text }),
      onForeground: (info) =>
        this.sendEvent({ ev: "foreground", streamId, ...info }),
      onDialog: (info) => this.sendEvent({ ev: "dialog", streamId, ...info }),
      onError: (message) => this.sendEvent({ ev: "error", streamId, message }),
      onClosed: (reason) => {
        this.sendEvent({ ev: "log", streamId, level: "info", text: reason });
        void this.detach(streamId).catch(() => {});
      },
    });

    try {
      stream.stopVideo = await handle.startVideo(codec, (tag, data) =>
        this.sendVideo(stream, tag, data),
      );
    } catch (err) {
      this.streams.delete(streamId);
      await handle.close().catch(() => {});
      throw err;
    }

    this.log.info(`attach ${deviceId} -> stream ${streamId} (${codec})`);
    if (device.screen) this.emitScreen(streamId, device.screen);
    return { streamId, codec, device };
  }

  private async detach(streamId: number): Promise<void> {
    const stream = this.streams.get(streamId);
    if (!stream) throw new Error(`no such stream ${streamId}`);
    this.streams.delete(streamId);
    await this.teardown(stream);
    this.log.info(
      `detach stream ${streamId} — ${stream.offered} video frames offered, ` +
        `${stream.dropped} dropped under backpressure, queue peaked at ${mib(stream.peakBuffered)}`,
    );
  }

  private async teardown(stream: Stream): Promise<void> {
    try {
      stream.stopVideo?.();
    } catch (err) {
      this.log.warn(`stopVideo failed: ${String(err)}`);
    }
    try {
      await stream.handle.close();
    } catch (err) {
      this.log.warn(`handle.close failed: ${String(err)}`);
    }
  }

  // -------------------------------------------------------------------------
  // input
  // -------------------------------------------------------------------------

  private async handleInput(
    streamId: number,
    msg: InputMessage,
  ): Promise<void> {
    const stream = this.streams.get(streamId);
    if (!stream) {
      this.log.debug(`input for unknown stream ${streamId}`);
      return;
    }

    // Coalesce a gesture's over-dense moves: drop anything not newer than the
    // last seq we accepted. begin/end always pass so a gesture never truncates.
    if (msg.kind === "touch" || msg.kind === "multitouch") {
      if (msg.phase === 1) {
        if (stream.lastSeq !== null && !seqIsNewer(msg.seq, stream.lastSeq)) {
          return;
        }
      }
      stream.lastSeq = msg.seq;
    }

    try {
      await stream.handle.input(msg);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn(`input failed on stream ${streamId}: ${message}`);
      this.sendEvent({ ev: "error", streamId, message });
    }
  }

  // -------------------------------------------------------------------------
  // sending
  // -------------------------------------------------------------------------

  private sendVideo(stream: Stream, tag: number, data: Uint8Array): void {
    if (this.closed) return;
    stream.offered++;
    const buffered = this.transport.bufferedAmount();
    if (buffered > stream.peakBuffered) stream.peakBuffered = buffered;

    // Never drop CONFIG: the client cannot decode anything without it.
    if (tag !== VIDEO_TAG.CONFIG && buffered > BACKPRESSURE_BYTES) {
      stream.dropped++;
      if (stream.dropped % 60 === 1) {
        // Both halves of the ratio, because "dropped 121" alone cannot
        // distinguish a provider sending far too much from a link that has
        // stalled — and those need opposite fixes. The queue depth says which.
        this.log.warn(
          `backpressure on stream ${stream.streamId}: dropped ${stream.dropped} of ` +
            `${stream.offered} offered, queue ${mib(buffered)} (peak ${mib(stream.peakBuffered)})`,
        );
      }
      return;
    }
    this.send(encodeVideoFrame(stream.streamId, tag, data));
  }

  private emitScreen(streamId: number, screen: Screen): void {
    this.sendEvent({ ev: "screen", streamId, ...screen });
  }

  private sendControl(json: unknown): void {
    this.send(encodeControl(json));
  }

  private sendEvent(json: unknown): void {
    this.send(encodeEvent(json));
  }

  private send(bytes: Uint8Array): void {
    if (this.closed) return;
    try {
      this.transport.send(bytes);
    } catch (err) {
      this.log.warn(`send failed: ${String(err)}`);
    }
  }

  private allocStreamId(): number {
    for (let i = 0; i < MAX_STREAMS; i++) {
      if (!this.streams.has(i)) return i;
    }
    throw new Error("no free stream id");
  }

  private stream(streamId: number): Stream {
    const stream = this.streams.get(streamId);
    if (!stream) throw new Error(`no such stream ${streamId}`);
    return stream;
  }
}

function mib(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function pickCodec(available: Codec[], requested?: Codec): Codec {
  if (available.length === 0) throw new Error("device declares no video codec");
  if (requested) {
    if (!available.includes(requested)) {
      throw new Error(
        `codec "${requested}" not supported (have: ${available.join(",")})`,
      );
    }
    return requested;
  }
  // Prefer h264 when the device offers it; it is the cheaper stream.
  return available.includes("h264") ? "h264" : available[0]!;
}

function str(v: unknown, what: string): string {
  if (typeof v !== "string" || v === "") throw new Error(`missing "${what}"`);
  return v;
}

function num(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(`missing "${what}"`);
  }
  return v;
}
