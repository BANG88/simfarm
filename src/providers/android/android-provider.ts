/**
 * Android provider — scrcpy server protocol (ARCHITECTURE.md).
 *
 * Shape of the thing:
 *
 *   adb track-devices ──> device list ("android:<serial>")
 *   open(id) ──> AndroidHandle
 *                  startVideo ──> ScrcpySession ──> Annex-B H.264
 *                                   └─ h264.ts ──> avcC CONFIG + AVCC KEY/DELTA
 *                  input      ──> scrcpy control messages over the control socket
 *
 * Owned by the Android milestone. Shared files (protocol.ts, types.ts,
 * registry.ts, session.ts, server.ts, main.ts, web/) are frozen — nothing here
 * needed a change to them.
 *
 * Registration and lifecycle are already wired in src/main.ts:
 *   --providers android  ->  new AndroidProvider(), init(ctx), then list/watch/open
 */

import { logger } from "../../util/log.ts";
import {
  BUTTON_NAME_BY_ID,
  VIDEO_TAG,
  appearanceMode,
  type InputMessage,
} from "../../protocol.ts";
import {
  getprop,
  listDevices,
  shell,
  trackDevices,
  type AdbDevice,
  type DeviceTracker,
} from "./adb.ts";
import {
  ANDROID_BUTTONS,
  BUTTON_KEYCODE,
  keycodeForHidUsage,
} from "./android-keycodes.ts";
import {
  annexBToAvcc,
  avcCodecString,
  buildAvcC,
  NAL_TYPE,
  parameterSetsFromAnnexB,
} from "../../util/h264.ts";
import { ensureJar, loadRelease } from "./scrcpy-release.ts";
import {
  COPY_KEY,
  CONTROL_MSG,
  KEY_ACTION,
  MOTION_ACTION,
  POINTER_ID,
  encodeBackOrScreenOn,
  encodeEmpty,
  encodeGetClipboard,
  encodeInjectKeycode,
  encodeInjectScroll,
  encodeInjectText,
  encodeInjectTouch,
  encodeSetClipboard,
  encodeStartApp,
  type DeviceMessage,
  type Position,
} from "./scrcpy-control.ts";
import { ScrcpySession, type VideoSize } from "./scrcpy-session.ts";
import type {
  Capabilities,
  Codec,
  Device,
  DeviceHandle,
  DeviceState,
  FrameSink,
  HandleEvents,
  Orientation,
  Provider,
  ProviderContext,
  Screen,
} from "../../types.ts";

const log = logger("android");

/**
 * Largest dimension of the encoded video. Override with `--android-max-size`.
 *
 * This is a real trade-off with no right answer, so it is a knob rather than a
 * decision. The client draws at the device's *point* size and downsamples from
 * the frame (ARCHITECTURE.md), so sharpness wants as many pixels as the display
 * will put on the glass: a 1280x2856 panel at density 3 is 427x952 points,
 * which a 2x screen paints with ~854x1904 physical pixels.
 *
 * But the AVD encodes in software, and its throughput falls off with pixel
 * count. Measured back to back on `emulator-5554`, flicking a list, against the
 * app's own render rate from `dumpsys gfxinfo` in the same window:
 *
 *   max_size   stream      delivered   scrcpy gave us   the app rendered
 *   640        286x640      20.5 fps   227              318
 *   1024       458x1024     15.0 fps   167              322
 *   1440       644x1440     11.5 fps
 *   1920       860x1920      8.5 fps   <- sharp, too choppy to judge motion
 *
 * Two ceilings, not one. The app itself only produces a frame every 48-53ms
 * (~21 fps, 59% janky) at 1280x2856, so 640 is already at the source limit and
 * lowering it further buys nothing. Between there and 1920 the limit is this
 * encoder. Our own pipeline drops nothing at any setting — see `stats`.
 *
 * 1024 stays the default because a soft picture is still a usable one and 8 fps
 * is not. Someone judging static type rather than animation should pass
 * `--android-max-size 1920`, and someone judging motion `640`. A real handset
 * encodes in hardware and has a real GPU; neither ceiling exists there.
 *
 * Input stays normalized, so this is invisible to clients either way.
 */
const DEFAULT_MAX_SIZE = 1024;
const DEFAULT_MAX_FPS = 60;
const DEFAULT_BIT_RATE = 8_000_000;

