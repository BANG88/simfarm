/**
 * Does a held touch, sent through the real simfarm protocol, arrive in a mini
 * program as a long press?
 *
 * ## Why this is a probe and not a screenshot
 *
 * The evidence rule for everything else is a before/after pair of pictures. It
 * cannot be met here, and not because of anything on our side: the target mini
 * program **binds no long-press handler anywhere** — zero hits for
 * `longpress` / `longtap` in its whole compiled bundle — so there is nothing on
 * screen that a long press could change. Every page in it that opens a
 * `wx.showModal` sits behind a login the project does not have.
 *
 * What can be shown is the thing simfarm is actually responsible for: that the
 * WebView framework, on the far side of the protocol, *synthesises* a long
 * press from what we dispatch. exparser only publishes events something is
 * listening for, so this attaches a listener of its own to a real element in
 * the page that is on screen, and then drives two touches through the wire
 * protocol that differ in exactly one way: how long the finger stays down.
 *
 * ```
 * node tools/probe-longpress.ts --host <host> --port 8801 \
 *   --device wechat:<appid>
 * ```
 *
 * Measured 2026-08-21 (devtools 2.01.2510290 / SDK 3.16.1):
 *
 * ```
 *   60ms  hold -> []
 *   900ms hold -> ["longtap", "longpress"]
 * ```
 *
 * Attaching the listener means touching the running app, which is why this
 * lives here and not in the provider: it is a diagnostic, and the only thing it
 * proves is about the *framework's* reading of our touches. Reload the mini
 * program afterwards if you care about it being pristine.
 */

import { WebSocket } from "ws";

import { CdpConnection, fetchTargets } from "../src/providers/wechat/cdp.ts";
import { CHANNEL, INPUT_KIND, TOUCH_PHASE } from "../src/protocol.ts";

interface Opts {
  host: string;
  port: number;
  device: string;
  wechatCdpPort: number;
  x: number;
  y: number;
  holdMs: number;
}

function parseArgs(argv: string[]): Opts {
  const o: Opts = {
    host: "127.0.0.1",
    port: 8801,
    device: "",
    wechatCdpPort: 9222,
    x: 0.5,
    y: 0.5,
    holdMs: 900,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!.replace(/^--/, "");
    if (flag === "host") o.host = argv[++i]!;
    else if (flag === "port") o.port = Number(argv[++i]);
    else if (flag === "device") o.device = argv[++i]!;
    else if (flag === "wechat-cdp-port") o.wechatCdpPort = Number(argv[++i]);
    else if (flag === "at") [o.x, o.y] = argv[++i]!.split(",").map(Number) as [number, number];
    else if (flag === "hold") o.holdMs = Number(argv[++i]);
    else throw new Error(`unknown flag --${flag}`);
  }
  if (!o.device) throw new Error("--device is required");
  return o;
}

/**
 * Listen on the biggest fully-visible element of the page that is on screen.
 *
 * `exparser.addListenerToElement` is the same call the compiled WXML makes for
 * a `bindlongpress`, so what it hears is what a handler in the app would hear.
 */
