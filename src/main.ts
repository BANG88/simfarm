#!/usr/bin/env node
/**
 * simfarm entry point.
 *
 *   node src/main.ts [--host 127.0.0.1] [--port 8801] [--providers mock,android,ios]
 *
 * Env: SIMFARM_HOST, SIMFARM_PORT, SIMFARM_LOG=debug|info|warn|error
 *
 * The default bind is loopback. M4 switches the shipped LaunchAgent to the
 * Tailscale address (ARCHITECTURE.md); `--host` already does it today.
 *
 * Provider wiring lives here and only here: a provider is constructed, its
 * middleware mounted, then init()ed once the socket is listening. Adding a
 * backend must not require editing this file beyond the table below.
 */

import { DeviceRegistry } from "./registry.ts";
import { SimfarmServer } from "./server.ts";
import { MockProvider } from "./providers/mock/mock-provider.ts";
import { AndroidProvider } from "./providers/android/android-provider.ts";
import { IosProvider } from "./providers/ios/ios-provider.ts";
import { WechatProvider } from "./providers/wechat/wechat-provider.ts";
import { logger } from "./util/log.ts";
import type { Provider } from "./types.ts";

const log = logger("main");

interface ProviderTuning {
  /** --android-max-size: largest dimension scrcpy encodes (android-provider.ts) */
  androidMaxSize?: number;
  /** --wechat-max-fps: 0 removes the cap (wechat-provider.ts) */
  wechatMaxFps?: number;
  /** --wechat-quality: JPEG quality, 1-100 */
  wechatQuality?: number;
  /** --wechat-no-h264: stay on jpeg even if ffmpeg is available */
  wechatNoH264?: boolean;
  /** --wechat-ffmpeg: path to the ffmpeg binary (for testing a broken one) */
  wechatFfmpeg?: string;
  /** --wechat-h264-max-fps: cap once h264 is in use; 0 (default) is uncapped */
  wechatH264MaxFps?: number;
}

const PROVIDERS: Record<string, (t: ProviderTuning) => Provider> = {
  mock: () => new MockProvider(),
  android: (t) =>
    new AndroidProvider(t.androidMaxSize ? { maxSize: t.androidMaxSize } : {}),
  ios: () => new IosProvider(),
  wechat: (t) =>
    new WechatProvider({
      ...(t.wechatMaxFps !== undefined ? { maxFps: t.wechatMaxFps } : {}),
      ...(t.wechatQuality !== undefined ? { quality: t.wechatQuality } : {}),
      ...(t.wechatNoH264 ? { h264: false } : {}),
      ...(t.wechatFfmpeg ? { ffmpegPath: t.wechatFfmpeg } : {}),
      ...(t.wechatH264MaxFps !== undefined ? { h264MaxFps: t.wechatH264MaxFps } : {}),
    }),
};

const DEFAULT_PROVIDERS = ["mock"];

interface Args {
  host: string;
  port: number;
  providers: string[];
  tuning: ProviderTuning;
}

