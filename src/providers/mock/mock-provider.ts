/**
 * Mock provider — a fake backend that needs no simulator at all.
 *
 * Purpose (ARCHITECTURE.md, M0): pin the protocol and the end-to-end path down before
 * any real backend exists, and stay in the tree afterwards as the thing you
 * test the server with when no simulator is running.
 */

import { encodeJpeg } from "../../util/raster.ts";
import { renderMockFrame, type TouchEcho } from "./mock-renderer.ts";
import { BUTTON_NAME_BY_ID, VIDEO_TAG, type InputMessage } from "../../protocol.ts";
import type {
  Capabilities,
  Codec,
  Device,
  DeviceHandle,
  FrameSink,
  HandleEvents,
  Orientation,
  Provider,
  Screen,
} from "../../types.ts";

const FPS = 15;
const TRAIL_LEN = 24;

const CAPS: Capabilities = {
  video: ["jpeg"],
  touch: true,
  multitouch: true,
  keyboard: true,
  text: true,
  scroll: true,
  buttons: ["home", "lock", "back"],
  rotate: true,
  edgeGesture: true,
  clipboard: false,
  ax: false,
  deeplink: false,
  mediaDrop: false,
  // the mock has no guest, so there is nothing whose appearance could change
  appearance: false,
  // nothing to start: the mock is always up
  boot: false,
};

interface MockSpec {
  id: string;
  name: string;
  screen: Screen;
}

const SPECS: MockSpec[] = [
  {
    id: "mock:phone",
    name: "Mock Phone",
    screen: { width: 390, height: 844, scale: 2, orientation: "portrait" },
  },
  {
    id: "mock:pad",
    name: "Mock Pad",
    screen: {
      width: 640,
      height: 480,
      scale: 2,
      orientation: "landscape_left",
    },
  },
];

export class MockProvider implements Provider {
  readonly kind = "mock" as const;

  private readonly devices = new Map<string, Device>(
    SPECS.map((s) => [
      s.id,
      {
        id: s.id,
        kind: "mock" as const,
        name: s.name,
        state: "booted" as const,
        screen: { ...s.screen },
        capabilities: CAPS,
      },
    ]),
  );

  async list(): Promise<Device[]> {
    return [...this.devices.values()].map(cloneDevice);
  }

  watch(cb: (devices: Device[]) => void): () => void {
    // The mock device set never changes; emit once so the session's device
    // list is populated the same way a real provider would populate it.
    queueMicrotask(() => cb([...this.devices.values()].map(cloneDevice)));
    return () => {};
  }

  async open(deviceId: string): Promise<DeviceHandle> {
    const device = this.devices.get(deviceId);
    if (!device) throw new Error(`no such mock device: ${deviceId}`);
    return new MockHandle(cloneDevice(device));
  }
}

class MockHandle implements DeviceHandle {
  readonly device: Device;

  private events: HandleEvents = {};
  private timer: NodeJS.Timeout | null = null;
  private frame = 0;
  private fps = 0;
  private lastFpsAt = Date.now();
  private lastFpsFrame = 0;
  private touch: TouchEcho | null = null;
  private trail: Array<{ x: number; y: number }> = [];
  private lastEvent = "";
  private closed = false;

  constructor(device: Device) {
    this.device = device;
  }

  subscribe(events: HandleEvents): void {
    this.events = events;
  }

  async startVideo(codec: Codec, onFrame: FrameSink): Promise<() => void> {
    if (codec !== "jpeg") {
      throw new Error(`mock provider only speaks jpeg, got ${codec}`);
    }
    if (this.timer) throw new Error("video already started");

    // SEED first: the client has a picture before the first "real" frame.
    onFrame(VIDEO_TAG.SEED, this.paint());

    this.timer = setInterval(() => {
      if (this.closed) return;
      try {
        onFrame(VIDEO_TAG.KEY, this.paint());
      } catch (err) {
        this.events.onError?.(String(err));
      }
    }, Math.round(1000 / FPS));
    this.timer.unref?.();

    return () => this.stopVideo();
  }