const LISTEN_EXPR = `(() => {
  window.__simfarmLongPress = [];
  const views = [...document.querySelectorAll('wx-view')].filter((n) => n.__wxElement);
  let best = null, area = 0;
  for (const n of views) {
    const r = n.getBoundingClientRect();
    if (r.top < 0 || r.bottom > innerHeight) continue;
    if (r.width * r.height > area) { area = r.width * r.height; best = n; }
  }
  if (!best) return 'no element to listen on';
  for (const name of ['longpress', 'longtap', 'tap'])
    exparser.addListenerToElement(best.__wxElement, name,
      () => window.__simfarmLongPress.push(name));
  const r = best.getBoundingClientRect();
  return 'listening on ' + Math.round(r.width) + 'x' + Math.round(r.height) + ' at ' +
         Math.round(r.x) + ',' + Math.round(r.y);
})()`;

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const o = parseArgs(process.argv.slice(2));

  const targets = await fetchTargets(`http://127.0.0.1:${o.wechatCdpPort}`);
  const frames = targets.filter((t) => t.url.includes("/__pageframe__/"));
  if (frames.length === 0) throw new Error("no mini program page is rendered");

  // Every page frame gets a listener: only one of them is on screen, and which
  // one that is belongs to the provider, not to this script.
  const conns: CdpConnection[] = [];
  for (const t of frames) {
    const conn = await CdpConnection.open(t.webSocketDebuggerUrl!);
    await conn.send("Runtime.enable");
    const res = await conn.send("Runtime.evaluate", {
      expression: LISTEN_EXPR,
      returnByValue: true,
    });
    const route = t.url.split("__pageframe__/")[1] ?? t.url;
    console.log(`${route}: ${String((res.result as { value?: unknown })?.value)}`);
    conns.push(conn);
  }

  const ws = new WebSocket(`ws://${o.host}:${o.port}/v1`);
  ws.binaryType = "arraybuffer";
  let nextId = 0;
  const pending = new Map<number, (v: Record<string, unknown>) => void>();
  ws.on("message", (raw: Buffer) => {
    const buf = Buffer.from(raw as unknown as ArrayBuffer);
    if (buf[0] !== CHANNEL.CONTROL) return;
    const json = JSON.parse(buf.subarray(1).toString("utf-8")) as { id: number };
    pending.get(json.id)?.(json as Record<string, unknown>);
    pending.delete(json.id);
  });
  const request = (req: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const id = ++nextId;
    ws.send(
      Buffer.concat([
        Buffer.from([CHANNEL.CONTROL]),
        Buffer.from(JSON.stringify({ id, ...req }), "utf-8"),
      ]),
    );
    return new Promise((resolve) => pending.set(id, resolve));
  };

  await new Promise((r) => ws.on("open", r));
  const reply = await request({ op: "attach", deviceId: o.device });
  if (reply.ok === false) throw new Error(String(reply.error));
  const streamId = Number(reply.streamId);
  console.log(`attached ${o.device} as stream ${streamId}`);
  await sleep(1500);

  // PROTOCOL §5: [0x02][streamId][0x10 TOUCH][phase][f32 x][f32 y][u16 seq][edge]
  let seq = 1;
  const touch = (phase: number): void => {
    const b = Buffer.alloc(15);
    b[0] = CHANNEL.INPUT;
    b[1] = streamId;
    b[2] = INPUT_KIND.TOUCH;
    b[3] = phase;
    b.writeFloatBE(o.x, 4);
    b.writeFloatBE(o.y, 8);
    b.writeUInt16BE(seq++ & 0xffff, 12);
    b[14] = 0;
    ws.send(b);
  };

  const heard = async (): Promise<string[]> => {
    const all: string[] = [];
    for (const conn of conns) {
      const res = await conn.send("Runtime.evaluate", {
        expression: `JSON.stringify(window.__simfarmLongPress || [])`,
        returnByValue: true,
      });
      all.push(...(JSON.parse(String((res.result as { value?: unknown })?.value)) as string[]));
      await conn.send("Runtime.evaluate", { expression: `window.__simfarmLongPress = []` });
    }
    return all;
  };

  // The two runs differ in one variable only. A long press that "works" without
  // a short-press control proves nothing: it could be firing on every touch.
  for (const hold of [60, o.holdMs]) {
    await heard();
    touch(TOUCH_PHASE.BEGIN);
    await sleep(hold);
    touch(TOUCH_PHASE.END);
    await sleep(1000);
    console.log(`${String(hold).padStart(4)}ms hold -> ${JSON.stringify(await heard())}`);
  }

  await request({ op: "detach", streamId });
  for (const conn of conns) conn.close();
  ws.close();
}

await main();
process.exit(0);