/** ARCHITECTURE.md. No edge gestures (Android has none) and no a11y tree (that would
 *  need a separate uiautomator channel). */
const CAPS: Capabilities = {
  video: ["h264"],
  touch: true,
  multitouch: true,
  keyboard: true,
  text: true,
  scroll: true,
  buttons: [...ANDROID_BUTTONS],
  rotate: true,
  edgeGesture: false,
  clipboard: true,
  ax: false,
  deeplink: true,
  mediaDrop: false,
  // `adb shell cmd uimode night yes|no`, and it reads back
  appearance: true,
  // adb cannot start an AVD — that is `emulator -avd`, a launcher concern —
  // and a real phone cannot be booted at all. A device only appears in the
  // list once adb can already see it, so this is rarely the state anyway.
  boot: false,
};

/** In-band NALs that only make sense in an Annex-B stream. */
const DROP_IN_AVCC = new Set<number>([NAL_TYPE.AUD]);

interface DeviceMeta {
  /** the name a person gave the AVD; empty on a real phone */
  avd: string;
  model: string;
  release: string;
  /** physical display, before scrcpy's max_size downscale */
  width: number;
  height: number;
  density: number;
}

export interface AndroidProviderOptions {
  maxSize?: number;
  maxFps?: number;
  videoBitRate?: number;
  /** keep the screen on while a session is attached (restored on close) */
  stayAwake?: boolean;
}

export class AndroidProvider implements Provider {
  readonly kind = "android" as const;

  private readonly options: AndroidProviderOptions;
  private readonly meta = new Map<string, DeviceMeta>();
  private readonly listeners = new Set<(devices: Device[]) => void>();
  private devices: Device[] = [];
  private tracker: DeviceTracker | null = null;
  private jar: { path: string; version: string } | null = null;

  constructor(options: AndroidProviderOptions = {}) {
    this.options = options;
  }

  async init(_ctx: ProviderContext): Promise<void> {
    // Get the pinned jar in place *before* announcing any device: a device we
    // cannot actually open is worse than no device at all. On a fresh install
    // it is not there yet, so this fetches it once (see `ensureJar`).
    const release = loadRelease();
    const jarFile = await ensureJar(release, undefined, (m: string) => log.info(m));
    this.jar = { path: jarFile, version: release.version };
    log.info(`scrcpy-server ${release.version} verified (${jarFile})`);

    this.devices = await this.toDevices(await listDevices().catch(() => []));

    this.tracker = trackDevices(
      (adbDevices) => {
        void this.toDevices(adbDevices).then((devices) => {
          this.devices = devices;
          for (const cb of this.listeners) cb(devices);
        });
      },
      (err) => log.warn(`adb track-devices: ${String(err)}`),
    );
  }

  async list(): Promise<Device[]> {
    this.devices = await this.toDevices(await listDevices());
    return this.devices;
  }

  watch(cb: (devices: Device[]) => void): () => void {
    this.listeners.add(cb);
    // Hand over what we already know so a client that connects between two adb
    // events still sees the device list.
    queueMicrotask(() => {
      if (this.listeners.has(cb)) cb(this.devices);
    });
    return () => this.listeners.delete(cb);
  }

  async open(deviceId: string): Promise<DeviceHandle> {
    if (!this.jar) throw new Error("android provider is not initialized");
    const serial = serialOf(deviceId);
    const known = this.devices.find((d) => d.id === deviceId);
    if (!known) {
      const fresh = await this.toDevices(await listDevices());
      this.devices = fresh;
      if (!fresh.some((d) => d.id === deviceId)) {
        throw new Error(`no such android device: ${deviceId}`);
      }
    }
    const device = this.devices.find((d) => d.id === deviceId)!;
    if (device.state !== "booted") {
      throw new Error(`android device ${serial} is ${device.state}`);
    }

    return new AndroidHandle(
      cloneDevice(device),
      serial,
      this.jar,
      this.options,
      this.meta.get(serial),
    );
  }

