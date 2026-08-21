/**
 * The thin slice of adb this provider needs.
 *
 * Two different transports on purpose:
 *
 *  - one-shot commands (`push`, `forward`, `shell`, `exec-out`) go through the
 *    `adb` binary, because quoting, transport selection and error reporting are
 *    already solved there;
 *  - device *discovery* speaks the adb server's host protocol directly over TCP
 *    (`host:track-devices`), because that is a long-lived push stream. Polling
 *    `adb devices` in a loop would spawn a process per second forever.
 *
 * adb host protocol: every request is `%04x` of its length followed by the
 * request text; the server answers `OKAY` / `FAIL`, and `track-devices` then
 * pushes one length-prefixed device-list snapshot per change.
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface AdbDevice {
  serial: string;
  /** raw adb state: device / offline / unauthorized / bootloader ... */
  state: string;
}

let cachedAdbPath: string | null = null;

/** Locate the adb binary: $ADB_PATH, then the SDK roots, then $PATH. */
export function adbPath(): string {
  if (cachedAdbPath) return cachedAdbPath;

  const candidates = [
    process.env.ADB_PATH,
    process.env.ANDROID_SDK_ROOT &&
      path.join(process.env.ANDROID_SDK_ROOT, "platform-tools", "adb"),
    process.env.ANDROID_HOME &&
      path.join(process.env.ANDROID_HOME, "platform-tools", "adb"),
    path.join(os.homedir(), "Library", "Android", "sdk", "platform-tools", "adb"),
  ].filter((p): p is string => Boolean(p));

  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      cachedAdbPath = candidate;
      return candidate;
    } catch {
      // try the next one
    }
  }
  cachedAdbPath = "adb"; // fall back to $PATH and let execFile report ENOENT
  return cachedAdbPath;
}

export function adbServerPort(): number {
  const fromEnv = Number(process.env.ANDROID_ADB_SERVER_PORT);
  return Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : 5037;
}

export function adbServerHost(): string {
  return process.env.ANDROID_ADB_SERVER_ADDRESS ?? "127.0.0.1";
}

export interface AdbRunOptions {
  serial?: string;
  timeoutMs?: number;
  maxBuffer?: number;
  /** return stdout as a Buffer (for `exec-out screencap` and friends) */
  binary?: boolean;
}

export async function adb(
  args: string[],
  opts: AdbRunOptions = {},
): Promise<string> {
  const out = await adbRaw(args, opts);
  return out.toString("utf8");
}

export async function adbRaw(
  args: string[],
  opts: AdbRunOptions = {},
): Promise<Buffer> {
  const full = opts.serial ? ["-s", opts.serial, ...args] : args;
  const { stdout } = await execFileAsync(adbPath(), full, {
    timeout: opts.timeoutMs ?? 20_000,
    maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
    encoding: "buffer",
  });
  return stdout as Buffer;
}

export function adbSpawn(args: string[], serial?: string): ChildProcess {
  const full = serial ? ["-s", serial, ...args] : args;
  return spawn(adbPath(), full, { stdio: ["ignore", "pipe", "pipe"] });
}

export async function startServer(): Promise<void> {
  await adb(["start-server"], { timeoutMs: 30_000 });
}

export async function shell(serial: string, command: string): Promise<string> {
  return (await adb(["shell", command], { serial })).trim();
}

export async function getprop(serial: string, prop: string): Promise<string> {
  return shell(serial, `getprop ${prop}`);
}

/**
 * `adb forward tcp:0 localabstract:<name>` — asking for port 0 makes adb pick a
 * free port and print it, which avoids the port-range dance the reference
 * client does (and avoids colliding with a real scrcpy running alongside us).
 */
export async function forwardToAbstract(
  serial: string,
  abstractName: string,
): Promise<number> {
  const out = await adb(["forward", "tcp:0", `localabstract:${abstractName}`], {
    serial,
  });
  const port = Number(out.trim());
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`adb forward returned no port (got ${JSON.stringify(out)})`);
  }
  return port;
}

export async function removeForward(
  serial: string,
  port: number,
): Promise<void> {
  await adb(["forward", "--remove", `tcp:${port}`], { serial }).catch(() => {});
}

export async function push(
  serial: string,
  local: string,
  remote: string,
): Promise<void> {
  await adb(["push", local, remote], { serial, timeoutMs: 60_000 });
}

/** Parse the payload of `host:track-devices` (or of `adb devices`). */
export function parseDeviceList(text: string): AdbDevice[] {
  const devices: AdbDevice[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("List of devices")) continue;
    const [serial, state] = trimmed.split(/\s+/);
    if (!serial || !state) continue;
    devices.push({ serial, state });
  }
  return devices;
}

export async function listDevices(): Promise<AdbDevice[]> {
  return parseDeviceList(await adb(["devices"]));
}

export interface DeviceTracker {
  stop(): void;
}

/**
 * Long-lived `host:track-devices` subscription with reconnect.
 *
 * `onDevices` fires once per snapshot the adb server pushes (which includes one
 * immediately on connect); `onError` is advisory — the tracker keeps retrying
 * until `stop()`.
 */
export function trackDevices(
  onDevices: (devices: AdbDevice[]) => void,
  onError?: (err: unknown) => void,
  retryMs = 2000,
): DeviceTracker {
  let stopped = false;
  let socket: net.Socket | null = null;
  let timer: NodeJS.Timeout | null = null;

  const connect = (): void => {
    if (stopped) return;
    const sock = net.connect(adbServerPort(), adbServerHost());
    socket = sock;
    sock.setNoDelay(true);

    let buf = Buffer.alloc(0);
    let handshakeDone = false;

    sock.on("connect", () => {
      const request = "host:track-devices";
      sock.write(request.length.toString(16).padStart(4, "0") + request);
    });

    sock.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (!handshakeDone) {
          if (buf.length < 4) return;
          const status = buf.subarray(0, 4).toString("ascii");
          buf = buf.subarray(4);
          if (status !== "OKAY") {
            onError?.(new Error(`adb track-devices refused: ${status}`));
            sock.destroy();
            return;
          }
          handshakeDone = true;
          continue;
        }
        if (buf.length < 4) return;
        const len = parseInt(buf.subarray(0, 4).toString("ascii"), 16);
        if (Number.isNaN(len)) {
          onError?.(new Error("adb track-devices sent a bad length prefix"));
          sock.destroy();
          return;
        }
        if (buf.length < 4 + len) return;
        const payload = buf.subarray(4, 4 + len).toString("utf8");
        buf = buf.subarray(4 + len);
        try {
          onDevices(parseDeviceList(payload));
        } catch (err) {
          onError?.(err);
        }
      }
    });

    const reconnect = (err?: unknown): void => {
      if (err) onError?.(err);
      sock.destroy();
      if (socket === sock) socket = null;
      if (stopped) return;
      timer = setTimeout(connect, retryMs);
      timer.unref?.();
    };

    sock.on("error", reconnect);
    sock.on("close", () => reconnect());
  };

  // The adb server may not be running yet; start it, then subscribe.
  void startServer()
    .catch((err) => onError?.(err))
    .then(connect);

  return {
    stop(): void {
      stopped = true;
      if (timer) clearTimeout(timer);
      socket?.destroy();
      socket = null;
    },
  };
}
