/**
 * The pinned scrcpy server build (ARCHITECTURE.md).
 *
 * The protocol this provider speaks is version-specific, so the version and the
 * SHA-256 of the jar are committed (`vendor/scrcpy-server.json`) while the jar
 * itself is not. Startup verifies the digest and **refuses to run on a
 * mismatch** rather than pushing an unknown binary onto a device.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface ScrcpyRelease {
  /** version string passed as the server's first argv (must match exactly) */
  version: string;
  tag: string;
  file: string;
  url: string;
  sha256: string;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const VENDOR_DIR = path.resolve(HERE, "..", "..", "..", "vendor");
export const MANIFEST_PATH = path.join(VENDOR_DIR, "scrcpy-server.json");

export function loadRelease(manifestPath = MANIFEST_PATH): ScrcpyRelease {
  const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<
    string,
    unknown
  >;
  for (const key of ["version", "tag", "file", "url", "sha256"]) {
    if (typeof raw[key] !== "string" || !raw[key]) {
      throw new Error(`${manifestPath}: missing "${key}"`);
    }
  }
  return raw as unknown as ScrcpyRelease;
}

export function jarPath(release: ScrcpyRelease, dir = VENDOR_DIR): string {
  return path.join(dir, release.file);
}

export function sha256File(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export class ScrcpyJarError extends Error {}

/**
 * @returns the verified jar path
 * @throws if the jar is missing or its digest does not match the manifest
 */
export function verifiedJarPath(
  release: ScrcpyRelease,
  dir = VENDOR_DIR,
): string {
  const file = jarPath(release, dir);
  if (!fs.existsSync(file)) {
    throw new ScrcpyJarError(
      `scrcpy server jar not found at ${file}\n` +
        `  fetch it with: node src/providers/android/download-scrcpy-server.ts`,
    );
  }
  const actual = sha256File(file);
  if (actual !== release.sha256) {
    throw new ScrcpyJarError(
      `scrcpy server jar digest mismatch for ${file}\n` +
        `  expected ${release.sha256}\n` +
        `  actual   ${actual}\n` +
        `  refusing to push an unpinned binary to a device; re-download it or ` +
        `update vendor/scrcpy-server.json deliberately`,
    );
  }
  return file;
}

/** Download the pinned jar and verify it before it lands at its final path. */
export async function downloadJar(
  release: ScrcpyRelease,
  dir = VENDOR_DIR,
): Promise<string> {
  const target = jarPath(release, dir);
  fs.mkdirSync(dir, { recursive: true });

  const res = await fetch(release.url, { redirect: "follow" });
  if (!res.ok) {
    throw new ScrcpyJarError(`GET ${release.url} -> ${res.status} ${res.statusText}`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  if (digest !== release.sha256) {
    throw new ScrcpyJarError(
      `downloaded jar does not match the pinned digest\n` +
        `  expected ${release.sha256}\n  actual   ${digest}`,
    );
  }

  const tmp = `${target}.download`;
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, target);
  return target;
}
