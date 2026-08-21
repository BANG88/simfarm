import test from "node:test";
import assert from "node:assert/strict";

import { DeviceRegistry, kindOfDeviceId } from "../src/registry.ts";
import { MockProvider } from "../src/providers/mock/mock-provider.ts";
import type { Device, DeviceKind, Provider } from "../src/types.ts";

test("device ids carry their provider kind", () => {
  assert.equal(kindOfDeviceId("ios:1234-ABCD"), "ios");
  assert.equal(kindOfDeviceId("android:emulator-5554"), "android");
  assert.equal(kindOfDeviceId("wechat:deadbeef"), "wechat");
  assert.throws(() => kindOfDeviceId("nocolon"), /malformed/);
  assert.throws(() => kindOfDeviceId(":leading"), /malformed/);
});

test("routing rejects ids no provider owns", async () => {
  const reg = new DeviceRegistry();
  reg.register(new MockProvider());
  await assert.rejects(() => reg.open("ios:nope"), /no provider/);
  await assert.rejects(() => reg.open("mock:nope"), /no such mock device/);
  await reg.dispose();
});

test("registering the same kind twice is a bug, not a silent overwrite", () => {
  const reg = new DeviceRegistry();
  reg.register(new MockProvider());
  assert.throws(() => reg.register(new MockProvider()), /already registered/);
});

test("watchers see the merged device list", async () => {
  const reg = new DeviceRegistry();
  const seen: Device[][] = [];
  reg.watch((d) => seen.push(d));

  const flaky = new FlakyProvider();
  reg.register(new MockProvider());
  reg.register(flaky);
  await new Promise((r) => setTimeout(r, 20));

  const last = seen.at(-1)!;
  assert.deepEqual(
    last.map((d) => d.id).sort(),
    ["flaky:a", "mock:pad", "mock:phone"],
  );

  flaky.emit([]);
  assert.deepEqual(
    seen.at(-1)!.map((d) => d.id).sort(),
    ["mock:pad", "mock:phone"],
  );
  await reg.dispose();
});

test("one failing provider does not sink list()", async () => {
  const reg = new DeviceRegistry();
  const flaky = new FlakyProvider();
  reg.register(new MockProvider());
  reg.register(flaky);
  await new Promise((r) => setTimeout(r, 20));

  const errors: unknown[] = [];
  reg.onProviderError = (_kind, err) => errors.push(err);
  flaky.failList = true;

  const devices = await reg.list();
  assert.ok(devices.some((d) => d.id === "mock:phone"));
  assert.ok(
    devices.some((d) => d.id === "flaky:a"),
    "falls back to the last known good list",
  );
  assert.equal(errors.length, 1);
  await reg.dispose();
});

class FlakyProvider implements Provider {
  readonly kind = "flaky" as DeviceKind;
  failList = false;
  private cb: ((d: Device[]) => void) | null = null;
  private devices: Device[] = [
    {
      id: "flaky:a",
      kind: this.kind,
      name: "Flaky",
      state: "booted",
      capabilities: {
        video: ["jpeg"],
        touch: false,
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
      boot: false,
      },
    },
  ];

  async list(): Promise<Device[]> {
    if (this.failList) throw new Error("adb is having a day");
    return this.devices;
  }
  watch(cb: (d: Device[]) => void): () => void {
    this.cb = cb;
    queueMicrotask(() => cb(this.devices));
    return () => {
      this.cb = null;
    };
  }
  async open(): Promise<never> {
    throw new Error("not implemented");
  }
  emit(devices: Device[]): void {
    this.devices = devices;
    this.cb?.(devices);
  }
}
