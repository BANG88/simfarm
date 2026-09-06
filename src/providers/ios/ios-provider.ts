/**
 * iOS provider — consumes serve-sim's public middleware (ARCHITECTURE.md).
 *
 * Shape of the thing
 * ------------------
 *   middleware()  mounts [guard, serve-sim] on simfarm's own HTTP server, guard
 *                 first (ARCHITECTURE.md — see sim-paths.ts for the policy).
 *   init(ctx)     remembers how to reach those routes, starts the private HID
 *                 bridge (hid-bridge.ts) and the device poll.
 *   open(id)      opens a serve-sim capture session for one booted simulator.
 *
 * The handle then translates:
 *
 *   GET  {base}/_ios/helper/<udid>/stream.avcc   -> VIDEO frames (h264)
 *   GET  {base}/_ios/helper/<udid>/stream.mjpeg  -> VIDEO frames (jpeg), capped
 *                                                    in size and rate by jpeg-scaler.ts
 *   WS   {base}/_ios/helper/<udid>/ws            <- INPUT messages
 *   GET  {base}/_ios/helper/<udid>/config        -> screen events
 *   GET  {base}/_ios/helper/<udid>/foreground    -> foreground events
 *   GET  {base}/_ios/helper/<udid>/ax            -> control("ax")
 *
 * No native code, no fork, no private frameworks of our own (ARCHITECTURE.md, §4.4).
 */

import {
  VIDEO_TAG,
  appearanceMode,
  type InputMessage,
} from "../../protocol.ts";
import { logger } from "../../util/log.ts";
import { AvccParser } from "./avcc.ts";
import { HidBridge, type HidSocket } from "./hid-bridge.ts";
import {
  SUPPORTED_BUTTONS,
  inputToHid,
  orientationFrame,
  type SimScreenConfig,
} from "./hid-protocol.ts";
import {
  DEFAULT_SCALER,
  JpegScaler,
  fitWithin,
  probeScaler,
  type ScalerOptions,
  type Size,
} from "./jpeg-scaler.ts";
import { MjpegParser } from "./mjpeg.ts";
import { displayedScreen, frameRotationFor } from "./rotation.ts";
import {
  loadServeSim,
  onCaptureFailure,
  type CaptureOp,
  type SimMiddleware,
} from "./serve-sim.ts";
import { simGuard } from "./sim-guard.ts";
import { IOS_BASE, helperUrl } from "./sim-paths.ts";
import * as simctl from "./simctl.ts";
import type {
  Capabilities,
  Codec,
  Device,
  DeviceHandle,
  FrameSink,
  HandleEvents,
  HttpMiddleware,
  Orientation,
  Provider,
  ProviderContext,
  Screen,
} from "../../types.ts";

const log = logger("ios");

const DEVICE_POLL_MS = 4000;
const FOREGROUND_POLL_MS = 2000;
/** How long to wait for the capture session's first frame before giving up. */
const SCREEN_READY_MS = 15_000;

/**
 * ARCHITECTURE.md. `edgeGesture` is the one that matters: iOS is the only backend
 * with real system edge gestures, and the whole `edge` byte in PROTOCOL §5
 * exists for it.
 *
 * `text` is true even though serve-sim has no text-injection call — we expand a
 * string into per-key HID (hid-protocol.ts), which is what its own preview UI
 * does. Non-US-keyboard characters are dropped; see NOTES.md.
 * `mediaDrop` is false: `simctl addmedia` exists, but the protocol has no way
 * for a remote client to get a file onto this mac, so claiming it would lie.
 */
const CAPS: Capabilities = {
  video: ["h264", "jpeg"],
  touch: true,
  multitouch: true,
  keyboard: true,
  text: true,
  scroll: true,
  buttons: SUPPORTED_BUTTONS,
  rotate: true,
  edgeGesture: true,
  clipboard: true,
  ax: true,
  deeplink: true,
  mediaDrop: false,
  // `xcrun simctl ui <udid> appearance light|dark`, and it reads back
  appearance: true,
  // `simctl boot` through serve-sim's grid route, which also registers the
  // device with serve-sim's own state
  boot: true,
};

const UDID_RE =
  /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

