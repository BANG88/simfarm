/**
 * WeChat provider — CDP for the data plane, the official CLI for the control
 * plane (ARCHITECTURE.md).
 *
 * What it attaches to
 * -------------------
 * The mini program's render layer is a `type: "webview"` target whose URL
 * contains `__pageframe__`. Its DOM is ordinary mini program DOM (`WX-VIEW`,
 * `WX-SWIPER`, …) — not a self-drawn canvas — and `Page.startScreencast` on it
 * yields the mini program picture with none of the IDE around it.
 *
 * The awkward part: **one page frame per mini program page.** Navigating pushes
 * a new target and leaves the old one alive, and nothing in the target list says
 * which of them is on screen. `document.visibilityState` is "visible" in every
 * one of them, and "whoever painted most recently" is worse than useless here
 * (see `PageFrameSet`). The answer is the logic layer's own page stack.
 *
 * Frame rate is not what the CDP documentation would lead you to expect. A
 * screencast is event-driven only while Chromium lets the renderer idle, and
 * this tool has to run with `--disable-renderer-backgrounding` or it stops
 * compositing new pages altogether (wechat-cli.ts). With that flag it produces
 * 60 full-size JPEGs a second whether or not anything moved.
 *
 * So a frame goes through three gates on its way out, and `stats` counts each
 * one — the accounting exists because "the client is getting fewer frames than
 * CDP produced" has four plausible causes that look identical from outside:
 *
 *   off-screen   it belongs to a page frame that is not the one on screen
 *                (we cast all of them, so ~2/3 of arrivals are these)
 *   duplicate    byte-identical to the frame already sent — a still page
 *                otherwise costs 29 Mbit/s to say nothing
 *   rate limit   arrived sooner than `maxFps` allows
 *
 * Everything that survives reaches the client, and a 5 fps idle resend plus a
 * SEED on attach keep a client that connects to a still screen from sitting
 * black (PROTOCOL §3).
 *
 * On smoothness
 * -------------
 * The rate limit only applies to jpeg. It exists because whole JPEGs cost ~85 KB
 * each; H.264 of the same picture costs a twentieth of that, so thinning it buys
 * nothing and spends the one thing a remote screen cannot afford to lose.
 *
 * The other thing that costs smoothness is us. Every HTTP poll of `/json/list`
 * and every `Runtime.evaluate` competes with screencast delivery inside the same
 * devtools process, and this used to schedule four of them *per input message* —
 * sixty-odd a second during a drag. Backing that off moved frame arrivals from
 * p99 300ms to p99 50ms. The route is now re-checked on target events, once per
 * burst of input, when an off-screen page starts painting, and on a slow
 * backstop poll — in that order of preference.
 */

import {
  BUTTON_ID,
  KEY_PHASE,
  VIDEO_TAG,
  type InputMessage,
} from "../../protocol.ts";
import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";

import { jpegSize } from "../../util/jpeg-size.ts";
import { logger } from "../../util/log.ts";
import { CdpConnection, browserWsUrl, fetchTargets, probe } from "./cdp.ts";
import {
  DEFAULT_ENCODER,
  H264Encoder,
  percentiles,
  probeEncoder,
  quantile,
  record,
  type EncoderOptions,
} from "./h264-encoder.ts";
import { inputToCdp, type Viewport } from "./wechat-input.ts";
import { WechatShell } from "./wechat-shell.ts";
import * as cli from "./wechat-cli.ts";
import {
  appServiceForProject,
  appidOf,
  deviceIdFor,
  findProjects,
  pageFramesByProject,
  type CdpTarget,
  type PageFrame,
  type WechatProject,
} from "./wechat-targets.ts";
import type {
  Capabilities,
  Codec,
  Device,
  DeviceHandle,
  FrameSink,
  HandleEvents,
  Provider,
  ProviderContext,
  Screen,
} from "../../types.ts";

const log = logger("wechat");

const DEFAULT_DEBUG_PORT = 9222;
const DEVICE_POLL_MS = 3000;
/** How long to wait for the first screencast frame when opening a device. */
const FIRST_FRAME_MS = 8000;
/**
 * Idle resend, matching serve-sim's iOS capture. It is not only for clients that
 * connect to a still screen — the session drops video under backpressure
 * (PROTOCOL §3), and without a resend a dropped lone frame leaves the client
 * black until the user happens to touch something.
 */
const IDLE_RESEND_MS = 200;
/**
 * When to re-ask the logic layer where it is, after input. A tap has to reach
 * the page, the framework has to navigate, and the render target has to be
 * created — spread the checks out rather than picking one delay and hoping.
 */
const RESOLVE_AFTER_INPUT_MS = [120, 400, 900, 1800];
/**
 * How long an encoder may accept frames without producing any before we say so.
 * Generously past the ~1.6s it normally takes to the first frame.
 */
const ENCODER_WATCHDOG_MS = 5000;
/**
 * How quiet the on-screen page has to be before another page painting counts as
 * a hint that the route moved. Comfortably longer than a frame interval so an
 * ordinary transition does not trigger it.
 */
const ROUTE_RECHECK_QUIET_MS = 400;
/** Gaps at least this long get a line saying what happened during them. */
const STALL_LOG_MS = 150;

const DEFAULT_JPEG_QUALITY = 70;

/**
 * Frames per second we are willing to send **on the jpeg path**.
 *
 * H.264 has its own, uncapped, setting (`h264MaxFps`): whole JPEGs cost ~85 KB
 * each and have to be thinned, while the same rate of H.264 costs a twentieth
 * of that, so thinning it only spends smoothness.
 *
 * A 752x1618 JPEG is ~74-89 KB, so uncapped 60 fps is 35-43 Mbit/s of whole
 * images with no interframe compression at all. The client is a *remote*
 * machine reached over Tailscale across the public internet — 61 Mbit/s, 73 ms
 * RTT, and no local-network shortcut available — which sounds like plenty and
 * is not: at ~6 MB/s offered against ~7.6 MB/s of link there is no headroom for
 * a stall, the socket queue passes the session's 4 MiB limit, and video is then
 * dropped arbitrarily (PROTOCOL §3). Observed on an uncapped build: 60 frames a
 * second dropped, 9 delivered.
 *
 * So the frames are thinned here, evenly, instead of being discarded in bursts
 * at the socket. 20 fps is ~1.8 MB/s = 14 Mbit/s, which leaves the link about
 * four times the room it needs; 30 fits too but leaves little slack for a
 * hiccup. `--wechat-max-fps 0` removes the cap for a client on this machine or
 * a genuinely local one.
 */
const DEFAULT_MAX_FPS = 20;
/** Slack on the rate cap; see where it is used. */
const FRAME_GAP_TOLERANCE_MS = 8;

/**
 * ARCHITECTURE.md. `rotate` is false: the IDE can rotate its simulator but exposes no
 * command for it, and CDP cannot reach that control. `edgeGesture` is false —
 * the WeChat simulator has no system gestures to trigger. `deeplink` is true
 * because a mini program page path can be opened through the logic layer.
 * `text` is true and, unlike the iOS backend, it is real text injection
 * (`Input.insertText`), so Chinese input works.
 *
 * `buttons: ["back", "home"]` are not hardware keys. The simulator's back arrow
 * lives in the IDE's own navigation bar, which is deliberately *outside* the
 * picture we capture — so without them a client that navigated into a
 * second-level page would have no way out at all. They are `wx.navigateBack()`
 * and a `reLaunch` to the app's declared entry page, which is what those
 * controls do anyway.
 */
