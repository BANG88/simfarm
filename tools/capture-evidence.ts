/**
 * Evidence harness.
 *
 * Drives the real test page in headless Chrome against a running simfarm
 * server, operates the device the way a human would (real mouse events on the
 * canvas, real clicks on the button row), and writes PNGs of what the page
 * actually displays.
 *
 * Every pixel it saves came through our own WebSocket protocol and our own
 * client — nothing reaches into a provider's internals. That is the point: a
 * green unit test does not prove a person can see and touch the device.
 *
 * Two rules stop it producing evidence that proves nothing (both learned the
 * hard way, 2026-08-20, on a WeChat run whose three PNGs were byte-identical):
 *
 *   1. **An input action waits for the picture to actually change**, and fails
 *      if it does not. Every backend here is event-driven — CDP screencast and
 *      CoreSimulator both send nothing while the screen is still — so
 *      "dispatched without error, now screenshot" reliably captures the frame
 *      from *before* the input. Waiting on the canvas contents is the only
 *      signal that means what it looks like it means.
 *   2. **No two shots in a run may be byte-identical.** If they are, the run
 *      fails and writes nothing further. A before/after pair that is one file
 *      twice cannot demonstrate anything, and the failure mode is silent
 *      otherwise: the images look perfectly good on their own.
 *
 * Usage (actions run in the order given):
 *
 *   node tools/capture-evidence.ts --port 3311 --device android:emulator-5554 \
 *     --codec h264 --out docs/evidence/android \
 *     --wait 2000 \
 *     --shot 01-home \
 *     --tap 0.5,0.92 --wait 1500 --shot 02-after-tap \
 *     --swipe 0.5,0.95,0.5,0.35 --wait 1200 --shot 03-after-swipe \
 *     --button back --wait 1000 --shot 04-after-back \
 *     --latency 0.5,0.5
 *
 * Actions:
 *   --shot NAME             save <out>/NAME.png from the stream canvas
 *   --shot-page NAME        save <out>/NAME.png of the whole client window —
 *                           use it when the evidence is something the client
 *                           draws over the picture rather than in it
 *   --sheet LABEL           real mouse click on a button of the dialog the
 *                           client is drawing (WeChat sheets live outside the
 *                           captured frame; see PROTOCOL §6 `dialog`)
 *   --tap X,Y               press+release at normalized coords
 *   --swipe X1,Y1,X2,Y2     press, glide, release (10 steps ~30ms apart)
 *   --long-press X,Y[,MS]   press, hold (default 800ms), release without moving
 *   --edge-swipe X1,Y1,X2,Y2  same, but starts hard against the edge so the
 *                             page tags it as an edge gesture (iOS home swipe)
 *   --scroll DX,DY,X,Y      wheel over the canvas at (X,Y); DX/DY are in canvas
 *                           CSS pixels, positive DY scrolls the content up
 *   --button NAME           click a button from the capability rail (back/home/…)
 *   --key CODE              KeyboardEvent.code, e.g. Enter / KeyA
 *   --text STRING           inject text through the text field
 *   --rotate ORIENTATION    control-channel rotate
 *   --launch TARGET         control-channel launch (deeplink / bundle id / mini
 *                           program page path). Useful as the first action, to
 *                           start a run from a known screen rather than wherever
 *                           the last run left the device.
 *   --wx EXPRESSION         run a `wx.*` call in the mini program's own logic
 *                           layer (WeChat only). A fixture for things the app
 *                           itself cannot be driven to do — see the note at the
 *                           implementation.
 *   --wait MS               sleep
 *   --latency X,Y           tap and poll the canvas until pixels change;
 *                           prints the input->display round trip in ms
 *
 * Options:
 *   --settle MS             how long an input may take to show up (default 6000)
 *   --wechat-cdp-port N     where the WeChat devtools listens, for --wx (9222)
 *   --allow-unchanged       do not fail when an input changes nothing. An escape
 *                           hatch for deliberately-inert actions; the
 *                           duplicate-image check still applies.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { WebSocket } from "ws";

import { ShotLedger } from "./shot-ledger.ts";
import { CdpConnection, fetchTargets } from "../src/providers/wechat/cdp.ts";
import { appServiceForProject, findProjects } from "../src/providers/wechat/wechat-targets.ts";

const CHROME =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

interface Action {
  kind: string;
  arg: string;
}

interface Opts {
  host: string;
  port: number;
  device: string;
  codec: string;
  out: string;
  debugPort: number;
  settleMs: number;
  /** where the WeChat devtools listens, for `--wx` */
  wechatCdpPort: number;
  allowUnchanged: boolean;
  actions: Action[];
}

