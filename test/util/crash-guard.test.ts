/**
 * The process-level guard (util/crash-guard.ts): an unhandled rejection is
 * logged and survived, a listen failure still exits.
 *
 * The handlers are exercised directly (node:test owns the process events
 * while a test runs); the subprocess case is the real thing — a node process
 * that would have died of `triggerUncaughtException` and instead prints
 * "alive" afterwards.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  crashHandlers,
  describeCrash,
  installCrashGuards,
  isListenFailure,
  sourceOf,
} from "../../src/util/crash-guard.ts";

const NS_ERROR =
  'Error Domain=FrameCapture Code=2 "Device not booted (state: Shutdown)" UserInfo={NSLocalizedDescription=Device not booted (state: Shutdown)}';

describe("describeCrash", () => {
  it("names the iOS capture for serve-sim's NSError, and keeps the code", () => {
    const err = Object.assign(new Error(NS_ERROR), { code: "NSError" });
    const text = describeCrash(err);
    assert.match(text, /^ios capture \(serve-sim FrameCapture\): Error Domain=FrameCapture/);
    assert.match(text, /\[NSError\]/);
    assert.match(text, /Device not booted \(state: Shutdown\)/);
  });

  it("copes with non-Error rejections", () => {
    assert.match(describeCrash("just a string"), /unknown source: just a string/);
    assert.match(describeCrash(undefined), /unknown source: undefined/);
    assert.match(describeCrash({ message: "scrcpy server exited" }), /^android: scrcpy server exited/);
  });

  it("classifies by message", () => {
    assert.equal(sourceOf("Error Domain=HIDInjector Code=1"), "ios input (serve-sim HIDInjector)");
    assert.equal(sourceOf("could not run ffmpeg: ENOENT"), "transcoder (ffmpeg)");
    assert.equal(sourceOf("devtools not debuggable"), "wechat");
  });
});

describe("isListenFailure", () => {
  it("is exactly a listen() error", () => {
    assert.equal(
      isListenFailure(Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE", syscall: "listen" })),
      true,
    );
    assert.equal(
      isListenFailure(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED", syscall: "connect" })),
      false,
    );
    assert.equal(isListenFailure(new Error(NS_ERROR)), false);
    assert.equal(isListenFailure(null), false);
  });
});

describe("crash handlers", () => {
  // node:test owns the process events while a test runs, so the handlers are
  // exercised directly here; the subprocess cases below wire them for real.
  it("logs an unhandled rejection and leaves the process alone", () => {
    const logged: string[] = [];
    let exited: number | null = null;
    const { onRejection } = crashHandlers({ error: (m) => logged.push(m) }, (code) => {
      exited = code;
    });
    onRejection(Object.assign(new Error(NS_ERROR), { code: "NSError" }));
    assert.equal(exited, null, "must not exit");
    assert.equal(logged.length, 1);
    assert.match(logged[0]!, /unhandled promise rejection kept from ending the process/);
    assert.match(logged[0]!, /ios capture \(serve-sim FrameCapture\)/);
    assert.match(logged[0]!, /Device not booted/);
  });

  it("exits on a listen failure and on nothing else", () => {
    const logged: string[] = [];
    let exited: number | null = null;
    const { onException } = crashHandlers({ error: (m) => logged.push(m) }, (code) => {
      exited = code;
    });
    onException(Object.assign(new Error("boom in a callback"), { code: "NSError" }));
    assert.equal(exited, null);
    assert.match(logged.at(-1)!, /uncaught exception kept from ending the process/);

    onException(
      Object.assign(new Error("listen EADDRINUSE: address already in use"), {
        code: "EADDRINUSE",
        syscall: "listen",
      }),
    );
    assert.equal(exited, 1);
    assert.match(logged.at(-1)!, /cannot listen/);
  });

  it("installs once per process", () => {
    const a = installCrashGuards({ error() {} });
    const b = installCrashGuards({ error() {} });
    assert.equal(a, b);
    a();
  });

  it("keeps a real node process alive through an unhandled NSError rejection", async () => {
    const guard = fileURLToPath(new URL("../../src/util/crash-guard.ts", import.meta.url));
    const script = `
      import { installCrashGuards } from ${JSON.stringify(guard)};
      installCrashGuards({ error: (m) => console.error("LOG " + m.split("\\n")[0]) });
      const err = new Error(${JSON.stringify(NS_ERROR)});
      err.code = "NSError";
      // serve-sim's DeviceSession.start(): call the async native method, drop the promise.
      (async () => { throw err; })();
      setTimeout(() => { console.log("alive"); process.exit(0); }, 50);
    `;
    const { code, stdout, stderr } = await run(["--input-type=module", "-e", script]);
    assert.equal(code, 0, stderr);
    assert.match(stdout, /alive/);
    assert.match(stderr, /LOG unhandled promise rejection kept from ending the process — ios capture/);
  });

  it("without the guard the same process dies — the baseline the test above is against", async () => {
    const script = `
      const err = new Error(${JSON.stringify(NS_ERROR)});
      err.code = "NSError";
      (async () => { throw err; })();
      setTimeout(() => { console.log("alive"); process.exit(0); }, 50);
    `;
    const { code, stdout } = await run(["--input-type=module", "-e", script]);
    assert.notEqual(code, 0);
    assert.doesNotMatch(stdout, /alive/);
  });
});

function run(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, args, { encoding: "utf8", timeout: 10_000 }, (err, stdout, stderr) => {
      const code = err && "code" in err && typeof err.code === "number" ? err.code : err ? 1 : 0;
      resolve({ code, stdout, stderr });
    });
  });
}
