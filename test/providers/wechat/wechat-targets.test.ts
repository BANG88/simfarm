/**
 * Reading the WeChat devtools target list.
 *
 * The fixtures below are real `/json/list` output captured from the running
 * tool (2026-08-20), in both of the layouts it has: the simulator docked inside
 * the project window, and the simulator detached into its own `standalone.html`
 * window. They nest differently, which is the whole reason `projectOf` walks a
 * parent chain instead of reading one field.
 *
 * The case that matters most is the empty one: a project with no
 * `__pageframe__` target at all. That is what "the tool is open but the mini
 * program has not rendered" looks like, and mistaking it for "the render layer
 * does not exist" is exactly the wrong turn ARCHITECTURE.md records.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  appidOf,
  appServiceForProject,
  deviceIdFor,
  findAppServices,
  findPageFrames,
  findProjects,
  isProjectPage,
  pageFramesByProject,
  parseProject,
  projectOf,
  routeOf,
  type CdpTarget,
} from "../../../src/providers/wechat/wechat-targets.ts";

const EXT = "chrome-extension://mbeenbnhnmdhkbicabncjghgnikfbgjh";

function projectTarget(
  id: string,
  opts: { path?: string; name?: string; appid?: string } = {},
): CdpTarget {
  const path = opts.path ?? "/Users/dev/projects/example-mini/miniprogram";
  const name = opts.name ?? "mini";
  const appid = opts.appid ?? "wxa1b2c3d4e5f60789";
  return {
    id,
    type: "page",
    title: "微信开发者工具",
    url:
      `${EXT}/html/index.html?projectpath=${encodeURIComponent(path)}` +
      `&projectname=${name}&projectid=${encodeURIComponent(path)}&parentid=` +
      `&theme=dark&messageCenterPort=32933&appid=${appid}&frame=0&devtype=miniprogram`,
    webSocketDebuggerUrl: `ws://127.0.0.1:9222/devtools/page/${id}`,
  };
}

function pageFrameTarget(
  id: string,
  route: string,
  parentId: string,
  port = "24056",
): CdpTarget {
  return {
    id,
    type: "webview",
    parentId,
    title: "微信开发者工具",
    url: `http://127.0.0.1:${port}/__pageframe__/${route}`,
    webSocketDebuggerUrl: `ws://127.0.0.1:9222/devtools/page/${id}`,
  };
}

function appServiceTarget(id: string, parentId: string, port = "24056"): CdpTarget {
  return {
    id,
    type: "webview",
    parentId,
    url: `http://127.0.0.1:${port}/appservice/mainframe?v=3.16.1?load`,
    webSocketDebuggerUrl: `ws://127.0.0.1:9222/devtools/page/${id}`,
  };
}

/** Simulator docked in the project window: page frames hang off the project. */
const DOCKED: CdpTarget[] = [
  pageFrameTarget("4E8F0DD6", "pages/profile/index", "99564BA4"),
  pageFrameTarget("DB6E8C03", "pages/home/index", "99564BA4"),
  {
    id: "0AABD394",
    type: "webview",
    parentId: "99564BA4",
    url: "devtools://devtools/bundled/devtools_app.html?remoteBase=https://chrome-devtools-frontend.appspot.com/",
    webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/0AABD394",
  },
  appServiceTarget("29FD62E7", "99564BA4"),
  projectTarget("99564BA4"),
  { id: "C4CD3384", type: "page", url: `${EXT}/html/entrance.html` },
  { id: "914F38EA", type: "background_page", url: `${EXT}/_generated_background_page.html` },
];

/** Simulator detached: page frames hang off standalone.html, which has no parent. */
const DETACHED: CdpTarget[] = [
  pageFrameTarget("7B662000", "pages/home/index", "A4FC2214", "56230"),
  appServiceTarget("98F2023A", "A4FC2214", "56230"),
  {
    id: "A4FC2214",
    type: "page",
    url: `${EXT}/html/standalone.html`,
    webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/A4FC2214",
  },
  projectTarget("7E9B1FBA"),
];