const CAPS: Capabilities = {
  // Replaced at init() with ["h264", "jpeg"] when an ffmpeg with
  // h264_videotoolbox is on the box. Declaring h264 we cannot produce would
  // make every attach fail, since PROTOCOL §4 has the server prefer it.
  video: ["jpeg"],
  touch: true,
  multitouch: true,
  keyboard: true,
  text: true,
  scroll: true,
  buttons: ["back", "home"],
  rotate: false,
  edgeGesture: false,
  clipboard: false,
  ax: false,
  deeplink: true,
  mediaDrop: false,
  /*
   * False, and measured twice over.
   *
   * There is no reachable appearance control: nothing in the IDE window's DOM
   * mentions a theme for the simulator (only the editor's own), and the
   * automation protocol's `Native.*` methods answer "unimplemented" on this
   * build. And even a working switch would be inert against this project —
   * its `app.json` declares no `darkmode`, so `wx.getSystemInfoSync().theme`
   * comes back undefined and the mini program is never told.
   */
  appearance: false,
  /*
   * True, though it means something slightly different here: "boot" makes sure
   * the devtools is running with the flags it needs and reopens the project so
   * the simulator renders again. That is the nearest thing this backend has to
   * powering a phone on, and it is the action a person would otherwise have to
   * go and do in the IDE by hand.
   */
  boot: true,
};

export interface WechatProviderOptions {
  /** where the tool's CDP endpoint lives; ARCHITECTURE.md uses 9222 */
  debugPort?: number;
  /** 0 disables the cap; see DEFAULT_MAX_FPS */
  maxFps?: number;
  /** JPEG quality passed to startScreencast, 1-100 */
  quality?: number;
  /** where to find ffmpeg; it must have h264_videotoolbox compiled in */
  ffmpegPath?: string;
  /** frame cap once h264 is in use; 0 removes it. Defaults to uncapped. */
  h264MaxFps?: number;
  /** false disables H.264 even when ffmpeg is available */
  h264?: boolean;
}

export class WechatProvider implements Provider {
  readonly kind = "wechat" as const;

  private readonly endpoint: string;
  private readonly debugPort: number;
  private readonly maxFps: number;
  private readonly quality: number;
  private readonly ffmpegPath: string;
  private readonly h264MaxFps: number;
  private readonly h264Wanted: boolean;
  private caps: Capabilities = CAPS;
  private readonly watchers = new Set<(devices: Device[]) => void>();
  /** project path -> mini program nickname; one CDP round trip, then cached */
  private readonly nicknames = new Map<string, string>();
  /**
   * project path -> the appid the *running mini program* reports.
   *
   * The IDE page URL carries `appid=` only sometimes: open the project from the
   * CLI and it is simply absent, at which point `parseProject` falls back to
   * hashing the path and the device id silently changes from
   * `wechat:wxa1b2c3…` to `wechat:path-98778109`. A client that remembered the
   * old id then cannot find the device any more (ARCHITECTURE.md restores the
   * last device from localStorage). `__wxConfig.accountInfo.appId` inside a
   * page frame is the same value and is always there, so it wins.
   */
  private readonly appids = new Map<string, string>();
  private pollTimer: NodeJS.Timeout | null = null;
  private lastFingerprint = "";
  private warnedUnreachable = false;
  private disposed = false;

  constructor(opts: WechatProviderOptions = {}) {
    this.debugPort = opts.debugPort ?? DEFAULT_DEBUG_PORT;
    this.endpoint = `http://127.0.0.1:${this.debugPort}`;
    this.maxFps = opts.maxFps ?? DEFAULT_MAX_FPS;
    this.quality = opts.quality ?? DEFAULT_JPEG_QUALITY;
    this.ffmpegPath = opts.ffmpegPath ?? DEFAULT_ENCODER.ffmpegPath;
    this.h264MaxFps = opts.h264MaxFps ?? DEFAULT_ENCODER.h264MaxFps;
    this.h264Wanted = opts.h264 ?? true;
  }

  // -------------------------------------------------------------------------
  // lifecycle
  // -------------------------------------------------------------------------

  async init(_ctx: ProviderContext): Promise<void> {
    if (await probe(this.endpoint)) {
      const projects = findProjects(await fetchTargets(this.endpoint));
      log.info(
        `devtools debuggable on ${this.endpoint}; ${projects.length} project(s) open`,
      );
    } else {
      // Not fatal, and deliberately not an auto-launch: starting a GUI app
      // because someone asked for a device list is too much initiative. `boot`
      // launches it on request.
      log.info(
        `devtools not debuggable on ${this.endpoint} — no WeChat devices until it is. Start it with: ${cli.launchHint(this.debugPort)}`,
      );
    }
    if (this.h264Wanted && (await probeEncoder(this.ffmpegPath))) {
      // Ordered by preference: the session picks h264 when the client does not
      // ask for a codec (PROTOCOL §4), which is what our own client does.
      this.caps = { ...CAPS, video: ["h264", "jpeg"] };
      log.info(`h264 available via ${this.ffmpegPath} (h264_videotoolbox)`);
    } else {
      log.info(
        this.h264Wanted
          ? `no ffmpeg with h264_videotoolbox at "${this.ffmpegPath}" — jpeg only, which costs ~10x the bandwidth. brew install ffmpeg`
          : "h264 disabled by --wechat-no-h264 — jpeg only",
      );
    }

    this.pollTimer = setInterval(() => void this.poll(), DEVICE_POLL_MS);
    this.pollTimer.unref?.();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.watchers.clear();
  }

  // -------------------------------------------------------------------------
  // device list
  // -------------------------------------------------------------------------

