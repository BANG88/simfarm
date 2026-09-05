/**
 * Print the `CHANGELOG.md` section for one version, for use as GitHub release
 * notes:
 *
 *   node tools/release-notes.ts 0.2.0
 *
 * changesets writes the changelog as one `## <version>` heading per release,
 * newest first. This takes everything between the requested heading and the
 * next one, with the blank lines at either end trimmed, and fails loudly when
 * the version is not there at all — an empty release body would otherwise
 * pass unnoticed.
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

const version = process.argv[2];
if (!version) {
  console.error("usage: release-notes.ts <version>");
  process.exit(1);
}

const lines = fs.readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8").split("\n");
const start = lines.indexOf(`## ${version}`);
if (start < 0) {
  console.error(`CHANGELOG.md has no "## ${version}" section`);
  process.exit(1);
}

const section: string[] = [];
for (const line of lines.slice(start + 1)) {
  if (line.startsWith("## ")) break;
  section.push(line);
}
while (section.length && section[0]?.trim() === "") section.shift();
while (section.length && section[section.length - 1]?.trim() === "") section.pop();

process.stdout.write(`${section.join("\n")}\n`);
