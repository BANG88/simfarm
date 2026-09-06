/**
 * Loader for serve-sim's public `./middleware` export.
 *
 * It is loaded with `createRequire` rather than a static `import` on purpose.
 * serve-sim's package.json points the `types` condition at its raw
 * `src/middleware.ts`, which imports several modules that are not in its
 * published `files` list and uses extensionless relative specifiers — under
 * this repo's `moduleResolution: nodenext` that produces ~15 type errors in a
 * dependency we do not own, and `skipLibCheck` does not suppress them because
 * the file is `.ts`, not `.d.ts`. Going through `require()` keeps the runtime
 * behaviour identical (the CJS entry just re-exports the ESM bundle) while
 * keeping the dependency's sources out of our program. The surface we actually
 * use is declared below.
 *
 * This is also the only place that knows serve-sim exists; everything else in
 * the provider talks HTTP/WebSocket to routes it mounted.
 *
 * The capture guard
 * -----------------
 * The addon's `SimCapture.start` is `@NodeMethod func start() async throws`
 * (Sources/SimNative/sim-module.swift): on a device that is not booted — or
 * one CoreSimulator considers Shutdown while `simctl list` still says Booted
 * — its promise rejects with `Error Domain=FrameCapture Code=2 "Device not
 * booted (state: Shutdown)"`. serve-sim 0.1.45's in-process `DeviceSession`
 * called `this.capture.start()` and never looked at that promise, and Node's
 * default for the unhandled rejection is to exit: one touch of `/config`,
 * `/foreground` or a stream route for such a device took the whole server
 * down (simfarm.log.crash-*). serve-sim 0.1.46 (its PR #140) awaits the
 * call, attaches a rejection observer of its own, answers the stream route
 * 503 `capture_unavailable` and evicts the failed session, so the process
 * would survive on its own now. The guard stays because the provider wants
 * more than survival: the rejection has to reach it with the udid, so it can
 * end the affected stream with the reason, fail a pending `attach` at once,
 * re-list the device and drop the dead session (ios-provider.ts,
 * onCaptureFailure). Those are the paths test/providers/ios and
 * test/server.test.ts pin down.
 *
 * The addon exports a plain, writable `SimCapture` class, and serve-sim reads
 * it off the module object at every `new` (dist/middleware.js, its
 * `NativeCapture` wrapper). So before serve-sim first touches it we swap in a
 * subclass whose `start` / `subscribe` / `stop` settle their promises here:
 * the rejection is reported to the provider, and serve-sim sees a resolved
 * promise, exactly as it would have on a device that produces no frames —
 * which also keeps its own 503-and-evict path dormant behind this one.
 * Verified against serve-sim@0.1.46; the shape is asserted at load time and a
 * mismatch only logs, because the process-level guard in src/main.ts still
 * stands behind this one.
 */

import { createRequire } from "node:module";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";

import { logger } from "../../util/log.ts";

const log = logger("ios");

export interface SimMiddlewareOptions {
  /** Where to mount. Default "/.sim"; we always pass "/_ios". */
  basePath?: string;
  /** Pin the preview to one simulator. Unused — we address devices per route. */
  device?: string;
  /** Bearer token for its exec route. We never expose that route (ARCHITECTURE.md). */
  execToken?: string;
}

/** Connect-style, but with an async `next`. */
export interface SimMiddleware {
  (req: IncomingMessage, res: ServerResponse, next?: () => Promise<void>): Promise<void>;
  handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void;
}

interface ServeSimModule {
  simMiddleware(options?: SimMiddlewareOptions): SimMiddleware;
}

const require_ = createRequire(import.meta.url);

let cached: ServeSimModule | null = null;

export function loadServeSim(): ServeSimModule {
  if (!cached) {
    const entry = require_.resolve("serve-sim/middleware");
    cached = require_(entry) as ServeSimModule;
    if (typeof cached.simMiddleware !== "function") {
      throw new Error("serve-sim/middleware did not export simMiddleware");
    }
    // Before any request can reach serve-sim, so the very first DeviceSession
    // is already built on the guarded class.
    guardServeSimNative(entry);
  }
  return cached;
}

// ---------------------------------------------------------------------------
// native capture guard
// ---------------------------------------------------------------------------

/** Which native call failed. `start` is the one that says "Device not booted". */
export type CaptureOp = "start" | "subscribe" | "stop";

