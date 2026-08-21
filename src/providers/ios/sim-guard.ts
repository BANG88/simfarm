/**
 * The guard middleware (ARCHITECTURE.md). Mounted *before* serve-sim's middleware so
 * no request can reach `exec`, `exec-ws`, the preview UI or any other
 * non-allowlisted route. See sim-paths.ts for the policy and why it is an
 * allowlist rather than a denylist.
 */

import { logger } from "../../util/log.ts";
import { decide } from "./sim-paths.ts";
import type { HttpMiddleware } from "../../types.ts";

const log = logger("ios");

export function simGuard(): HttpMiddleware {
  return (req, res, next) => {
    if (decide(req.url ?? "/") !== "block") {
      next();
      return;
    }
    log.warn(`blocked serve-sim route ${req.method} ${req.url}`);
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  };
}
