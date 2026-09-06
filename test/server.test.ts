/** End-to-end over a real socket: HTTP statics, health, and the /v1 protocol. */

import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";

import { SimfarmServer } from "../src/server.ts";
import { DeviceRegistry } from "../src/registry.ts";
import { MockProvider } from "../src/providers/mock/mock-provider.ts";
import {
  VIDEO_TAG,
  decodeFrame,
  encodeControl,
  encodeInput,
  type WireFrame,
} from "../src/protocol.ts";

async function boot(): Promise<{
  base: string;
  ws: string;
  close: () => Promise<void>;
}> {
  const registry = new DeviceRegistry();
  registry.register(new MockProvider());
  const server = new SimfarmServer({ host: "127.0.0.1", port: 0, registry });
  await server.listen();
  const addr = server.http.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  return {
    base: `http://127.0.0.1:${addr.port}`,
    ws: `ws://127.0.0.1:${addr.port}/v1`,
    close: async () => {
      await server.close();
      await registry.dispose();
    },
  };
}

class Client {
  private readonly socket: WebSocket;
  readonly frames: WireFrame[] = [];
  private nextId = 1;

  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.binaryType = "nodebuffer";
    this.socket.on("message", (data: Buffer) =>
      this.frames.push(decodeFrame(new Uint8Array(data))),
    );
  }

  ready(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.once("open", () => resolve());
      this.socket.once("error", reject);
    });
  }

  async request(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    this.socket.send(encodeControl({ id, ...req }));
    for (let i = 0; i < 100; i++) {
      const hit = this.frames.find(
        (f) =>
          f.channel === "control" &&
          (f.json as { id?: number }).id === id,
      );
      if (hit) return (hit as { json: Record<string, unknown> }).json;
      await sleep(20);
    }
    throw new Error(`no reply to ${JSON.stringify(req)}`);
  }

  sendInput(streamId: number, msg: Parameters<typeof encodeInput>[1]): void {
    this.socket.send(encodeInput(streamId, msg));
  }

  videos(): Array<{ streamId: number; tag: number; data: Uint8Array }> {
    return this.frames
      .filter((f) => f.channel === "video")
      .map((f) => f as { streamId: number; tag: number; data: Uint8Array });
  }

  close(): void {
    this.socket.close();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("serves the test page and a health endpoint", async (t) => {
  const s = await boot();
  t.after(s.close);

  const page = await fetch(`${s.base}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /text\/html/);
  assert.match(await page.text(), /simfarm/);

  const js = await fetch(`${s.base}/protocol.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get("content-type") ?? "", /javascript/);

  const health = await fetch(`${s.base}/healthz`);
  assert.equal(health.status, 200);
  const body = (await health.json()) as { ok: boolean; devices: number };
  assert.equal(body.ok, true);

  assert.equal((await fetch(`${s.base}/nope.html`)).status, 404);
});

test("static serving refuses to escape the web root", async (t) => {
  const s = await boot();
  t.after(s.close);

  // fetch() normalizes ../ away, so go under it with a raw request
  const res = await rawGet(s.base, "/../package.json");
  assert.notEqual(res.status, 200);
  assert.ok(!res.body.includes("simfarm"), "must not leak repo files");
});

test("a websocket client can attach, see frames and send input", async (t) => {
  const s = await boot();
  const client = new Client(s.ws);
  t.after(async () => {
    client.close();
    await s.close();
  });
  await client.ready();

  const list = await client.request({ op: "list" });
  assert.equal(list.ok, true);
  assert.equal((list.devices as unknown[]).length, 2);

  const attached = await client.request({
    op: "attach",
    deviceId: "mock:phone",
    codec: "jpeg",
  });
  assert.equal(attached.ok, true);
  const streamId = attached.streamId as number;

  await sleep(300);
  const videos = client.videos().filter((v) => v.streamId === streamId);
  assert.ok(videos.length >= 2, `expected frames, got ${videos.length}`);
  assert.equal(videos[0]!.tag, VIDEO_TAG.SEED);

  // every payload must be a real JPEG: SOI ... EOI
  for (const v of videos) {
    assert.equal(v.data[0], 0xff);
    assert.equal(v.data[1], 0xd8);
    assert.equal(v.data.at(-2), 0xff);
    assert.equal(v.data.at(-1), 0xd9);
  }

  client.sendInput(streamId, {
    kind: "touch",
    phase: 0,
    x: 0.5,
    y: 0.5,
    seq: 1,
    edge: 0,
  });
  await sleep(150);
  const errors = client.frames.filter(
    (f) => f.channel === "event" && (f.json as { ev?: string }).ev === "error",
  );
  assert.equal(errors.length, 0);

  const detached = await client.request({ op: "detach", streamId });
  assert.equal(detached.ok, true);
});

test("upgrade on a wrong path is refused", async (t) => {
  const s = await boot();
  t.after(s.close);

  const bad = new WebSocket(`${s.ws.replace("/v1", "/nope")}`);
  await assert.rejects(
    () =>
      new Promise((resolve, reject) => {
        bad.once("open", resolve);
        bad.once("error", reject);
        bad.once("close", () => reject(new Error("closed")));
      }),
  );
});

/** fetch() collapses "..", so this speaks HTTP/1.1 by hand. */
async function rawGet(
  base: string,
  path: string,
): Promise<{ status: number; body: string }> {
  const { port } = new URL(base);
  const net = await import("node:net");
  return new Promise((resolve, reject) => {
    const sock = net.connect(Number(port), "127.0.0.1", () => {
      sock.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    let data = "";
    sock.on("data", (c) => (data += c.toString("latin1")));
    sock.on("error", reject);
    sock.on("close", () => {
      const status = Number(data.split(" ")[1] ?? 0);
      resolve({ status, body: data });
    });
  });
}

// ---------------------------------------------------------------------------
// a device that dies under its stream
// ---------------------------------------------------------------------------

import type {
  Device,
  DeviceHandle,
  DeviceKind,
  FrameSink,
  HandleEvents,
  Provider,
} from "../src/types.ts";

const NS_NOT_BOOTED =
  'Error Domain=FrameCapture Code=2 "Device not booted (state: Shutdown)" UserInfo={NSLocalizedDescription=Device not booted (state: Shutdown)}';

/**
 * A backend whose device delivers `framesBeforeLoss` pictures and then loses
 * its capture the way the iOS provider does when a simulator is shut down:
 * an `error` on the stream, the handle closes, the device is re-listed as
 * shut down. `boot` brings it back.
 */
class DyingProvider implements Provider {
  readonly kind = "dying" as DeviceKind;
  readonly framesBeforeLoss: number;
  private state: Device["state"] = "booted";
  private readonly watchers = new Set<(devices: Device[]) => void>();

  constructor(framesBeforeLoss: number) {
    this.framesBeforeLoss = framesBeforeLoss;
  }

  private device(): Device {
    return {
      id: "dying:sim",
      kind: this.kind,
      name: "Dying Sim",
      state: this.state,
      screen: { width: 100, height: 200, scale: 1, orientation: "portrait" },
      capabilities: {
        video: ["jpeg"],
        touch: true,
        multitouch: false,
        keyboard: false,
        text: false,
        scroll: false,
        buttons: [],
        rotate: false,
        edgeGesture: false,
        clipboard: false,
        ax: false,
        deeplink: false,
        mediaDrop: false,
        appearance: false,
        boot: true,
      },
    };
  }

  async list(): Promise<Device[]> {
    return [this.device()];
  }

  watch(cb: (devices: Device[]) => void): () => void {
    this.watchers.add(cb);
    queueMicrotask(() => cb([this.device()]));
    return () => this.watchers.delete(cb);
  }

  private setState(state: Device["state"]): void {
    this.state = state;
    for (const cb of this.watchers) cb([this.device()]);
  }

  async control(op: string): Promise<unknown> {
    if (op === "boot") {
      this.setState("booted");
      return { ok: true };
    }
    throw new Error(`no ${op}`);
  }

  async open(): Promise<DeviceHandle> {
    if (this.state !== "booted") {
      throw new Error(`simulator Dying Sim is Shutdown; send {"op":"boot","deviceId":"dying:sim"} first`);
    }
    const provider = this;
    let events: HandleEvents = {};
    let timer: NodeJS.Timeout | null = null;
    let closed = false;
    const handle: DeviceHandle = {
      device: provider.device(),
      subscribe(e) {
        events = e;
      },
      async startVideo(_codec, onFrame: FrameSink) {
        let sent = 0;
        onFrame(VIDEO_TAG.SEED, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
        timer = setInterval(() => {
          if (closed) return;
          if (sent++ < provider.framesBeforeLoss) {
            onFrame(VIDEO_TAG.KEY, new Uint8Array([0xff, 0xd8, sent, 0xff, 0xd9]));
            return;
          }
          // The capture rejected under us (ios-provider.ts `fail`): say why,
          // close, and let the provider re-list the device.
          events.onError?.(`simulator capture lost: ${NS_NOT_BOOTED}`);
          void handle.close();
          provider.setState("shutdown");
        }, 5);
        return () => {
          if (timer) clearInterval(timer);
          timer = null;
        };
      },
      async input() {},
      async control() {
        return {};
      },
      async close() {
        if (closed) return;
        closed = true;
        if (timer) clearInterval(timer);
        events.onClosed?.("simulator capture lost");
      },
    };
    return handle;
  }
}

async function bootWith(provider: Provider): Promise<{
  base: string;
  ws: string;
  close: () => Promise<void>;
}> {
  const registry = new DeviceRegistry();
  registry.register(new MockProvider());
  registry.register(provider);
  const server = new SimfarmServer({ host: "127.0.0.1", port: 0, registry });
  await server.listen();
  const addr = server.http.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  return {
    base: `http://127.0.0.1:${addr.port}`,
    ws: `ws://127.0.0.1:${addr.port}/v1`,
    close: async () => {
      await server.close();
      await registry.dispose();
    },
  };
}

test("a stream whose device dies ends with an error, frees its id, re-lists the device, and the server lives", async (t) => {
  const srv = await bootWith(new DyingProvider(3));
  t.after(srv.close);
  const client = new Client(srv.ws);
  await client.ready();
  t.after(() => client.close());

  const attach = await client.request({ op: "attach", deviceId: "dying:sim", codec: "jpeg" });
  assert.equal(attach.ok, true);
  assert.equal(attach.streamId, 0);

  // Frames flow, then the device goes.
  for (let i = 0; i < 100 && !events(client, "error").length; i++) await sleep(10);
  const error = events(client, "error").at(-1)!;
  assert.equal(error.streamId, 0);
  assert.match(String(error.message), /Device not booted \(state: Shutdown\)/);
  assert.ok(client.videos().length >= 4, `frames were delivered before the loss (${client.videos().length})`);

  // PROTOCOL §6: the stream is detached server-side — a `log` says so and the
  // id is free — and the device list says shut down.
  await sleep(30);
  const log = events(client, "log").find((e) => e.streamId === 0)!;
  assert.match(String(log.text), /capture lost/);
  const detach = await client.request({ op: "detach", streamId: 0 });
  assert.equal(detach.ok, false);
  assert.match(String(detach.error), /no such stream 0/);
  const devices = events(client, "devices").at(-1)!.devices as Device[];
  assert.equal(devices.find((d) => d.id === "dying:sim")!.state, "shutdown");

  // A single stream failure must never take the server down.
  const health = (await (await fetch(`${srv.base}/healthz`)).json()) as { ok: boolean; sessions: number };
  assert.equal(health.ok, true);
  assert.equal(health.sessions, 1);
  const again = await client.request({ op: "attach", deviceId: "mock:phone" });
  assert.equal(again.ok, true, "other devices still attach on the same connection");
});

test("attach on a device that is not booted is an error reply, not a dead server", async (t) => {
  const provider = new DyingProvider(0);
  const srv = await bootWith(provider);
  t.after(srv.close);
  const client = new Client(srv.ws);
  await client.ready();
  t.after(() => client.close());

  // Put the device down first: one attach loses it immediately.
  const first = await client.request({ op: "attach", deviceId: "dying:sim" });
  assert.equal(first.ok, true);
  for (let i = 0; i < 100 && !events(client, "error").length; i++) await sleep(10);
  await sleep(30);

  const reply = await client.request({ op: "attach", deviceId: "dying:sim" });
  assert.equal(reply.ok, false);
  assert.match(String(reply.error), /is Shutdown; send \{"op":"boot"/);
  assert.equal(((await (await fetch(`${srv.base}/healthz`)).json()) as { ok: boolean }).ok, true);

  // The client's way back is the boot op the error names.
  const boot = await client.request({ op: "boot", deviceId: "dying:sim" });
  assert.equal(boot.ok, true);
  const booted = events(client, "devices").at(-1)!.devices as Device[];
  assert.equal(booted.find((d) => d.id === "dying:sim")!.state, "booted");
  const attach = await client.request({ op: "attach", deviceId: "dying:sim" });
  assert.equal(attach.ok, true);
});

function events(client: Client, name: string): Array<Record<string, unknown>> {
  return client.frames
    .filter((f) => f.channel === "event")
    .map((f) => f.json as Record<string, unknown>)
    .filter((j) => j.ev === name);
}