  async list(): Promise<Device[]> {
    let targets: CdpTarget[];
    try {
      targets = await fetchTargets(this.endpoint);
      this.warnedUnreachable = false;
    } catch (err) {
      if (!this.warnedUnreachable) {
        this.warnedUnreachable = true;
        log.debug(`devtools unreachable: ${String(err)}`);
      }
      return [];
    }

    const projects = findProjects(targets);
    const frames = pageFramesByProject(targets);
    const devices: Device[] = [];
    for (const project of projects) {
      const mine = frames.get(project.appid) ?? [];
      await this.learnIdentity(project, mine);
      devices.push({
        id: deviceIdFor(this.identify(project)),
        kind: "wechat",
        name: this.displayName(project),
        // "The tool is open but nothing has rendered" is a real, normal state:
        // page frames only exist once the mini program has painted. Reporting it
        // as shutdown (rather than hiding the project) lets a client boot it.
        state: mine.length > 0 ? "booted" : "shutdown",
        capabilities: this.caps,
      });
    }
    return devices;
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

  /** The project with its identity resolved to the running app's own appid. */
  private identify(project: WechatProject): WechatProject {
    const known = this.appids.get(project.projectPath);
    return known ? { ...project, appid: known } : project;
  }

  private displayName(project: WechatProject): string {
    const nickname = this.nicknames.get(project.projectPath);
    return `${nickname || project.projectName} (WeChat)`;
  }

  /**
   * The IDE's `projectname` is whatever directory the project sits in — "mini"
   * for a build output directory, which tells a human nothing. The mini
   * program's own nickname is in `__wxConfig` in any rendered page frame, so
   * read it once and keep it.
   */
  /**
   * Read the name and the appid the running mini program reports, once.
   *
   * Both come from `__wxConfig.accountInfo` in any rendered page frame, and
   * both are better than what the IDE page URL offers: the URL's `projectname`
   * is whatever directory the project sits in ("mini", for a build output), and
   * its `appid` is sometimes missing entirely.
   */
  private async learnIdentity(
    project: WechatProject,
    frames: PageFrame[],
  ): Promise<void> {
    if (frames.length === 0) return;
    if (this.nicknames.has(project.projectPath) && this.appids.has(project.projectPath)) {
      return;
    }
    let conn: CdpConnection | null = null;
    try {
      conn = await CdpConnection.open(frames[0]!.wsUrl);
      const res = await conn.send(
        "Runtime.evaluate",
        {
          expression: `JSON.stringify((typeof __wxConfig !== 'undefined' && __wxConfig.accountInfo) || {})`,
          returnByValue: true,
        },
        3000,
      );
      const raw = (res.result as { value?: unknown } | undefined)?.value;
      if (typeof raw !== "string") return;
      const info = JSON.parse(raw) as { nickname?: string; appId?: string };
      if (info.nickname) this.nicknames.set(project.projectPath, info.nickname);
      if (info.appId) this.appids.set(project.projectPath, info.appId);
    } catch {
      // Falls back to the project name and the URL-derived id; not worth a log
      // line on every poll.
    } finally {
      conn?.close();
    }
  }

  // -------------------------------------------------------------------------
  // open / control
  // -------------------------------------------------------------------------

  async open(deviceId: string): Promise<DeviceHandle> {
    const appid = appidOf(deviceId);
    if (!(await probe(this.endpoint))) {
      throw new Error(
        `WeChat devtools is not debuggable on ${this.endpoint}. Start it with: ${cli.launchHint(this.debugPort)}`,
      );
    }
    const targets = await fetchTargets(this.endpoint);
    // Match on either identity: a client may be holding an id from before the
    // project was reopened without an `appid` in its URL, or after.
    const project = findProjects(targets).find(
      (p) => p.appid === appid || this.appids.get(p.projectPath) === appid,
    );
    if (!project) throw new Error(`no WeChat project open with appid ${appid}`);

    const frames = pageFramesByProject(targets).get(project.appid) ?? [];
    if (frames.length === 0) {
      throw new Error(
        `${project.projectName} has no rendered page yet — the mini program must be running in the simulator before it can be streamed (send {"op":"boot","deviceId":"${deviceId}"} to reopen the project)`,
      );
    }

    /*
     * Two different appids are in play and mixing them up costs a whole attach.
     * `project.appid` is whatever the IDE page URL says, and is what every
     * target-grouping lookup keys on. The device id may instead carry the appid
     * the running app reports, which is the stable one but matches no target.
     * Anything that resolves targets gets the former; only the device id gets
     * the latter.
     */
    const set = new PageFrameSet(this.endpoint, project.appid, {
      maxFps: this.maxFps,
      quality: this.quality,
    });
    try {
      const screen = await set.start(frames);
      log.info(
        `opened ${project.projectName} (${appid}) ${screen.width}x${screen.height} @${screen.scale}x, ${frames.length} page frame(s), showing ${set.route}`,
      );
      return new WechatHandle(
        {
          id: deviceId,
          kind: "wechat",
          name: this.displayName(project),
          state: "booted",
          screen,
          capabilities: this.caps,
        },
        set,
        project,
        {
          ...DEFAULT_ENCODER,
          ffmpegPath: this.ffmpegPath,
          // Encode at the rate we actually intend to send. Telling the encoder
          // 30 while feeding it 20 makes it space keyframes by the wrong clock.
          fps: this.h264MaxFps > 0 ? this.h264MaxFps : 60,
          h264MaxFps: this.h264MaxFps,
          width: screen.width,
          height: screen.height,
        },
      );
    } catch (err) {
      set.close();
      throw err;
    }
  }

  /** Provider-level ops: these need no open handle. */
  async control(op: string, args: unknown): Promise<unknown> {
    const deviceId = (args as { deviceId?: string })?.deviceId ?? "";
    const appid = appidOf(deviceId);
    const project = await this.findProject(appid);

    switch (op) {
      case "boot": {
        // "boot" for this backend means: make sure the tool is up with the
        // flags it needs, then (re)open the project so the simulator renders.
        await cli.launchTool(this.debugPort);
        if (!project) {
          throw new Error(
            `no open project with appid ${appid} to reopen; open it in the IDE once so simfarm can learn its path`,
          );
        }
        await cli.openProject(project.projectPath);
        this.lastFingerprint = "";
        void this.poll(true);
        return { ok: true };
      }
      case "shutdown": {
        if (!project) throw new Error(`no open project with appid ${appid}`);
        await cli.closeProject(project.projectPath);
        this.lastFingerprint = "";
        void this.poll(true);
        return { ok: true };
      }
      default:
        throw new Error(`WeChat provider does not support op "${op}"`);
    }
  }

  private async findProject(appid: string): Promise<WechatProject | null> {
    try {
      return findProjects(await fetchTargets(this.endpoint)).find(
        (p) => p.appid === appid || this.appids.get(p.projectPath) === appid,
      ) ?? null;
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// the set of page frames that make up one running mini program
// ---------------------------------------------------------------------------

interface FrameEntry {
  targetId: string;
  /** kept so a retired page frame can be reconnected if it comes back */
  wsUrl: string;
  route: string;
  /** null while retired — only the page on screen holds a socket open */
  conn: CdpConnection | null;
  viewport: Viewport;
  /** whether a screencast is running; all of them cast, see `setCurrent` */
  casting: boolean;
  /** most recent frame this page painted, on screen or not */
  lastFrame: Uint8Array | null;
  /** when that frame arrived; used to tell a quiet page from a busy one */
  lastAt: number;
  /** insertion order, so the newest instance of a repeated route wins */
  seq: number;
}

/**
 * Every page frame of one mini program, and the rule for deciding which one the
 * user is looking at.
 *
 * **The rule is the logic layer's page stack**, read from `getCurrentPages()` in
 * the appservice target. Only that page gets a screencast; the rest are
 * connected but silent.
 *
 * Getting here took two wrong answers, both worth recording because both looked
 * right:
 *
 *   - `document.visibilityState` is `"visible"` in *every* page frame, on screen
 *     or not. It is simply not wired up for these guests.
 *   - "whoever painted most recently is on screen" survives casual testing and
 *     then fails on a real app. The tool has to run with
 *     `--disable-renderer-backgrounding` for page transitions to work at all
 *     (wechat-cli.ts), and one thing that buys is that a page which is no longer
 *     on screen still finishes whatever it was animating. This project's home
 *     page carries an auto-playing swiper: it out-paints the page you just
 *     navigated to, wins on recency, then goes quiet — leaving the stream stuck
 *     on it permanently, with every subsequent touch delivered to the wrong
 *     frame. Measured, not theorised: taps into the visible frame worked every
 *     time, taps into the stale one did nothing at all and looked identical.
 *
 * The page stack has neither problem: it is the app's own idea of where it is,
 * it changes exactly when the user navigates, and it was correct in every state
 * tested.
 */
export class PageFrameSet {
  readonly endpoint: string;
  private readonly appid: string;
  private readonly maxFps: number;
  private readonly quality: number;
  private minFrameGapMs: number;
  private readonly entries = new Map<string, FrameEntry>();

  private currentId: string | null = null;
  private lastFrame: Uint8Array | null = null;
  private lastSentAt = 0;
  private seq = 0;
  private timer: NodeJS.Timeout | null = null;
  private browser: CdpConnection | null = null;
  private service: CdpConnection | null = null;
  private closed = false;
  private syncing = false;
  private resolving = false;
  private resolveScheduled = false;

  /**
   * Where every frame went. Without this the only observable is "the client is
   * getting fewer frames than CDP produced", which has at least four plausible
   * causes and no way to tell them apart.
   */
  readonly stats = {
    /** screencast frames handed to us by CDP, across every page frame */
    fromCdp: 0,
    /** dropped: belonged to a page frame that is not on screen */
    offScreen: 0,
    /** dropped: byte-identical to the frame already sent */
    duplicate: 0,
    /** handed to the session (which may still drop them under backpressure) */
    forwarded: 0,
    /** of those, resends of an unchanged picture from the idle timer */
    idleResent: 0,
    /** dropped: arrived sooner than the frame-rate cap allows */
    rateLimited: 0,
    /** sent late by the idle timer because the rate limiter dropped the newest */
    flushed: 0,
    bytesForwarded: 0,
    /** longest interval between two forwarded frames, ms */
    maxGapMs: 0,
    /** spacing of frames arriving from CDP for the page on screen, ms */
    cdpGapMs: percentiles(),
    /** spacing of frames we hand on, ms — what the client experiences */
    outGapMs: percentiles(),
  };

  /**
   * Event loop delay while streaming.
   *
   * This is the one measurement that separates "our process was busy" from
   * "something upstream went quiet". A stall with a clean event loop is not our
   * CPU, whatever the profile of the code looks like.
   */
  private readonly loopLag: IntervalHistogram = monitorEventLoopDelay({ resolution: 10 });
  private lastCdpAt = 0;
  /** counter snapshot at the last forward, so a gap can be attributed */
  private stallMark = { fromCdp: 0, offScreen: 0, duplicate: 0, rateLimited: 0 };
  /** which path produced the frame that ended the current gap */
  private stallEnder = "a live frame";

  onFrame: ((data: Uint8Array) => void) | null = null;
  onRoute: ((route: string) => void) | null = null;
  onGone: ((reason: string) => void) | null = null;

  constructor(
    endpoint: string,
    appid: string,
    tuning: { maxFps: number; quality: number },
  ) {
    this.endpoint = endpoint;
    this.appid = appid;
    this.maxFps = tuning.maxFps;
    this.quality = tuning.quality;
    // 0 means "no cap"; anything else becomes the minimum spacing between
    // forwarded frames.
    this.minFrameGapMs = tuning.maxFps > 0 ? 1000 / tuning.maxFps : 0;
  }

  get route(): string {
    return this.current?.route ?? "";
  }

  get current(): FrameEntry | null {
    return this.currentId ? (this.entries.get(this.currentId) ?? null) : null;
  }

  get latestFrame(): Uint8Array | null {
    return this.lastFrame;
  }

  /**
   * Subscribe to `frames`, work out which one is on screen, and wait until we
   * know what the picture looks like.
   */
  async start(frames: PageFrame[]): Promise<Screen> {
    for (const frame of frames) await this.add(frame);
    await this.connectService();
    await this.watchTargets();
    await this.resolveCurrent();
    const first = await this.waitForFrame(FIRST_FRAME_MS);
    const size = jpegSize(first);
    if (!size) throw new Error("first screencast frame was not a readable JPEG");
    this.timer = setInterval(() => void this.tick(), IDLE_RESEND_MS);
    this.timer.unref?.();
    this.loopLag.enable();
    return this.screenFor(size);
  }

  /** Bring the subscription set in line with the live target list. */
  async sync(): Promise<void> {
    if (this.closed || this.syncing) return;
    this.syncing = true;
    try {
      const targets = await fetchTargets(this.endpoint);
      const frames = pageFramesByProject(targets).get(this.appid) ?? [];
      for (const frame of frames) {
        const known = this.entries.get(frame.targetId);
        if (known) {
          // A page frame's URL changes under it. It is created as
          // `__pageframe__/instanceframe.html` — a blank shell — and only takes
          // its real route a moment later, and a route change can happen in
          // place rather than as a new target (ARCHITECTURE.md). Recording the route
          // once at attach time means the entry keeps a name the page stack will
          // never ask for, so the stream sticks on the previous page forever
          // while logging that it cannot find the new one.
          if (known.route !== frame.route) {
            log.debug(`page frame ${known.route} is now ${frame.route}`);
            known.route = frame.route;
          }
          continue;
        }
        try {
          await this.add(frame);
        } catch (err) {
          // A page frame that has just been created may not answer
          // `Page.getLayoutMetrics` yet. Letting that abort the whole reconcile
          // is how the stream ends up stuck on the previous page: the new page
          // never gets added, so it can never become current. Skip it and let
          // the next sync pick it up.
          log.debug(`page frame ${frame.route} not ready yet: ${String(err)}`);
        }
      }
      if (frames.length === 0) {
        this.onGone?.("the mini program stopped rendering");
        return;
      }
      await this.resolveCurrent();
    } catch (err) {
      // A failed poll is not fatal; the sockets we already hold keep working.
      log.debug(`sync failed: ${String(err)}`);
    } finally {
      this.syncing = false;
    }
  }

  /**
   * Ask the logic layer where it is, and point the stream at that page frame.
   *
   * Safe to call often and from several places at once — navigation is
   * user-driven and can happen between any two of them.
   */
  async resolveCurrent(): Promise<void> {
    if (this.closed || this.resolving) return;
    this.resolving = true;
    try {
      const route = await this.topRoute();
      if (route === null) {
        // No logic layer to ask. Keep whatever we have rather than guessing;
        // if we have nothing yet, any page frame beats a black screen.
        if (!this.current && this.entries.size > 0) {
          await this.setCurrent([...this.entries.values()][0]!);
        }
        return;
      }
      const entry = this.entryForRoute(route);
      if (!entry) {
        // The page exists in the logic layer but its render target has not been
        // created yet. `sync()` runs again on the next target event.
        log.debug(`no page frame for route ${route} yet`);
        return;
      }
      await this.setCurrent(entry);
    } finally {
      this.resolving = false;
    }
  }

  close(): void {
    this.closed = true;
    this.loopLag.disable();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.browser?.close();
    this.browser = null;
    this.service?.close();
    this.service = null;
    for (const entry of this.entries.values()) this.retire(entry);
    this.entries.clear();
    this.currentId = null;
  }

  /**
   * Change the frame-rate cap for this stream.
   *
   * The right number depends entirely on the codec, which is not known until
   * `startVideo`. Whole JPEGs cost ~85 KB each and have to be thinned; H.264 at
   * the same rate costs a twentieth of that, so thinning it buys nothing and
   * spends smoothness — which is the thing being optimised for now.
   */
  setMaxFps(fps: number): void {
    this.minFrameGapMs = fps > 0 ? 1000 / fps : 0;
    log.debug(fps > 0 ? `frame cap ${fps} fps` : "frame cap removed");
  }

  /** Dispatch CDP commands into whichever page frame is on screen. */
  dispatch(commands: Array<{ method: string; params: Record<string, unknown> }>): void {
    const entry = this.current;
    if (!entry) throw new Error("no page frame is currently on screen");
    // `post` is fire-and-forget and silently returns on a closed socket, so
    // without this a dropped input looks identical to one that was delivered
    // and ignored — which is a very expensive thing to debug.
    if (!entry.conn?.isOpen) {
      throw new Error(
        `page frame ${entry.route} has no open connection; input was not delivered`,
      );
    }
    for (const c of commands) {
      // Which frame and which CSS pixel: the two things you need when a tap
      // lands somewhere unexpected, and neither is recoverable after the fact.
      log.debug(
        `-> ${entry.route} [${entry.targetId.slice(0, 8)}] ${c.method} ${describeInput(c.params)}`,
      );
      entry.conn?.post(c.method, c.params);
    }
    // Input is what makes a mini program navigate, so this is the moment the
    // answer is most likely to be about to change.
    this.scheduleResolve();
  }

  viewportOfCurrent(): Viewport {
    const entry = this.current;
    if (!entry) throw new Error("no page frame is currently on screen");
    return entry.viewport;
  }

  screenFor(size: { width: number; height: number }): Screen {
    const viewport = this.current?.viewport;
    // Frames come out at the host display's backing scale, and the CSS viewport
    // is what CDP input is measured in; their ratio is the protocol's `scale`,
    // which is what lets a client draw the picture at the size the simulator
    // actually is on this Mac (ARCHITECTURE.md).
    const scale =
      viewport && viewport.width > 0 ? round2(size.width / viewport.width) : 1;
    return {
      width: size.width,
      height: size.height,
      scale,
      orientation: "portrait",
      frameRotation: 0,
    };
  }

  /** p50/p90/p99 of how late timers ran, in ms. */
  loopLagSummary(): { p50: number; p90: number; p99: number; max: number } {
    const ms = (ns: number): number => Math.round(ns / 1e5) / 10;
    return {
      p50: ms(this.loopLag.percentile(50)),
      p90: ms(this.loopLag.percentile(90)),
      p99: ms(this.loopLag.percentile(99)),
      max: ms(this.loopLag.max),
    };
  }

  /** Evaluate an expression in the logic layer. */
  async evaluateInService(expression: string): Promise<unknown> {
    const service = await this.connectService();
    const res = await service.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    return (res.result as { value?: unknown } | undefined)?.value;
  }

  async pageStack(): Promise<string[]> {
    const value = await this.evaluateInService(
      `JSON.stringify(getCurrentPages().map(p => p.route))`,
    );
    return typeof value === "string" ? (JSON.parse(value) as string[]) : [];
  }

  // -------------------------------------------------------------------------

  /**
   * Learn about page frames the moment they exist.
   *
   * Navigating creates a `__pageframe__` target and popping destroys one, far
   * faster than any poll. Until we know, input goes to whichever frame we still
   * believe is on screen.
   */
  private async watchTargets(): Promise<void> {
    try {
      this.browser = await CdpConnection.open(await browserWsUrl(this.endpoint));
      this.browser.on("Target.targetCreated", () => void this.sync());
      this.browser.on("Target.targetDestroyed", () => void this.sync());
      await this.browser.send("Target.setDiscoverTargets", { discover: true });
    } catch (err) {
      // The poll still covers us, just more slowly. Worth a warning, not worth
      // failing the attach over.
      log.warn(
        `no browser-level target events (${String(err)}); falling back to polling`,
      );
    }
  }

  private async connectService(): Promise<CdpConnection> {
    if (this.service?.isOpen) return this.service;
    const svc = appServiceForProject(await fetchTargets(this.endpoint), this.appid);
    if (!svc) throw new Error("the mini program's logic layer is not running");
    this.service = await CdpConnection.open(svc.wsUrl);
    await this.service.send("Runtime.enable");
    return this.service;
  }

  /** @returns the route on top of the page stack, or null if we cannot ask. */
  private async topRoute(): Promise<string | null> {
    try {
      const stack = await this.pageStack();
      return stack.length > 0 ? stack[stack.length - 1]! : null;
    } catch (err) {
      log.debug(`could not read the page stack: ${String(err)}`);
      return null;
    }
  }

  /**
   * The page frame showing `route`. When a route appears more than once — the
   * same page pushed twice — the newest instance is the one on top.
   */
  private entryForRoute(route: string): FrameEntry | null {
    let best: FrameEntry | null = null;
    for (const entry of this.entries.values()) {
      if (entry.route !== route) continue;
      if (!best || entry.seq > best.seq) best = entry;
    }
    return best;
  }

  /**
   * Move the stream to `entry`.
   *
   * Every page frame keeps its screencast running the whole time and we simply
   * ignore frames from the ones that are not on screen. Stopping and restarting
   * casts as the user navigates is the obvious thing to do and it does not work:
   * a cast restarted on a connection whose previous cast was stopped with a
   * frame still unacknowledged never delivers again, so the client freezes on
   * whatever was last drawn — with the routing itself perfectly correct, which
   * makes it a miserable thing to debug. Leaving them running costs little,
   * because a page that is not on screen has nothing to paint.
   */
  private async setCurrent(entry: FrameEntry): Promise<void> {
    if (this.currentId === entry.targetId) return;
    const previous = this.current;
    this.currentId = entry.targetId;
    log.debug(
      `page frame on screen: ${entry.route}${previous ? ` (was ${previous.route})` : ""}`,
    );
    if (previous) this.retire(previous);
    await this.startCast(entry);
    // Starting a cast makes Chromium emit a frame straight away, so the picture
    // changes at the moment the route does rather than whenever the new page
    // next happens to repaint.
    this.onRoute?.(entry.route);
  }

  /**
   * Stop capturing a page that has left the screen — by closing its socket.
   *
   * `Page.stopScreencast` followed later by a `startScreencast` on the same
   * connection wedges it permanently when a frame was still unacknowledged: it
   * never delivers again. Dropping the connection sidesteps that entirely, and
   * costs a few milliseconds to re-establish if the user navigates back.
   */
  private retire(entry: FrameEntry): void {
    entry.casting = false;
    const conn = entry.conn;
    entry.conn = null;
    if (!conn) return;
    conn.onClose = null;
    conn.close();
    log.debug(`stopped capturing ${entry.route}`);
  }

  /** Reconnect a retired page frame and (re)subscribe to its frames. */
  private async revive(entry: FrameEntry): Promise<void> {
    if (entry.conn || this.closed) return;
    const conn = await CdpConnection.open(entry.wsUrl);
    entry.conn = conn;
    conn.onClose = () => this.drop(entry.targetId);
    conn.on("Page.screencastFrame", (params) => this.onCastFrame(entry, params));
    await conn.send("Page.enable");
  }

  private async startCast(entry: FrameEntry): Promise<void> {
    if (entry.casting || this.closed) return;
    try {
      await this.revive(entry);
      if (!entry.conn) return;
      await entry.conn.send("Page.startScreencast", {
        format: "jpeg",
        quality: this.quality,
        everyNthFrame: 1,
      });
      entry.casting = true;
    } catch (err) {
      log.warn(`could not start screencast on ${entry.route}: ${String(err)}`);
    }
  }

  /**
   * Re-check where the app is, shortly after input.
   *
   * Debounced, and that matters far more than it looks. This is called per
   * *input message*, and a single flick is a touch-start, fourteen moves and a
   * touch-end — sixteen messages. Scheduling four unconditional timers each
   * meant up to sixty-four `sync()` calls a second, every one of them an HTTP
   * request to the devtools plus a `Runtime.evaluate` on its logic layer.
   *
   * That is not free: we are competing for the same devtools process that is
   * supposed to be sending us screencast frames. Measured, backing our polling
   * off moved the arrival gap from p99 300ms to p99 50ms and our own output
   * from p99 500ms to p99 300ms. The stalls were partly self-inflicted.
   *
   * So one round of checks per burst of input, not one per message.
   */
  private scheduleResolve(): void {
    if (this.resolveScheduled) return;
    this.resolveScheduled = true;
    for (const [i, delay] of RESOLVE_AFTER_INPUT_MS.entries()) {
      const t = setTimeout(() => {
        if (i === RESOLVE_AFTER_INPUT_MS.length - 1) this.resolveScheduled = false;
        void this.sync();
      }, delay);
      t.unref?.();
    }
  }

  /**
   * Start tracking a page frame — **without** capturing it.
   *
   * Only the page on screen gets a screencast. Capturing all of them made the
   * devtools JPEG-encode three full-size frames sixty times a second, two
   * thirds of it for pages nobody is looking at, and it periodically could not
   * keep up: measured, every stall in the delivered stream was a window in
   * which ~20 frames arrived off-screen and one arrived from the page that
   * mattered. The encoder was busy on the wrong pages.
   */
  private async add(frame: PageFrame): Promise<void> {
    if (this.closed || this.entries.has(frame.targetId)) return;
    const conn = await CdpConnection.open(frame.wsUrl);
    const entry: FrameEntry = {
      targetId: frame.targetId,
      wsUrl: frame.wsUrl,
      route: frame.route,
      conn,
      viewport: { width: 0, height: 0 },
      casting: false,
      lastFrame: null,
      lastAt: 0,
      seq: ++this.seq,
    };

    conn.onClose = () => this.drop(frame.targetId);
    conn.on("Page.screencastFrame", (params) => this.onCastFrame(entry, params));

    await conn.send("Page.enable");
    entry.viewport = await readViewport(conn);

    this.entries.set(frame.targetId, entry);
    log.debug(`tracking page frame ${frame.route} (${frame.targetId.slice(0, 8)})`);
    // A page frame added while it is already the current route needs capturing
    // now; anything else waits until it comes on screen.
    if (this.currentId === frame.targetId) await this.startCast(entry);
  }

  private drop(targetId: string): void {
    const entry = this.entries.get(targetId);
    if (!entry) return;
    this.entries.delete(targetId);
    if (this.currentId === targetId) {
      this.currentId = null;
      log.debug(`page frame ${entry.route} went away while on screen`);
      // Whatever is on top now needs the stream.
      void this.resolveCurrent();
    }
    if (!this.closed && this.entries.size === 0) {
      this.onGone?.("every page frame closed");
    }
  }

  private onCastFrame(entry: FrameEntry, params: Record<string, unknown>): void {
    const sessionId = params.sessionId;
    // Chromium stops sending until the previous frame is acknowledged.
    if (sessionId !== undefined) {
      entry.conn?.post("Page.screencastFrameAck", { sessionId });
    }
    if (this.closed) return;

    const data = params.data;
    if (typeof data !== "string") return;
    this.stats.fromCdp++;
    if (entry.targetId === this.currentId) {
      const now = Date.now();
      if (this.lastCdpAt > 0) record(this.stats.cdpGapMs, now - this.lastCdpAt);
      this.lastCdpAt = now;
    }
    entry.lastFrame = Buffer.from(data, "base64");
    entry.lastAt = Date.now();
    // Every page frame casts, but only one of them is what the user is looking
    // at. Forwarding an off-screen page's frame would jump the client back to a
    // page it has already left.
    if (entry.targetId !== this.currentId) {
      this.stats.offScreen++;
      // A page that is not supposed to be on screen painting something, while
      // the one that is has gone quiet, is the app moving. Noticing it here is
      // free and replaces most of what the poll was for.
      const current = this.current;
      if (!current || Date.now() - current.lastAt > ROUTE_RECHECK_QUIET_MS) {
        this.scheduleResolve();
      }
      return;
    }

    /*
     * Drop frames that are the frame we already sent.
     *
     * The screencast is only event-driven while Chromium is willing to let the
     * renderer idle — and this tool has to run with
     * `--disable-renderer-backgrounding` for page transitions to work at all
     * (wechat-cli.ts). With that flag the compositor keeps ticking, and a
     * perfectly still mini program produces 60 identical full-size JPEGs a
     * second: measured at 29 Mbit/s on a static page and 47 Mbit/s on one with
     * an auto-playing carousel. Over the Tailscale hop that is well past the
     * point where the session starts dropping video under backpressure
     * (PROTOCOL §3), for a picture that never changed.
     *
     * A byte comparison is enough — the encoder is deterministic, so identical
     * pixels give identical bytes — and it costs a memcmp against a frame we
     * are already holding.
     */
    if (sameBytes(entry.lastFrame, this.lastFrame)) {
      this.stats.duplicate++;
      return;
    }
    // The cap is applied to genuinely new pictures only — after the duplicate
    // check, so a still screen does not spend its budget on frames that carry
    // nothing, and before the send, so the bytes are never queued at all.
    // The tolerance matters: frames arrive on a 60 Hz cadence, so a strict
    // ">= 33.3ms" test rejects the frame that lands at 32.9 and waits for the
    // next one 16ms later, turning a 30 fps cap into 23. Half a source frame of
    // slack lets the intended one through.
    if (
      this.minFrameGapMs > 0 &&
      Date.now() - this.lastSentAt < this.minFrameGapMs - FRAME_GAP_TOLERANCE_MS
    ) {
      this.stats.rateLimited++;
      return;
    }
    this.forward(entry.lastFrame);
  }

  /** Keeps the client fed while nothing moves. */
  private async tick(): Promise<void> {
    if (this.closed || !this.onFrame) return;
    if (Date.now() - this.lastSentAt < IDLE_RESEND_MS) return;

    /*
     * Flush before resending.
     *
     * The rate limiter drops frames it will never revisit, and the last frame
     * of a gesture is exactly the one most likely to land inside a closed gate:
     * the screen moves, the limiter discards the frame where it came to rest,
     * and nothing changes afterwards to trigger another send. The client is then
     * left showing a picture that is merely *close* to the truth — and the idle
     * resend used to re-send that same stale frame forever, making it permanent
     * rather than momentary.
     *
     * So if the page on screen holds something newer than what we last sent,
     * that goes out first. It costs at most one extra frame per idle interval
     * (5 fps), and it makes the rate limiter lossy only in the middle of motion,
     * never at the end of it.
     */
    const latest = this.current?.lastFrame;
    if (latest && !sameBytes(latest, this.lastFrame)) {
      this.stats.flushed++;
      this.stallEnder = "the idle timer flushing a newer frame";
      this.forward(latest);
      this.stallEnder = "a live frame";
      return;
    }

    // PROTOCOL §3: a still page sends nothing, and a client that connected to a
    // still page — or whose only frame was dropped under backpressure — would
    // otherwise sit black.
    if (this.lastFrame) {
      this.stats.idleResent++;
      this.stallEnder = "the idle timer resending an unchanged frame";
      this.forward(this.lastFrame);
      this.stallEnder = "a live frame";
    }
  }

  private forward(data: Uint8Array): void {
    const now = Date.now();
    if (this.lastSentAt > 0) {
      const gap = now - this.lastSentAt;
      if (gap > this.stats.maxGapMs) this.stats.maxGapMs = gap;
      /*
       * A gap worth explaining. Log what every gate did during it, because the
       * *shape* of a stall is not enough to identify it: gaps clustered at
       * 200ms look like a 200ms timer blocking the path, and would look exactly
       * the same if a 200ms timer were the thing *ending* a longer stall.
       * Counting per gate tells those apart.
       */
      if (gap >= STALL_LOG_MS) {
        const d = this.stallMark;
        log.debug(
          `gap ${gap}ms — during it: ${this.stats.fromCdp - d.fromCdp} from CDP, ` +
            `${this.stats.offScreen - d.offScreen} off-screen, ` +
            `${this.stats.duplicate - d.duplicate} duplicate, ` +
            `${this.stats.rateLimited - d.rateLimited} rate-limited; ` +
            `ended by ${this.stallEnder}`,
        );
      }
      this.stallMark = {
        fromCdp: this.stats.fromCdp,
        offScreen: this.stats.offScreen,
        duplicate: this.stats.duplicate,
        rateLimited: this.stats.rateLimited,
      };
    }
    if (this.lastSentAt > 0) record(this.stats.outGapMs, now - this.lastSentAt);
    this.stats.forwarded++;
    this.stats.bytesForwarded += data.length;
    this.lastFrame = data;
    this.lastSentAt = now;
    this.onFrame?.(data);
  }

  private async waitForFrame(timeoutMs: number): Promise<Uint8Array> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.lastFrame) return this.lastFrame;
      if (Date.now() >= deadline) break;
      await sleep(50);
    }
    throw new Error(
      `no screencast frame in ${timeoutMs}ms — is the simulator showing the mini program?`,
    );
  }
}
// ---------------------------------------------------------------------------
// one attached mini program
// ---------------------------------------------------------------------------

class WechatHandle implements DeviceHandle {
  readonly device: Device;

