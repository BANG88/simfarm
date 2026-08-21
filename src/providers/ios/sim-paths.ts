/**
 * Path policy for the mounted serve-sim middleware (ARCHITECTURE.md).
 *
 * serve-sim's middleware exposes a lot more than the four data-plane routes we
 * need: a shell-exec endpoint (`{base}/exec`, plus a WebSocket twin
 * `{base}/exec-ws`), its own React preview UI at `{base}`, an SSE app-state
 * tail, and a same-origin proxy that fetches Chrome DevTools assets from the
 * public internet. ARCHITECTURE.md only names `exec` and the preview UI, but a
 * *denylist* of those two would still leave the rest reachable and would rot the
 * moment serve-sim adds a route.
 *
 * So this is an allowlist: exactly the routes the iOS provider consumes pass
 * through, everything else under the base path is a 404 before serve-sim ever
 * sees it. Anything outside the base path is none of our business and falls
 * through to the rest of the server.
 *
 * The exec route is easy to get wrong: `.sim` is only serve-sim's *default*
 * basePath, and we mount at `/_ios`, so the route to refuse is `/_ios/exec`
 * rather than `/_ios/.sim/exec`, and the preview UI is `/_ios` itself.
 * Verified against serve-sim@0.1.45 (`simMiddleware`:
 * `base = (options?.basePath ?? "/.sim")`, then `url === base + "/exec"`).
 * Both spellings are refused here — the allowlist covers them by construction.
 */

/** Where the serve-sim middleware is mounted. */
export const IOS_BASE = "/_ios";

/** Device-scoped helper endpoints the provider actually uses. */
const HELPER_ENDPOINTS = new Set([
  "stream.avcc",
  "stream.mjpeg",
  "config",
  "ax",
  "foreground",
  "health",
]);

/** Grid routes used for device enumeration / boot / shutdown. */
const GRID_ROUTES = new Set([
  `${IOS_BASE}/grid/api`,
  `${IOS_BASE}/grid/api/start`,
  `${IOS_BASE}/grid/api/shutdown`,
]);

const UDID_RE =
  /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

/** The HID input socket, reachable only over the provider's private bridge. */
export const HELPER_WS_ENDPOINT = "ws";

export type Decision =
  /** not addressed to serve-sim — hand it to the next middleware */
  | "pass"
  /** an allowlisted serve-sim route — forward it */
  | "allow"
  /** addressed to serve-sim but not allowlisted — 404 without forwarding */
  | "block";

/** Strip the query string. A `#` (illegal in a request-target) stays in the
 *  path on purpose so it fails the canonical-form check below. */
export function pathOf(rawUrl: string): string {
  const q = rawUrl.indexOf("?");
  return q === -1 ? rawUrl : rawUrl.slice(0, q);
}

/**
 * Percent-decode and resolve `.` / `..` / `//`. Returns null when the input
 * cannot be decoded (a malformed escape), which callers treat as hostile.
 *
 * A trailing slash is removed (except on the root) so `/_ios/grid/api/` is not
 * canonical and therefore never reaches serve-sim.
 */
export function canonicalize(path: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return null;
  }
  // A second decode that changes the string means the caller double-encoded;
  // treat the *fully* decoded form as the intent so `%2565xec` cannot hide.
  let prev = decoded;
  for (let i = 0; i < 4; i++) {
    let next: string;
    try {
      next = decodeURIComponent(prev);
    } catch {
      break;
    }
    if (next === prev) break;
    prev = next;
  }
  decoded = prev;

  const out: string[] = [];
  for (const seg of decoded.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return `/${out.join("/")}`;
}

/** True when `path` addresses the serve-sim mount (segment-aware, case-insensitive). */
function touchesBase(path: string): boolean {
  const lower = path.toLowerCase();
  return lower === IOS_BASE || lower.startsWith(`${IOS_BASE}/`);
}

/**
 * Decide what to do with one request URL.
 *
 * The rule is deliberately blunt: a request only reaches serve-sim when its
 * raw path is *already* in canonical form **and** matches the allowlist
 * exactly. Any case variant, percent-encoding, `..` segment, duplicated slash
 * or trailing slash fails the canonical comparison and is blocked — we never
 * have to reason about whether serve-sim's own string comparison would have
 * matched the mutated form.
 */
export function decide(rawUrl: string): Decision {
  const raw = pathOf(rawUrl);
  const canon = canonicalize(raw);

  if (canon === null) {
    // Undecodable. Block if it looks like it is aimed at us, otherwise leave it
    // to the rest of the server (serve-sim compares raw strings, so an
    // undecodable path cannot match any of its routes either).
    return touchesBase(raw) ? "block" : "pass";
  }

  if (!touchesBase(canon) && !touchesBase(raw)) return "pass";

  // From here the request is aimed at the serve-sim mount.
  if (raw !== canon) return "block";
  if (!canon.startsWith(`${IOS_BASE}/`)) return "block"; // `/_ios` itself = preview UI

  if (GRID_ROUTES.has(canon)) return "allow";

  const rest = canon.slice(IOS_BASE.length + 1).split("/");
  if (
    rest.length === 3 &&
    rest[0] === "helper" &&
    UDID_RE.test(rest[1]!) &&
    HELPER_ENDPOINTS.has(rest[2]!)
  ) {
    return "allow";
  }

  return "block";
}

/** Canonical URL for a device-scoped helper endpoint. */
export function helperUrl(
  baseUrl: string,
  udid: string,
  endpoint: string,
  query = "",
): string {
  return `${baseUrl}${IOS_BASE}/helper/${udid}/${endpoint}${query}`;
}

/** Path (no origin) of the HID socket for `udid` — used by the private bridge. */
export function hidPath(udid: string): string {
  return `${IOS_BASE}/helper/${udid}/${HELPER_WS_ENDPOINT}`;
}

/** True when `path` is exactly a HID socket path for some simulator. */
export function isHidPath(rawUrl: string): boolean {
  const raw = pathOf(rawUrl);
  if (canonicalize(raw) !== raw) return false;
  const rest = raw.startsWith(`${IOS_BASE}/`)
    ? raw.slice(IOS_BASE.length + 1).split("/")
    : [];
  return (
    rest.length === 3 &&
    rest[0] === "helper" &&
    UDID_RE.test(rest[1]!) &&
    rest[2] === HELPER_WS_ENDPOINT
  );
}
