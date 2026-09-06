/**
 * Provider-level wiring that does not need a booted simulator.
 *
 * The middleware-order test is a safety property, not a style check: main.ts
 * mounts whatever `middleware()` returns in order, so if serve-sim ever ended
 * up in front of the guard, `/_ios/exec` would be live (ARCHITECTURE.md).
 */

import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";

import { IosProvider, selfUrl, udidOf } from "../../../src/providers/ios/ios-provider.ts";

const UDID = "0A1B2C3D-4E5F-6789-ABCD-0123456789AB";

describe("IosProvider wiring", () => {
  it("registers under the ios kind so the registry routes ios: ids to it", () => {
    assert.equal(new IosProvider().kind, "ios");
  });

  it("returns the guard first and serve-sim second", () => {
    const mws = new IosProvider().middleware();
    assert.equal(mws.length, 2);

    // Drive only the first middleware. If it is the guard, an exec request dies
    // here and `next` is never called.
    let nexted = false;
    const req = { url: "/_ios/exec", method: "POST" } as http.IncomingMessage;
    let status = 0;
    const res = {
      headersSent: false,
      writeHead(code: number) {
        status = code;
        return this;
      },
      end() {},
    } as unknown as http.ServerResponse;

    mws[0]!(req, res, () => {
      nexted = true;
    });
    assert.equal(nexted, false, "exec reached the next middleware");
    assert.equal(status, 404);
  });

  it("the exec route it guards is genuinely live behind the guard", async () => {
    // Establish that the hazard is real before asserting it is closed: with
    // *only* serve-sim mounted, an unauthenticated POST reaches its exec
    // handler and gets its 401 — i.e. the route exists at `/_ios/exec` and the
    // sole thing standing between the network and `exec(command)` is a bearer
    // token printed to a log. That is what ARCHITECTURE.md is about.
    const serveSimOnly = new IosProvider().middleware()[1]!;
    await withServer([serveSimOnly], async (base) => {
      const res = await fetch(`${base}/_ios/exec`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: "id" }),
      });
      assert.equal(res.status, 401);
      assert.match(await res.text(), /Unauthorized/);
    });
  });

  it("with the full stack mounted, exec and the preview UI are gone", async () => {
    // The genuine middleware pair, in the order main.ts mounts them.
    await withServer(new IosProvider().middleware(), async (base) => {
      for (const [path, method] of [
        ["/_ios/exec", "POST"],
        ["/_ios/exec-ws", "GET"],
        ["/_ios", "GET"],
        ["/_ios/", "GET"],
      ] as const) {
        const res = await fetch(base + path, {
          method,
          ...(method === "POST"
            ? { headers: { "content-type": "application/json" }, body: "{}" }
            : {}),
        });
        assert.equal(res.status, 404, `${method} ${path}`);
        // Our guard's body, not serve-sim's — proof it never ran.
        assert.equal(await res.text(), "not found", `${method} ${path}`);
      }
    });
  });
});

/**
 * Run `stack` as a connect chain on a throwaway loopback server.
 *
 * Note for anyone extending this file: do **not** request
 * `/_ios/helper/<udid>/…` here. serve-sim creates a native capture session on
 * first touch — even for a udid that does not exist — and that session keeps
 * the event loop alive, so the test process never exits. Anything needing a
 * live session belongs in the evidence harness, not in `npm test`.
 */
