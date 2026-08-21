/**
 * A very small Chrome DevTools Protocol client.
 *
 * One socket per target. We connect to each target's own
 * `webSocketDebuggerUrl` rather than using browser-level flat sessions: the
 * WeChat devtools is Chromium 91 inside NW.js, the per-target endpoints are
 * exactly what `/json/list` advertises, and one socket per page frame keeps the
 * lifetime of a subscription tied to the lifetime of the thing it watches — when
 * a mini program page is popped, its socket simply closes.
 *
 * Every request carries a timeout because some CDP calls genuinely never answer
 * here: `Page.captureScreenshot` against a page frame the compositor is not
 * drawing hangs forever rather than failing.
 */

import { WebSocket } from "ws";

const DEFAULT_TIMEOUT_MS = 10_000;

type EventHandler = (params: Record<string, unknown>) => void;

interface Pending {
  resolve: (value: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class CdpError extends Error {}

export class CdpConnection {
  readonly url: string;

  private readonly ws: WebSocket;
  private readonly pending = new Map<number, Pending>();
  private readonly handlers = new Map<string, Set<EventHandler>>();
  private nextId = 0;
  private closed = false;
  private closeReason = "";

  /** Called once when the socket goes away for any reason. */
  onClose: ((reason: string) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    this.ws = new WebSocket(url, {
      // Screencast frames are base64 JPEGs; the default 100 MiB cap is fine but
      // the fragmented default can stall on big frames.
      maxPayload: 64 * 1024 * 1024,
    });
    this.ws.on("message", (raw) => this.onMessage(raw));
    this.ws.on("close", () => this.teardown("socket closed"));
    this.ws.on("error", (err) => this.teardown(`socket error: ${String(err)}`));
  }

  static async open(url: string): Promise<CdpConnection> {
    const conn = new CdpConnection(url);
    await conn.ready();
    return conn;
  }

  ready(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        this.ws.terminate();
        reject(new CdpError(`CDP connect timed out: ${this.url}`));
      }, timeoutMs);
      const onOpen = (): void => {
        cleanup();
        resolve();
      };
      const onError = (err: Error): void => {
        cleanup();
        reject(new CdpError(`CDP connect failed: ${String(err)}`));
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        this.ws.off("open", onOpen);
        this.ws.off("error", onError);
      };
      this.ws.once("open", onOpen);
      this.ws.once("error", onError);
    });
  }

  get isOpen(): boolean {
    return !this.closed && this.ws.readyState === WebSocket.OPEN;
  }

  send(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<Record<string, unknown>> {
    if (this.closed) {
      return Promise.reject(new CdpError(`CDP closed (${this.closeReason})`));
    }
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new CdpError(`${method} send failed: ${String(err)}`));
      }
    });
  }

  /** Fire-and-forget: for input, where waiting on the ack costs more than it buys. */
  post(method: string, params: Record<string, unknown> = {}): void {
    if (!this.isOpen) return;
    try {
      this.ws.send(JSON.stringify({ id: ++this.nextId, method, params }));
    } catch {
      // the close handler will report it
    }
  }

  /** @returns unsubscribe */
  on(event: string, handler: EventHandler): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler);
    return () => set.delete(handler);
  }

  close(): void {
    if (this.closed) return;
    try {
      this.ws.close();
    } catch {
      this.ws.terminate();
    }
    this.teardown("closed by us");
  }

  // -------------------------------------------------------------------------

  private onMessage(raw: unknown): void {
    let msg: {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
      result?: Record<string, unknown>;
      error?: { message?: string };
    };
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }

    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new CdpError(msg.error.message ?? "CDP error"));
      else p.resolve(msg.result ?? {});
      return;
    }

    if (typeof msg.method === "string") {
      const set = this.handlers.get(msg.method);
      if (!set) return;
      for (const handler of set) {
        try {
          handler(msg.params ?? {});
        } catch {
          // a bad listener must not kill the socket's read loop
        }
      }
    }
  }

  private teardown(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new CdpError(`CDP closed: ${reason}`));
    }
    this.pending.clear();
    this.handlers.clear();
    const cb = this.onClose;
    this.onClose = null;
    cb?.(reason);
  }
}

// ---------------------------------------------------------------------------

/** `GET http://<host>:<port>/json/list` — the target inventory. */
export async function fetchTargets(
  endpoint: string,
  timeoutMs = 4000,
): Promise<import("./wechat-targets.ts").CdpTarget[]> {
  const res = await fetch(`${endpoint}/json/list`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new CdpError(`/json/list failed: ${res.status}`);
  return (await res.json()) as import("./wechat-targets.ts").CdpTarget[];
}

/**
 * The browser-level debugger socket, used only to be told when targets come and
 * go. Polling `/json/list` for that is a race: a mini program page transition
 * destroys and creates page frames in well under a poll interval, and any input
 * dispatched in the gap goes to a frame that is no longer on screen.
 */
export async function browserWsUrl(
  endpoint: string,
  timeoutMs = 4000,
): Promise<string> {
  const res = await fetch(`${endpoint}/json/version`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new CdpError(`/json/version failed: ${res.status}`);
  const body = (await res.json()) as { webSocketDebuggerUrl?: string };
  if (!body.webSocketDebuggerUrl) {
    throw new CdpError("no browser webSocketDebuggerUrl");
  }
  return body.webSocketDebuggerUrl;
}

/** True when something is listening and speaking CDP at `endpoint`. */
export async function probe(endpoint: string, timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetch(`${endpoint}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}
