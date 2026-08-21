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
