import test from "node:test";
import assert from "node:assert/strict";

import { Session, pickCodec, type Transport } from "../src/session.ts";
import { DeviceRegistry } from "../src/registry.ts";
import { MockProvider } from "../src/providers/mock/mock-provider.ts";
import {
  VIDEO_TAG,
  decodeFrame,
  encodeControl,
  encodeInput,
  type InputMessage,
  type WireFrame,
} from "../src/protocol.ts";
import type {
  Device,
  DeviceHandle,
  DeviceKind,
  Provider,
} from "../src/types.ts";

class FakeTransport implements Transport {
  readonly frames: WireFrame[] = [];
  buffered = 0;
  closed = false;

  send(data: Uint8Array): void {
    this.frames.push(decodeFrame(data));
  }
  bufferedAmount(): number {
    return this.buffered;
  }
  close(): void {
    this.closed = true;
  }

  controls(): Array<Record<string, unknown>> {
    return this.frames
      .filter((f) => f.channel === "control")
      .map((f) => f.json as Record<string, unknown>);
  }
  events(name?: string): Array<Record<string, unknown>> {
    return this.frames
      .filter((f) => f.channel === "event")
      .map((f) => f.json as Record<string, unknown>)
      .filter((j) => !name || j.ev === name);
  }
  videos(): Array<{ streamId: number; tag: number; size: number }> {
    return this.frames
      .filter((f) => f.channel === "video")
      .map((f) => ({
        streamId: (f as { streamId: number }).streamId,
        tag: (f as { tag: number }).tag,
        size: (f as { data: Uint8Array }).data.length,
      }));
  }
  reply(id: number): Record<string, unknown> | undefined {
    return this.controls().find((c) => c.id === id);
  }
}

/** A provider that records what the session hands it. */
class RecordingProvider implements Provider {
  readonly kind = "rec" as DeviceKind;
  readonly inputs: InputMessage[] = [];
  failInput = false;

  private readonly device: Device = {
    id: "rec:one",
    kind: this.kind,
    name: "Recorder",
    state: "booted",
    screen: { width: 100, height: 200, scale: 1, orientation: "portrait" },
    capabilities: {
      video: ["jpeg"],
      touch: true,
      multitouch: true,
      keyboard: true,
      text: true,
      scroll: true,
      buttons: [],
      rotate: false,
      edgeGesture: false,
      clipboard: false,
      ax: false,
      deeplink: false,
      mediaDrop: false,
      appearance: false,
      boot: false,
    },
  };

  async list(): Promise<Device[]> {
    return [this.device];
  }
  watch(cb: (devices: Device[]) => void): () => void {
    queueMicrotask(() => cb([this.device]));
    return () => {};
  }
  async open(): Promise<DeviceHandle> {
    const self = this;
    return {
      device: self.device,
      async startVideo() {
        return () => {};
      },
      async input(msg: InputMessage) {
        if (self.failInput) throw new Error("nope");
        self.inputs.push(msg);
      },
      async control() {
        return {};
      },
      async close() {},
    };
  }
}

const silent = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function setup(): { session: Session; tx: FakeTransport; reg: DeviceRegistry } {
  const reg = new DeviceRegistry();
  reg.register(new MockProvider());
  const tx = new FakeTransport();
  return { session: new Session(tx, reg, silent), tx, reg };
}

const send = (s: Session, req: unknown) =>
  s.handleMessage(encodeControl(req));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("start() pushes the device list", async (t) => {
  const { session, tx, reg } = setup();
  t.after(async () => {
    await session.close();
    await reg.dispose();
  });

  session.start();
  await sleep(30);

  const devices = tx.events("devices");
  assert.ok(devices.length >= 1, "expected a devices event");
  const list = devices.at(-1)!.devices as Array<{ id: string }>;
  assert.deepEqual(
    list.map((d) => d.id).sort(),
    ["mock:pad", "mock:phone"],
  );
});

test("list op answers with every device", async (t) => {
  const { session, tx, reg } = setup();
  t.after(async () => {
    await session.close();
    await reg.dispose();
  });

  await send(session, { id: 1, op: "list" });
  const reply = tx.reply(1)!;
  assert.equal(reply.ok, true);
  assert.equal((reply.devices as unknown[]).length, 2);
});

