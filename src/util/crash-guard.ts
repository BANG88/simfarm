/**
 * Last line of defence: a rejected promise nobody awaited, or an exception
 * thrown from a callback nobody wrapped, must not take the whole server down.
 *
 * Node's default for both is to print and exit, which is the right thing for
 * a script and the wrong thing for a process that is streaming three devices
 * to two phones: one bad promise on one stream ended every stream and every
 * session (simfarm.log.crash-*: serve-sim's native capture rejecting with
 * `FrameCapture Code=2 "Device not booted"` after a simulator was shut down
 * mid-stream). The providers now handle the failures they know about; this is
 * for the ones they do not, and for the next one.
 *
 * The one thing that *should* still end the process is failing to bind the
 * listening socket: a server that cannot listen is not a server, and a
 * supervisor (launchd) restarting it is the recovery. `listen()` in main.ts
 * awaits its own error and exits through `main().catch`, so a bind error only
 * reaches here if something re-listens later; it is recognised by its
 * syscall and treated the same way.
 */

export interface GuardLogger {
  error(msg: string): void;
}

/** What the handlers log: a one-line classification plus the stack. */
export function describeCrash(err: unknown): string {
  const e = err as { message?: unknown; stack?: unknown; code?: unknown } | null;
  const message = e && typeof e === "object" && "message" in e ? String(e.message) : String(err);
  const code = e && typeof e === "object" && e.code !== undefined ? ` [${String(e.code)}]` : "";
  const stack = e && typeof e === "object" && typeof e.stack === "string" ? e.stack : "";
  return `${sourceOf(message)}: ${message}${code}${stack && stack !== message ? `\n${stack}` : ""}`;
}

/**
 * Which part of the server the error most likely came from. Best effort,
 * from the message alone — an unhandled rejection carries no context of its
 * own, and the point of naming a source is that the log line says "ios
 * capture" instead of leaving the reader to guess from an NSError domain.
 */
export function sourceOf(message: string): string {
  if (/Domain=FrameCapture/.test(message)) return "ios capture (serve-sim FrameCapture)";
  if (/Domain=HIDInjector/.test(message)) return "ios input (serve-sim HIDInjector)";
  if (/Domain=Accessibility/.test(message)) return "ios accessibility (serve-sim)";
  if (/Domain=com\.apple\.CoreSimulator|CoreSimulator/.test(message)) return "ios (CoreSimulator)";
  if (/scrcpy|adb/i.test(message)) return "android";
  if (/ffmpeg/i.test(message)) return "transcoder (ffmpeg)";
  if (/wechat|devtools/i.test(message)) return "wechat";
  return "unknown source";
}

/** A failure to bind the listening socket. Exit on those; nothing else. */
export function isListenFailure(err: unknown): boolean {
  const e = err as { syscall?: unknown; code?: unknown } | null;
  if (!e || typeof e !== "object") return false;
  return e.syscall === "listen";
}

/**
 * The two handlers, separately from installing them, so a test can call them
 * without fighting node:test for the process events.
 */
export function crashHandlers(
  log: GuardLogger,
  exit: (code: number) => void = (code) => process.exit(code),
): { onRejection: (reason: unknown) => void; onException: (err: unknown) => void } {
  return {
    onRejection: (reason) => {
      // A single stream failure must never take the server down. Log it with
      // everything we know and carry on: the sessions and providers that were
      // not involved are still fine, and the one that was has already lost
      // its stream — exiting would only add every other client to the
      // casualty list.
      log.error(`unhandled promise rejection kept from ending the process — ${describeCrash(reason)}`);
    },
    onException: (err) => {
      if (isListenFailure(err)) {
        log.error(`cannot listen: ${describeCrash(err)}`);
        exit(1);
        return;
      }
      log.error(`uncaught exception kept from ending the process — ${describeCrash(err)}`);
    },
  };
}

/**
 * Install the process-level handlers. Returns a function that removes them
 * (tests). Idempotent per process: installing twice is a no-op the second
 * time.
 */
export function installCrashGuards(
  log: GuardLogger,
  exit: (code: number) => void = (code) => process.exit(code),
): () => void {
  if (installed) return installed;
  const { onRejection, onException } = crashHandlers(log, exit);
  process.on("unhandledRejection", onRejection);
  process.on("uncaughtException", onException);
  installed = () => {
    process.off("unhandledRejection", onRejection);
    process.off("uncaughtException", onException);
    installed = null;
  };
  return installed;
}

let installed: (() => void) | null = null;
