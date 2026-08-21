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

import { execFile } from "node:child_process";

export const APP_PATH = "/Applications/wechatwebdevtools.app";
export const CLI_PATH = `${APP_PATH}/Contents/MacOS/cli`;

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
  return `open -a ${APP_PATH} --args ${launchArgs(debugPort).join(" ")}`;
}

function run(
  file: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { encoding: "utf-8", timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
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
