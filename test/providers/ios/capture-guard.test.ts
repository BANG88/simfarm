/**
 * The guard around serve-sim's native SimCapture (serve-sim.ts).
 *
 * serve-sim calls `capture.start()` and drops the promise; the Swift method is
 * `async throws`. The guard is what stands between "Device not booted" and
 * `triggerUncaughtException`, so it is pinned here against a fake addon with
 * the same shape: a rejection is reported with the udid and never escapes.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  guardNativeCapture,
  onCaptureFailure,
  type NativeCapture,
  type NativeCaptureModule,
} from "../../../src/providers/ios/serve-sim.ts";

const UDID = "0A1B2C3D-4E5F-6789-ABCD-0123456789AB";

/** What node-swift's binding rejects with: an Error whose `code` is "NSError". */
function nsError(code: number, text: string): Error & { code: string } {
  const err = new Error(
    `Error Domain=FrameCapture Code=${code} "${text}" UserInfo={NSLocalizedDescription=${text}}`,
  ) as Error & { code: string };
  err.code = "NSError";
  return err;
}

function fakeAddon(behaviour: {
  start?: () => Promise<void>;
  subscribe?: () => Promise<() => unknown>;
}): NativeCaptureModule & { instances: string[] } {
  const instances: string[] = [];
  class SimCapture implements NativeCapture {
    constructor(udid: string) {
      instances.push(udid);
    }
    start(): Promise<void> {
      return behaviour.start ? behaviour.start() : Promise.resolve();
    }
    subscribe(): Promise<() => unknown> {
      return behaviour.subscribe ? behaviour.subscribe() : Promise.resolve(() => {});
    }
    stop(): Promise<void> {
      return Promise.resolve();
    }
  }
  return { SimCapture, instances };
}

/** Catch what the process would otherwise have died of. */
function trapUnhandled(): { count: () => number; restore: () => void } {
  let n = 0;
  const onRejection = (): void => {
    n++;
  };
  process.on("unhandledRejection", onRejection);
  return {
    count: () => n,
    restore: () => process.off("unhandledRejection", onRejection),
  };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

describe("guardNativeCapture", () => {
  it("turns a rejected start() into a report and a resolved promise", async () => {
    const addon = fakeAddon({ start: () => Promise.reject(nsError(2, "Device not booted (state: Shutdown)")) });
    assert.equal(guardNativeCapture(addon), true);

    const seen: Array<{ udid: string; err: unknown; op: string }> = [];
    const off = onCaptureFailure((udid, err, op) => seen.push({ udid, err, op }));
    const trap = trapUnhandled();
    try {
      // Exactly what serve-sim's DeviceSession.start does: call, ignore the promise.
      const capture = new addon.SimCapture(UDID);
      const p = capture.start();
      await assert.doesNotReject(p);
      await tick();
      assert.equal(trap.count(), 0, "the rejection must not reach the process");
      assert.equal(seen.length, 1);
      assert.equal(seen[0]!.udid, UDID);
      assert.equal(seen[0]!.op, "start");
      assert.match(String((seen[0]!.err as Error).message), /Device not booted \(state: Shutdown\)/);
      assert.equal((seen[0]!.err as { code?: string }).code, "NSError");
    } finally {
      off();
      trap.restore();
    }
  });

  it("gives serve-sim a no-op unsubscribe when subscribe() rejects", async () => {
    const addon = fakeAddon({ subscribe: () => Promise.reject(new Error("invalidCodec")) });
    guardNativeCapture(addon);
    const seen: string[] = [];
    const off = onCaptureFailure((_udid, _err, op) => seen.push(op));
    try {
      const capture = new addon.SimCapture(UDID);
      const unsubscribe = await capture.subscribe(0, () => {});
      assert.equal(typeof unsubscribe, "function");
      assert.doesNotThrow(() => unsubscribe());
      assert.deepEqual(seen, ["subscribe"]);
    } finally {
      off();
    }
  });

  it("passes a healthy capture through untouched", async () => {
    let started = 0;
    const addon = fakeAddon({
      start: async () => {
        started++;
      },
    });
    guardNativeCapture(addon);
    const seen: string[] = [];
    const off = onCaptureFailure((_udid, _err, op) => seen.push(op));
    try {
      const capture = new addon.SimCapture(UDID);
      await capture.start();
      await capture.stop();
      assert.equal(started, 1);
      assert.deepEqual(seen, []);
      assert.deepEqual(addon.instances, [UDID], "the real constructor still runs");
    } finally {
      off();
    }
  });

  it("is idempotent and refuses a module that is not the addon it knows", () => {
    const addon = fakeAddon({});
    const Original = addon.SimCapture;
    assert.equal(guardNativeCapture(addon), true);
    const Guarded = addon.SimCapture;
    assert.notEqual(Guarded, Original);
    assert.equal(guardNativeCapture(addon), true);
    assert.equal(addon.SimCapture, Guarded, "a second call must not wrap the wrapper");

    assert.equal(
      guardNativeCapture({ SimCapture: class {} } as unknown as NativeCaptureModule),
      false,
    );
    assert.equal(guardNativeCapture({} as NativeCaptureModule), false);
  });

  it("keeps reporting even when a listener throws", async () => {
    const addon = fakeAddon({ start: () => Promise.reject(nsError(2, "Device not booted (state: Shutdown)")) });
    guardNativeCapture(addon);
    let second = 0;
    const off1 = onCaptureFailure(() => {
      throw new Error("listener bug");
    });
    const off2 = onCaptureFailure(() => {
      second++;
    });
    const trap = trapUnhandled();
    try {
      await new addon.SimCapture(UDID).start();
      await tick();
      assert.equal(second, 1);
      assert.equal(trap.count(), 0);
    } finally {
      off1();
      off2();
      trap.restore();
    }
  });
});