/** Actions that are supposed to move the picture. */
const INPUT_ACTIONS = new Set([
  "tap",
  "long-press",
  "swipe",
  "edge-swipe",
  "scroll",
  "button",
  "key",
  "text",
  "rotate",
]);

const ACTION_FLAGS = new Set([
  "shot",
  "shot-page",
  "sheet",
  "tap",
  "long-press",
  "swipe",
  "edge-swipe",
  "scroll",
  "button",
  "key",
  "text",
  "rotate",
  "launch",
  "wait",
  "latency",
  "wx",
]);

function parseArgs(argv: string[]): Opts {
  const o: Opts = {
    // the server may be bound to the Tailscale interface only, in which case
    // loopback will not reach it
    host: "127.0.0.1",
    port: 8801,
    device: "",
    codec: "",
    out: "docs/evidence",
    debugPort: 9333,
    settleMs: 6000,
    wechatCdpPort: 9222,
    allowUnchanged: false,
    actions: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!.replace(/^--/, "");
    const value = argv[i + 1] ?? "";
    if (ACTION_FLAGS.has(flag)) {
      o.actions.push({ kind: flag, arg: value });
      i++;
    } else if (flag === "host") o.host = argv[++i]!;
    else if (flag === "port") o.port = Number(argv[++i]);
    else if (flag === "device") o.device = argv[++i]!;
    else if (flag === "codec") o.codec = argv[++i]!;
    else if (flag === "out") o.out = argv[++i]!;
    else if (flag === "debug-port") o.debugPort = Number(argv[++i]);
    else if (flag === "settle") o.settleMs = Number(argv[++i]);
    else if (flag === "wechat-cdp-port") o.wechatCdpPort = Number(argv[++i]);
    else if (flag === "allow-unchanged") o.allowUnchanged = true;
    else throw new Error(`unknown flag --${flag}`);
  }
  if (!o.device) throw new Error("--device is required");
  return o;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  private readonly ws: WebSocket;
  private id = 0;
  private readonly waiters = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void }
  >();
  readonly console: string[] = [];

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on("message", (raw: Buffer) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id !== undefined) {
        const w = this.waiters.get(msg.id);
        if (!w) return;
        this.waiters.delete(msg.id);
        msg.error ? w.reject(new Error(JSON.stringify(msg.error))) : w.resolve(msg.result);
        return;
      }
      if (msg.method === "Runtime.consoleAPICalled") {
        this.console.push(
          `console.${msg.params.type}: ${msg.params.args.map((a: any) => a.value ?? a.description).join(" ")}`,
        );
      } else if (msg.method === "Runtime.exceptionThrown") {
        this.console.push(
          `EXCEPTION: ${msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text}`,
        );
      }
    });
  }

  ready(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("error", reject);
    });
  }

  send(method: string, params: unknown = {}): Promise<any> {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.waiters.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.waiters.delete(id)) reject(new Error(`${method} timed out`));
      }, 30000);
    });
  }

  async eval<T = unknown>(expression: string): Promise<T> {
    const r = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error(
        `eval failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`,
      );
    }
    return r.result.value as T;
  }

  close(): void {
    this.ws.close();
  }
}

