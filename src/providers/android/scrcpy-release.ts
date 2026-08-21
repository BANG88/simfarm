/**
 * The pinned scrcpy server build (ARCHITECTURE.md).
 *
 * The protocol this provider speaks is version-specific, so the version and the
 * SHA-256 of the jar are committed (`vendor/scrcpy-server.json`) while the jar
 * itself is not. Startup verifies the digest and **refuses to run on a
 * mismatch** rather than pushing an unknown binary onto a device.
 */

import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
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
 * A ceiling on the one network call this project makes.
 *
 * Generous enough for a slow link, short enough that a wedged download cannot
 * hold up the server's startup: the Android provider fetches during `init()`,
 * and `init()` is awaited.
 */
const DOWNLOAD_TIMEOUT_MS = 60_000;

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
        `  fetch it with: npx simfarm download-scrcpy`,
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

/**
 * The jar, downloading it first if it is not already there.
 *
 * The jar is not shipped — in the repository because a binary in git is a binary
 * nobody re-reads, and in the npm package because redistributing someone else's
 * release inside ours is not ours to do. That leaves the first run on a new
 * machine needing a fetch, and making the user perform it by hand was one step
 * too many: it is a step they can only discover by hitting an error.
 *
 * So it is fetched on demand, out loud. A digest mismatch is still fatal and
 * still never auto-corrected — an unpinned jar and a wrong one are different
 * problems, and only the first is safe to fix by downloading.
 */
export async function ensureJar(
  release: ScrcpyRelease,
  dir = VENDOR_DIR,
  onProgress: (message: string) => void = () => {},
): Promise<string> {
  const file = jarPath(release, dir);
  if (fs.existsSync(file)) return verifiedJarPath(release, dir);

  onProgress(
    `scrcpy-server ${release.version} is not present; fetching it once from ` +
      `${release.url} (~730 KB, verified against the pinned SHA-256)`,
  );
  try {
    return await downloadJar(release, dir);
  } catch (err) {
    throw new ScrcpyJarError(
      `could not fetch the scrcpy server jar: ${err instanceof Error ? err.message : String(err)}\n` +
        `  it belongs at ${file}\n` +
        `  retry with: npx simfarm download-scrcpy\n` +
        `  or start without the android backend: --providers ios,wechat`,
    );
  }
}

/**
 * Fetch a URL, through curl rather than `fetch`.
 *
 * Not a style choice. **Node's `fetch` ignores `HTTP_PROXY` / `HTTPS_PROXY`**,
 * and on a machine that reaches the internet only through a proxy it does not
 * fail — it hangs until the TCP timeout, which is minutes. That turned a missing
 * jar from a clear error into a server that never finishes starting. curl reads
 * the same environment the rest of the machine does, and this project is macOS
 * only, so curl is always there.
 *
 * `--max-time` is the other half: whatever goes wrong, this returns.
 */
async function get(url: string, timeoutMs = DOWNLOAD_TIMEOUT_MS): Promise<Buffer> {
  const seconds = Math.ceil(timeoutMs / 1000);
  const curl = spawnSync(
    "curl",
    ["-fsSL", "--max-time", String(seconds), "--retry", "1", url],
    { maxBuffer: 64 * 1024 * 1024, encoding: "buffer", timeout: timeoutMs + 5000 },
  );
  if (curl.error) {
    throw new ScrcpyJarError(`could not run curl: ${curl.error.message}`);
  }
  if (curl.status !== 0) {
    const why = curl.stderr?.toString().trim();
    throw new ScrcpyJarError(
      `GET ${url} failed (curl exit ${curl.status ?? "signal"})${why ? `: ${why}` : ""}`,
    );
  }
  return Buffer.from(curl.stdout);
}

/** Download the pinned jar and verify it before it lands at its final path. */
export async function downloadJar(
  release: ScrcpyRelease,
  dir = VENDOR_DIR,
): Promise<string> {
  const target = jarPath(release, dir);
  fs.mkdirSync(dir, { recursive: true });

  const bytes = await get(release.url);
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
