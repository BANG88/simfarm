/**
 * The publish-only build: `src/*.ts` -> `dist/*.js`, with bun.
 *
 * A clone still has **no build step**. `npm start` is `node src/main.ts` and
 * Node strips the types itself. This script exists for one reason: Node refuses
 * to strip types for anything under `node_modules`
 * (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), so a published `.ts` entry
 * point fails for every `npx simfarm` user. Measured, not assumed.
 *
 * Three constraints shape it, and each one is checked here rather than trusted:
 *
 * 1. **The layout must survive.** Two modules resolve paths off
 *    `import.meta.url` — `src/server.ts` wants the entry one level below the
 *    package root (`../web/`) and `src/providers/android/scrcpy-release.ts`
 *    wants three (`../../../vendor`). A *bundle* collapses everything into one
 *    file at one depth, so it cannot satisfy both. Hence `--no-bundle`, which
 *    transpiles file-for-file and keeps the tree.
 *
 * 2. **The `.ts` import specifiers must become `.js`.** The sources import each
 *    other with explicit `.ts` extensions, which is what Node wants when
 *    running them directly. tsc used to rewrite those on the way out
 *    (`rewriteRelativeImportExtensions`); bun's transpiler leaves them alone,
 *    so `rewriteSpecifiers()` does it, and `verifyOutput()` then resolves every
 *    remaining relative specifier against the emitted tree and fails the build
 *    if one dangles.
 *
 * 3. **`dist/main.js` must keep its shebang.** bun drops it in `--no-bundle`
 *    mode; it is put back, and the file is made executable.
 *
 * No source maps and no `.d.ts` are emitted: this package ships a `bin` and
 * nothing else — no `main`, no `exports`, no `types` — so both are unreachable
 * weight in the tarball. Type *checking* is unchanged and still tsc's job
 * (`npm run typecheck`).
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SRC = path.join(ROOT, "src");
const OUT = path.join(ROOT, "dist");

/** Every `.ts` under `src/`, as absolute paths. */
function sources(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sources(full));
    else if (entry.name.endsWith(".ts")) found.push(full);
  }
  return found.sort();
}

/** Every `.js` under `dist/`, as absolute paths. */
function outputs(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...outputs(full));
    else if (entry.name.endsWith(".js")) found.push(full);
  }
  return found.sort();
}

/**
 * How to invoke bun.
 *
 * When this script is itself run by bun — which is how `npm run build` invokes
 * it — the answer is already in hand: `process.execPath` is that same bun
 * binary. Preferring it means the nested `bun build` cannot resolve to a
 * different install, and it sidesteps PATH entirely, which matters because
 * under a version manager bun is a shim that a lifecycle script's PATH may not
 * carry.
 *
 * The rest is fallback for being run by something else: `$BUN`, a plain `bun`,
 * then `mise exec -- bun`.
 */
function findBun(): { cmd: string; args: string[] } {
  const runningUnderBun =
    typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
  const candidates: { cmd: string; args: string[] }[] = [
    ...(runningUnderBun ? [{ cmd: process.execPath, args: [] }] : []),
    { cmd: process.env.BUN ?? "bun", args: [] },
    { cmd: "mise", args: ["exec", "--", "bun"] },
  ];
  for (const c of candidates) {
    const probe = spawnSync(c.cmd, [...c.args, "--version"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (probe.status === 0) return c;
  }
  throw new Error(
    "bun not found. The publish build needs it (development does not: " +
      "`npm start` runs the TypeScript directly). Install it from " +
      "https://bun.sh, or point $BUN at the binary.",
  );
}

/**
 * `from "./x.ts"` -> `from "./x.js"`, for relative specifiers only.
 *
 * Anchored to a `from` / `import` / `import(` keyword so that a string literal
 * that merely looks like a module path is left alone.
 */
const SPECIFIER = /((?:\bfrom|\bimport)\s*\(?\s*)(["'])(\.{1,2}\/[^"'\n]*?)\.ts\2/g;

function rewriteSpecifiers(code: string): string {
  return code.replace(SPECIFIER, (_m, lead, quote, spec) => `${lead}${quote}${spec}.js${quote}`);
}

/** Every relative module specifier in an emitted file. */
const RELATIVE = /(?:\bfrom|\bimport)\s*\(?\s*(["'])(\.{1,2}\/[^"'\n]*?)\1/g;

/**
 * Fail the build on anything the rewrite missed: a surviving `.ts` specifier,
 * or a relative import that does not land on a file that was actually emitted.
 * Both would be a runtime `ERR_MODULE_NOT_FOUND` for the installed user, and
 * both are invisible until then.
 */
function verifyOutput(files: string[]): void {
  const problems: string[] = [];
  for (const file of files) {
    const code = fs.readFileSync(file, "utf8");
    for (const [, , spec] of code.matchAll(RELATIVE)) {
      const rel = path.relative(OUT, file);
      if (spec!.endsWith(".ts")) {
        problems.push(`${rel}: still imports "${spec}"`);
        continue;
      }
      const target = path.resolve(path.dirname(file), spec!);
      if (!fs.existsSync(target)) {
        problems.push(`${rel}: imports "${spec}", which was not emitted`);
      }
    }
  }
  if (problems.length) {
    throw new Error(`the build produced broken imports:\n  ${problems.join("\n  ")}`);
  }
}

function main(): void {
  const bun = findBun();
  const entries = sources(SRC);
  if (entries.length === 0) throw new Error(`no sources under ${SRC}`);

  fs.rmSync(OUT, { recursive: true, force: true });

  const build = spawnSync(
    bun.cmd,
    [
      ...bun.args,
      "build",
      "--no-bundle", // keeps the tree; see (1) above
      "--target=node",
      `--root=${SRC}`,
      `--outdir=${OUT}`,
      ...entries,
    ],
    { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] },
  );
  if (build.status !== 0) {
    throw new Error(`bun build failed (exit ${build.status ?? "signal"})`);
  }

  const emitted = outputs(OUT);
  for (const file of emitted) {
    fs.writeFileSync(file, rewriteSpecifiers(fs.readFileSync(file, "utf8")));
  }

  // bun drops the shebang in --no-bundle mode, and `bin` needs it.
  for (const entry of entries) {
    const first = fs.readFileSync(entry, "utf8").split("\n", 1)[0] ?? "";
    if (!first.startsWith("#!")) continue;
    const out = path.join(OUT, path.relative(SRC, entry).replace(/\.ts$/, ".js"));
    const code = fs.readFileSync(out, "utf8");
    if (!code.startsWith("#!")) fs.writeFileSync(out, `${first}\n${code}`);
    fs.chmodSync(out, 0o755);
  }

  verifyOutput(emitted);

  const bytes = emitted.reduce((n, f) => n + fs.statSync(f).size, 0);
  console.log(`dist/: ${emitted.length} files, ${(bytes / 1024).toFixed(0)} kB`);
}

main();