async function main(): Promise<void> {
  const o = parseArgs(process.argv.slice(2));
  fs.mkdirSync(o.out, { recursive: true });
  const profile = fs.mkdtempSync("/tmp/simfarm-evidence-");

  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${o.debugPort}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1600,1200",
      "--force-device-scale-factor=1",
      "--autoplay-policy=no-user-gesture-required",
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  const done = (code: number): never => {
    chrome.kill();
    // The profile is a few MB per run and these add up fast when a milestone
    // is captured a dozen times.
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch {
      // best effort — chrome may still hold a handle
    }
    process.exit(code);
  };

  try {
    const version = await waitForBrowser(o.debugPort);
    console.log(`browser: ${version.Browser}`);

    const browser = new Cdp(version.webSocketDebuggerUrl);
    await browser.ready();
    const { targetId } = await browser.send("Target.createTarget", {
      url: `http://${o.host.includes(":") ? `[${o.host}]` : o.host}:${o.port}/`,
    });
    const list = (await (
      await fetch(`http://127.0.0.1:${o.debugPort}/json/list`)
    ).json()) as Array<{ id: string; webSocketDebuggerUrl: string }>;
    const target = list.find((t) => t.id === targetId)!;
    const page = new Cdp(target.webSocketDebuggerUrl);
    await page.ready();
    await page.send("Runtime.enable");

    await waitFor(page, `simfarm.connected()`, "websocket connect");
    await waitFor(
      page,
      `simfarm.devices.some(d => d.id === ${JSON.stringify(o.device)})`,
      `device ${o.device} to appear`,
    );

    // The page connects to a device by itself on load (ARCHITECTURE.md), so wait
    // that out and then take over: attaching on top of it would leave two
    // streams and the shots would come from whichever one happened to be first.
    await waitFor(page, `!simfarm.busy`, "the page's own auto-connect");
    // Without --codec, leave the choice exactly where a person leaves it: the
    // client asks for nothing, the server picks (PROTOCOL §4), and the client's
    // own "can this browser decode that?" fallback gets to run. Naming a codec
    // here would step over the very code path a user depends on.
    const codec = o.codec ? JSON.stringify(o.codec) : "undefined";
    await page.eval(`(async () => {
      for (const id of [...simfarm.streams.keys()]) await simfarm.detach(id);
      await simfarm.attach(${JSON.stringify(o.device)}, ${codec});
    })()`);
    await waitFor(page, `simfarm.streams.size === 1`, "attach");
    const streamId = await page.eval<number>(`[...simfarm.streams.keys()][0]`);
    console.log(`attached ${o.device} as stream ${streamId}`);

    for (const action of o.actions) {
      // Snapshot before dispatching, so the wait afterwards is against the
      // picture the input was supposed to change.
      const before = INPUT_ACTIONS.has(action.kind)
        ? await canvasHash(page, streamId)
        : null;
      await run(page, o, streamId, action);
      if (before !== null) {
        await waitForChange(page, o, streamId, before, action);
      }
    }

    const stats = await page.eval<string>(
      `document.querySelector('.stats')?.textContent ?? ''`,
    );
    console.log(`stats: ${stats}`);
    if (page.console.length) {
      console.log("--- browser console ---");
      console.log(page.console.join("\n"));
    }
    done(0);
  } catch (err) {
    console.error(String(err));
    done(1);
  }
}