export interface IosProviderOptions {
  /** longest side of a delivered jpeg picture, px; 0 leaves the framebuffer size alone */
  jpegMaxSize?: number;
  /** frame cap on the jpeg path; 0 removes it */
  jpegMaxFps?: number;
  /** JPEG quality of re-encoded (scaled) pictures, 1-100 */
  jpegQuality?: number;
  /** where to find ffmpeg for the scaler */
  ffmpegPath?: string;
  /**
   * The simctl calls the provider enumerates with. A seam for tests that have
   * no simulator (or want a device to change state on cue); production never
   * sets it.
   */
  simctl?: IosSimctl;
}

/** The two simctl reads the provider depends on (simctl.ts has the real ones). */
export interface IosSimctl {
  listDevices(): Promise<simctl.SimDevice[]>;
  deviceGeometry(deviceTypeIdentifier: string | undefined): Promise<simctl.DeviceGeometry | null>;
}

export class IosProvider implements Provider {
  readonly kind = "ios" as const;

  private scaler: ScalerOptions;
  private readonly sim: IosSimctl;
  private mw: SimMiddleware | null = null;
  private baseUrl = "";
  private readonly bridge = new HidBridge();
  private readonly watchers = new Set<(devices: Device[]) => void>();
  private pollTimer: NodeJS.Timeout | null = null;
  private lastFingerprint = "";
  private disposed = false;
  private unsubscribeCapture: (() => void) | null = null;

  /** every open handle, by udid — a device can be attached by several clients */
  private readonly handles = new Map<string, Set<IosHandle>>();
  /**
   * Simulators serve-sim holds an in-process capture session for. serve-sim
   * creates one on the first helper request for a udid and keeps it for the
   * life of the process, even after the simulator shuts down; re-booted, the
   * old session serves its last cached picture and nothing else (a re-attach
   * gets one SEED and 0 fps, measured). So the provider remembers which udids
   * it touched and has the session dropped once the simulator is seen down
   * (`reconcile`).
   */
  private readonly sessions = new Set<string>();
  /**
   * udid -> why its native capture could not start, kept until the dead
   * session is dropped. `open()` fails fast on it instead of waiting
   * SCREEN_READY_MS for a frame that will never come.
   */
  private readonly captureFailures = new Map<string, string>();

  constructor(options: IosProviderOptions = {}) {
    this.scaler = {
      ffmpegPath: options.ffmpegPath ?? DEFAULT_SCALER.ffmpegPath,
      maxSize: options.jpegMaxSize ?? DEFAULT_SCALER.maxSize,
      maxFps: options.jpegMaxFps ?? DEFAULT_SCALER.maxFps,
      quality: options.jpegQuality ?? DEFAULT_SCALER.quality,
    };
    this.sim = options.simctl ?? simctl;
  }

  // -------------------------------------------------------------------------
  // lifecycle
  // -------------------------------------------------------------------------

  middleware(): HttpMiddleware[] {
    const mw = loadServeSim().simMiddleware({ basePath: IOS_BASE });
    this.mw = mw;

    const adapter: HttpMiddleware = (req, res, next) => {
      void Promise.resolve(mw(req, res, async () => next())).catch((err) => {
        log.error(`serve-sim middleware failed: ${String(err)}`);
        if (!res.headersSent) res.writeHead(500).end("internal error");
      });
    };

    // Guard first, unconditionally. Anything that is not an allowlisted
    // serve-sim route dies here (ARCHITECTURE.md).
    return [simGuard(), adapter];
  }

  async init(ctx: ProviderContext): Promise<void> {
    this.baseUrl = selfUrl(ctx);
    if (!this.mw) throw new Error("middleware() was not called before init()");
    await this.bridge.start(this.mw);

    // Fail fast and loudly if the native addon cannot load at all — better here
    // than as a mysterious 404 on the first attach.
    const devices = await this.sim.listDevices();
    log.info(
      `serve-sim mounted at ${IOS_BASE}; ${devices.length} iOS simulators (${devices.filter((d) => d.state === "Booted").length} booted)`,
    );

    // Nothing here starts a capture: serve-sim only does that on the first
    // helper request for a udid. What init() has to do is be ready for one of
    // those to fail, whichever request it was (serve-sim.ts).
    this.unsubscribeCapture = onCaptureFailure((udid, err, op) =>
      this.onCaptureFailure(udid, err, op),
    );

    // The jpeg path does not *depend* on ffmpeg — serve-sim's pictures are
    // JPEG already — but without it they go out at the framebuffer's full
    // size, which is the thing `--ios-max-size` exists to stop. Probe once so
    // the log says which it will be, rather than every attach finding out.
    if (this.scaler.maxSize > 0) {
      if (await probeScaler(this.scaler.ffmpegPath)) {
        log.info(
          `jpeg frames capped at ${this.scaler.maxSize}px / ${this.scaler.maxFps || "unlimited"} fps ` +
            `via ${this.scaler.ffmpegPath}`,
        );
      } else {
        log.warn(
          `no usable ffmpeg at "${this.scaler.ffmpegPath}" — iOS jpeg frames go out at the ` +
            `framebuffer's full size (1206x2622 on an iPhone 17 Pro), which a phone viewer ` +
            `pays for on every frame. brew install ffmpeg`,
        );
        this.scaler = { ...this.scaler, maxSize: 0 };
      }
    }

    this.pollTimer = setInterval(() => void this.poll(), DEVICE_POLL_MS);
    this.pollTimer.unref?.();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.unsubscribeCapture?.();
    this.unsubscribeCapture = null;
    this.watchers.clear();
    await this.bridge.stop();
  }