  async input(msg: InputMessage): Promise<void> {
    switch (msg.kind) {
      case "touch": {
        this.touch = {
          x: msg.x,
          y: msg.y,
          phase: msg.phase,
          seq: msg.seq,
          edge: msg.edge,
          down: msg.phase !== 2,
        };
        if (msg.phase === 0) this.trail = [];
        this.trail.push({ x: msg.x, y: msg.y });
        if (this.trail.length > TRAIL_LEN) this.trail.shift();
        break;
      }
      case "multitouch":
        this.lastEvent = `MULTITOUCH ${msg.x1.toFixed(2)},${msg.y1.toFixed(2)} / ${msg.x2.toFixed(2)},${msg.y2.toFixed(2)}`;
        this.touch = {
          x: msg.x1,
          y: msg.y1,
          phase: msg.phase,
          seq: msg.seq,
          edge: 0,
          down: msg.phase !== 2,
        };
        break;
      case "key":
        this.lastEvent = `KEY ${msg.phase === 0 ? "DOWN" : "UP"} USAGE 0X${msg.usage.toString(16).toUpperCase()}`;
        break;
      case "button":
        this.lastEvent = `BUTTON ${BUTTON_NAME_BY_ID[msg.buttonId] ?? `0X${msg.buttonId.toString(16)}`} ${msg.phase === 0 ? "DOWN" : "UP"}`;
        break;
      case "scroll":
        this.lastEvent = `SCROLL ${msg.dx.toFixed(3)},${msg.dy.toFixed(3)} AT ${msg.anchorX.toFixed(2)},${msg.anchorY.toFixed(2)}`;
        break;
      case "text":
        this.lastEvent = `TEXT ${JSON.stringify(msg.text)}`;
        break;
    }
  }

  async control(op: string, args: unknown): Promise<unknown> {
    switch (op) {
      case "rotate": {
        const orientation = (args as { orientation?: Orientation })
          ?.orientation;
        if (!orientation) throw new Error("rotate needs an orientation");
        this.rotate(orientation);
        return { screen: this.device.screen };
      }
      case "launch":
        this.lastEvent = `LAUNCH ${String((args as { target?: string })?.target ?? "")}`;
        return { ok: true };
      default:
        throw new Error(`mock provider does not support op "${op}"`);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.stopVideo();
    this.events.onClosed?.("closed");
  }

  // -------------------------------------------------------------------------

  private stopVideo(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private rotate(orientation: Orientation): void {
    const screen = this.device.screen;
    if (!screen) return;
    const wasLandscape = isLandscape(screen.orientation);
    const willBeLandscape = isLandscape(orientation);
    if (wasLandscape !== willBeLandscape) {
      const w = screen.width;
      screen.width = screen.height;
      screen.height = w;
    }
    screen.orientation = orientation;
    this.lastEvent = `ROTATE ${orientation}`;
    this.events.onScreen?.({ ...screen });
  }

  private paint(): Uint8Array {
    const screen = this.device.screen!;
    this.frame++;

    const now = Date.now();
    if (now - this.lastFpsAt >= 1000) {
      this.fps =
        ((this.frame - this.lastFpsFrame) * 1000) / (now - this.lastFpsAt);
      this.lastFpsAt = now;
      this.lastFpsFrame = this.frame;
    }

    const raster = renderMockFrame({
      name: this.device.name,
      width: screen.width,
      height: screen.height,
      orientation: screen.orientation,
      frame: this.frame,
      fps: this.fps,
      now: new Date(now),
      touch: this.touch,
      trail: this.trail,
      lastEvent: this.lastEvent,
    });
    return encodeJpeg(raster, 70);
  }
}

function isLandscape(o: Orientation): boolean {
  return o === "landscape_left" || o === "landscape_right";
}

function cloneDevice(d: Device): Device {
  return { ...d, screen: d.screen ? { ...d.screen } : undefined };
}
