/**
 * What a stream actually costs when the screen is moving.
 *
 * The frame rates in STATUS.md were all measured on still or barely-moving
 * screens, which says almost nothing: every backend here is event-driven, so a
 * still screen means an idle-fallback trickle by design. The number worth
 * knowing is the one under a flicking finger.
 *
 * This talks the protocol directly rather than driving the browser — the
 * question is what the server emits, not what Chrome manages to decode, and
 * mixing the two in one number is how you end up blaming the wrong half.
 *
 *   node tools/measure-stream.ts --host <host> --port 8801 \
 *     --device ios:<udid> --seconds 12
 *
 * Prints a per-second series plus the idle baseline, so "static 5fps, moving
 * 30fps" is visible rather than averaged into a meaningless 18.
 */

import { WebSocket } from "ws";

import {
  CHANNEL,
  VIDEO_TAG,
  decodeFrame,
  encodeControl,
  encodeInput,
  TOUCH_PHASE,
} from "../src/protocol.ts";

interface Opts {
  host: string;
  port: number;
  device: string;
  codec: string;
  seconds: number;
  idleSeconds: number;
}

function parseArgs(argv: string[]): Opts {
  const o: Opts = {
    host: "127.0.0.1",
    port: 8801,
    device: "",
    codec: "",
    seconds: 12,
    idleSeconds: 4,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!.replace(/^--/, "");
    if (flag === "host") o.host = argv[++i]!;
    else if (flag === "port") o.port = Number(argv[++i]);
    else if (flag === "device") o.device = argv[++i]!;
    else if (flag === "codec") o.codec = argv[++i]!;
    else if (flag === "seconds") o.seconds = Number(argv[++i]);
    else if (flag === "idle-seconds") o.idleSeconds = Number(argv[++i]);
    else throw new Error(`unknown flag --${flag}`);
  }
  if (!o.device) throw new Error("--device is required");
  return o;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Bucket {
  frames: number;
  bytes: number;
}

async function main(): Promise<void> {
  const o = parseArgs(process.argv.slice(2));
  const url = `ws://${o.host.includes(":") ? `[${o.host}]` : o.host}:${o.port}/v1`;
  const ws = new WebSocket(url);
  ws.binaryType = "nodebuffer";
  await new Promise<void>((res, rej) => {
    ws.once("open", () => res());
    ws.once("error", rej);
  });

  let nextId = 1;
  const pending = new Map<number, (v: Record<string, unknown>) => void>();
  const request = (req: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, resolve as (v: Record<string, unknown>) => void);
      ws.send(encodeControl({ id, ...req }));
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`${String(req.op)} timed out`));
      }, 30000);
    });
  };

  let streamId = -1;
  let bucket: Bucket = { frames: 0, bytes: 0 };
  let screen = "";

  ws.on("message", (raw: Buffer) => {
    const buf = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    if (buf[0] === CHANNEL.VIDEO) {
      // SEED is a one-off courtesy frame, not part of the stream's rate.
      if (buf[2] !== VIDEO_TAG.SEED && buf[1] === streamId) {
        bucket.frames++;
        bucket.bytes += buf.length;
      }
      return;
    }
    let frame;
    try {
      frame = decodeFrame(buf);
    } catch {
      return;
    }
    if (frame.channel === "control") {
      const json = frame.json as { id?: number };
      if (typeof json.id === "number") pending.get(json.id)?.(json as Record<string, unknown>);
      pending.delete(json.id ?? -1);
    } else if (frame.channel === "event") {
      const ev = frame.json as Record<string, unknown>;
      if (ev.ev === "screen" && ev.streamId === streamId) {
        screen = `${String(ev.width)}x${String(ev.height)} @${String(ev.scale)}x`;
      }
    }
  });

  const reply = await request(
    o.codec
      ? { op: "attach", deviceId: o.device, codec: o.codec }
      : { op: "attach", deviceId: o.device },
  );
  if (reply.ok === false) throw new Error(String(reply.error));
  streamId = reply.streamId as number;
  const device = reply.device as { name: string; screen?: Record<string, number> };
  if (device.screen) {
    screen = `${device.screen.width}x${device.screen.height} @${device.screen.scale}x`;
  }
  console.log(`${device.name}  ${screen}  codec=${String(reply.codec)}  stream=${streamId}`);

  /** The provider's own frame ledger, when the backend keeps one. */
  const stats = async (): Promise<Record<string, number> | null> => {
    try {
      const r = await request({ op: "stats", streamId });
      return r.ok === false ? null : (r.result as Record<string, number>);
    } catch {
      return null;
    }
  };
  const before = await stats();

  const series: Array<{ label: string; fps: number; mbps: number }> = [];
  const sample = async (label: string, seconds: number, during?: () => void): Promise<void> => {
    for (let s = 0; s < seconds; s++) {
      bucket = { frames: 0, bytes: 0 };
      const started = Date.now();
      during?.();
      await sleep(1000);
      const dt = (Date.now() - started) / 1000;
      series.push({
        label,
        fps: bucket.frames / dt,
        mbps: (bucket.bytes * 8) / dt / 1e6,
      });
    }
  };

  // Baseline: nobody touching it. This is the number that has been quoted so
  // far, and it is the idle fallback, not a ceiling.
  await sleep(1200);
  await sample("idle", o.idleSeconds);

  /**
   * One flick, alternating direction.
   *
   * Always flicking the same way runs the list to its end after a second or
   * two, and everything after that measures a stationary screen while looking
   * like it is measuring a moving one — which is exactly the mistake this tool
   * exists to stop making.
   */
  let seq = 1;
  let up = true;
  const flick = (): void => {
    const from = up ? 0.82 : 0.22;
    const to = up ? 0.22 : 0.82;
    up = !up;
    void (async () => {
      const send = (msg: Parameters<typeof encodeInput>[1]): void =>
        ws.send(encodeInput(streamId, msg));
      send({ kind: "touch", phase: TOUCH_PHASE.BEGIN, x: 0.5, y: from, seq: seq++ & 0xffff, edge: 0 });
      for (let i = 1; i <= 14; i++) {
        await sleep(16);
        send({
          kind: "touch",
          phase: TOUCH_PHASE.MOVE,
          x: 0.5,
          y: from + ((to - from) * i) / 14,
          seq: seq++ & 0xffff,
          edge: 0,
        });
      }
      send({ kind: "touch", phase: TOUCH_PHASE.END, x: 0.5, y: to, seq: seq++ & 0xffff, edge: 0 });
    })();
  };

  await sample("moving", o.seconds, flick);

  const after = await stats();
  await request({ op: "detach", streamId }).catch(() => {});
  ws.close();

  report(series);
  if (before && after && after.fromCdp === undefined) {
    // A backend with a different ledger shape (Android): print whatever it
    // reports rather than nothing, since the point is to compare stages.
    console.log("\nprovider ledger");
    for (const [k, v] of Object.entries(after)) {
      if (typeof v !== "number") continue;
      const delta = v - Number(before[k] ?? 0);
      console.log(`  ${k.padEnd(22)} ${String(delta).padStart(8)}`);
    }
  }
  if (before && after && after.fromCdp !== undefined) {
    // Where every frame went, so "the client got fewer than the cap allows"
    // can be attributed to a stage instead of argued about.
    const d = (k: string): number => (Number(after[k] ?? 0)) - (Number(before[k] ?? 0));
    const total = d("fromCdp");
    const row = (label: string, n: number): string =>
      `  ${label.padEnd(22)} ${String(n).padStart(6)}` +
      (total > 0 ? `  ${((n / total) * 100).toFixed(1).padStart(5)}%` : "");
    console.log("\nprovider ledger");
    console.log(row("frames from CDP", total));
    console.log(row("dropped: off-screen", d("offScreen")));
    console.log(row("dropped: duplicate", d("duplicate")));
    console.log(row("dropped: rate limit", d("rateLimited")));
    console.log(row("forwarded", d("forwarded")));
    console.log(row("  of which idle resend", d("idleResent")));
    console.log(row("  of which late flush", d("flushed")));
    console.log(`  max gap between sends  ${String(after.maxGapMs ?? 0).padStart(6)} ms`);
    const unaccounted =
      total -
      d("offScreen") -
      d("duplicate") -
      d("rateLimited") -
      (d("forwarded") - d("idleResent") - d("flushed"));
    console.log(`  unaccounted            ${String(unaccounted).padStart(6)}`);

    const pct = (v: unknown): string => {
      const o = v as { n: number; p50: number; p90: number; p99: number; max: number } | undefined;
      if (!o || !o.n) return "no samples";
      return `n=${String(o.n).padStart(4)}  p50 ${String(o.p50).padStart(4)}  p90 ${String(o.p90).padStart(4)}  p99 ${String(o.p99).padStart(5)}  max ${String(o.max).padStart(5)}`;
    };
    console.log("\nwhere the time goes (ms)");
    console.log(`  CDP frame spacing      ${pct(after.cdpGapMs)}`);
    console.log(`  our output spacing     ${pct(after.outGapMs)}`);
    const lag = after.eventLoopLagMs as Record<string, number> | undefined;
    if (lag) {
      console.log(
        `  event loop lag         p50 ${lag.p50}  p90 ${lag.p90}  p99 ${lag.p99}  max ${lag.max}`,
      );
    }
    const enc = after.encoder as Record<string, unknown> | undefined;
    if (enc) {
      console.log(`  ffmpeg input spacing   ${pct(enc.inGapMs)}`);
      console.log(`  ffmpeg latency (quiet) ${pct(enc.encodeMs)}`);
      console.log(`  ffmpeg output spacing  ${pct(enc.outGapMs)}`);
    }

    const encBefore = (before.encoder ?? null) as Record<string, number> | null;
    const encAfter = (after.encoder ?? null) as Record<string, number> | null;
    if (encBefore && encAfter) {
      const e = (k: string): number => (encAfter[k] ?? 0) - (encBefore[k] ?? 0);
      console.log("\nh264 encoder pipe");
      console.log(`  JPEGs in               ${String(e("jpegIn")).padStart(6)}`);
      console.log(`    dropped on backlog   ${String(e("backlogDropped")).padStart(6)}`);
      console.log(`  bytes written to stdin ${String(e("bytesIn")).padStart(6)}`);
      console.log(`  bytes read from stdout ${String(e("stdoutBytes")).padStart(6)} in ${e("stdoutChunks")} chunks`);
      console.log(`  access units parsed    ${String(e("accessUnits")).padStart(6)}`);
      console.log(`  protocol frames out    ${String(e("framesOut")).padStart(6)}`);
    }
  }
}

function report(series: Array<{ label: string; fps: number; mbps: number }>): void {
  for (const label of ["idle", "moving"]) {
    const rows = series.filter((s) => s.label === label);
    if (rows.length === 0) continue;
    const fps = rows.map((r) => r.fps).sort((a, b) => a - b);
    const mbps = rows.map((r) => r.mbps).sort((a, b) => a - b);
    console.log(
      `${label.padEnd(7)} p50 ${median(fps).toFixed(1).padStart(5)} fps  ` +
        `peak ${fps[fps.length - 1]!.toFixed(1).padStart(5)} fps   ` +
        `p50 ${median(mbps).toFixed(2).padStart(5)} Mbit/s  ` +
        `peak ${mbps[mbps.length - 1]!.toFixed(2).padStart(5)} Mbit/s`,
    );
    console.log(`        per second: ${rows.map((r) => r.fps.toFixed(0)).join(" ")}`);
  }
}

function median(sorted: number[]): number {
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

await main();
process.exit(0);