  // -------------------------------------------------------------------------
  // device list
  // -------------------------------------------------------------------------

  async list(): Promise<Device[]> {
    const devices = await this.sim.listDevices();
    return Promise.all(devices.map((d) => toDevice(d, this.sim)));
  }

  watch(cb: (devices: Device[]) => void): () => void {
    this.watchers.add(cb);
    void this.poll(true);
    return () => this.watchers.delete(cb);
  }

  /**
   * Re-read simctl and tell the watchers when anything changed. Public so a
   * test can drive it instead of waiting on the interval; production only ever
   * calls it from the timer and after a boot / shutdown / capture failure.
   */
  async poll(force = false): Promise<void> {
    if (this.disposed || this.watchers.size === 0) return;
    try {
      const devices = await this.list();
      await this.reconcile(devices);
      const fingerprint = devices
        .map((d) => `${d.id}:${d.state}:${d.name}`)
        .join("|");
      if (!force && fingerprint === this.lastFingerprint) return;
      this.lastFingerprint = fingerprint;
      for (const cb of this.watchers) cb(devices);
    } catch (err) {
      log.warn(`device poll failed: ${String(err)}`);
    }
  }

  /**
   * A simulator we hold a session for is no longer booted: end its streams
   * with an error the client can act on, and have serve-sim drop the dead
   * session so the next boot gets a live one. Runs on every poll, so an
   * `xcrun simctl shutdown` from a terminal is noticed within DEVICE_POLL_MS.
   */
  private async reconcile(devices: Device[]): Promise<void> {
    const state = new Map(devices.map((d) => [udidOf(d.id), d] as const));
    for (const udid of [...this.sessions]) {
      const device = state.get(udid);
      if (device?.state === "booted") continue;
      // "connecting" is Booting: a shutdown now would abort the boot, and the
      // stale session will still be here on the next poll, when it is either
      // Booted (nothing to drop — see open()) or down.
      if (device?.state === "connecting") continue;
      const why = device ? `simulator ${device.name} is ${device.state}` : `simulator ${udid} is gone`;
      this.failHandles(udid, why);
      await this.dropSession(udid);
    }
  }

  /** Native capture failed for `udid` (serve-sim.ts). Never throws. */
  private onCaptureFailure(udid: string, err: unknown, op: CaptureOp): void {
    const message = errorText(err);
    log.warn(`${udid}: serve-sim capture ${op} failed: ${message}`);
    // Only a failed start() means "no frame will ever come from this
    // session". A subscribe or stop that rejected is logged and the stream
    // left to its own fate: the process is safe either way, which is the
    // part that matters.
    if (op !== "start") return;
    this.captureFailures.set(udid, message);
    this.failHandles(udid, `simulator capture lost: ${message}`);
    void this.afterCaptureFailure(udid);
  }

  private async afterCaptureFailure(udid: string): Promise<void> {
    let device: simctl.SimDevice | undefined;
    try {
      device = (await this.sim.listDevices()).find((d) => d.udid === udid);
    } catch (err) {
      log.warn(`simctl list failed after capture failure: ${String(err)}`);
    }
    if (device?.state === "Booted") {
      // simctl and CoreSimulator disagree — the "Booted" device whose
      // CoreSimulatorService connection died ("Mach error -308 (ipc/mig)
      // server died" in the log). Nothing we can do from here recovers it, and
      // shutting down a device simctl calls Booted is not ours to decide, so
      // the failure stays recorded (open() reports it) until the simulator is
      // seen down, when reconcile() drops the session.
      log.warn(
        `${udid}: simctl reports ${device.name} as Booted but CoreSimulator cannot capture it — ` +
          `run "xcrun simctl shutdown ${udid}" and boot it again; if that does not help, ` +
          `"killall -9 com.apple.CoreSimulator.CoreSimulatorService" and boot again`,
      );
    } else if (device?.state !== "Booting") {
      await this.dropSession(udid);
    }
    this.lastFingerprint = "";
    await this.poll(true);
  }