  private readonly set: PageFrameSet;
  private readonly project: WechatProject;
  private readonly endpoint: string;

  private readonly encoderOptions: EncoderOptions;

  private events: HandleEvents = {};
  private sink: FrameSink | null = null;
  private syncTimer: NodeJS.Timeout | null = null;
  private service: CdpConnection | null = null;
  private encoder: H264Encoder | null = null;
  private shellConn: WechatShell | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(
    device: Device,
    set: PageFrameSet,
    project: WechatProject,
    encoderOptions: EncoderOptions,
  ) {
    this.device = device;
    this.set = set;
    this.project = project;
    this.endpoint = set.endpoint;
    this.encoderOptions = encoderOptions;
  }

  subscribe(events: HandleEvents): void {
    this.events = events;
    this.set.onRoute = (route) => {
      // The protocol has no "current page" event and does not need one: a mini
      // program route is the same idea as a foreground app.
      this.events.onForeground?.({ bundleId: route });
    };
    this.set.onGone = (reason) => {
      if (!this.closed) this.events.onError?.(reason);
    };
    this.watchShell();
  }

  /**
   * Tell the client about the sheets the IDE draws over the phone.
   *
   * Without this a modal is a device that has silently stopped responding: the
   * picture is the page frame, and the page frame does not contain the dialog
   * (wechat-shell.ts). It is a push rather than a poll because the shell watches
   * with a MutationObserver — asking the same devtools we stream video out of,
   * on a timer, is what used to cost us frame pacing.
   */
  private watchShell(): void {
    const shell = this.shell();
    shell.onChange = (overlays) => {
      if (this.closed) return;
      this.events.onDialog?.({ open: overlays.length > 0, overlays });
    };
    void shell
      .watch()
      // Whatever is already up when a client attaches counts as news to it.
      .then(() => shell.refresh())
      .catch((err) => {
        log.debug(`cannot watch the IDE shell: ${String(err)}`);
      });
  }