  async control(op: string, args: unknown): Promise<unknown> {
    const deviceId = (args as { deviceId?: string })?.deviceId ?? "";
    const serial = serialOf(deviceId);
    switch (op) {
      case "boot":
        // adb cannot boot an AVD; `emulator -avd` is a launcher concern and a
        // real phone cannot be booted at all. Say so instead of pretending.
        throw new Error(
          `cannot boot ${serial} from adb — start the AVD with ` +
            `"~/Library/Android/sdk/emulator/emulator -avd <name>"`,
        );
      case "shutdown":
        await shell(serial, "reboot -p").catch(() => {});
        return { ok: true };
      default:
        throw new Error(`android provider does not support op "${op}"`);
    }
  }

  async dispose(): Promise<void> {
    this.tracker?.stop();
    this.tracker = null;
    this.listeners.clear();
  }

  // -------------------------------------------------------------------------

  private async toDevices(adbDevices: AdbDevice[]): Promise<Device[]> {
    const out: Device[] = [];
    for (const d of adbDevices) {
      const meta = d.state === "device" ? await this.metaFor(d.serial) : null;
      out.push({
        id: `android:${d.serial}`,
        kind: "android",
        name: meta ? deviceName(meta, d.serial) : d.serial,
        state: stateOf(d.state),
        screen: meta
          ? {
              width: meta.width,
              height: meta.height,
              scale: round2(meta.density / 160),
              orientation: meta.width > meta.height ? "landscape_left" : "portrait",
            }
          : undefined,
        capabilities: CAPS,
      });
    }
    return out;
  }