  private failHandles(udid: string, reason: string): void {
    const handles = this.handles.get(udid);
    if (!handles) return;
    for (const handle of [...handles]) handle.fail(reason);
  }

  /**
   * Ask serve-sim to forget its in-process session for `udid`. The grid
   * shutdown route is the one public route that closes a DeviceSession (it
   * does that first, then runs `simctl shutdown`); on a simulator that is
   * already down the simctl half fails and the route answers 500, but the
   * session is gone by then, which is all this is for. Only ever called for a
   * simulator that is not Booted, so nothing is shut down that was running.
   */
  private async dropSession(udid: string): Promise<void> {
    const had = this.sessions.delete(udid);
    const failed = this.captureFailures.delete(udid);
    if (!had && !failed) return;
    try {
      await this.gridRequest("shutdown", udid);
    } catch (err) {
      log.debug(`${udid}: dropped serve-sim session (${String(err)})`);
    }
  }

  // -------------------------------------------------------------------------
  // open / control
  // -------------------------------------------------------------------------

  async open(deviceId: string): Promise<DeviceHandle> {
    const udid = udidOf(deviceId);
    const device = (await this.sim.listDevices()).find((d) => d.udid === udid);
    if (!device) throw new Error(`no such iOS simulator: ${udid}`);
    if (device.state !== "Booted") {
      throw new Error(
        `simulator ${device.name} is ${device.state}; send {"op":"boot","deviceId":"${deviceId}"} first`,
      );
    }
    const failed = this.captureFailures.get(udid);
    if (failed) throw new Error(captureFailureMessage(device, udid, failed));

    // Touching /config is what creates serve-sim's capture session. Its
    // framebuffer size is only known once the first frame lands, so wait for it
    // — that also guarantees the avcc stream will carry a SEED jpeg, which is
    // the difference between "picture appears instantly" and "black until the
    // first IDR" (PROTOCOL §3).
    //
    // Remembered before the request, not after: serve-sim creates the session
    // whether or not this call ends well, and a session for a device that
    // failed to capture is exactly the kind reconcile() must drop.
    this.sessions.add(udid);
    const config = await this.waitForScreen(udid, device);
    const hid = await this.bridge.connect(udid);

    const geometry = await this.sim.deviceGeometry(device.deviceTypeIdentifier);
    const geometryScale = geometry?.scale ?? 1;
    // Attaching to an already-rotated simulator has to report the rotation too,
    // not just a later rotate op — so this goes through the same helper.
    const screen = displayedScreen(config, geometryScale);

    log.info(
      `opened ${device.name} (${udid}) ${screen.width}x${screen.height} ${screen.orientation} (frame ${config.width}x${config.height}, rotate ${screen.frameRotation}deg)`,
    );

    const handle = new IosHandle(
      {
        id: deviceId,
        kind: "ios",
        name: `${device.name} (${device.runtime})`,
        state: "booted",
        screen,
        capabilities: CAPS,
      },
      udid,
      this.baseUrl,
      hid,
      config,
      geometryScale,
      this.scaler,
      () => this.handles.get(udid)?.delete(handle),
    );
    let handles = this.handles.get(udid);
    if (!handles) this.handles.set(udid, (handles = new Set()));
    handles.add(handle);
    return handle;
  }

  /** Provider-level ops: boot / shutdown need no open handle. */
  async control(op: string, args: unknown): Promise<unknown> {
    const deviceId = (args as { deviceId?: string })?.deviceId ?? "";
    const udid = udidOf(deviceId);
    switch (op) {
      case "boot": {
        // A session left over from the simulator's last life would serve its
        // last picture forever; while the device is still down is the one
        // moment it can be dropped for free.
        await this.dropSession(udid);
        // The grid route boots via simctl *and* registers the device with
        // serve-sim's own state, which is what its `/api` surface expects.
        await this.gridRequest("start", udid);
        this.lastFingerprint = "";
        void this.poll(true);
        return { ok: true };
      }
      case "shutdown": {
        // End the streams before the simulator goes, whatever order the client
        // chose: a handle still open here would keep polling /foreground, and
        // the first of those after serve-sim drops its session would create a
        // fresh one on a device that is going down (the crash this replaces).
        this.failHandles(udid, "simulator shut down by request");
        this.sessions.delete(udid);
        this.captureFailures.delete(udid);
        await this.gridRequest("shutdown", udid);
        this.lastFingerprint = "";
        void this.poll(true);
        return { ok: true };
      }
      default:
        throw new Error(`iOS provider does not support op "${op}"`);
    }
  }

