/**
 * Control plane: launching the WeChat devtools and opening / closing projects.
 *
 * The tool ships an official CLI (`Contents/MacOS/cli`) that talks to an HTTP
 * server the IDE runs on a per-launch port. Its whole surface is
 * login / islogin / preview / upload / autopreview / buildnpm / open / close /
 * quit / resetfileutils / cleancache — **no screenshot, stream, display or input
 * endpoint anywhere** (ARCHITECTURE.md). So it is exactly and only a control plane;
 * everything a user sees or touches goes through CDP.
 *
 * The launch flags below are not optional. Measured 2026-08-20: started without
 * them, the tool renders the first mini program page and then never composites
 * another one. `wx.switchTab()` succeeds, `getCurrentPages()` moves, new page
 * frames appear in the target list — and the picture stays frozen on the page
 * that was up first, because Chromium never brings the new surfaces up while it
 * believes the window is in the background. With them, page transitions work.
 */

import { execFile, spawn } from "node:child_process";
import path from "node:path";

/**
 * Where the tool lives. macOS and Windows are the two builds Tencent ships;
 * `WECHAT_DEVTOOLS_PATH` overrides the install location on either (the .app
 * bundle on macOS, the install folder on Windows).
 */
const WIN32 = process.platform === "win32";

export const APP_PATH =
  process.env.WECHAT_DEVTOOLS_PATH ??
  (WIN32
    ? "C:\\Program Files (x86)\\Tencent\\微信web开发者工具"
    : "/Applications/wechatwebdevtools.app");

export const CLI_PATH = WIN32
  ? path.join(APP_PATH, "cli.bat")
  : `${APP_PATH}/Contents/MacOS/cli`;

/** The executable that starts the IDE itself (macOS goes through `open` instead). */
const WIN_EXE = path.join(APP_PATH, "微信开发者工具.exe");

/**
 * Flags the tool must be started with.
 *
 * `--remote-debugging-port` still takes effect despite the `--disable-devtools`
 * in the app's own `chromium-args` (that one only hides the devtools UI).
 */
export function launchArgs(debugPort: number): string[] {
  return [
    `--remote-debugging-port=${debugPort}`,
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
  ];
}

/** The command a human should run when the tool is up but not debuggable. */
export function launchHint(debugPort: number): string {
  return WIN32
    ? `"${WIN_EXE}" ${launchArgs(debugPort).join(" ")}`
    : `open -a ${APP_PATH} --args ${launchArgs(debugPort).join(" ")}`;
}

function run(
  file: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // Node refuses to spawn a .bat without a shell (CVE-2024-27980), and
    // `cli.bat` is all Windows ships; with a shell the path must be quoted.
    const viaShell = WIN32 && file.toLowerCase().endsWith(".bat");
    execFile(
      viaShell ? `"${file}"` : file,
      args,
      {
        encoding: "utf-8",
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        ...(viaShell ? { shell: true } : {}),
      },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr?.trim() || stdout?.trim() || err.message));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

/** Is a devtools process running at all? */
export async function isToolRunning(): Promise<boolean> {
  try {
    if (WIN32) {
      const { stdout } = await run(
        "tasklist",
        ["/FI", `IMAGENAME eq ${path.basename(WIN_EXE)}`, "/NH"],
        4000,
      );
      return stdout.includes(path.basename(WIN_EXE));
    }
    // The main process is the one holding package.nw; the crash handler and the
    // launcher daemon linger after a quit and must not be mistaken for it.
    const { stdout } = await run("/usr/bin/pgrep", ["-f", "package.nw"], 4000);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Start the tool with the debugging port and the compositing flags.
 * No-op if it is already running — `open --args` cannot re-flag a live process,
 * which is exactly why "already running without the flag" needs a human.
 */
export async function launchTool(debugPort: number): Promise<void> {
  if (await isToolRunning()) return;
  if (WIN32) {
    // No `open` equivalent that returns once the app is up: start the exe
    // detached and let `probe` (wechat-provider.ts) wait for the debug port.
    const proc = spawn(WIN_EXE, launchArgs(debugPort), { detached: true, stdio: "ignore" });
    await new Promise<void>((resolve, reject) => {
      proc.once("spawn", resolve);
      proc.once("error", reject);
    });
    proc.unref();
    return;
  }
  await run("/usr/bin/open", ["-a", APP_PATH, "--args", ...launchArgs(debugPort)], 20_000);
}

export async function openProject(projectPath: string): Promise<void> {
  // Cold start of the IDE plus a project compile; this is genuinely slow.
  await run(CLI_PATH, ["open", "--project", projectPath], 180_000);
}

export async function closeProject(projectPath: string): Promise<void> {
  await run(CLI_PATH, ["close", "--project", projectPath], 60_000);
}

export async function quitTool(): Promise<void> {
  await run(CLI_PATH, ["quit"], 60_000);
}
