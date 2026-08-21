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
 *   GET  {base}/_ios/helper/<udid>/stream.mjpeg  -> VIDEO frames (jpeg)
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
import { MjpegParser } from "./mjpeg.ts";
import { displayedScreen, frameRotationFor } from "./rotation.ts";
import { loadServeSim, type SimMiddleware } from "./serve-sim.ts";
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

export class IosProvider implements Provider {
  readonly kind = "ios" as const;

  private mw: SimMiddleware | null = null;
  private baseUrl = "";
  private readonly bridge = new HidBridge();
  private readonly watchers = new Set<(devices: Device[]) => void>();
  private pollTimer: NodeJS.Timeout | null = null;
  private lastFingerprint = "";
  private disposed = false;

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
    const devices = await simctl.listDevices();
    log.info(
      `serve-sim mounted at ${IOS_BASE}; ${devices.length} iOS simulators (${devices.filter((d) => d.state === "Booted").length} booted)`,
    );

    this.pollTimer = setInterval(() => void this.poll(), DEVICE_POLL_MS);
    this.pollTimer.unref?.();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.watchers.clear();
    await this.bridge.stop();
  }

  // -------------------------------------------------------------------------
  // device list
  // -------------------------------------------------------------------------

  async list(): Promise<Device[]> {
    const devices = await simctl.listDevices();
    return Promise.all(devices.map((d) => toDevice(d)));
  }

  watch(cb: (devices: Device[]) => void): () => void {
    this.watchers.add(cb);
    void this.poll(true);
    return () => this.watchers.delete(cb);
  }

  private async poll(force = false): Promise<void> {
    if (this.disposed || this.watchers.size === 0) return;
    try {
      const devices = await this.list();
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

  // -------------------------------------------------------------------------
  // open / control
  // -------------------------------------------------------------------------

  async open(deviceId: string): Promise<DeviceHandle> {
    const udid = udidOf(deviceId);
    const device = (await simctl.listDevices()).find((d) => d.udid === udid);
    if (!device) throw new Error(`no such iOS simulator: ${udid}`);
    if (device.state !== "Booted") {
      throw new Error(
        `simulator ${device.name} is ${device.state}; send {"op":"boot","deviceId":"${deviceId}"} first`,
      );
    }

    // Touching /config is what creates serve-sim's capture session. Its
    // framebuffer size is only known once the first frame lands, so wait for it
    // — that also guarantees the avcc stream will carry a SEED jpeg, which is
    // the difference between "picture appears instantly" and "black until the
    // first IDR" (PROTOCOL §3).
    const config = await this.waitForScreen(udid);
    const hid = await this.bridge.connect(udid);

    const geometry = await simctl.deviceGeometry(device.deviceTypeIdentifier);
    // Attaching to an already-rotated simulator has to report the rotation too,
    // not just a later rotate op — so this goes through the same helper.
    const screen = displayedScreen(config, geometry?.scale ?? 1);

    log.info(
      `opened ${device.name} (${udid}) ${screen.width}x${screen.height} ${screen.orientation} (frame ${config.width}x${config.height}, rotate ${screen.frameRotation}deg)`,
    );

    return new IosHandle(
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
    );
  }

  /** Provider-level ops: boot / shutdown need no open handle. */
  async control(op: string, args: unknown): Promise<unknown> {
    const deviceId = (args as { deviceId?: string })?.deviceId ?? "";
    const udid = udidOf(deviceId);
    switch (op) {
      case "boot":
        // The grid route boots via simctl *and* registers the device with
        // serve-sim's own state, which is what its `/api` surface expects.
        return await this.gridPost("start", udid);
      case "shutdown":
        return await this.gridPost("shutdown", udid);
      default:
        throw new Error(`iOS provider does not support op "${op}"`);
    }
  }

  private async gridPost(action: string, udid: string): Promise<unknown> {
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
    this.lastFingerprint = "";
    void this.poll(true);
    return { ok: true };
  }

  private async waitForScreen(udid: string): Promise<SimScreenConfig> {
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

  constructor(
    device: Device,
    udid: string,
    baseUrl: string,
    hid: HidSocket,
    fb: SimScreenConfig,
  ) {
    this.device = device;
    this.udid = udid;
    this.baseUrl = baseUrl;
    this.hid = hid;
    this.fb = fb;
  }

  subscribe(events: HandleEvents): void {
    this.events = events;
    // serve-sim pushes a screen config on the HID socket at attach time and
    // whenever the framebuffer changes shape (rotation, or the guest resizing
    // it). That is the authoritative source once a session is live.
    this.hid.subscribe({
      onConfig: (config) => this.applyScreen(config),
      onClose: () => {
        if (!this.closed) this.events.onError?.("HID socket closed");
      },
    });
    this.startForegroundPoll();
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

    void this.pump(codec, res.body, onFrame, abort);

    return () => {
      if (this.abort === abort) this.abort = null;
      abort.abort();
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
    const reader = body.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done || abort.signal.aborted) break;
        if (!value) continue;
        if (codec === "h264") {
          for (const frame of avcc.push(value)) onFrame(frame.tag, frame.data);
        } else {
          for (const jpeg of mjpeg.push(value)) {
            // The very first jpeg is delivered as SEED so a fresh client has a
            // picture immediately; the rest are ordinary complete frames.
            onFrame(firstJpeg ? VIDEO_TAG.SEED : VIDEO_TAG.KEY, jpeg);
            firstJpeg = false;
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

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.abort?.abort();
    this.abort = null;
    if (this.foregroundTimer) clearInterval(this.foregroundTimer);
    this.foregroundTimer = null;
    this.hid.close();
    this.events.onClosed?.("closed");
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
    this.fb = config;
    // On iOS width/height do *not* move when the guest rotates — only
    // `orientation` does — so this is usually an orientation-only change that
    // nevertheless flips the reported dimensions and `frameRotation`.
    const screen = displayedScreen(config, this.device.screen?.scale ?? 1);
    this.device.screen = screen;
    this.events.onScreen?.({ ...screen });
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

async function toDevice(d: simctl.SimDevice): Promise<Device> {
  const geometry = await simctl.deviceGeometry(d.deviceTypeIdentifier);
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
