/**
 * ARCHITECTURE.md is the whole point of this file: serve-sim's middleware carries a
 * shell-exec endpoint and a preview UI, and we mount it inside our own server.
 * If the guard leaks, an unauthenticated caller on the Tailscale interface gets
 * arbitrary command execution on this mac.
 *
 * These tests drive a *real* HTTP server with the real middleware stack in the
 * real order — guard first, then a stand-in for serve-sim that records every
 * request that reached it. A test that only called `decide()` would not prove
 * the wiring, and the wiring is what ARCHITECTURE.md is about.
 */

import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

import { simGuard } from "../../../src/providers/ios/sim-guard.ts";
import { decide } from "../../../src/providers/ios/sim-paths.ts";
import type { HttpMiddleware } from "../../../src/types.ts";

const UDID = "00000000-0000-0000-0000-000000000000";

/** Everything the guard let through, in order. */
const reached: string[] = [];

/** Stands in for `simMiddleware()`; records instead of running shell commands. */
const fakeServeSim: HttpMiddleware = (req, res) => {
  reached.push(`${req.method} ${req.url}`);
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("SERVE-SIM");
};

let server: http.Server;
let base = "";

before(async () => {
  const stack: HttpMiddleware[] = [simGuard(), fakeServeSim];
  server = http.createServer((req, res) => {
    let i = 0;
    const next = (): void => {
      const mw = stack[i++];
      if (mw) mw(req, res, next);
      else res.writeHead(404).end("builtin 404");
    };
    next();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

async function get(path: string, method = "GET"): Promise<number> {
  const before = reached.length;
  const res = await fetch(base + path, { method });
  await res.text();
  // Anything that got past the guard shows up here; the assertion helpers
  // below use it so "blocked" means "serve-sim never saw it", not just "404".
  (get as unknown as { leaked: boolean }).leaked = reached.length > before;
  return res.status;
}

function leaked(): boolean {
  return (get as unknown as { leaked: boolean }).leaked;
}

async function assertBlocked(path: string, method = "GET"): Promise<void> {
  const status = await get(path, method);
  assert.equal(status, 404, `${method} ${path} should 404`);
  assert.equal(leaked(), false, `${method} ${path} reached serve-sim`);
}

async function assertForwarded(path: string, method = "GET"): Promise<void> {
  const status = await get(path, method);
  assert.equal(status, 200, `${method} ${path} should reach serve-sim`);
  assert.equal(leaked(), true, `${method} ${path} did not reach serve-sim`);
}

describe("serve-sim exec endpoint is unreachable", () => {
  // serve-sim mounts exec at `{basePath}/exec`. ARCHITECTURE.md spells it
  // `/_ios/.sim/exec`, which is what it would be at serve-sim's *default*
  // basePath; both spellings are covered here so the requirement holds
  // whichever one the reader had in mind.
  const attempts = [
    "/_ios/exec",
    "/_ios/exec/",
    "/_ios/exec?x=1",
    "/_ios/.sim/exec",
    "/_ios/.sim/exec/",
    // the WebSocket twin of the same capability
    "/_ios/exec-ws",
    // case variants
    "/_ios/EXEC",
    "/_ios/Exec",
    "/_IOS/exec",
    "/_Ios/ExEc",
    // percent-encoding, single and double
    "/_ios/exe%63",
    "/_ios/%65xec",
    "/_ios/exe%2563",
    "/_ios/%2565xec",
    "/_ios%2fexec",
    // path traversal back into the base
    "/_ios/foo/../exec",
    "/_ios/./exec",
    "/_ios/helper/../exec",
    "/_ios/grid/api/../../exec",
    `/_ios/helper/${UDID}/../../exec`,
    "/_ios/foo/..%2fexec",
    // duplicated separators
    "/_ios//exec",
    "/_ios/.//exec",
  ];

  for (const path of attempts) {
    it(`blocks GET ${path}`, async () => {
      await assertBlocked(path);
    });
    it(`blocks POST ${path}`, async () => {
      await assertBlocked(path, "POST");
    });
  }

  it("blocks a traversal that starts outside the base path", async () => {
    await assertBlocked("/anything/../_ios/exec", "POST");
  });
});

describe("serve-sim preview UI is unreachable", () => {
  for (const path of [
    "/_ios",
    "/_ios/",
    "/_ios?device=x",
    "/_ios/index.html",
    "/_IOS",
    "/_ios/./",
    "/_ios//",
    // the preview's own data + asset routes
    "/_ios/api",
    "/_ios/api/events",
    "/_ios/api/event-log",
    "/_ios/appstate",
    "/_ios/ax",
    "/_ios/devtools",
    "/_ios/devtools-frontend/inspector.html",
    "/_ios/grid/api/memory",
    "/_ios/grid/api/devicekit-chrome",
  ]) {
    it(`blocks ${path}`, async () => {
      await assertBlocked(path);
    });
  }
});

describe("the routes the provider actually uses still work", () => {
  for (const path of [
    `/_ios/helper/${UDID}/stream.avcc`,
    `/_ios/helper/${UDID}/stream.mjpeg?raw=1`,
    `/_ios/helper/${UDID}/config`,
    `/_ios/helper/${UDID}/ax`,
    `/_ios/helper/${UDID}/foreground`,
    `/_ios/helper/${UDID}/health`,
    "/_ios/grid/api",
    "/_ios/grid/api?limit=50",
  ]) {
    it(`forwards ${path}`, async () => {
      await assertForwarded(path);
    });
  }

  it("forwards the grid boot/shutdown posts", async () => {
    await assertForwarded("/_ios/grid/api/start", "POST");
    await assertForwarded("/_ios/grid/api/shutdown", "POST");
  });

  it("blocks a helper endpoint that is not on the allowlist", async () => {
    await assertBlocked(`/_ios/helper/${UDID}/camera/status`);
    await assertBlocked(`/_ios/helper/${UDID}/ws`);
  });

  it("blocks a helper route with a bogus udid", async () => {
    await assertBlocked("/_ios/helper/not-a-udid/config");
    await assertBlocked("/_ios/helper/..%2f..%2fexec/config");
  });

  it("blocks a trailing slash on an otherwise allowed route", async () => {
    await assertBlocked(`/_ios/helper/${UDID}/config/`);
    await assertBlocked("/_ios/grid/api/");
  });
});

describe("requests outside the base path are untouched", () => {
  it("falls through to the rest of the server", async () => {
    // The stand-in serve-sim answers everything it is handed, so a 200 here
    // means the guard passed it along rather than swallowing it.
    await assertForwarded("/");
    await assertForwarded("/v1");
    await assertForwarded("/healthz");
    await assertForwarded("/_iossomething/exec");
    await assertForwarded("/other/_ios/exec");
  });
});

describe("decide()", () => {
  it("classifies the three cases", () => {
    assert.equal(decide("/healthz"), "pass");
    assert.equal(decide("/_ios/grid/api"), "allow");
    assert.equal(decide("/_ios/exec"), "block");
  });

  it("never returns pass for anything under the base path", () => {
    for (const p of [
      "/_ios",
      "/_ios/",
      "/_ios/exec",
      "/_IOS/exec",
      "/_ios/%65xec",
      "/_ios/../_ios/exec",
      // A literal NUL, written as an escape. As a raw byte it made this
      // whole file `data` rather than text, so git treated it as binary:
      // no diffs, and `grep` answering "Binary file matches" instead of
      // listing the line. A file nobody can see the changes to is a worse
      // problem than the byte was.
      "/_ios/\u0000",
    ]) {
      assert.notEqual(decide(p), "pass", p);
    }
  });

  it("blocks undecodable escapes aimed at the base path", () => {
    assert.equal(decide("/_ios/%zz"), "block");
    assert.equal(decide("/_ios/%"), "block");
  });
});
