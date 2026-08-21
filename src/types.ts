/** Device / Provider abstraction — ARCHITECTURE.md. */

import type { InputMessage } from "./protocol.ts";

export type DeviceKind = "ios" | "android" | "wechat" | "mock";

export type Orientation =
  | "portrait"
  | "portrait_upside_down"
  | "landscape_left"
  | "landscape_right";

export type Codec = "h264" | "jpeg";

export type DeviceState = "booted" | "shutdown" | "connecting" | "error";

/** Clockwise degrees to rotate a decoded frame to make it upright. */
export type FrameRotation = 0 | 90 | 180 | 270;

export interface Screen {
  /** pixel width of the picture **as displayed** (i.e. after frameRotation) */
  width: number;
  /** pixel height of the picture **as displayed** (i.e. after frameRotation) */
  height: number;
  /** backing scale factor; points = pixels / scale */
  scale: number;
  orientation: Orientation;
  /**
   * How far clockwise the client must rotate the decoded frame to display it
   * upright. 0 for backends whose frames are already rotated (Android, mock).
   *
   * iOS needs this: CoreSimulator's framebuffer stays portrait-shaped when the
   * guest rotates, so the picture arrives lying on its side. Without this field
   * a client either shows a sideways screen or has to guess.
   *
   * Absent means 0. Input coordinates are always normalized against the
   * displayed (upright) picture, so clients never do coordinate maths for this.
   */
  frameRotation?: FrameRotation;
}

export interface Capabilities {
  video: Codec[];
  touch: boolean;
  multitouch: boolean;
  /** per-key HID */
  keyboard: boolean;
  /** inject a whole string at once */
  text: boolean;
  scroll: boolean;
  /** button names; ids on the wire come from protocol.ts BUTTON_ID */
  buttons: string[];
  rotate: boolean;
  /** iOS-style system edge gestures (swipe up from bottom = home) */
  edgeGesture: boolean;
  clipboard: boolean;
  ax: boolean;
  deeplink: boolean;
  mediaDrop: boolean;
  /**
   * The device's own light/dark setting can be driven from here.
   *
   * Not a rendering concern: it is the *guest's* system appearance, so a client
   * that follows the desktop theme can make the simulator follow it too. The
   * three backends have nothing in common here — `simctl ui appearance`,
   * `cmd uimode night`, and (for WeChat) nothing at all — which is exactly why
   * it is declared rather than assumed.
   */
  appearance: boolean;
  /**
   * The provider can start this device from a shutdown state (PROTOCOL §4
   * `boot`).
   *
   * Per-device rather than per-provider because it genuinely varies within one:
   * an Android AVD could in principle be launched, a phone on the end of a USB
   * cable cannot. A client that shows a Start button on a device that has no
   * way to start is worse than one that shows nothing — it is a button that
   * does nothing, which reads as a broken panel rather than a missing feature.
   */
  boot: boolean;
}

export interface Device {
  /** stable and unique: "ios:<udid>" / "android:<serial>" / "wechat:<projectHash>" */
  id: string;
  kind: DeviceKind;
  /** human readable, e.g. "iPhone 17 Pro (iOS 26.5)" */
  name: string;
  state: DeviceState;
  screen?: Screen;
  capabilities: Capabilities;
}

/** Frame tags mirror protocol.ts VIDEO_TAG. */
export type FrameTag = number;

export type FrameSink = (tag: FrameTag, data: Uint8Array) => void;

/** Out-of-band things a handle can tell the session about, post-attach. */
export interface HandleEvents {
  onScreen?: (screen: Screen) => void;
  onLog?: (level: "debug" | "info" | "warn" | "error", text: string) => void;
  onForeground?: (info: { bundleId: string; pid?: number }) => void;
  /**
   * A sheet the backend draws *outside* the picture it streams — the WeChat
   * simulator's `wx.showModal`, action sheet, authorization and payment
   * dialogs, all of which the IDE renders over the phone rather than inside the
   * page frame we capture. Without this the device just stops responding and
   * the picture gives no hint why. `open:false` means the last one went away.
   */
  onDialog?: (info: { open: boolean; overlays: unknown[] }) => void;
  onError?: (message: string) => void;
  onClosed?: (reason: string) => void;
}

export interface DeviceHandle {
  readonly device: Device;
  /** @returns a stop function for this video stream */
  startVideo(codec: Codec, onFrame: FrameSink): Promise<() => void>;
  input(msg: InputMessage): Promise<void>;
  control(op: string, args: unknown): Promise<unknown>;
  close(): Promise<void>;
  /** register out-of-band callbacks; called by the session right after open() */
  subscribe?(events: HandleEvents): void;
}

/**
 * Connect-style HTTP middleware. Lives here rather than in server.ts so a
 * provider can declare middleware without importing the server (which would
 * be a cycle).
 */
export type HttpMiddleware = (
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  next: () => void,
) => void;

/**
 * WebSocket upgrade handler for paths other than `/v1`. Return true to claim
 * the socket. Registered via `SimfarmServer.onUpgrade` / `Provider.upgrade()`.
 */
export type UpgradeHandler = (
  req: import("node:http").IncomingMessage,
  socket: import("node:stream").Duplex,
  head: Buffer,
) => boolean;

/** Handed to every provider once the HTTP server is listening. */
export interface ProviderContext {
  host: string;
  port: number;
  /** e.g. "http://127.0.0.1:3311" — how to reach our own mounted middleware */
  baseUrl: string;
}

export interface Provider {
  readonly kind: DeviceKind;
  list(): Promise<Device[]>;
  /** @returns unsubscribe */
  watch(cb: (devices: Device[]) => void): () => void;
  open(deviceId: string): Promise<DeviceHandle>;
  /** provider-level ops that need no open handle (boot / shutdown a device) */
  control?(op: string, args: unknown): Promise<unknown>;
  /**
   * HTTP middleware to mount, in order, before the built-in routes. This is
   * the seam the iOS provider mounts serve-sim through — and, crucially, the
   * place its `/.sim/exec` guard goes *first* (ARCHITECTURE.md).
   */
  middleware?(): HttpMiddleware[];
  /**
   * WebSocket upgrade handlers for paths other than `/v1`, tried in order.
   * `/v1` is claimed by the server before any of these run.
   */
  upgrade?(): UpgradeHandler[];
  /** called once after the server is listening, before any device is opened */
  init?(ctx: ProviderContext): Promise<void>;
  dispose?(): Promise<void>;
}