async function run(
  page: Cdp,
  o: Opts,
  streamId: number,
  action: Action,
): Promise<void> {
  const nums = (s: string) => s.split(",").map(Number);

  switch (action.kind) {
    case "wait":
      await sleep(Number(action.arg));
      return;

    /*
     * The whole client window, not just the canvas.
     *
     * Needed for anything the *device* is showing that the video cannot carry:
     * the WeChat simulator draws wx.showModal outside the page frame we
     * capture, so the client draws it back over the picture from a `dialog`
     * event. A canvas-only shot would be a picture of the page with no dialog
     * in it — which is precisely the bug this feature exists to fix.
     */
    case "shot-page": {
      const file = path.join(o.out, `${action.arg}.png`);
      const res = await page.send("Page.captureScreenshot", { format: "png" });
      const bytes = Buffer.from(String((res as { data?: string }).data), "base64");
      const digest = shots.add(action.arg, bytes);
      fs.writeFileSync(file, bytes);
      console.log(`shot-page ${file} (md5 ${digest.slice(0, 8)})`);
      return;
    }

    /*
     * Press a button on the dialog the client drew, with a real mouse event on
     * the real element — the same thing a person's cursor does. Going through
     * `simfarm.request` instead would skip the half of the loop that is under
     * test: that the drawn button is where the user can hit it.
     */
    case "sheet": {
      const rect = await page.eval<{ x: number; y: number; w: number; h: number } | null>(
        `(() => {
          const b = [...document.querySelectorAll('.sheet-buttons button')]
            .find(b => b.textContent.trim() === ${JSON.stringify(action.arg)});
          if (!b) return null;
          const r = b.getBoundingClientRect();
          return {x: r.x, y: r.y, w: r.width, h: r.height};
        })()`,
      );
      if (!rect) {
        const up = await page.eval<string>(
          `[...document.querySelectorAll('.sheet-buttons button')].map(b => b.textContent.trim()).join(', ') || '(no dialog on screen)'`,
        );
        throw new Error(`no "${action.arg}" button on the dialog; showing: ${up}`);
      }
      const x = Math.round(rect.x + rect.w / 2);
      const y = Math.round(rect.y + rect.h / 2);
      for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
        await page.send("Input.dispatchMouseEvent", {
          type,
          x,
          y,
          button: "left",
          buttons: type === "mousePressed" ? 1 : 0,
          clickCount: type === "mouseMoved" ? 0 : 1,
        });
        await sleep(40);
      }
      console.log(`sheet ${action.arg}`);
      return;
    }

    case "shot": {
      const file = path.join(o.out, `${action.arg}.png`);
      const dataUrl = await page.eval<string>(
        `simfarm.canvasOf(${streamId}).toDataURL('image/png')`,
      );
      const bytes = Buffer.from(dataUrl.split(",")[1]!, "base64");
      // Throws, and throws *before* the write: a run that produced a duplicate
      // must not leave the duplicate on disk (tools/shot-ledger.ts).
      const digest = shots.add(action.arg, bytes);
      fs.writeFileSync(file, bytes);
      const size = await page.eval<string>(
        `(c => c.width + 'x' + c.height)(simfarm.canvasOf(${streamId}))`,
      );
      console.log(`shot ${file} (${size}, md5 ${digest.slice(0, 8)})`);
      return;
    }

    case "tap": {
      const [x, y] = nums(action.arg);
      await mouse(page, streamId, "mousePressed", x!, y!);
      await sleep(60);
      await mouse(page, streamId, "mouseReleased", x!, y!);
      console.log(`tap ${x},${y}`);
      return;
    }

    case "long-press": {
      // Held still: a press that drifts is a drag, and the frameworks that
      // care about long press cancel on movement.
      const [x, y, ms] = nums(action.arg);
      await mouse(page, streamId, "mousePressed", x!, y!);
      await sleep(ms ?? 800);
      await mouse(page, streamId, "mouseReleased", x!, y!);
      console.log(`long-press ${x},${y} for ${ms ?? 800}ms`);
      return;
    }

    case "swipe":
    case "edge-swipe": {
      const [x1, y1, x2, y2] = nums(action.arg);
      await mouse(page, streamId, "mousePressed", x1!, y1!);
      const steps = 12;
      for (let i = 1; i <= steps; i++) {
        await mouse(
          page,
          streamId,
          "mouseMoved",
          x1! + ((x2! - x1!) * i) / steps,
          y1! + ((y2! - y1!) * i) / steps,
        );
        await sleep(25);
      }
      await sleep(40);
      await mouse(page, streamId, "mouseReleased", x2!, y2!);
      console.log(`${action.kind} ${action.arg}`);
      return;
    }

    case "scroll": {
      // A real wheel event on the canvas, so it goes through the page's own
      // wheel handler and out as a SCROLL frame — the same path a user's
      // trackpad takes, rather than poking the debug API.
      const [dx, dy, x, y] = nums(action.arg);
      const rect = await canvasRect(page, streamId);
      await page.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: Math.round(rect.x + (x ?? 0.5) * rect.w),
        y: Math.round(rect.y + (y ?? 0.5) * rect.h),
        deltaX: dx,
        deltaY: dy,
        button: "none",
        buttons: 0,
      });
      console.log(`scroll ${action.arg}`);
      return;
    }

    case "button": {
      const ok = await page.eval<boolean>(
        // The capability row is the vertical rail on the right now
        // (ARCHITECTURE.md); its buttons carry the name as an aria-label,
        // because the visible label only appears on hover.
        `(() => {
          const b = [...document.querySelectorAll('#rail .rail-button')]
            .find(b => b.getAttribute('aria-label') === ${JSON.stringify(action.arg)});
          if (!b) return false;
          b.click();
          return true;
        })()`,
      );
      if (!ok) throw new Error(`no "${action.arg}" button in the capability row`);
      console.log(`button ${action.arg}`);
      return;
    }

    case "key": {
      await page.eval(
        `document.querySelector('.stream').dispatchEvent(
           new KeyboardEvent('keydown', {code: ${JSON.stringify(action.arg)}, bubbles: true}))`,
      );
      await sleep(50);
      await page.eval(
        `document.querySelector('.stream').dispatchEvent(
           new KeyboardEvent('keyup', {code: ${JSON.stringify(action.arg)}, bubbles: true}))`,
      );
      console.log(`key ${action.arg}`);
      return;
    }

    case "text": {
      await page.eval(
        `(() => {
          const i = document.querySelector('.text-input');
          i.value = ${JSON.stringify(action.arg)};
          document.querySelector('.send-text').click();
        })()`,
      );
      console.log(`text ${JSON.stringify(action.arg)}`);
      return;
    }

    case "rotate": {
      await page.eval(
        `simfarm.request({op:'rotate', streamId:${streamId}, orientation:${JSON.stringify(action.arg)}})`,
      );
      console.log(`rotate ${action.arg}`);
      return;
    }

    case "launch": {
      const reply = await page.eval<unknown>(
        `simfarm.request({op:'launch', streamId:${streamId}, target:${JSON.stringify(action.arg)}})`,
      );
      console.log(`launch ${action.arg} -> ${JSON.stringify(reply)}`);
      return;
    }

    /*
     * Make the *device* do something the client is then judged on — currently
     * only used to raise a dialog.
     *
     * This is a fixture, not a feature, and it is here rather than in the
     * server on purpose: an "evaluate this in the app" control op would be the
     * same hole ARCHITECTURE.md makes us block in serve-sim. It exists because every
     * `wx.showModal` in the target mini program sits on a page behind a login
     * the project does not have, so there is no in-app route to a dialog. What
     * it proves is unaffected: from the call onwards, everything — detecting the
     * sheet, pushing it, drawing it, pressing it — is the real path.
     */
    case "wx": {
      await wxCall(o, action.arg);
      console.log(`wx ${action.arg}`);
      return;
    }

    case "latency": {
      const [x, y] = nums(action.arg);
      const ms = await measureLatency(page, streamId, x!, y!);
      console.log(
        ms < 0
          ? `latency: no visible change within the probe window`
          : `latency: ~${ms} ms input -> visible change`,
      );
      return;
    }

    default:
      throw new Error(`unknown action ${action.kind}`);
  }
}