describe("parseProject", () => {
  it("reads path, name and appid out of the IDE page URL", () => {
    const p = parseProject(projectTarget("X"));
    assert.equal(p?.appid, "wxa1b2c3d4e5f60789");
    assert.equal(p?.projectPath, "/Users/dev/projects/example-mini/miniprogram");
    assert.equal(p?.projectName, "mini");
    assert.equal(p?.targetId, "X");
  });

  it("falls back to a stable hash of the path when there is no appid", () => {
    const a = parseProject(projectTarget("X", { appid: "" }));
    const b = parseProject(projectTarget("Y", { appid: "" }));
    assert.match(a!.appid, /^path-[0-9a-f]{8}$/);
    assert.equal(a!.appid, b!.appid, "same path must give the same id");

    const other = parseProject(projectTarget("Z", { appid: "", path: "/tmp/other" }));
    assert.notEqual(a!.appid, other!.appid);
  });

  it("falls back to the last path segment when projectname is missing", () => {
    const t = projectTarget("X", { name: "" });
    assert.equal(parseProject(t)?.projectName, "miniprogram");
  });

  it("ignores everything that is not a project page", () => {
    for (const t of [
      { id: "a", type: "page", url: `${EXT}/html/entrance.html` },
      { id: "b", type: "page", url: `${EXT}/html/standalone.html` },
      { id: "c", type: "webview", url: "http://127.0.0.1:24056/__pageframe__/pages/home/index" },
      { id: "d", type: "page", url: `${EXT}/html/index.html?theme=dark` },
    ] satisfies CdpTarget[]) {
      assert.equal(isProjectPage(t) && parseProject(t) !== null, false, t.url);
    }
  });
});

describe("routeOf", () => {
  it("takes everything after the marker", () => {
    assert.equal(
      routeOf("http://127.0.0.1:24056/__pageframe__/pages/events/detail/index"),
      "pages/events/detail/index",
    );
  });

  it("drops query and hash", () => {
    assert.equal(
      routeOf("http://127.0.0.1:24056/__pageframe__/pages/home/index?id=7#top"),
      "pages/home/index",
    );
  });

  it("is null for anything else", () => {
    assert.equal(routeOf("http://127.0.0.1:24056/appservice/mainframe"), null);
    assert.equal(routeOf("about:blank"), null);
  });
});

describe("findPageFrames", () => {
  it("finds only the render-layer webviews", () => {
    const frames = findPageFrames(DOCKED);
    assert.deepEqual(
      frames.map((f) => f.route),
      ["pages/profile/index", "pages/home/index"],
    );
    assert.equal(frames[0]!.port, "24056");
    assert.equal(frames[0]!.parentId, "99564BA4");
  });

  it("skips targets with no debugger URL — there is nothing to attach to", () => {
    const t: CdpTarget = {
      id: "z",
      type: "webview",
      url: "http://127.0.0.1:24056/__pageframe__/pages/home/index",
    };
    assert.deepEqual(findPageFrames([t]), []);
  });

  it("returns nothing when the mini program has not rendered yet", () => {
    // The tool is open, the project is loaded, no page has painted. This is a
    // normal state and must not read as "there is no render layer".
    const idle = DOCKED.filter((t) => !t.url.includes("__pageframe__"));
    assert.deepEqual(findPageFrames(idle), []);
    assert.equal(findProjects(idle).length, 1, "the project is still there");
  });
});