  private async gridRequest(action: "start" | "shutdown", udid: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}${IOS_BASE}/grid/api/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ udid }),
      // Booting a cold simulator is slow; serve-sim waits on `simctl bootstatus`.
      signal: AbortSignal.timeout(action === "start" ? 180_000 : 60_000),
    });
    const body = (await res.json().catch(() => null)) as
      | { ok?: boolean; error?: string }
      | null;
    if (!res.ok || body?.ok !== true) {
      throw new Error(body?.error ?? `grid ${action} failed (${res.status})`);
    }
  }

  private async waitForScreen(udid: string, device: simctl.SimDevice): Promise<SimScreenConfig> {
    const deadline = Date.now() + SCREEN_READY_MS;
    let last = "";
    for (;;) {
      const res = await fetch(helperUrl(this.baseUrl, udid, "config"));
      if (res.status === 404) {
        // serve-sim answers 404 when it cannot open a capture session at all.
        throw new Error(
          `serve-sim has no capture session for ${udid} (is it really booted?)`,
        );
      }
      const config = (await res.json()) as SimScreenConfig;
      if (config.width > 0 && config.height > 0) return config;
      // The capture behind this session rejected (serve-sim.ts) — no frame is
      // coming, so say why now rather than after the deadline.
      const failed = this.captureFailures.get(udid);
      if (failed) throw new Error(captureFailureMessage(device, udid, failed));
      last = JSON.stringify(config);
      if (Date.now() > deadline) {
        throw new Error(`simulator ${udid} produced no frame in ${SCREEN_READY_MS}ms (last config ${last})`);
      }
      await sleep(120);
    }
  }
}

// ---------------------------------------------------------------------------
// one attached simulator
// ---------------------------------------------------------------------------

class IosHandle implements DeviceHandle {
  readonly device: Device;

  private readonly udid: string;
  private readonly baseUrl: string;
  private readonly hid: HidSocket;

  private events: HandleEvents = {};
  private abort: AbortController | null = null;
  private foregroundTimer: NodeJS.Timeout | null = null;
  private lastForeground = "";
  private closed = false;
  /**
   * The framebuffer as serve-sim last described it — *not* what we report.
   * `device.screen` holds the rotated, displayed shape (PROTOCOL §6), so config
   * pushes have to be de-duplicated against the raw values or every push would
   * look like a change.
   */
  private fb: SimScreenConfig;
  /** profile.plist's backing scale; the reported `scale` shrinks with the picture */
  private readonly geometryScale: number;
  private readonly scalerOptions: ScalerOptions;
  private codec: Codec | null = null;
  /** the jpeg cap, alive only while a jpeg stream is */
  private scaler: JpegScaler | null = null;
  /** tells the provider this handle is gone */
  private readonly onDispose: () => void;

  /**
   * The same shape of ledger the Android handle keeps, so `stats` (and
   * tools/measure-stream.ts) can say where a missing picture went.
   */
  readonly stats = {
    /** frames parsed out of serve-sim's stream (avcc units or whole JPEGs) */
    framesIn: 0,
    /** handed to the session */
    framesOut: 0,
    bytesIn: 0,
    bytesOut: 0,
  };

  constructor(
    device: Device,
    udid: string,
    baseUrl: string,
    hid: HidSocket,
    fb: SimScreenConfig,
    geometryScale: number,
    scalerOptions: ScalerOptions,
    onDispose: () => void = () => {},
  ) {
    this.device = device;
    this.udid = udid;
    this.baseUrl = baseUrl;
    this.hid = hid;
    this.fb = fb;
    this.geometryScale = geometryScale;
    this.scalerOptions = scalerOptions;
    this.onDispose = onDispose;
  }