  async startVideo(codec: Codec, onFrame: FrameSink): Promise<() => void> {
    if (codec !== "jpeg" && codec !== "h264") {
      throw new Error(`WeChat provider cannot produce ${codec}`);
    }
    if (this.sink) throw new Error("video already started");
    this.sink = onFrame;

    // SEED is a JPEG whatever the stream codec is (PROTOCOL §3): it gives the
    // client a picture immediately instead of waiting out the first IDR.
    const seed = this.set.latestFrame;
    if (seed) onFrame(VIDEO_TAG.SEED, seed);

    if (codec === "h264") {
      // Bandwidth stops being the constraint here — 20 fps of H.264 measured
      // 910 kbit/s against a 61 Mbit/s link — so the thinning that jpeg needs
      // only costs smoothness. Let the source rate through.
      this.set.setMaxFps(this.encoderOptions.h264MaxFps);
      this.startEncoder();
      this.set.onFrame = (data) => {
        if (this.closed) return;
        // The size check reads the JPEG, so it has to happen on the way in.
        this.checkScreen(data);
        this.encoder?.push(data);
      };
    } else {
      this.set.onFrame = (data) => this.emit(VIDEO_TAG.KEY, data);
    }

    // Page frames appear and vanish as the user navigates; keep up with them.
    this.syncTimer = setInterval(
      () => void this.set.sync(),
      // A backstop only. Target creation and destruction arrive as events, input
      // schedules its own checks, and an off-screen page painting triggers one —
      // so polling this often was buying almost nothing and costing the tail.
      Number(process.env.SIMFARM_WECHAT_SYNC_MS ?? 5000),
    );
    this.syncTimer.unref?.();

    return () => this.stopVideo();
  }

