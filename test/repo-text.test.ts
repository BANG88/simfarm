/**
 * Every tracked source file must be text.
 *
 * This exists because one was not, and the consequence was worse than the byte.
 * `test/providers/ios/sim-guard.test.ts` carried a literal NUL inside a test
 * fixture — a path-traversal case that wanted a NUL in it, written as a raw byte
 * instead of an escape. Git classifies a file with a NUL as binary, and from
 * then on:
 *
 *   - `git diff` says `Bin 7388 -> 7724 bytes` instead of showing the change;
 *   - `grep` answers `Binary file … matches` instead of printing the line.
 *
 * So the file went invisible to every review and every sweep, and a real device
 * UDID sat in it through a pass that was specifically looking for real device
 * UDIDs. It was caught by noticing the odd `Binary file matches` output, which
 * is luck, not process.
 *
 * A checklist item would have the same failure mode as the sweep that missed it.
 * This runs on every `npm test` instead.
 *
 * The rule is about *tracked* files: anything ignored is not going to be
 * published, and genuinely binary assets are listed below.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");

/** Extensions that are supposed to be binary. Everything else must be text. */
const BINARY_OK = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".pdf",
  ".jar",
  ".zip",
  ".gz",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".node",
]);

function trackedFiles(): string[] | null {
  try {
    const out = execFileSync("git", ["ls-files", "-z"], {
      cwd: ROOT,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.split("\0").filter(Boolean);
  } catch {
    // Not a git checkout (an extracted tarball, say). Nothing to check.
    return null;
  }
}

test("no tracked source file contains a NUL byte", () => {
  const files = trackedFiles();
  if (!files) return;
  assert.ok(files.length > 0, "git ls-files returned nothing");

  const binary: string[] = [];
  for (const file of files) {
    if (BINARY_OK.has(path.extname(file).toLowerCase())) continue;
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(path.join(ROOT, file));
    } catch {
      continue; // listed but not present in this working tree
    }
    if (bytes.includes(0)) binary.push(file);
  }

  assert.deepEqual(
    binary,
    [],
    `these are tracked as source but git will treat them as binary, which hides ` +
      `them from diffs and from grep: ${binary.join(", ")}. If a NUL is ` +
      `deliberate test data, write it as an escape (\\u0000) rather than a raw byte.`,
  );
});
