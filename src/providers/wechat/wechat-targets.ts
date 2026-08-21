/**
 * Reading the WeChat devtools' CDP target list.
 *
 * The tool is a NW.js (Chromium 91) app, so `GET /json/list` describes its whole
 * window tree. Three kinds of target matter:
 *
 *   page     .../html/index.html?projectpath=…&appid=…   one per open project
 *   webview  http://127.0.0.1:<port>/__pageframe__/<route>   the render layer
 *   webview  http://127.0.0.1:<port>/appservice/mainframe    the logic layer
 *
 * Everything here is pure parsing over that list — no sockets — so the awkward
 * parts (a project with no render layer yet, several projects at once, the two
 * different window layouts) are unit-testable.
 *
 * ⚠️ A `__pageframe__` target only exists once the mini program has actually
 * rendered. "Tool open, nothing rendered" is a normal state, not an error — an
 * earlier spike concluded the render layer did not exist at all because it
 * looked before that point (ARCHITECTURE.md).
 */

export interface CdpTarget {
  id: string;
  type: string;
  url: string;
  title?: string;
  parentId?: string;
  webSocketDebuggerUrl?: string;
}

/** One project window open in the IDE. */
export interface WechatProject {
  /** mini program appid, e.g. "wxa1b2c3d4e5f60789" */
  appid: string;
  /** absolute path of the project the IDE has open */
  projectPath: string;
  /** the IDE's own name for it; usually the last path segment */
  projectName: string;
  /** target id of the IDE page, used to attribute page frames to this project */
  targetId: string;
}

/** One render-layer webview: a single mini program page. */
export interface PageFrame {
  targetId: string;
  wsUrl: string;
  /** e.g. "pages/home/index" */
  route: string;
  /** the local http port the project is served on; groups frames per project */
  port: string;
  parentId?: string;
}

export interface AppService {
  targetId: string;
  wsUrl: string;
  port: string;
  parentId?: string;
}

const PAGEFRAME_MARK = "/__pageframe__/";
const APPSERVICE_MARK = "/appservice/mainframe";

export function isProjectPage(t: CdpTarget): boolean {
  return (
    t.type === "page" &&
    t.url.includes("/html/index.html?") &&
    t.url.includes("projectpath=")
  );
}

export function parseProject(t: CdpTarget): WechatProject | null {
  if (!isProjectPage(t)) return null;
  const query = t.url.slice(t.url.indexOf("?") + 1);
  const params = new URLSearchParams(query);
  const projectPath = params.get("projectpath") ?? "";
  if (!projectPath) return null;
  const appid = params.get("appid") ?? "";
  const projectName = params.get("projectname") || lastSegment(projectPath);
  return {
    // Without an appid we still need a stable id; the path is the next best
    // thing the IDE gives us and it is stable across restarts.
    appid: appid || `path-${shortHash(projectPath)}`,
    projectPath,
    projectName,
    targetId: t.id,
  };
}

export function findProjects(targets: CdpTarget[]): WechatProject[] {
  return targets.map(parseProject).filter((p): p is WechatProject => p !== null);
}

/** "http://127.0.0.1:24056/__pageframe__/pages/home/index" -> "pages/home/index" */
export function routeOf(url: string): string | null {
  const i = url.indexOf(PAGEFRAME_MARK);
  if (i < 0) return null;
  const rest = url.slice(i + PAGEFRAME_MARK.length);
  return rest.split(/[?#]/)[0] ?? "";
}

function portOf(url: string): string {
  try {
    return new URL(url).port;
  } catch {
    return "";
  }
}

export function findPageFrames(targets: CdpTarget[]): PageFrame[] {
  const out: PageFrame[] = [];
  for (const t of targets) {
    if (t.type !== "webview") continue;
    const route = routeOf(t.url);
    if (route === null || !t.webSocketDebuggerUrl) continue;
    out.push({
      targetId: t.id,
      wsUrl: t.webSocketDebuggerUrl,
      route,
      port: portOf(t.url),
      ...(t.parentId ? { parentId: t.parentId } : {}),
    });
  }
  return out;
}

export function findAppServices(targets: CdpTarget[]): AppService[] {
  const out: AppService[] = [];
  for (const t of targets) {
    if (t.type !== "webview" || !t.url.includes(APPSERVICE_MARK)) continue;
    if (!t.webSocketDebuggerUrl) continue;
    out.push({
      targetId: t.id,
      wsUrl: t.webSocketDebuggerUrl,
      port: portOf(t.url),
      ...(t.parentId ? { parentId: t.parentId } : {}),
    });
  }
  return out;
}

/**
 * Which project a render/logic target belongs to.
 *
 * The IDE has two layouts and they nest differently: with the simulator docked,
 * a page frame's parent *is* the project page; with the simulator detached, its
 * parent is a `standalone.html` window that has no parent at all. So walk the
 * parent chain first, and only then fall back — to the single open project if
 * there is one, which is the case that actually happens day to day.
 */
export function projectOf(
  child: { parentId?: string; port: string },
  targets: CdpTarget[],
  projects: WechatProject[],
): WechatProject | null {
  const byId = new Map(targets.map((t) => [t.id, t]));
  let cursor = child.parentId;
  for (let hops = 0; cursor && hops < 8; hops++) {
    const project = projects.find((p) => p.targetId === cursor);
    if (project) return project;
    cursor = byId.get(cursor)?.parentId;
  }
  return projects.length === 1 ? projects[0]! : null;
}

/** Group page frames per project, in `targets` order (newest first). */
export function pageFramesByProject(
  targets: CdpTarget[],
): Map<string, PageFrame[]> {
  const projects = findProjects(targets);
  const out = new Map<string, PageFrame[]>();
  for (const p of projects) out.set(p.appid, []);
  for (const frame of findPageFrames(targets)) {
    const project = projectOf(frame, targets, projects);
    if (!project) continue;
    out.get(project.appid)?.push(frame);
  }
  return out;
}

export function appServiceForProject(
  targets: CdpTarget[],
  appid: string,
): AppService | null {
  const projects = findProjects(targets);
  for (const svc of findAppServices(targets)) {
    if (projectOf(svc, targets, projects)?.appid === appid) return svc;
  }
  return null;
}

// ---------------------------------------------------------------------------
// device ids
// ---------------------------------------------------------------------------

export function deviceIdFor(project: WechatProject): string {
  return `wechat:${project.appid}`;
}

/**
 * ARCHITECTURE.md sketched `wechat:<projectHash>`; the appid is what we actually use,
 * because the IDE hands it to us, it is stable across restarts and moves, and
 * unlike a hash it is recognisable to a human reading a log. Projects with no
 * appid fall back to a hash of the project path, so the shape still holds.
 */
export function appidOf(deviceId: string): string {
  const appid = deviceId.startsWith("wechat:") ? deviceId.slice(7) : deviceId;
  if (!appid || /[\s/]/.test(appid)) {
    throw new Error(`not a WeChat device id: "${deviceId}"`);
  }
  return appid;
}

// ---------------------------------------------------------------------------

function lastSegment(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** Small non-cryptographic hash; only ever used to name a project. */
function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
