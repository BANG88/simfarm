/**
 * Thin `xcrun simctl` wrapper: device enumeration, screen geometry, and the
 * few control-plane actions serve-sim has no route for (openurl / launch /
 * clipboard).
 *
 * Enumeration deliberately does not go through serve-sim's `/grid/api`. That
 * route resolves a DeviceKit "chrome" descriptor (bezel artwork, button hit
 * boxes, PDF-derived geometry) for every device it returns — ~150 KB of JSON we
 * would parse and throw away on every poll. `simctl list devices -j` is the same
 * data source serve-sim itself reads, and costs a fraction of that. Boot and
 * shutdown *do* go through the grid routes (see ios-provider.ts) because those
 * also register the device with serve-sim's in-process state.
 */

import { execFile } from "node:child_process";
import path from "node:path";

export interface SimDevice {
  udid: string;
  name: string;
  /** raw simctl state, e.g. "Booted" / "Shutdown" / "Booting" */
  state: string;
  /** e.g. "iOS 26.5" */
  runtime: string;
  deviceTypeIdentifier?: string;
}

export interface DeviceGeometry {
  width: number;
  height: number;
  scale: number;
}

interface SimctlDeviceListEntry {
  udid: string;
  name: string;
  state: string;
  isAvailable?: boolean;
  deviceTypeIdentifier?: string;
}

export function run(
  args: string[],
  timeout = 15_000,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      "xcrun",
      args,
      { encoding: "utf-8", timeout, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr?.trim() || err.message));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

/**
 * Every available iOS simulator. watchOS / visionOS / tvOS are excluded: our
 * capability declaration (touch, edge gestures, rotation) describes a phone or
 * tablet, and a watch would need the digital crown to be usable.
 */
export async function listDevices(): Promise<SimDevice[]> {
  const { stdout } = await run(["simctl", "list", "devices", "-j"]);
  const parsed = JSON.parse(stdout) as {
    devices: Record<string, SimctlDeviceListEntry[]>;
  };
  const out: SimDevice[] = [];
  for (const [runtime, devices] of Object.entries(parsed.devices)) {
    const match = /SimRuntime\.iOS-(\d+)-(\d+)/.exec(runtime);
    if (!match) continue;
    for (const d of devices) {
      if (d.isAvailable === false) continue;
      out.push({
        udid: d.udid,
        name: d.name,
        state: d.state,
        runtime: `iOS ${match[1]}.${match[2]}`,
        deviceTypeIdentifier: d.deviceTypeIdentifier,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// screen geometry
// ---------------------------------------------------------------------------

let bundlePaths: Map<string, string> | null = null;
const geometryCache = new Map<string, DeviceGeometry | null>();

async function deviceTypeBundlePaths(): Promise<Map<string, string>> {
  if (bundlePaths) return bundlePaths;
  const map = new Map<string, string>();
  try {
    const { stdout } = await run(["simctl", "list", "devicetypes", "-j"]);
    const parsed = JSON.parse(stdout) as {
      devicetypes: Array<{ identifier: string; bundlePath: string }>;
    };
    for (const t of parsed.devicetypes) map.set(t.identifier, t.bundlePath);
  } catch {
    // Geometry is a nicety; an empty map just means we report no screen for
    // devices that are not booted.
  }
  bundlePaths = map;
  return map;
}

/**
 * Native pixel size and backing scale for a device type, read from
 * CoreSimulator's `profile.plist` (`mainScreenWidth` / `mainScreenHeight` /
 * `mainScreenScale`). This is what lets the device list carry a `screen`
 * before anything is attached; once a stream is open, serve-sim's own config
 * frames take over.
 */
export async function deviceGeometry(
  deviceTypeIdentifier: string | undefined,
): Promise<DeviceGeometry | null> {
  if (!deviceTypeIdentifier) return null;
  const cached = geometryCache.get(deviceTypeIdentifier);
  if (cached !== undefined) return cached;

  let geometry: DeviceGeometry | null = null;
  try {
    const bundle = (await deviceTypeBundlePaths()).get(deviceTypeIdentifier);
    if (bundle) {
      const plist = path.join(bundle, "Contents", "Resources", "profile.plist");
      const { stdout } = await runPlutil(plist);
      const profile = JSON.parse(stdout) as Record<string, unknown>;
      const width = Number(profile.mainScreenWidth);
      const height = Number(profile.mainScreenHeight);
      const scale = Number(profile.mainScreenScale);
      if (width > 0 && height > 0) {
        geometry = { width, height, scale: scale > 0 ? scale : 1 };
      }
    }
  } catch {
    geometry = null;
  }
  geometryCache.set(deviceTypeIdentifier, geometry);
  return geometry;
}

function runPlutil(plist: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      "plutil",
      ["-convert", "json", "-o", "-", "--", plist],
      { encoding: "utf-8", timeout: 5000 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(stderr?.trim() || err.message));
        else resolve({ stdout, stderr });
      },
    );
  });
}

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------

/** Open a URL (deeplink) or launch a bundle id, whichever `target` looks like. */
export async function launch(udid: string, target: string): Promise<string> {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target) || target.startsWith("mailto:")) {
    const { stdout } = await run(["simctl", "openurl", udid, target]);
    return stdout.trim() || "ok";
  }
  const { stdout } = await run(["simctl", "launch", udid, target], 30_000);
  return stdout.trim() || "ok";
}

/**
 * The guest's system light/dark setting.
 *
 * `simctl ui` is the supported surface for this and it reads back, so a client
 * that follows the desktop theme can make the simulator follow it too. Nothing
 * about the *stream* changes — this is the guest's own setting, the same one a
 * person would flip in Settings.
 */
export async function setAppearance(
  udid: string,
  mode: "light" | "dark",
): Promise<void> {
  await run(["simctl", "ui", udid, "appearance", mode], 20_000);
}

export async function getAppearance(udid: string): Promise<string> {
  const { stdout } = await run(["simctl", "ui", udid, "appearance"], 10_000);
  return stdout.trim();
}

export async function setClipboard(udid: string, text: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = execFile(
      "xcrun",
      ["simctl", "pbcopy", udid],
      { timeout: 10_000 },
      (err) => (err ? reject(err) : resolve()),
    );
    child.stdin?.end(text);
  });
}

export async function getClipboard(udid: string): Promise<string> {
  const { stdout } = await run(["simctl", "pbpaste", udid], 10_000);
  return stdout;
}