/**
 * Evaluate in the appservice of whichever WeChat project is open.
 *
 * `awaitPromise` is deliberately off: `wx.showModal` returns a promise that
 * settles when the *user* answers, so awaiting it would hang until the very
 * thing we are about to test has already happened.
 */
async function wxCall(o: Opts, expression: string): Promise<void> {
  const endpoint = `http://127.0.0.1:${o.wechatCdpPort}`;
  const targets = await fetchTargets(endpoint);
  const project = findProjects(targets)[0];
  if (!project) throw new Error(`no WeChat project open at ${endpoint}`);
  const svc = appServiceForProject(targets, project.appid);
  if (!svc) throw new Error("the mini program's logic layer is not attachable");
  const conn = await CdpConnection.open(svc.wsUrl);
  try {
    await conn.send("Runtime.enable");
    const res = await conn.send("Runtime.evaluate", {
      expression: `(() => { ${expression}; return "ok"; })()`,
      returnByValue: true,
    });
    const failed = (res as { exceptionDetails?: { text?: string } }).exceptionDetails;
    if (failed) throw new Error(`wx call threw: ${failed.text ?? "?"}`);
  } finally {
    conn.close();
  }
}

/** The duplicate gate; see tools/shot-ledger.ts for why it is unconditional. */
const shots = new ShotLedger();

/**
 * A cheap content hash of what the canvas is *displaying*.
 *
 * Deliberately over the drawn pixels rather than the arriving frames: the
 * question is whether a person looking at the client would see something
 * different, and with the WeChat backend's 5 fps idle resend, "a frame arrived"
 * is true several times a second while nothing at all is happening.
 */