  /** Device properties change only across reboots, so one probe per serial. */
  private async metaFor(serial: string): Promise<DeviceMeta | null> {
    const cached = this.meta.get(serial);
    if (cached) return cached;
    try {
      const [model, release, avd, size, density] = await Promise.all([
        getprop(serial, "ro.product.model"),
        getprop(serial, "ro.build.version.release"),
        // Only emulators have this, and when they do it is the name a person
        // chose. `ro.product.model` on an AVD is `sdk_gphone16k_arm64`.
        getprop(serial, "ro.boot.qemu.avd_name").catch(() => ""),
        shell(serial, "wm size"),
        shell(serial, "wm density"),
      ]);
      const dims = /(\d+)x(\d+)/.exec(size);
      const dpi = /(\d+)/.exec(density);
      const meta: DeviceMeta = {
        avd: avd.trim(),
        model: model || serial,
        release: release || "?",
        width: dims ? Number(dims[1]) : 0,
        height: dims ? Number(dims[2]) : 0,
        density: dpi ? Number(dpi[1]) : 160,
      };
      this.meta.set(serial, meta);
      return meta;
    } catch (err) {
      log.warn(`could not probe ${serial}: ${String(err)}`);
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// one attached device
// ---------------------------------------------------------------------------

class AndroidHandle implements DeviceHandle {
  readonly device: Device;

  private readonly serial: string;
  private readonly jar: { path: string; version: string };
  private readonly options: AndroidProviderOptions;
  private readonly meta: DeviceMeta | undefined;

  /**
   * Frame accounting, so "Android is slower than the other two" can be settled
   * as source-versus-pipeline with a number rather than by reading the code.
   * There is no rate limit and no de-duplication on this path: whatever scrcpy
   * hands over is what goes out, and these counters are what proves it.
   */
  readonly stats = {
    /** video packets handed over by the scrcpy session */
    packetsIn: 0,
    /** dropped: arrived before the codec config, so undecodable by anyone */
    beforeConfig: 0,
    /** dropped: nothing left after stripping in-band-only NALs */
    emptyAfterStrip: 0,
    /** handed to the session */
    framesOut: 0,
    bytesIn: 0,
    bytesOut: 0,
    /** longest interval between two packets from scrcpy, ms */
    maxGapMs: 0,
  };
  private lastPacketAt = 0;

  private events: HandleEvents = {};
  private session: ScrcpySession | null = null;
  private sink: FrameSink | null = null;
  private avcC: Uint8Array | null = null;
  private sawConfig = false;
  private clipboardWaiters: Array<(text: string) => void> = [];
  private clipboardSeq = 1n;
  private savedRotation: { accelerometer: string; userRotation: string } | null =
    null;
  private closed = false;

  constructor(
    device: Device,
    serial: string,
    jar: { path: string; version: string },
    options: AndroidProviderOptions,
    meta: DeviceMeta | undefined,
  ) {
    this.device = device;
    this.serial = serial;
    this.jar = jar;
    this.options = options;
    this.meta = meta;
  }

  subscribe(events: HandleEvents): void {
    this.events = events;
  }

  async startVideo(codec: Codec, onFrame: FrameSink): Promise<() => void> {
    if (codec !== "h264") {
      throw new Error(`android provider only speaks h264, got ${codec}`);
    }
    if (this.session) throw new Error("video already started");

    this.sink = onFrame;
    const session = new ScrcpySession(
      {
        serial: this.serial,
        jarPath: this.jar.path,
        version: this.jar.version,
        maxSize: this.options.maxSize ?? DEFAULT_MAX_SIZE,
        maxFps: this.options.maxFps ?? DEFAULT_MAX_FPS,
        videoBitRate: this.options.videoBitRate ?? DEFAULT_BIT_RATE,
        stayAwake: this.options.stayAwake ?? true,
      },
      {
        onVideoPacket: (packet) => this.onPacket(packet),
        onVideoSize: (size) => this.onVideoSize(size),
        onDeviceMessage: (msg) => this.onDeviceMessage(msg),
        onLog: (level, text) => this.events.onLog?.(level, text),
        onClosed: (reason) => {
          if (this.closed) return;
          this.events.onClosed?.(`android: ${reason}`);
        },
      },
    );

    await session.start();
    this.session = session;
    // start() only resolves once the session packet has arrived, so the size is
    // authoritative by now; session.ts re-emits device.screen after attach.
    this.onVideoSize(session.videoSize);
    log.info(
      `${this.serial}: streaming ${session.videoSize.width}x${session.videoSize.height} h264`,
    );

    return () => {
      void this.close();
    };
  }

  async input(msg: InputMessage): Promise<void> {
    const session = this.session;
    if (!session) return;
    const size = session.videoSize;
    if (!size.width || !size.height) return;

    switch (msg.kind) {
      case "touch": {
        session.send(
          encodeInjectTouch({
            action: motionAction(msg.phase),
            pointerId: POINTER_ID.GENERIC_FINGER,
            position: position(msg.x, msg.y, size),
            pressure: msg.phase === 2 ? 0 : 1,
          }),
        );
        return;
      }
      case "multitouch": {
        const action = motionAction(msg.phase);
        const pressure = msg.phase === 2 ? 0 : 1;
        // Two independent pointers: the device side derives ACTION_POINTER_DOWN
        // / _UP and the pointer index from its own pointer table
        // (Controller.injectTouch), so we just send two plain events.
        session.send(
          encodeInjectTouch({
            action,
            pointerId: POINTER_ID.GENERIC_FINGER,
            position: position(msg.x1, msg.y1, size),
            pressure,
          }),
        );
        session.send(
          encodeInjectTouch({
            action,
            pointerId: POINTER_ID.VIRTUAL_FINGER,
            position: position(msg.x2, msg.y2, size),
            pressure,
          }),
        );
        return;
      }
      case "key": {
        const keycode = keycodeForHidUsage(msg.usage);
        if (keycode === undefined) {
          log.debug(`no android keycode for HID usage 0x${msg.usage.toString(16)}`);
          return;
        }
        session.send(
          encodeInjectKeycode(
            msg.phase === 0 ? KEY_ACTION.DOWN : KEY_ACTION.UP,
            keycode,
          ),
        );
        return;
      }
      case "button": {
        const name = BUTTON_NAME_BY_ID[msg.buttonId];
        const keycode = name ? BUTTON_KEYCODE[name] : undefined;
        if (keycode === undefined) {
          this.events.onError?.(`unsupported button id 0x${msg.buttonId.toString(16)}`);
          return;
        }
        const action = msg.phase === 0 ? KEY_ACTION.DOWN : KEY_ACTION.UP;
        // BACK_OR_SCREEN_ON also wakes a sleeping screen, which is what you
        // want from a remote panel; every other button is a plain keycode.
        session.send(
          name === "back"
            ? encodeBackOrScreenOn(action)
            : encodeInjectKeycode(action, keycode),
        );
        return;
      }
      case "scroll": {
        // Our dx/dy are fractions of the screen; scrcpy counts wheel notches.
        session.send(
          encodeInjectScroll({
            position: position(msg.anchorX, msg.anchorY, size),
            hscroll: clamp(msg.dx * 16, -16, 16),
            vscroll: clamp(msg.dy * 16, -16, 16),
          }),
        );
        return;
      }
      case "text": {
        session.send(encodeInjectText(msg.text));
        return;
      }
    }
  }

  async control(op: string, args: unknown): Promise<unknown> {
    switch (op) {
      case "rotate": {
        const orientation = (args as { orientation?: Orientation })?.orientation;
        if (!orientation) throw new Error("rotate needs an orientation");
        return { screen: await this.rotate(orientation) };
      }
      case "launch": {
        const target = String((args as { target?: string })?.target ?? "");
        if (!target) throw new Error("launch needs a target");
        return await this.launch(target);
      }

      /*
       * PROTOCOL §4 `appearance`. `cmd uimode night` is the same switch as
       * Settings > Display > Dark theme, so apps see a real configuration
       * change. Read back rather than trusting the exit status.
       */
      case "appearance": {
        const mode = appearanceMode(args);
        await shell(this.serial, `cmd uimode night ${mode === "dark" ? "yes" : "no"}`);
        const now = (await shell(this.serial, "cmd uimode night")).trim();
        return { mode: /yes/i.test(now) ? "dark" : "light", raw: now };
      }
      case "stats":
        return { ...this.stats, videoSize: this.session?.videoSize ?? null };
      case "getClipboard":
        return { text: await this.getClipboard() };
      case "setClipboard": {
        const text = String((args as { text?: string })?.text ?? "");
        const paste = Boolean((args as { paste?: boolean })?.paste);
        this.session?.send(encodeSetClipboard(this.clipboardSeq++, text, paste));
        return { ok: true };
      }
      case "expandNotifications":
        this.session?.send(encodeEmpty(CONTROL_MSG.EXPAND_NOTIFICATION_PANEL));
        return { ok: true };
      case "collapsePanels":
        this.session?.send(encodeEmpty(CONTROL_MSG.COLLAPSE_PANELS));
        return { ok: true };
      case "resetVideo":
        // Forces a fresh config + IDR; useful after a client reconnects.
        this.session?.send(encodeEmpty(CONTROL_MSG.RESET_VIDEO));
        return { ok: true };
      default:
        throw new Error(`android provider does not support op "${op}"`);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const session = this.session;
    this.session = null;
    this.sink = null;
    await this.restoreRotationSettings();
    await session?.close("detached");
  }

  // -------------------------------------------------------------------------

  private onPacket(packet: { config: boolean; key: boolean; data: Uint8Array }): void {
    const sink = this.sink;
    if (!sink) return;
    this.stats.packetsIn++;
    this.stats.bytesIn += packet.data.length;
    const now = Date.now();
    if (this.lastPacketAt > 0) {
      const gap = now - this.lastPacketAt;
      if (gap > this.stats.maxGapMs) this.stats.maxGapMs = gap;
    }
    this.lastPacketAt = now;

    if (packet.config) {
      // MediaCodec's csd-0: SPS+PPS in Annex-B. WebCodecs wants an avcC record.
      try {
        this.avcC = buildAvcC(parameterSetsFromAnnexB(packet.data));
      } catch (err) {
        this.events.onError?.(`h264 config: ${String(err)}`);
        return;
      }
      this.sawConfig = true;
      sink(VIDEO_TAG.CONFIG, this.avcC);
      this.events.onLog?.(
        "info",
        `h264 config ${avcCodecString(this.avcC)} (${this.avcC.length} B avcC)`,
      );
      return;
    }

    // Frames before CONFIG cannot be decoded by anyone; PROTOCOL.md §3 says so
    // for clients, and there is no point paying to ship them either.
    if (!this.sawConfig) {
      this.stats.beforeConfig++;
      return;
    }

    const avcc = annexBToAvcc(packet.data, DROP_IN_AVCC);
    if (avcc.length === 0) {
      // Every NAL in the packet was one we strip; nothing decodable is left.
      this.stats.emptyAfterStrip++;
      return;
    }
    this.stats.framesOut++;
    this.stats.bytesOut += avcc.length;
    sink(packet.key ? VIDEO_TAG.KEY : VIDEO_TAG.DELTA, avcc);
  }

  private onVideoSize(size: VideoSize): void {
    if (!size.width || !size.height) return;
    const physical = this.meta?.width && this.meta?.height
      ? Math.max(this.meta.width, this.meta.height)
      : 0;
    const encoded = Math.max(size.width, size.height);
    const scale =
      physical && encoded
        ? round2(((this.meta!.density || 160) / 160) * (encoded / physical))
        : 1;

    const screen: Screen = {
      width: size.width,
      height: size.height,
      scale: scale || 1,
      orientation:
        size.width > size.height
          ? currentLandscape(this.device.screen?.orientation)
          : "portrait",
    };
    // Mutate in place: session.ts emits `handle.device.screen` right after
    // startVideo() resolves, so this is what the client will be told.
    this.device.screen = screen;
    this.events.onScreen?.({ ...screen });
  }

  private onDeviceMessage(msg: DeviceMessage): void {
    if (msg.type !== "clipboard") return;
    const waiters = this.clipboardWaiters;
    this.clipboardWaiters = [];
    for (const resolve of waiters) resolve(msg.text);
  }

  private async getClipboard(): Promise<string> {
    const session = this.session;
    if (!session) throw new Error("not streaming");
    return await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.clipboardWaiters = this.clipboardWaiters.filter((w) => w !== once);
        reject(new Error("clipboard read timed out"));
      }, 3000);
      const once = (text: string): void => {
        clearTimeout(timer);
        resolve(text);
      };
      this.clipboardWaiters.push(once);
      session.send(encodeGetClipboard(COPY_KEY.NONE));
    });
  }