export type CaptureFailureListener = (udid: string, err: unknown, op: CaptureOp) => void;

/**
 * The slice of node-swift's `SimCapture` we go through
 * (Sources/SimNative/sim-module.swift). Every method is `async` on the Swift
 * side, hence every one returns a promise.
 */
export interface NativeCapture {
  start(): Promise<void>;
  subscribe(codec: number, onFrame: (...args: unknown[]) => unknown): Promise<() => unknown>;
  stop(): Promise<void>;
}

export interface NativeCaptureModule {
  SimCapture: new (udid: string) => NativeCapture;
}

const listeners = new Set<CaptureFailureListener>();

/** Hear about native capture calls that rejected. @returns unsubscribe */
export function onCaptureFailure(cb: CaptureFailureListener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * Deliver one failure to every listener. Exported so the provider can be
 * exercised without a simulator: this is the only thing the guard does with a
 * rejection.
 */
export function reportCaptureFailure(udid: string, err: unknown, op: CaptureOp = "start"): void {
  for (const cb of listeners) {
    try {
      cb(udid, err, op);
    } catch (cbErr) {
      log.warn(`capture failure listener threw: ${String(cbErr)}`);
    }
  }
}

const GUARDED = Symbol.for("simfarm.ios.guardedSimCapture");

/**
 * Replace `native.SimCapture` with a subclass that settles its promises.
 * Idempotent. Returns false when the module does not look like the addon we
 * know, in which case nothing is changed.
 */
export function guardNativeCapture(native: NativeCaptureModule): boolean {
  const Native = native.SimCapture as (new (udid: string) => NativeCapture) & {
    [GUARDED]?: true;
  };
  if (typeof Native !== "function") return false;
  if (Native[GUARDED]) return true;
  const proto = Native.prototype as Partial<NativeCapture>;
  if (
    typeof proto.start !== "function" ||
    typeof proto.subscribe !== "function" ||
    typeof proto.stop !== "function"
  ) {
    return false;
  }

  class GuardedSimCapture extends Native {
    readonly udid: string;

    constructor(udid: string) {
      super(udid);
      this.udid = udid;
    }

    override start(): Promise<void> {
      return settle(this.udid, "start", () => super.start(), undefined);
    }

    override subscribe(
      codec: number,
      onFrame: (...args: unknown[]) => unknown,
    ): Promise<() => unknown> {
      // serve-sim stores the result as its unsubscribe function, or calls it
      // straight away when the session was closed meanwhile; a no-op keeps
      // both paths whole.
      return settle(this.udid, "subscribe", () => super.subscribe(codec, onFrame), () => () => {});
    }

    override stop(): Promise<void> {
      return settle(this.udid, "stop", () => super.stop(), undefined);
    }
  }
  (GuardedSimCapture as typeof GuardedSimCapture & { [GUARDED]?: true })[GUARDED] = true;

  native.SimCapture = GuardedSimCapture;
  return true;
}

/**
 * Run one native call; a rejection (or a synchronous throw, should the
 * binding ever produce one) becomes a report plus the fallback value.
 */
async function settle<T>(
  udid: string,
  op: CaptureOp,
  call: () => Promise<T>,
  fallback: T | (() => T),
): Promise<T> {
  try {
    return await call();
  } catch (err) {
    reportCaptureFailure(udid, err, op);
    return typeof fallback === "function" ? (fallback as () => T)() : fallback;
  }
}

/**
 * Find the addon serve-sim will load and guard it first. Both loads go
 * through `Module._load` with the same absolute path, so serve-sim receives
 * the very object patched here.
 */
function guardServeSimNative(middlewareEntry: string): void {
  const addon = path.join(path.dirname(middlewareEntry), "native", "serve-sim-native.node");
  let native: NativeCaptureModule;
  try {
    native = require_(addon) as NativeCaptureModule;
  } catch (err) {
    log.warn(
      `could not load ${addon} ahead of serve-sim (${String(err)}); a capture failure on a ` +
        `shut-down simulator will be caught by the process guard instead of ending its stream cleanly`,
    );
    return;
  }
  if (!guardNativeCapture(native)) {
    log.warn(
      `serve-sim's native SimCapture does not look like the class this build knows; ` +
        `capture failures fall through to the process guard`,
    );
  }
}