describe("projectOf", () => {
  it("attributes page frames through the parent chain when docked", () => {
    const projects = findProjects(DOCKED);
    for (const frame of findPageFrames(DOCKED)) {
      assert.equal(projectOf(frame, DOCKED, projects)?.appid, "wxa1b2c3d4e5f60789");
    }
  });

  it("still attributes them when the simulator is a detached window", () => {
    // Here the chain dead-ends at standalone.html, so the single-project
    // fallback is what carries it.
    const projects = findProjects(DETACHED);
    const frame = findPageFrames(DETACHED)[0]!;
    assert.equal(projectOf(frame, DETACHED, projects)?.appid, "wxa1b2c3d4e5f60789");
  });

  it("refuses to guess when two projects are open and the chain dead-ends", () => {
    const targets: CdpTarget[] = [
      pageFrameTarget("F1", "pages/home/index", "ORPHAN", "56230"),
      { id: "ORPHAN", type: "page", url: `${EXT}/html/standalone.html` },
      projectTarget("P1"),
      projectTarget("P2", { path: "/tmp/second", name: "second", appid: "wxSECOND" }),
    ];
    const frame = findPageFrames(targets)[0]!;
    assert.equal(projectOf(frame, targets, findProjects(targets)), null);
  });

  it("does not loop forever on a cyclic parent chain", () => {
    const targets: CdpTarget[] = [
      pageFrameTarget("F1", "pages/home/index", "A"),
      { id: "A", type: "page", url: "about:blank", parentId: "B" },
      { id: "B", type: "page", url: "about:blank", parentId: "A" },
      projectTarget("P1"),
      projectTarget("P2", { path: "/tmp/second", appid: "wxSECOND" }),
    ];
    assert.equal(
      projectOf(findPageFrames(targets)[0]!, targets, findProjects(targets)),
      null,
    );
  });
});

describe("pageFramesByProject", () => {
  it("groups every frame under its project", () => {
    const byProject = pageFramesByProject(DOCKED);
    assert.deepEqual([...byProject.keys()], ["wxa1b2c3d4e5f60789"]);
    assert.equal(byProject.get("wxa1b2c3d4e5f60789")!.length, 2);
  });

  it("gives an open-but-idle project an empty list, not a missing entry", () => {
    const idle = DOCKED.filter((t) => !t.url.includes("__pageframe__"));
    const byProject = pageFramesByProject(idle);
    assert.deepEqual(byProject.get("wxa1b2c3d4e5f60789"), []);
  });

  it("keeps two projects' frames apart", () => {
    const targets: CdpTarget[] = [
      pageFrameTarget("F1", "pages/home/index", "P1", "24056"),
      pageFrameTarget("F2", "pages/other/index", "P2", "33000"),
      projectTarget("P1"),
      projectTarget("P2", { path: "/tmp/second", name: "second", appid: "wxSECOND" }),
    ];
    const byProject = pageFramesByProject(targets);
    assert.deepEqual(
      byProject.get("wxa1b2c3d4e5f60789")!.map((f) => f.route),
      ["pages/home/index"],
    );
    assert.deepEqual(
      byProject.get("wxSECOND")!.map((f) => f.route),
      ["pages/other/index"],
    );
  });
});

describe("findAppServices / appServiceForProject", () => {
  it("finds the logic layer and ties it to its project", () => {
    assert.equal(findAppServices(DOCKED).length, 1);
    assert.equal(
      appServiceForProject(DOCKED, "wxa1b2c3d4e5f60789")?.targetId,
      "29FD62E7",
    );
  });

  it("is null for an appid that is not open", () => {
    assert.equal(appServiceForProject(DOCKED, "wxNOPE"), null);
  });
});

describe("device ids", () => {
  it("round trips", () => {
    const project = findProjects(DOCKED)[0]!;
    const id = deviceIdFor(project);
    assert.equal(id, "wechat:wxa1b2c3d4e5f60789");
    assert.equal(appidOf(id), "wxa1b2c3d4e5f60789");
  });

  it("accepts a bare appid so a human can type one", () => {
    assert.equal(appidOf("wxa1b2c3d4e5f60789"), "wxa1b2c3d4e5f60789");
  });

  it("rejects ids that are not ours", () => {
    for (const bad of ["wechat:", "", "wechat:has space", "wechat:a/b"]) {
      assert.throws(() => appidOf(bad), /not a WeChat device id/, bad);
    }
  });
});