  /**
   * scrcpy's ROTATE_DEVICE only *toggles*, so setting a specific orientation
   * goes through the settings provider instead. Auto-rotate has to be off or
   * the sensor immediately overrides us; the previous values are restored when
   * the handle closes.
   *
   * Android only rotates the display if the foreground activity allows it —
   * the Pixel launcher famously does not. When the display refuses to turn we
   * put the setting back and fail the op rather than reporting an orientation
   * that does not match the pixels we are shipping.
   */
  private async rotate(orientation: Orientation): Promise<Screen> {
    const rotation = ROTATION[orientation];
    if (rotation === undefined) {
      throw new Error(`unknown orientation "${orientation}"`);
    }
    await this.rememberRotationSettings();
    await shell(this.serial, "settings put system accelerometer_rotation 0");
    await shell(this.serial, `settings put system user_rotation ${rotation}`);

    const wantPortrait =
      orientation === "portrait" || orientation === "portrait_upside_down";
    // Generous: the settings write has to reach WindowManager, scrcpy debounces
    // display resizes by 300 ms (DisplayResizeDebouncer), and only then does it
    // restart the encoder and emit a new session packet. Three seconds was not
    // always enough on a busy emulator.
    const rotated = await this.waitForVideoSize(
      (size) => (size.height > size.width) === wantPortrait,
      8000,
    );
    if (!rotated) {
      const previous = this.savedRotation?.userRotation;
      if (previous !== undefined && previous !== "") {
        await shell(
          this.serial,
          `settings put system user_rotation ${previous}`,
        ).catch(() => {});
      }
      throw new Error(
        `the display stayed ${wantPortrait ? "landscape" : "portrait"} — the ` +
          `foreground app does not allow ${orientation} (Android's launcher ` +
          `is locked to portrait)`,
      );
    }

    const screen = this.device.screen;
    if (screen) screen.orientation = orientation;
    return screen ?? { width: 0, height: 0, scale: 1, orientation };
  }