function intArg(raw: string | undefined, flag: string, min: number, max = Infinity): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`bad ${flag}: ${String(raw)}`);
  }
  return n;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    host: process.env.SIMFARM_HOST ?? "127.0.0.1",
    port: Number(process.env.SIMFARM_PORT ?? 8801),
    providers: (process.env.SIMFARM_PROVIDERS ?? "").split(",").filter(Boolean),
    tuning: {},
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--host") args.host = argv[++i] ?? args.host;
    else if (a === "--port") args.port = Number(argv[++i] ?? args.port);
    else if (a === "--providers") {
      args.providers = (argv[++i] ?? "").split(",").filter(Boolean);
    } else if (a === "--android-max-size") {
      args.tuning.androidMaxSize = intArg(argv[++i], "--android-max-size", 1);
    } else if (a === "--wechat-max-fps") {
      args.tuning.wechatMaxFps = intArg(argv[++i], "--wechat-max-fps", 0);
    } else if (a === "--wechat-h264-max-fps") {
      args.tuning.wechatH264MaxFps = intArg(argv[++i], "--wechat-h264-max-fps", 0);
    } else if (a === "--wechat-ffmpeg") {
      args.tuning.wechatFfmpeg = argv[++i];
    } else if (a === "--wechat-no-h264") {
      args.tuning.wechatNoH264 = true;
    } else if (a === "--wechat-quality") {
      args.tuning.wechatQuality = intArg(argv[++i], "--wechat-quality", 1, 100);
    } else if (a === "--no-mock") {
      args.providers = args.providers.filter((p) => p !== "mock");
    } else if (a === "--help" || a === "-h") {
      console.log(
        `usage: simfarm [--host HOST] [--port PORT] ` +
          `[--providers ${Object.keys(PROVIDERS).join(",")}]\n` +
          `       [--android-max-size N] [--wechat-max-fps N] [--wechat-quality 1-100]\n` +
          `       [--wechat-no-h264] [--wechat-h264-max-fps N] [--wechat-ffmpeg PATH]\n` +
          `\n` +
          `       simfarm download-scrcpy [--force]\n` +
          `         Fetch the pinned scrcpy server jar the android backend needs.\n` +
          `         Not usually necessary — it is fetched on demand.`,
      );
      process.exit(0);
    } else throw new Error(`unknown argument: ${a}`);
  }
  if (args.providers.length === 0) args.providers = DEFAULT_PROVIDERS;
  for (const name of args.providers) {
    if (!PROVIDERS[name]) {
      throw new Error(
        `unknown provider "${name}" (have: ${Object.keys(PROVIDERS).join(", ")})`,
      );
    }
  }
  if (!Number.isInteger(args.port) || args.port <= 0 || args.port > 65535) {
    throw new Error(`bad port: ${args.port}`);
  }
  return args;
}

/**
 * `simfarm download-scrcpy` — fetch the pinned scrcpy server jar.
 *
 * The Android backend fetches it on demand anyway, so this exists for the cases
 * where "on demand" is the wrong moment: preparing an image, priming a cache, or
 * a machine that will not have network when the server first runs. It is also
 * the command the error messages name, and an error message must name something
 * that can actually be run.
 */
async function downloadScrcpy(argv: string[]): Promise<void> {
  const { ensureJar, jarPath, loadRelease, sha256File } = await import(
    "./providers/android/scrcpy-release.ts"
  );
  const fs = await import("node:fs");
  const release = loadRelease();
  const target = jarPath(release);

  if (argv.includes("--force") && fs.existsSync(target)) fs.unlinkSync(target);
  if (fs.existsSync(target) && sha256File(target) === release.sha256) {
    console.log(`scrcpy-server ${release.version} already present and verified:`);
    console.log(`  ${target}`);
    return;
  }
  const file = await ensureJar(release, undefined, (m) => console.log(m));
  console.log(`ok: ${file}`);
  console.log(`sha256 ${release.sha256} (matches vendor/scrcpy-server.json)`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "download-scrcpy") {
    await downloadScrcpy(argv.slice(1));
    return;
  }
  const args = parseArgs(argv);

  const registry = new DeviceRegistry();
  registry.onProviderError = (kind, err) =>
    log.warn(`provider ${kind} failed: ${String(err)}`);

  const providers = args.providers.map((name) => PROVIDERS[name]!(args.tuning));

  const server = new SimfarmServer({
    host: args.host,
    port: args.port,
    registry,
  });

  // Middleware must be mounted before listen() so no request can slip past a
  // provider's guard (ARCHITECTURE.md).
  for (const provider of providers) {
    for (const mw of provider.middleware?.() ?? []) server.use(mw);
    for (const up of provider.upgrade?.() ?? []) server.onUpgrade(up);
  }

  await server.listen();

  const base = `${args.host.includes(":") ? `[${args.host}]` : args.host}:${args.port}`;

  for (const provider of providers) {
    try {
      await provider.init?.({
        host: args.host,
        port: args.port,
        baseUrl: `http://${base}`,
      });
      registry.register(provider);
      log.info(`provider ${provider.kind} ready`);
    } catch (err) {
      log.error(`provider ${provider.kind} failed to start: ${String(err)}`);
    }
  }

  log.info(`client      http://${base}/`);
  log.info(`protocol    ws://${base}/v1`);
  log.info(`health      http://${base}/healthz`);
  log.info(`devices     http://${base}/devices`);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${signal} — shutting down`);
    await server.close();
    await registry.dispose();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  log.error(String(err?.stack ?? err));
  process.exit(1);
});