async function canvasHash(page: Cdp, streamId: number): Promise<number> {
  return await page.eval<number>(`(() => {
    const c = simfarm.canvasOf(${streamId});
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let h = 2166136261;
    for (let i = 0; i < d.length; i += 97) { h ^= d[i]; h = Math.imul(h, 16777619); }
    return h >>> 0;
  })()`);
}

/**
 * Block until the canvas shows something else, or give up loudly.
 *
 * Giving up has to be an error. Screenshotting anyway would produce a file that
 * is indistinguishable from a real capture and silently worthless.
 */
async function waitForChange(
  page: Cdp,
  o: Opts,
  streamId: number,
  before: number,
  action: Action,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < o.settleMs) {
    if ((await canvasHash(page, streamId)) !== before) {
      console.log(`  changed after ${Date.now() - started}ms`);
      return;
    }
    await sleep(50);
  }
  const what = `--${action.kind} ${action.arg}`;
  if (o.allowUnchanged) {
    console.log(`  WARNING: ${what} changed nothing in ${o.settleMs}ms (allowed)`);
    return;
  }
  throw new Error(
    `${what} changed nothing within ${o.settleMs}ms. Either the input never ` +
      `reached the device, or it did nothing there — a screenshot now would ` +
      `just be the previous frame again. Re-run with --allow-unchanged if the ` +
      `action is genuinely expected to be inert.`,
  );
}

/**
 * Presses at (x,y) and polls the canvas until enough pixels differ from the
 * pre-press snapshot. Order of magnitude, not a benchmark: it includes one
 * frame interval and the browser's own decode+paint.
 */
async function measureLatency(
  page: Cdp,
  streamId: number,
  x: number,
  y: number,
): Promise<number> {
  await page.eval(`(() => {
    const c = simfarm.canvasOf(${streamId});
    const g = c.getContext('2d');
    window.__probe = {
      before: g.getImageData(0, 0, c.width, c.height).data.slice(),
      diff() {
        const now = g.getImageData(0, 0, c.width, c.height).data;
        let n = 0;
        for (let i = 0; i < now.length; i += 40) {
          if (Math.abs(now[i] - this.before[i]) > 24) n++;
        }
        return n / (now.length / 40);
      },
    };
  })()`);

  const started = Date.now();
  await mouse(page, streamId, "mousePressed", x, y);
  await mouse(page, streamId, "mouseReleased", x, y);

  for (let i = 0; i < 200; i++) {
    const changed = await page.eval<number>(`window.__probe.diff()`);
    if (changed > 0.02) return Date.now() - started;
    await sleep(10);
  }
  return -1;
}

async function canvasRect(
  page: Cdp,
  streamId: number,
): Promise<{ x: number; y: number; w: number; h: number }> {
  return await page.eval(
    `(r => ({x: r.x, y: r.y, w: r.width, h: r.height}))(simfarm.canvasOf(${streamId}).getBoundingClientRect())`,
  );
}

async function mouse(
  page: Cdp,
  streamId: number,
  type: string,
  nx: number,
  ny: number,
): Promise<void> {
  const rect = await canvasRect(page, streamId);
  // clamp a hair inside the box so an edge gesture still lands on the canvas
  const px = rect.x + Math.min(rect.w - 1, Math.max(0, nx * rect.w));
  const py = rect.y + Math.min(rect.h - 1, Math.max(0, ny * rect.h));
  await page.send("Input.dispatchMouseEvent", {
    type,
    x: Math.round(px),
    y: Math.round(py),
    button: "left",
    buttons: type === "mouseReleased" ? 0 : 1,
    clickCount: 1,
  });
}

async function waitFor(page: Cdp, expr: string, what: string): Promise<void> {
  for (let i = 0; i < 150; i++) {
    try {
      if (await page.eval<boolean>(expr)) return;
    } catch {
      // page still loading
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function waitForBrowser(port: number): Promise<any> {
  for (let i = 0; i < 60; i++) {
    try {
      return await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    } catch {
      await sleep(250);
    }
  }
  throw new Error("chrome never came up");
}

await main();