  /**
   * Watch for the encoder accepting frames and producing none.
   *
   * This is the failure that has to be loud. The codec negotiates, the attach
   * succeeds, the SEED puts a picture on screen — and then nothing ever moves,
   * with no error anywhere, because every stage is individually behaving. The
   * client cannot be switched to jpeg mid-stream (it has already configured a
   * decoder from our CONFIG), so the honest move is to say exactly what is
   * wrong and exactly how to get a working picture back.
   */
  private startEncoderWatchdog(): void {
    const timer = setTimeout(() => {
      const enc = this.encoder;
      if (this.closed || !enc) return;
      if (enc.stats.framesOut > 0) return;
      this.events.onError?.(
        `h264 encoder took ${ENCODER_WATCHDOG_MS}ms and produced nothing ` +
          `(${enc.stats.jpegIn} frames in, ${enc.stats.bytesIn} bytes written, ` +
          `${enc.stats.stdoutBytes} bytes back, ${enc.stats.accessUnits} access units). ` +
          `Re-attach with codec "jpeg", or restart the server with --wechat-no-h264.`,
      );
    }, ENCODER_WATCHDOG_MS);
    timer.unref?.();
    this.watchdog = timer;
  }

  private startEncoder(): void {
    const screen = this.device.screen;
    const encoder = new H264Encoder(
      {
        ...this.encoderOptions,
        width: screen?.width ?? this.encoderOptions.width,
        height: screen?.height ?? this.encoderOptions.height,
      },
      (tag, data) => {
        if (!this.closed) this.sink?.(tag, data);
      },
    );
    encoder.onFailure = (reason) => {
      // Nothing to fall back to mid-stream: the client configured a decoder
      // from our CONFIG frame and cannot be switched to jpeg without a
      // re-attach. Say so plainly rather than going quietly black.
      if (!this.closed) {
        this.events.onError?.(`h264 encoder stopped: ${reason} — re-attach to recover`);
      }
    };
    encoder.start();
    this.encoder = encoder;
    if (this.watchdog) clearTimeout(this.watchdog);
    this.startEncoderWatchdog();
  }