  subscribe(events: HandleEvents): void {
    this.events = events;
    // serve-sim pushes a screen config on the HID socket at attach time and
    // whenever the framebuffer changes shape (rotation, or the guest resizing
    // it). That is the authoritative source once a session is live.
    this.hid.subscribe({
      onConfig: (config) => this.applyScreen(config),
      // serve-sim closes the HID sockets when it drops the device session
      // (its grid shutdown route, or its own reaper). Input is gone and so is
      // the capture behind the stream: end the stream rather than leave a
      // handle polling /foreground, which would make serve-sim open a new
      // session on a simulator that is shutting down.
      onClose: () => this.fail("HID socket closed — serve-sim dropped the device session"),
    });
    this.startForegroundPoll();
  }

  /**
   * The device went away under the stream (shut down, or its capture
   * failed). PROTOCOL §6: an `error` on the stream says why, then the stream
   * closes and the session detaches it, freeing the stream id. Idempotent.
   */
  fail(reason: string): void {
    if (this.closed) return;
    log.warn(`${this.udid}: ${reason}`);
    this.events.onError?.(reason);
    void this.close(reason);
  }

  async startVideo(codec: Codec, onFrame: FrameSink): Promise<() => void> {
    if (this.abort) throw new Error("video already started");
    const abort = new AbortController();
    this.abort = abort;

    const url =
      codec === "h264"
        ? helperUrl(this.baseUrl, this.udid, "stream.avcc")
        : helperUrl(this.baseUrl, this.udid, "stream.mjpeg", "?raw=1");

    const res = await fetch(url, { signal: abort.signal });
    if (!res.ok || !res.body) {
      this.abort = null;
      throw new Error(`serve-sim ${codec} stream failed: ${res.status}`);
    }

    this.codec = codec;
    if (codec === "jpeg") this.startScaler();
    // session.ts emits `handle.device.screen` right after this resolves, so
    // the size it reports has to be the delivered one, not the framebuffer's.
    this.publishScreen(false);
    const size = this.deliveredSize();
    log.info(
      `${this.udid}: streaming ${size.width}x${size.height} ${codec}` +
        (this.scaler?.needsScaling
          ? ` (scaled from ${this.fb.width}x${this.fb.height}, max-size ${this.scalerOptions.maxSize}, ` +
            `${this.scalerOptions.maxFps || "unlimited"} fps, q${this.scalerOptions.quality})`
          : codec === "jpeg" && this.scalerOptions.maxFps > 0
            ? ` (${this.scalerOptions.maxFps} fps)`
            : ""),
    );

    void this.pump(codec, res.body, onFrame, abort);

    return () => {
      if (this.abort === abort) this.abort = null;
      abort.abort();
      this.stopScaler();
    };
  }