  private async rememberRotationSettings(): Promise<void> {
    if (this.savedRotation) return;
    const [accelerometer, userRotation] = await Promise.all([
      shell(this.serial, "settings get system accelerometer_rotation").catch(
        () => "",
      ),
      shell(this.serial, "settings get system user_rotation").catch(() => ""),
    ]);
    this.savedRotation = {
      accelerometer: numericOrEmpty(accelerometer),
      userRotation: numericOrEmpty(userRotation),
    };
  }

  private async restoreRotationSettings(): Promise<void> {
    const saved = this.savedRotation;
    this.savedRotation = null;
    if (!saved) return;
    for (const [key, value] of [
      ["user_rotation", saved.userRotation],
      ["accelerometer_rotation", saved.accelerometer],
    ] as const) {
      if (value === "") continue;
      await shell(this.serial, `settings put system ${key} ${value}`).catch(
        () => {},
      );
    }
  }

  private waitForVideoSize(
    predicate: (size: VideoSize) => boolean,
    timeoutMs: number,
  ): Promise<boolean> {
    const session = this.session;
    if (!session) return Promise.resolve(false);
    if (predicate(session.videoSize)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (predicate(session.videoSize)) {
          clearInterval(timer);
          resolve(true);
        } else if (Date.now() - started > timeoutMs) {
          clearInterval(timer);
          resolve(false);
        }
      }, 50);
      timer.unref?.();
    });
  }

  /**
   * `launch` takes a package name, a component, or a URL. Package names go
   * through scrcpy's START_APP (no shell round trip); anything with a scheme is
   * an implicit VIEW intent, i.e. a deeplink.
   */
  private async launch(target: string): Promise<unknown> {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target) || target.includes("://")) {
      const out = await shell(
        this.serial,
        `am start -a android.intent.action.VIEW -d ${JSON.stringify(target)}`,
      );
      return { result: out };
    }
    this.session?.send(encodeStartApp(target));
    return { result: `start-app ${target}` };
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const ROTATION: Readonly<Record<string, number>> = {
  portrait: 0,
  landscape_left: 1,
  portrait_upside_down: 2,
  landscape_right: 3,
};