  async input(msg: InputMessage): Promise<void> {
    if (this.closed) return;
    // `back` has no CDP expression — it is a navigation, not an event — so it
    // is handled here rather than in the pure translation.
    if (msg.kind === "button") {
      if (msg.phase !== KEY_PHASE.DOWN) return;
      if (msg.buttonId === BUTTON_ID.back) await this.back();
      else if (msg.buttonId === BUTTON_ID.home) await this.goHome();
      return;
    }
    this.set.dispatch(inputToCdp(msg, this.set.viewportOfCurrent()));
  }

  /**
   * Back to the mini program's first page.
   *
   * `reLaunch` to the entry page rather than popping the stack repeatedly: it is
   * what the IDE's own "home" control does, it works from a tab page as well as
   * a pushed one, and it cannot half-succeed the way a loop of `navigateBack`
   * can. The entry path comes from the app's own config, so a mini program whose
   * first page is not `pages/index/index` still goes to the right place.
   */
  private async goHome(): Promise<void> {
    const entry = await this.set.evaluateInService(
      `(typeof __wxConfig !== 'undefined' && __wxConfig.entryPagePath) || ''`,
    );
    const path = entryPageUrl(typeof entry === "string" ? entry : "");
    if (!path) throw new Error("the app does not declare an entry page");
    const ok = await this.set.evaluateInService(
      `new Promise(r => wx.reLaunch({url: ${JSON.stringify(path)}, success: () => r(true), fail: () => r(false)}))`,
    );
    if (ok !== true) throw new Error(`could not go home (${path})`);
    await this.set.sync();
  }

  /** The IDE's back arrow, which our picture deliberately does not include. */
  private async back(): Promise<void> {
    const stack = await this.set.pageStack();
    if (stack.length <= 1) {
      // Refusing is better than silently doing nothing: navigateBack on the
      // root page is a no-op in the framework too, and the client should know
      // why nothing moved.
      throw new Error("already on the first page; there is nothing to go back to");
    }
    await this.set.evaluateInService(
      `new Promise(r => wx.navigateBack({delta: 1, success: () => r(true), fail: () => r(false)}))`,
    );
    await this.set.sync();
  }