  private async pump(
    codec: Codec,
    body: ReadableStream<Uint8Array>,
    onFrame: FrameSink,
    abort: AbortController,
  ): Promise<void> {
    const avcc = new AvccParser();
    const mjpeg = new MjpegParser();
    let firstJpeg = true;
    const emitJpeg = (jpeg: Uint8Array): void => {
      if (abort.signal.aborted) return;
      // The very first jpeg is delivered as SEED so a fresh client has a
      // picture immediately; the rest are ordinary complete frames.
      this.stats.framesOut++;
      this.stats.bytesOut += jpeg.length;
      onFrame(firstJpeg ? VIDEO_TAG.SEED : VIDEO_TAG.KEY, jpeg);
      firstJpeg = false;
    };
    if (this.scaler) this.scaler.sink = emitJpeg;
    const reader = body.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done || abort.signal.aborted) break;
        if (!value) continue;
        if (codec === "h264") {
          for (const frame of avcc.push(value)) {
            this.stats.framesIn++;
            this.stats.bytesIn += frame.data.length;
            this.stats.framesOut++;
            this.stats.bytesOut += frame.data.length;
            onFrame(frame.tag, frame.data);
          }
        } else {
          for (const jpeg of mjpeg.push(value)) {
            this.stats.framesIn++;
            this.stats.bytesIn += jpeg.length;
            // The scaler owns the rate cap and the size cap; without one
            // (h264 never has one) pictures go straight through.
            if (this.scaler) this.scaler.push(jpeg);
            else emitJpeg(jpeg);
          }
        }
      }
    } catch (err) {
      if (!abort.signal.aborted && !this.closed) {
        const message = `video stream ended: ${String(err)}`;
        log.warn(message);
        this.events.onError?.(message);
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* already torn down */
      }
    }
  }

  async input(msg: InputMessage): Promise<void> {
    if (this.closed) return;
    if (!this.hid.open) throw new Error("HID socket is not open");
    // PROTOCOL §6: the client normalized against the upright picture and did no
    // coordinate maths. Undoing the rotation is our job, and it has to use the
    // *current* orientation — a gesture that starts before a rotate and ends
    // after it is the client's problem, not ours.
    this.hid.send(inputToHid(msg, frameRotationFor(this.fb.orientation)));
  }

  async control(op: string, args: unknown): Promise<unknown> {
    switch (op) {
      case "rotate": {
        const orientation = (args as { orientation?: Orientation })?.orientation;
        if (!orientation) throw new Error("rotate needs an orientation");
        this.hid.send([orientationFrame(orientation)]);
        // The guest rotates asynchronously; wait for the framebuffer to follow
        // so the caller gets a screen that is already correct.
        const screen = await this.awaitOrientation(orientation);
        return { screen };
      }

      case "launch": {
        const target = (args as { target?: string })?.target;
        if (!target) throw new Error("launch needs a target");
        return await simctl.launch(this.udid, target);
      }

      case "ax": {
        const res = await fetch(helperUrl(this.baseUrl, this.udid, "ax"));
        if (!res.ok) throw new Error(`ax unavailable (${res.status})`);
        return await res.json();
      }

      case "foreground":
        return await this.readForeground();

      case "stats":
        // Diagnostic: the frame ledger, the framebuffer against what is
        // actually delivered, and the scaler's own counters when one runs.
        return {
          ...this.stats,
          codec: this.codec,
          frameSize: { width: this.fb.width, height: this.fb.height },
          videoSize: this.deliveredSize(),
          scaler: this.scaler
            ? { ...this.scaler.stats, scaling: this.scaler.scaling, target: this.scaler.target }
            : null,
        };

      /*
       * PROTOCOL §4 `appearance`. Reads back afterwards rather than trusting
       * the exit status: a client that follows the desktop theme would
       * otherwise have no way to notice the guest ignored it.
       */
      case "appearance": {
        const mode = appearanceMode(args);
        await simctl.setAppearance(this.udid, mode);
        return { mode: await simctl.getAppearance(this.udid) };
      }

      case "clipboard_get":
        return { text: await simctl.getClipboard(this.udid) };

      case "clipboard_set": {
        const text = (args as { text?: string })?.text ?? "";
        await simctl.setClipboard(this.udid, text);
        return { ok: true };
      }

      default:
        throw new Error(`iOS provider does not support op "${op}"`);
    }
  }

  async close(reason = "closed"): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.onDispose();
    this.abort?.abort();
    this.abort = null;
    this.stopScaler();
    if (this.foregroundTimer) clearInterval(this.foregroundTimer);
    this.foregroundTimer = null;
    this.hid.close();
    this.events.onClosed?.(reason);
  }

  // -------------------------------------------------------------------------

  private applyScreen(config: SimScreenConfig): void {
    if (
      this.fb.width === config.width &&
      this.fb.height === config.height &&
      this.fb.orientation === config.orientation
    ) {
      return;
    }
    const resized = this.fb.width !== config.width || this.fb.height !== config.height;
    this.fb = config;
    // On iOS width/height do *not* move when the guest rotates — only
    // `orientation` does — so this is usually an orientation-only change that
    // nevertheless flips the reported dimensions and `frameRotation`. A real
    // resize (the guest changing its framebuffer) needs a fresh ffmpeg, whose
    // encoder was opened at the old picture's size.
    if (resized && this.scaler) {
      log.info(`${this.udid}: framebuffer now ${config.width}x${config.height}, restarting the jpeg scaler`);
      const sink = this.scaler.sink;
      this.stopScaler();
      this.startScaler();
      this.scaler!.sink = sink;
    }
    this.publishScreen();
  }

  /**
   * `device.screen` as the client should see it: the delivered picture,
   * rotated upright, with `scale` shrunk in step so `width / scale` is still
   * the device's point size (PROTOCOL §7). Mutated in place because
   * session.ts reads `handle.device.screen` after attach.
   */
  private publishScreen(emit = true): void {
    const size = this.deliveredSize();
    const scale = round3(this.geometryScale * (size.width / this.fb.width));
    const screen = displayedScreen({ ...this.fb, ...size }, scale);
    this.device.screen = screen;
    if (emit) this.events.onScreen?.({ ...screen });
  }

  /** Pixel size of the frames actually sent: the framebuffer, unless the jpeg cap shrinks it. */
  private deliveredSize(): Size {
    if (this.scaler) return this.scaler.delivered;
    if (this.codec === "jpeg") return fitWithin(this.fb.width, this.fb.height, this.scalerOptions.maxSize);
    return { width: this.fb.width, height: this.fb.height };
  }

  private startScaler(): void {
    const scaler = new JpegScaler(
      this.scalerOptions,
      { width: this.fb.width, height: this.fb.height },
      (jpeg) => scaler.sink?.(jpeg),
    );
    scaler.onFailure = () => {
      if (this.closed || this.scaler !== scaler) return;
      // Pictures now arrive at the framebuffer's size; say so before the
      // client draws one into a rectangle sized for the small ones.
      this.publishScreen();
    };
    this.scaler = scaler;
    scaler.start();
  }

  private stopScaler(): void {
    this.scaler?.stop();
    this.scaler = null;
  }

  private async awaitOrientation(want: Orientation): Promise<Screen | undefined> {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if (this.device.screen?.orientation === want) break;
      await sleep(100);
    }
    return this.device.screen ? { ...this.device.screen } : undefined;
  }

  private startForegroundPoll(): void {
    const tick = async (): Promise<void> => {
      if (this.closed) return;
      try {
        const info = await this.readForeground();
        const key = `${info.bundleId}:${info.pid ?? ""}`;
        if (key === this.lastForeground) return;
        this.lastForeground = key;
        if (info.bundleId) this.events.onForeground?.(info);
      } catch {
        // The AX bridge warms up a second or two after boot; keep quiet.
      }
    };
    void tick();
    this.foregroundTimer = setInterval(() => void tick(), FOREGROUND_POLL_MS);
    this.foregroundTimer.unref?.();
  }

  private async readForeground(): Promise<{ bundleId: string; pid?: number }> {
    const res = await fetch(helperUrl(this.baseUrl, this.udid, "foreground"));
    if (!res.ok) throw new Error(`foreground unavailable (${res.status})`);
    return (await res.json()) as { bundleId: string; pid?: number };
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** `Error` or not, node-swift's NSError included: the text a person should read. */
function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err) return String((err as { message: unknown }).message);
  return String(err);
}