function currentLandscape(previous: Orientation | undefined): Orientation {
  return previous === "landscape_right" ? "landscape_right" : "landscape_left";
}

function motionAction(phase: number): number {
  return phase === 0
    ? MOTION_ACTION.DOWN
    : phase === 1
      ? MOTION_ACTION.MOVE
      : MOTION_ACTION.UP;
}

/**
 * Normalized [0,1] -> pixels of the *encoded* frame.
 *
 * The device rejects a positional event whose `screenWidth/Height` do not match
 * the video size it is currently producing (PositionMapper.map), which is how
 * scrcpy avoids acting on clicks aimed at a pre-rotation frame — so the size
 * travels with every event rather than being configured once.
 */
function position(x: number, y: number, size: VideoSize): Position {
  return {
    x: Math.min(size.width - 1, Math.max(0, Math.round(clamp01(x) * (size.width - 1)))),
    y: Math.min(size.height - 1, Math.max(0, Math.round(clamp01(y) * (size.height - 1)))),
    screenWidth: size.width,
    screenHeight: size.height,
  };
}

function clamp01(v: number): number {
  return Number.isNaN(v) ? 0 : v < 0 ? 0 : v > 1 ? 1 : v;
}

function clamp(v: number, lo: number, hi: number): number {
  return Number.isNaN(v) ? 0 : v < lo ? lo : v > hi ? hi : v;
}

/** `settings get` prints "null" when a key is unset; that is not restorable. */
function numericOrEmpty(value: string): string {
  return /^\d+$/.test(value.trim()) ? value.trim() : "";
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function serialOf(deviceId: string): string {
  const serial = deviceId.startsWith("android:") ? deviceId.slice(8) : "";
  if (!serial) throw new Error(`not an android device id: "${deviceId}"`);
  return serial;
}

function stateOf(adbState: string): DeviceState {
  switch (adbState) {
    case "device":
      return "booted";
    case "offline":
    case "unauthorized":
      return "error";
    case "connecting":
    case "authorizing":
      return "connecting";
    default:
      return "shutdown";
  }
}

function cloneDevice(d: Device): Device {
  return { ...d, screen: d.screen ? { ...d.screen } : undefined };
}

/**
 * What to call this device in a picker.
 *
 * `sdk_gphone16k_arm64 (Android 17) — emulator-5554` was accurate and unusable:
 * three technical strings where iOS manages `iPhone 17 Pro (iOS 26.5)`. The AVD
 * name is the one a person chose themselves, so it wins; a real phone has a
 * model name worth showing. The serial is still in the device id, which is what
 * the client hangs its tooltip on — it belongs in a tooltip, not in a pill.
 */
export function deviceName(
  meta: { avd?: string; model: string; release: string },
  serial: string,
): string {
  const human = meta.avd ? meta.avd.replace(/[_-]+/g, " ").trim() : meta.model;
  return `${human || serial} (Android ${meta.release})`;
}