  async control(op: string, args: unknown): Promise<unknown> {
    switch (op) {
      case "launch": {
        const target = (args as { target?: string })?.target;
        if (!target) throw new Error("launch needs a target");
        return await this.navigate(target);
      }
      case "pages":
        return { route: this.set.route, stack: await this.set.pageStack() };

      /*
       * Dialogs live in the IDE window, not in the page frame (wechat-shell.ts).
       * They cannot be touched and — the part that matters to a user — they
       * cannot be *seen* in the stream either. `dialog` asks what is up; the
       * same answer is pushed unasked as a `dialog` event whenever it changes,
       * which is what lets the client draw one.
       */
      case "dialog": {
        const overlays = await this.shell().overlays();
        return { open: overlays.length > 0, overlays };
      }

      /*
       * `dialogPress` is the general form and the other names are the automator
       * vocabulary (`confirmModal`, `authorizeAllow`, …) mapped onto it, so a
       * client written against either one works.
       */
      case "dialogPress": {
        const which = (args as { which?: string | number })?.which;
        if (which === undefined) throw new Error("dialogPress needs a button");
        return { pressed: await this.shell().press(which) };
      }
      case "confirmModal":
      case "authorizeAllow":
        return { pressed: await this.shell().press("confirm") };

      case "cancelModal":
      case "authorizeCancel":
        return { pressed: await this.shell().press("cancel") };

      // The payment sheet has no text buttons at all, only a ✕; `press`
      // resolves "close" to it and falls back to a cancel button elsewhere.
      case "closePaymentDialog":
        return { pressed: await this.shell().press("close") };

      case "stats":
        // Diagnostic: the frame ledger plus per-stage timing, so a stall can be
        // attributed to a stage instead of guessed at.
        return {
          ...this.set.stats,
          cdpGapMs: summarize(this.set.stats.cdpGapMs),
          outGapMs: summarize(this.set.stats.outGapMs),
          eventLoopLagMs: this.set.loopLagSummary(),
          route: this.set.route,
          ...(this.encoder
            ? {
                encoder: {
                  ...this.encoder.stats,
                  encodeMs: summarize(this.encoder.stats.encodeMs),
                  inGapMs: summarize(this.encoder.stats.inGapMs),
                  outGapMs: summarize(this.encoder.stats.outGapMs),
                },
              }
            : {}),
        };
      case "rotate":
        throw new Error(
          "the WeChat simulator's orientation is an IDE control with no CDP or CLI equivalent",
        );
      default:
        throw new Error(`WeChat provider does not support op "${op}"`);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stopVideo();
    this.shellConn?.close();
    this.shellConn = null;
    this.set.close();
    this.events.onClosed?.("closed");
  }

  // -------------------------------------------------------------------------

  private shell(): WechatShell {
    // The target-side appid, for the same reason as PageFrameSet's.
    this.shellConn ??= new WechatShell(this.endpoint, this.project.appid);
    return this.shellConn;
  }

  private stopVideo(): void {
    this.set.onFrame = null;
    this.sink = null;
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
    this.encoder?.stop();
    this.encoder = null;
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.syncTimer = null;
  }

  private emit(tag: number, data: Uint8Array): void {
    if (this.closed || !this.sink) return;
    this.checkScreen(data);
    this.sink(tag, data);
  }

  /**
   * The picture changes shape when the user picks a different phone in the IDE.
   * Reading it back off the frames themselves means we never have to trust a
   * separate source for the size the client is about to draw.
   */
  private checkScreen(data: Uint8Array): void {
    const size = jpegSize(data);
    if (!size) return;
    const screen = this.device.screen;
    if (screen && screen.width === size.width && screen.height === size.height) {
      return;
    }
    const next = this.set.screenFor(size);
    this.device.screen = next;
    this.events.onScreen?.({ ...next });

    // A running encoder is pinned to the old dimensions — the IDE changed the
    // simulated phone, so the stream has to be rebuilt around the new size.
    if (this.encoder) {
      log.info(`picture is now ${size.width}x${size.height}; restarting the encoder`);
      this.encoder.stop();
      this.startEncoder();
    }
  }

  /**
   * Open a mini program page path. The three navigation calls are not
   * interchangeable — `navigateTo` refuses tab bar pages and `switchTab` refuses
   * everything else — and a client that had to know which is which would need
   * the app's `app.json`. So try them in order of least disruption.
   */
  private async navigate(target: string): Promise<unknown> {
    const url = target.startsWith("/") ? target : `/${target}`;
    for (const method of ["navigateTo", "switchTab", "reLaunch"] as const) {
      const ok = await this.set.evaluateInService(
        `new Promise(r => wx.${method}({url: ${JSON.stringify(url)}, success: () => r(true), fail: () => r(false)}))`,
      );
      if (ok === true) {
        // The render target for the new page appears a moment later.
        await this.set.sync();
        return { ok: true, via: method };
      }
    }
    throw new Error(`could not open "${url}" (tried navigateTo, switchTab, reLaunch)`);
  }
}

// ---------------------------------------------------------------------------

async function readViewport(conn: CdpConnection): Promise<Viewport> {
  const metrics = await conn.send("Page.getLayoutMetrics");
  const viewport = (metrics.cssLayoutViewport ?? metrics.layoutViewport) as
    | { clientWidth?: number; clientHeight?: number }
    | undefined;
  const width = viewport?.clientWidth ?? 0;
  const height = viewport?.clientHeight ?? 0;
  if (width <= 0 || height <= 0) {
    throw new Error("page frame reported an empty layout viewport");
  }
  return { width, height };
}

async function evaluateBoolean(
  conn: CdpConnection,
  expression: string,
): Promise<boolean> {
  const res = await conn.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  return (res.result as { value?: unknown } | undefined)?.value === true;
}

/**
 * Byte equality. `Buffer.equals` when both are Buffers (they are, off the
 * socket), with a plain loop as the fallback so this does not quietly depend on
 * how the caller allocated them.
 */
function sameBytes(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (!a || !b || a.length !== b.length) return false;
  if (Buffer.isBuffer(a) && Buffer.isBuffer(b)) return a.equals(b);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function summarize(p: import("./h264-encoder.ts").Percentiles): {
  n: number;
  p50: number;
  p90: number;
  p99: number;
  max: number;
} {
  return {
    n: p.n,
    p50: quantile(p, 0.5),
    p90: quantile(p, 0.9),
    p99: quantile(p, 0.99),
    max: p.max,
  };
}

/** One-line summary of a CDP input command, for the debug log. */
function describeInput(params: Record<string, unknown>): string {
  const type = String(params.type ?? "");
  const touches = params.touchPoints as Array<{ x: number; y: number }> | undefined;
  if (touches) {
    return touches.length === 0
      ? `${type} (no points)`
      : `${type} ${touches.map((p) => `${p.x},${p.y}`).join(" ")}`;
  }
  if (params.x !== undefined) {
    const delta =
      params.deltaX !== undefined
        ? ` delta ${params.deltaX},${params.deltaY}`
        : "";
    return `${type} ${String(params.x)},${String(params.y)}${delta}`;
  }
  if (params.key !== undefined) return `${type} ${String(params.key)}`;
  if (params.text !== undefined) return `text ${JSON.stringify(params.text)}`;
  return type;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * `__wxConfig.entryPagePath` -> a url `wx.reLaunch` will accept.
 *
 * Measured on this project: the IDE reports `pages/home/index.html`, and
 * `reLaunch` rejects the `.html` — the framework wants a *route*, which is the
 * same string without the extension. Nothing says so out loud: `reLaunch` just
 * calls `fail`, so the home key silently did nothing. Empty in, empty out, so
 * the caller can say "this app declares no entry page" rather than navigate
 * somewhere arbitrary.
 */
export function entryPageUrl(entryPagePath: string): string {
  const route = entryPagePath.trim().split(/[?#]/)[0]?.replace(/\.html$/i, "") ?? "";
  if (!route) return "";
  return route.startsWith("/") ? route : `/${route}`;
}
