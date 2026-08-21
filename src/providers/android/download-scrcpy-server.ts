/**
 * Fetch the pinned scrcpy server jar into vendor/.
 *
 *   node src/providers/android/download-scrcpy-server.ts [--force]
 *
 * The jar is deliberately not committed (ARCHITECTURE.md): `vendor/scrcpy-server.json`
 * carries the version and SHA-256, and this script refuses to keep a download
 * whose digest does not match.
 */

import fs from "node:fs";
import {
  downloadJar,
  jarPath,
  loadRelease,
  sha256File,
} from "./scrcpy-release.ts";

const force = process.argv.includes("--force");
const release = loadRelease();
const target = jarPath(release);

if (!force && fs.existsSync(target) && sha256File(target) === release.sha256) {
  console.log(`scrcpy-server ${release.version} already present and verified:`);
  console.log(`  ${target}`);
  process.exit(0);
}

console.log(`downloading scrcpy-server ${release.version} from ${release.url}`);
const file = await downloadJar(release);
console.log(`ok: ${file}`);
console.log(`sha256 ${release.sha256} (matches vendor/scrcpy-server.json)`);