test("attach starts a video stream and seeds it immediately", async (t) => {
  const { session, tx, reg } = setup();
  t.after(async () => {
    await session.close();
    await reg.dispose();
  });

  await send(session, { id: 1, op: "attach", deviceId: "mock:phone" });
  const reply = tx.reply(1)!;
  assert.equal(reply.ok, true);
  assert.equal(reply.streamId, 0);
  assert.equal(reply.codec, "jpeg");

  const first = tx.videos()[0];
  assert.ok(first, "expected a video frame right after attach");
  assert.equal(first.tag, VIDEO_TAG.SEED, "first frame must be a SEED jpeg");
  assert.ok(first.size > 1000, "seed frame should carry a real jpeg");

  // a screen event tells the client the pixel size before any frame decodes
  const screen = tx.events("screen").at(-1)!;
  assert.equal(screen.streamId, 0);
  assert.equal(screen.width, 390);
  assert.equal(screen.height, 844);
  assert.equal(screen.orientation, "portrait");

  await sleep(200);
  const keys = tx.videos().filter((v) => v.tag === VIDEO_TAG.KEY);
  assert.ok(keys.length >= 1, "video should keep flowing after the seed");
});

test("two attaches get distinct stream ids and both stream", async (t) => {
  const { session, tx, reg } = setup();
  t.after(async () => {
    await session.close();
    await reg.dispose();
  });

  await send(session, { id: 1, op: "attach", deviceId: "mock:phone" });
  await send(session, { id: 2, op: "attach", deviceId: "mock:pad" });
  assert.equal(tx.reply(1)!.streamId, 0);
  assert.equal(tx.reply(2)!.streamId, 1);

  await sleep(200);
  const ids = new Set(tx.videos().map((v) => v.streamId));
  assert.deepEqual([...ids].sort(), [0, 1]);
});

test("detach stops the stream and frees the id", async (t) => {
  const { session, tx, reg } = setup();
  t.after(async () => {
    await session.close();
    await reg.dispose();
  });

  await send(session, { id: 1, op: "attach", deviceId: "mock:phone" });
  await send(session, { id: 2, op: "detach", streamId: 0 });
  assert.equal(tx.reply(2)!.ok, true);

  const before = tx.videos().length;
  await sleep(150);
  assert.equal(tx.videos().length, before, "no frames after detach");

  await send(session, { id: 3, op: "attach", deviceId: "mock:pad" });
  assert.equal(tx.reply(3)!.streamId, 0, "stream id 0 is reusable");
});

test("input reaches the device and stale moves are dropped", async (t) => {
  const reg = new DeviceRegistry();
  const recorder = new RecordingProvider();
  reg.register(recorder);
  const tx = new FakeTransport();
  const session = new Session(tx, reg, silent);
  t.after(async () => {
    await session.close();
    await reg.dispose();
  });

  await send(session, { id: 1, op: "attach", deviceId: "rec:one" });

  const touch = (phase: 0 | 1 | 2, seq: number, x: number) =>
    session.handleMessage(
      encodeInput(0, { kind: "touch", phase, x, y: 0.5, seq, edge: 0 }),
    );

  await touch(0, 10, 0.5);
  await touch(1, 11, 0.6);
  await touch(1, 9, 0.1); // stale: arrived late, must be dropped
  await touch(1, 11, 0.7); // duplicate seq: also dropped
  await touch(2, 12, 0.6);

  const seqs = recorder.inputs
    .filter((m) => m.kind === "touch")
    .map((m) => (m as { seq: number }).seq);
  assert.deepEqual(seqs, [10, 11, 12]);
  assert.equal(tx.events("error").length, 0);

  // a begin always passes, even when its seq looks older (new gesture)
  await touch(0, 3, 0.2);
  assert.equal(recorder.inputs.at(-1)!.kind, "touch");
  assert.equal((recorder.inputs.at(-1) as { seq: number }).seq, 3);
});

