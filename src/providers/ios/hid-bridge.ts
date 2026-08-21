/**
 * Private transport for serve-sim's HID input socket.
 *
 * Why this exists
 * ---------------
 * serve-sim delivers HID input over a WebSocket at
 * `{base}/helper/<udid>/ws`, and it handles that socket from
 * `SimMiddleware.handleUpgrade` — *not* from the connect-style
 * `(req, res, next)` chain. simfarm's HTTP server owns `upgrade` itself and
 * destroys any socket whose path is not `/v1` (src/server.ts), and there is no
 * `Provider.handleUpgrade` seam. Shared files are frozen during parallel
 * development, so the provider cannot route the upgrade through the public
 * server.
 *
 * So it routes it through a private one: a tiny `http.Server` bound to a **Unix
 * domain socket** in a 0700 temp directory, whose only job is to hand
 * `/_ios/helper/<udid>/ws` upgrades to serve-sim. That keeps input working
 * with no TCP port, no new network surface (a Unix socket is protected by
 * filesystem permissions, and this one lives in a directory only this user can
 * enter), and no change to any shared file. Everything else — the video
 * streams, config, ax, foreground, grid — still goes through the publicly
 * mounted middleware behind the ARCHITECTURE.md guard.
 *
 * See docs/evidence/ios/NOTES.md: a `Provider.handleUpgrade?()` seam in
 * server.ts would let this file go away.
 */

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { Socket } from "node:net";
import { WebSocket } from "ws";

import { logger } from "../../util/log.ts";
import { decodeConfigFrame, encodeHidFrame, type HidFrame, type SimScreenConfig } from "./hid-protocol.ts";
import { hidPath, isHidPath } from "./sim-paths.ts";
import type { SimMiddleware } from "./serve-sim.ts";

const log = logger("ios");

export interface HidSocketEvents {
  onConfig?: (config: SimScreenConfig) => void;
  onClose?: () => void;
}

export class HidSocket {
  private readonly ws: WebSocket;
  private events: HidSocketEvents = {};
  private closed = false;

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.binaryType = "nodebuffer";
    ws.on("message", (data: Buffer) => {
      const config = decodeConfigFrame(
        new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      );
      if (config) this.events.onConfig?.(config);
    });
    ws.on("close", () => {
      this.closed = true;
      this.events.onClose?.();
    });
    ws.on("error", (err) => log.warn(`hid socket error: ${String(err)}`));
  }

  subscribe(events: HidSocketEvents): void {
    this.events = events;
  }

  get open(): boolean {
    return !this.closed && this.ws.readyState === WebSocket.OPEN;
  }

  send(frames: HidFrame[]): void {
    if (!this.open) return;
    for (const frame of frames) {
      this.ws.send(encodeHidFrame(frame), { binary: true });
    }
  }

  close(): void {
    this.closed = true;
    try {
      this.ws.close();
    } catch {
      /* already gone */
    }
  }
}

export class HidBridge {
  private server: http.Server | null = null;
  private dir: string | null = null;
  private socketPath: string | null = null;

  async start(mw: SimMiddleware): Promise<void> {
    if (this.server) return;

    // 0700 by mkdtemp; the socket inside inherits the directory's protection.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simfarm-ios-"));
    fs.chmodSync(dir, 0o700);
    const socketPath = path.join(dir, "hid.sock");

    const server = http.createServer((_req, res) => {
      // Nothing but upgrades is served here.
      res.writeHead(404).end();
    });
    server.on("upgrade", (req, socket, head) => {
      // Belt and braces: serve-sim's own exec-ws control channel also lives
      // behind handleUpgrade. Only the HID path is ever forwarded.
      if (!isHidPath(req.url ?? "")) {
        socket.destroy();
        return;
      }
      // node:http types the upgrade socket as Duplex; it is a net.Socket.
      mw.handleUpgrade(req, socket as unknown as Socket, head);
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });

    this.server = server;
    this.dir = dir;
    this.socketPath = socketPath;
    log.debug(`hid bridge listening on ${socketPath}`);
  }

  async connect(udid: string, timeoutMs = 5000): Promise<HidSocket> {
    if (!this.socketPath) throw new Error("hid bridge not started");
    const ws = new WebSocket(
      `ws+unix://${this.socketPath}:${hidPath(udid)}`,
    );
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error(`hid socket for ${udid} did not open in ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      ws.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    return new HidSocket(ws);
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (this.dir) {
      fs.rmSync(this.dir, { recursive: true, force: true });
      this.dir = null;
      this.socketPath = null;
    }
  }
}