/**
 * What `attach` answers when serve-sim's capture rejected for a device simctl
 * still calls Booted. The NSError text is kept verbatim — it is the one line
 * a bug report needs — followed by what to do about it.
 */
function captureFailureMessage(device: simctl.SimDevice, udid: string, failure: string): string {
  return (
    `simulator ${device.name} cannot be captured: ${failure} — ` +
    `xcrun simctl shutdown ${udid}, then boot it again`
  );
}

async function toDevice(d: simctl.SimDevice, sim: IosSimctl): Promise<Device> {
  const geometry = await sim.deviceGeometry(d.deviceTypeIdentifier);
  return {
    id: `ios:${d.udid}`,
    kind: "ios",
    name: `${d.name} (${d.runtime})`,
    state: d.state === "Booted" ? "booted" : d.state === "Booting" ? "connecting" : "shutdown",
    ...(geometry
      ? {
          // A device that is not attached has no live orientation; the
          // profile.plist geometry is the portrait one, so frameRotation is 0.
          // The real value arrives with the first `screen` event after attach.
          screen: {
            width: geometry.width,
            height: geometry.height,
            scale: geometry.scale,
            orientation: "portrait" as Orientation,
            frameRotation: 0 as const,
          },
        }
      : {}),
    capabilities: CAPS,
  };
}

export function udidOf(deviceId: string): string {
  const udid = deviceId.startsWith("ios:") ? deviceId.slice(4) : deviceId;
  if (!UDID_RE.test(udid)) throw new Error(`not an iOS device id: "${deviceId}"`);
  return udid;
}

/**
 * How the provider reaches its own mounted middleware. A wildcard bind is not
 * a usable destination, so those collapse to loopback.
 */
export function selfUrl(ctx: ProviderContext): string {
  const host = ctx.host;
  if (host === "0.0.0.0" || host === "" || host === "::" || host === "*") {
    return `http://127.0.0.1:${ctx.port}`;
  }
  return ctx.baseUrl;
}

/**
 * `scale` goes out with three decimals: a phone viewer sizes its stage as
 * `width / scale` points, and at two decimals a scaled 472x1024 picture would
 * come out half a point wide of the device's 402.
 */
function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