test("an input failure is reported on the event channel", async (t) => {
  const reg = new DeviceRegistry();
  const recorder = new RecordingProvider();
  recorder.failInput = true;
  reg.register(recorder);
  const tx = new FakeTransport();
  const session = new Session(tx, reg, silent);
  t.after(async () => {
    await session.close();
    await reg.dispose();
  });

  await send(session, { id: 1, op: "attach", deviceId: "rec:one" });
  await session.handleMessage(
    encodeInput(0, { kind: "touch", phase: 0, x: 0, y: 0, seq: 1, edge: 0 }),
  );
  const err = tx.events("error").at(-1)!;
  assert.equal(err.streamId, 0);
  assert.match(String(err.message), /nope/);
});

test("input for an unknown stream is ignored, not fatal", async (t) => {
  const { session, tx, reg } = setup();
  t.after(async () => {
    await session.close();
    await reg.dispose();
  });

  await session.handleMessage(
    encodeInput(9, { kind: "touch", phase: 0, x: 0, y: 0, seq: 1, edge: 0 }),
  );
  assert.equal(tx.frames.length, 0);
});

test("rotate swaps the screen and announces it", async (t) => {
  const { session, tx, reg } = setup();
  t.after(async () => {
    await session.close();
    await reg.dispose();
  });

  await send(session, { id: 1, op: "attach", deviceId: "mock:phone" });
  await send(session, {
    id: 2,
    op: "rotate",
    streamId: 0,
    orientation: "landscape_left",
  });
  assert.equal(tx.reply(2)!.ok, true);

  const screen = tx.events("screen").at(-1)!;
  assert.equal(screen.width, 844);
  assert.equal(screen.height, 390);
  assert.equal(screen.orientation, "landscape_left");
});

test("bad requests produce error replies, never a dead session", async (t) => {
  const { session, tx, reg } = setup();
  t.after(async () => {
    await session.close();
    await reg.dispose();
  });

  await send(session, { id: 1, op: "attach", deviceId: "mock:nope" });
  assert.equal(tx.reply(1)!.ok, false);

  await send(session, { id: 2, op: "attach", deviceId: "ios:whatever" });
  assert.match(String(tx.reply(2)!.error), /no provider/);

  await send(session, { id: 3, op: "attach", deviceId: "mock:phone", codec: "h264" });
  assert.match(String(tx.reply(3)!.error), /not supported/);

  await send(session, { id: 4, op: "detach", streamId: 42 });
  assert.equal(tx.reply(4)!.ok, false);

  await send(session, { id: 5, op: "nonsense" });
  assert.equal(tx.reply(5)!.ok, false);

  await send(session, { op: "list" });
  assert.equal(tx.reply(0)!.ok, false);

  // still alive
  await send(session, { id: 6, op: "list" });
  assert.equal(tx.reply(6)!.ok, true);
});

test("garbage bytes are reported, not thrown", async (t) => {
  const { session, tx, reg } = setup();
  t.after(async () => {
    await session.close();
    await reg.dispose();
  });

  await session.handleMessage(new Uint8Array([0xee, 0x01]));
  assert.equal(tx.events("error").length, 1);
});

test("video is dropped under backpressure", async (t) => {
  const { session, tx, reg } = setup();
  t.after(async () => {
    await session.close();
    await reg.dispose();
  });

  await send(session, { id: 1, op: "attach", deviceId: "mock:phone" });
  tx.buffered = 8 * 1024 * 1024;
  const before = tx.videos().length;
  await sleep(200);
  assert.equal(tx.videos().length, before, "frames dropped while backed up");

  tx.buffered = 0;
  await sleep(200);
  assert.ok(tx.videos().length > before, "frames resume once drained");
});

test("close() tears every stream down", async (t) => {
  const { session, tx, reg } = setup();
  t.after(async () => reg.dispose());

  await send(session, { id: 1, op: "attach", deviceId: "mock:phone" });
  await send(session, { id: 2, op: "attach", deviceId: "mock:pad" });
  await session.close();

  const before = tx.videos().length;
  await sleep(150);
  assert.equal(tx.videos().length, before);
});

test("pickCodec prefers h264 and rejects the unsupported", () => {
  assert.equal(pickCodec(["h264", "jpeg"]), "h264");
  assert.equal(pickCodec(["jpeg"]), "jpeg");
  assert.equal(pickCodec(["h264", "jpeg"], "jpeg"), "jpeg");
  assert.throws(() => pickCodec(["jpeg"], "h264"), /not supported/);
  assert.throws(() => pickCodec([]), /no video codec/);
});
