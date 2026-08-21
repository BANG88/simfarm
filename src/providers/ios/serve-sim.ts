/**
 * Loader for serve-sim's public `./middleware` export.
 *
 * It is loaded with `createRequire` rather than a static `import` on purpose.
 * serve-sim's package.json points the `types` condition at its raw
 * `src/middleware.ts`, which imports several modules that are not in its
 * published `files` list and uses extensionless relative specifiers — under
 * this repo's `moduleResolution: nodenext` that produces ~15 type errors in a
 * dependency we do not own, and `skipLibCheck` does not suppress them because
 * the file is `.ts`, not `.d.ts`. Going through `require()` keeps the runtime
 * behaviour identical (the CJS entry just re-exports the ESM bundle) while
 * keeping the dependency's sources out of our program. The surface we actually
 * use is declared below.
 *
 * This is also the only place that knows serve-sim exists; everything else in
 * the provider talks HTTP/WebSocket to routes it mounted.
 */

import { createRequire } from "node:module";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";

export interface SimMiddlewareOptions {
  /** Where to mount. Default "/.sim"; we always pass "/_ios". */
  basePath?: string;
  /** Pin the preview to one simulator. Unused — we address devices per route. */
  device?: string;
  /** Bearer token for its exec route. We never expose that route (ARCHITECTURE.md). */
  execToken?: string;
}

/** Connect-style, but with an async `next`. */
export interface SimMiddleware {
  (req: IncomingMessage, res: ServerResponse, next?: () => Promise<void>): Promise<void>;
  handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void;
}

interface ServeSimModule {
  simMiddleware(options?: SimMiddlewareOptions): SimMiddleware;
}

const require_ = createRequire(import.meta.url);

let cached: ServeSimModule | null = null;

export function loadServeSim(): ServeSimModule {
  if (!cached) {
    cached = require_("serve-sim/middleware") as ServeSimModule;
    if (typeof cached.simMiddleware !== "function") {
      throw new Error("serve-sim/middleware did not export simMiddleware");
    }
  }
  return cached;
}
