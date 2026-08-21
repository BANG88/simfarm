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
