/**
 * Strip the development scripts out of `package.json` for the duration of a
 * pack, then put them back.
 *
 *   node tools/pack-manifest.ts strip     # prepack
 *   node tools/pack-manifest.ts restore   # postpack
 *
 * Why this is needed at all: npm packs whatever `package.json` says at pack
 * time, and there is no way to declare "these scripts are not for consumers".
 * Shipping them is not cosmetic — every one of them points at `src/`, `test/` or
 * `tools/`, none of which are in the package, so a user who runs
 * `npm run start` after installing gets a file-not-found for a path that was
 * never published. `prepack` is worse than useless there: npm runs it when
 * installing from a git reference, and it would invoke a bun that may not exist
 * on that machine.
 *
 * The original is written next to `package.json` as a backup rather than held in
 * memory, because the two halves run as separate processes and a failed pack
 * must still be recoverable. `restore` is idempotent and safe to run when
 * nothing was stripped.
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const MANIFEST = path.join(ROOT, "package.json");
const BACKUP = path.join(ROOT, "package.json.packbak");

/**
 * Scripts a consumer of the package can meaningfully run.
 *
 * Nothing today: the package ships a `bin`, and everything it can do is reached
 * through that. Kept as a list rather than inlined as `{}` so that adding one
 * later is an obvious edit rather than a rewrite.
 */
const KEEP: string[] = [];

function strip(): void {
  const raw = fs.readFileSync(MANIFEST, "utf8");
  const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
  if (!fs.existsSync(BACKUP)) fs.writeFileSync(BACKUP, raw);

  const scripts = pkg.scripts ?? {};
  const kept: Record<string, string> = {};
  for (const name of KEEP) {
    if (scripts[name]) kept[name] = scripts[name];
  }
  const dropped = Object.keys(scripts).filter((n) => !(n in kept));
  if (Object.keys(kept).length > 0) pkg.scripts = kept;
  else delete pkg.scripts;

  fs.writeFileSync(MANIFEST, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`pack: dropped ${dropped.length} development script(s): ${dropped.join(", ")}`);
}

function restore(): void {
  if (!fs.existsSync(BACKUP)) return;
  fs.copyFileSync(BACKUP, MANIFEST);
  fs.unlinkSync(BACKUP);
  console.log("pack: package.json restored");
}

const action = process.argv[2];
if (action === "strip") strip();
else if (action === "restore") restore();
else {
  console.error("usage: pack-manifest.ts strip|restore");
  process.exit(1);
}