async function withServer(
  stack: Array<(req: http.IncomingMessage, res: http.ServerResponse, next: () => void) => void>,
  body: (base: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer((req, res) => {
    let i = 0;
    const next = (): void => {
      const mw = stack[i++];
      if (mw) mw(req, res, next);
      else res.writeHead(404).end("builtin");
    };
    next();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  try {
    await body(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

describe("device ids", () => {
  it("accepts the ios: prefix the registry routes on", () => {
    assert.equal(udidOf(`ios:${UDID}`), UDID);
    assert.equal(udidOf(UDID), UDID);
    assert.equal(udidOf(`ios:${UDID.toLowerCase()}`), UDID.toLowerCase());
  });

  it("rejects anything that is not a udid", () => {
    for (const bad of [
      "ios:",
      "ios:nope",
      "android:emulator-5554",
      `ios:${UDID}/../exec`,
      `ios:${UDID}x`,
      "",
    ]) {
      assert.throws(() => udidOf(bad), /not an iOS device id/, bad);
    }
  });
});

describe("selfUrl", () => {
  it("uses the context's own base url when it is addressable", () => {
    assert.equal(
      selfUrl({ host: "127.0.0.1", port: 3312, baseUrl: "http://127.0.0.1:3312" }),
      "http://127.0.0.1:3312",
    );
    assert.equal(
      selfUrl({
        host: "10.1.2.3",
        port: 3312,
        baseUrl: "http://10.1.2.3:3312",
      }),
      "http://10.1.2.3:3312",
    );
  });

  it("falls back to loopback for a wildcard bind, which is not a destination", () => {
    assert.equal(
      selfUrl({ host: "0.0.0.0", port: 3312, baseUrl: "http://0.0.0.0:3312" }),
      "http://127.0.0.1:3312",
    );
    assert.equal(
      selfUrl({ host: "::", port: 3312, baseUrl: "http://[::]:3312" }),
      "http://127.0.0.1:3312",
    );
  });
});

/**
 * A simulator going away, seen from the provider, without a simulator.
 *
 * simctl is stubbed through the `simctl` option; serve-sim is stood in for by
 * a plain HTTP server answering the two routes these paths touch. The real
 * serve-sim middleware is still loaded (`middleware()` is what installs the
 * capture guard) but never mounted, so no native capture session is ever
 * created — see the note on `withServer` above.
 */
import { reportCaptureFailure } from "../../../src/providers/ios/serve-sim.ts";
import type { SimDevice } from "../../../src/providers/ios/simctl.ts";
import type { Device } from "../../../src/types.ts";

const NS_NOT_BOOTED =
  'Error Domain=FrameCapture Code=2 "Device not booted (state: Shutdown)" UserInfo={NSLocalizedDescription=Device not booted (state: Shutdown)}';

interface FakeServeSim {
  port: number;
  /** requests in arrival order, "METHOD path" */
  hits: string[];
  close: () => Promise<void>;
}

/** The slice of serve-sim's routes these tests reach: /config and the grid actions. */
async function fakeServeSim(): Promise<FakeServeSim> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    const url = req.url ?? "";
    hits.push(`${req.method} ${url}`);
    if (/^\/_ios\/helper\/[^/]+\/config$/.test(url)) {
      // What serve-sim answers while its capture has produced no frame — and
      // forever, once that capture has rejected.
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ width: 0, height: 0, orientation: "portrait" }));
      return;
    }
    if (url === "/_ios/grid/api/shutdown") {
      // serve-sim closes its DeviceSession first, then runs `simctl shutdown`,
      // which fails on a device that is already down — hence 500, session gone.
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Unable to shutdown device in current state: Shutdown" }));
      return;
    }
    if (url === "/_ios/grid/api/start") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return {
    port: (server.address() as AddressInfo).port,
    hits,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

function simDevice(state: string): SimDevice {
  return { udid: UDID, name: "Spare iPhone", state, runtime: "iOS 26.5" };
}

async function providerAgainst(
  fake: FakeServeSim,
  state: { current: string },
): Promise<{ provider: IosProvider; lists: Device[][] }> {
  const provider = new IosProvider({
    jpegMaxSize: 0,
    simctl: {
      listDevices: async () => [simDevice(state.current)],
      deviceGeometry: async () => null,
    },
  });
  provider.middleware();
  await provider.init({ host: "127.0.0.1", port: fake.port, baseUrl: `http://127.0.0.1:${fake.port}` });
  const lists: Device[][] = [];
  provider.watch((devices) => lists.push(devices));
  await new Promise((r) => setTimeout(r, 10));
  return { provider, lists };
}

describe("IosProvider when the simulator is not there to stream", () => {
  it("answers attach on a shut-down simulator with an error and never touches serve-sim", async () => {
    const fake = await fakeServeSim();
    const state = { current: "Shutdown" };
    const { provider } = await providerAgainst(fake, state);
    try {
      await assert.rejects(
        provider.open(`ios:${UDID}`),
        /simulator Spare iPhone is Shutdown; send \{"op":"boot","deviceId":"ios:0A1B2C3D-4E5F-6789-ABCD-0123456789AB"\} first/,
      );
      assert.deepEqual(fake.hits, [], "no helper request, so no serve-sim session for a device that is down");
    } finally {
      await provider.dispose();
      await fake.close();
    }
  });

  it("fails attach at once when the capture rejects, then drops the dead session once the device is seen down", async () => {
    const fake = await fakeServeSim();
    // simctl says Booted (the zombie the crash log shows) — the native side
    // disagrees, and says so through the capture guard mid-wait.
    const state = { current: "Booted" };
    const { provider, lists } = await providerAgainst(fake, state);
    try {
      const opening = provider.open(`ios:${UDID}`);
      // Let waitForScreen ask /config once, then have the capture fail the way
      // serve-sim's DeviceSession.start would have.
      await new Promise((r) => setTimeout(r, 30));
      reportCaptureFailure(UDID, Object.assign(new Error(NS_NOT_BOOTED), { code: "NSError" }));
      await assert.rejects(opening, (err: Error) => {
        assert.match(err.message, /simulator Spare iPhone cannot be captured/);
        assert.match(err.message, /Device not booted \(state: Shutdown\)/);
        assert.match(err.message, new RegExp(`xcrun simctl shutdown ${UDID}`));
        return true;
      });
      // Well inside SCREEN_READY_MS: the failure short-circuited the wait.
      assert.ok(fake.hits.some((h) => h.startsWith(`GET /_ios/helper/${UDID}/config`)));
      await new Promise((r) => setTimeout(r, 30));
      // simctl still calls it Booted, so nothing is shut down on the user's
      // behalf and a second attach gets the same fast answer.
      assert.ok(!fake.hits.includes("POST /_ios/grid/api/shutdown"), "must not shut down a device simctl calls Booted");
      await assert.rejects(provider.open(`ios:${UDID}`), /cannot be captured/);

      // The user shuts it down; the next poll notices and has serve-sim drop
      // the session, and the watchers hear the device is down.
      state.current = "Shutdown";
      await provider.poll();
      assert.ok(fake.hits.includes("POST /_ios/grid/api/shutdown"), "the dead session is dropped through the grid route");
      assert.equal(lists.at(-1)![0]!.state, "shutdown");

      // Booted again: attach reaches serve-sim afresh instead of the old failure.
      state.current = "Booted";
      const shutdownsBefore = fake.hits.filter((h) => h === "POST /_ios/grid/api/shutdown").length;
      const configsBefore = fake.hits.filter((h) => h.includes("/config")).length;
      const again = provider.open(`ios:${UDID}`);
      await new Promise((r) => setTimeout(r, 30));
      assert.ok(fake.hits.filter((h) => h.includes("/config")).length > configsBefore, "a fresh attach asks serve-sim again");
      // (the fake never produces a frame; end the wait the same way)
      reportCaptureFailure(UDID, new Error("stopped by the test"));
      await assert.rejects(again, /stopped by the test/);
      assert.equal(fake.hits.filter((h) => h === "POST /_ios/grid/api/shutdown").length, shutdownsBefore);
    } finally {
      await provider.dispose();
      await fake.close();
    }
  });

  it("drops a leftover session before booting, and forgets it on shutdown", async () => {
    const fake = await fakeServeSim();
    const state = { current: "Shutdown" };
    const { provider } = await providerAgainst(fake, state);
    try {
      // A session exists only once open() touched /config; simulate that
      // history through a capture failure, which is one way to acquire one.
      reportCaptureFailure(UDID, new Error(NS_NOT_BOOTED));
      await new Promise((r) => setTimeout(r, 30));
      fake.hits.length = 0;
      await provider.control("boot", { deviceId: `ios:${UDID}` });
      assert.deepEqual(fake.hits, ["POST /_ios/grid/api/start"], "nothing left to drop after the failure was reconciled");

      await assert.rejects(
        provider.control("shutdown", { deviceId: `ios:${UDID}` }),
        /Unable to shutdown device in current state/,
      );
      assert.equal(fake.hits.at(-1), "POST /_ios/grid/api/shutdown");
    } finally {
      await provider.dispose();
      await fake.close();
    }
  });
});
