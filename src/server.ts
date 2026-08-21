/**
 * HTTP + WebSocket server.
 *
 * Routes:
 *   GET  /            static client (web/)
 *   GET  /healthz     liveness + device counts
 *   GET  /devices     the device list as JSON
 *   WS   /v1          the protocol (ARCHITECTURE.md)
 *
 * `/devices` exists for callers that cannot hold a WebSocket — the Omarchy bar
 * widget polls it. It is the same list the `devices` event carries, read from
 * the registry's watch cache, so it costs nothing and cannot block on a
 * provider.
 *
 * `use()` exists for M1: the serve-sim middleware gets mounted through it,
 * behind the path guard.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";

import { Session, type Transport } from "./session.ts";
import type { DeviceRegistry } from "./registry.ts";
import type { HttpMiddleware, UpgradeHandler } from "./types.ts";
import { logger } from "./util/log.ts";

const log = logger("server");

const WEB_ROOT = fileURLToPath(new URL("../web/", import.meta.url));

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

export type { HttpMiddleware, UpgradeHandler } from "./types.ts";

export interface ServerOptions {
  host: string;
  port: number;
  registry: DeviceRegistry;
}

export class SimfarmServer {
  readonly http: http.Server;
  private readonly wss: WebSocketServer;
  private readonly middlewares: HttpMiddleware[] = [];
  private readonly upgradeHandlers: UpgradeHandler[] = [];
  private readonly sessions = new Set<Session>();

  private readonly opts: ServerOptions;

  constructor(opts: ServerOptions) {
    this.opts = opts;
    this.http = http.createServer((req, res) => this.onRequest(req, res));
    this.wss = new WebSocketServer({ noServer: true });
    this.http.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      // /v1 is ours and is checked first: no upgrade handler can shadow the
      // protocol endpoint.
      if (url.pathname === "/v1") {
        this.wss.handleUpgrade(req, socket, head, (ws) =>
          this.onSocket(ws, req),
        );
        return;
      }
      for (const handler of this.upgradeHandlers) {
        try {
          if (handler(req, socket, head)) return;
        } catch (err) {
          log.error(`upgrade handler threw: ${String(err)}`);
          break;
        }
      }
      socket.destroy();
    });
  }

  /** Mount an HTTP middleware; they run in registration order before statics. */
  use(mw: HttpMiddleware): void {
    this.middlewares.push(mw);
  }

  /**
   * Register a WebSocket upgrade handler for paths other than /v1.
   *
   * This exists because a provider may need to consume a third-party
   * WebSocket endpoint that lives outside the connect chain — serve-sim serves
   * its HID socket straight off `handleUpgrade`. Returning true claims the
   * socket; anything unclaimed is destroyed.
   */
  onUpgrade(handler: UpgradeHandler): void {
    this.upgradeHandlers.push(handler);
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.http.once("error", reject);
      this.http.listen(this.opts.port, this.opts.host, () => {
        this.http.off("error", reject);
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    for (const s of this.sessions) await s.close();
    this.sessions.clear();
    for (const client of this.wss.clients) client.terminate();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }

  // -------------------------------------------------------------------------

  private onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    let i = 0;
    const next = (): void => {
      const mw = this.middlewares[i++];
      if (mw) {
        try {
          mw(req, res, next);
        } catch (err) {
          log.error(`middleware threw: ${String(err)}`);
          if (!res.headersSent) res.writeHead(500).end("internal error");
        }
        return;
      }
      this.serveBuiltin(req, res);
    };
    next();
  }

  private serveBuiltin(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === "/healthz") {
      const devices = this.opts.registry.devices();
      res.writeHead(200, { "content-type": CONTENT_TYPES[".json"]! });
      res.end(
        JSON.stringify({
          ok: true,
          uptime: process.uptime(),
          // `devices` counts everything a provider knows about, which for iOS
          // is every simulator ever created — 28 of them here, of which one is
          // usually running. `booted` is the number you actually want on a
          // status bar, so it gets its own field rather than redefining the old
          // one out from under anything already reading it.
          devices: devices.length,
          booted: devices.filter((d) => d.state === "booted").length,
          sessions: this.sessions.size,
        }),
      );
      return;
    }

    if (url.pathname === "/devices") {
      const devices = this.opts.registry.devices();
      res.writeHead(200, {
        "content-type": CONTENT_TYPES[".json"]!,
        "cache-control": "no-store",
      });
      res.end(
        JSON.stringify({
          devices: url.searchParams.get("booted") === "1"
            ? devices.filter((d) => d.state === "booted")
            : devices,
        }),
      );
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405).end("method not allowed");
      return;
    }

    const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const file = path.resolve(WEB_ROOT, rel);
    if (!file.startsWith(WEB_ROOT)) {
      res.writeHead(403).end("forbidden");
      return;
    }

    fs.readFile(file, (err, body) => {
      if (err) {
        res.writeHead(404, { "content-type": "text/plain" }).end("not found");
        return;
      }
      res.writeHead(200, {
        "content-type":
          CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream",
        "cache-control": "no-cache",
      });
      res.end(req.method === "HEAD" ? undefined : body);
    });
  }

  private onSocket(ws: WebSocket, req: http.IncomingMessage): void {
    const peer = req.socket.remoteAddress ?? "?";
    log.info(`client connected from ${peer}`);
    ws.binaryType = "nodebuffer";

    const transport: Transport = {
      send: (data) => {
        if (ws.readyState === ws.OPEN) ws.send(data, { binary: true });
      },
      bufferedAmount: () => ws.bufferedAmount,
      close: (code, reason) => ws.close(code, reason),
    };

    const session = new Session(transport, this.opts.registry, logger("session"));
    this.sessions.add(session);
    session.start();

    ws.on("message", (data, isBinary) => {
      if (!isBinary) {
        log.warn("ignoring text frame from client");
        return;
      }
      const buf = Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.isBuffer(data)
          ? data
          : Buffer.from(data as ArrayBuffer);
      void session.handleMessage(
        new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
      );
    });

    ws.on("close", () => {
      log.info(`client ${peer} disconnected`);
      this.sessions.delete(session);
      void session.close();
    });

    ws.on("error", (err) => {
      log.warn(`socket error from ${peer}: ${String(err)}`);
    });
  }
}
