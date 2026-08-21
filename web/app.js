// simfarm's client. Plain ESM, no framework, no build step.
//
// It is also the reference implementation of docs/PROTOCOL.md, so the wire
// handling below is deliberately literal.
//
// Two halves, and the line between them matters (ARCHITECTURE.md):
//
//   * the engine — connection, control requests, frame decode, input encoding.
//     This is verified against three real backends and is not to be rewritten
//     for the sake of the UI.
//   * the instrument — how big the picture is drawn, which device is on, and
//     the two floating clusters. That half follows docs/ARCHITECTURE.md.
//
// The one rule that shapes everything visible: the picture is drawn at the size
// the device actually is (§4). Not stretched to the window — 402x874 CSS px for
// an iPhone 17 Pro, because someone is using this to judge whether their own
// 17pt type looks right.

import {
  BUTTON_ID,
  KEY_PHASE,
  TOUCH_EDGE,
  TOUCH_PHASE,
  VIDEO_TAG,
  decodeFrame,
  encodeControl,
  encodeInput,
} from "./protocol.js";

const $ = (sel, root = document) => root.querySelector(sel);

const els = {
  stage: $("#stage"),
  topCluster: $("#top-cluster"),
  bottomCluster: $("#bottom-cluster"),
  deviceButton: $("#device-button"),
  deviceName: $("#device-name"),
  dot: $("#dot"),
  menu: $("#menu"),
  menuList: $("#menu-list"),
  menuSearch: $("#menu-search"),
  rail: $("#rail"),
  railHandle: $("#rail-handle"),
  textRow: $("#text-row"),
  readout: $("#readout"),
  template: $("#stream-template"),
};

const LAST_DEVICE_KEY = "simfarm.deviceId";
const READOUT_KEY = "simfarm.readout";
const ZOOM_KEY = "simfarm.zoom";
const RAIL_KEY = "simfarm.rail";

/**
 * The rail is a drawer, closed by default, opened by hand (ARCHITECTURE.md).
 *
 * Closed, the picture is centred in the whole window and the composition is
 * square with its own frame. Open, the picture slides left by half the gutter
 * and the rail takes the space — the two of them still centred together.
 *
 * This is not the auto-fade coming back. That hid and reappeared on its own,
 * which made the layout move while nobody was touching it; §5.3 records why it
 * went. Nothing here happens without a press.
 */
let railOpen = localStorage.getItem(RAIL_KEY) === "1";

function applyRailState() {
  document.body.classList.toggle("rail-open", railOpen);
  els.railHandle.setAttribute("aria-expanded", railOpen ? "true" : "false");
  els.railHandle.setAttribute("aria-label", railOpen ? "hide tools" : "show tools");
}

/**
 * Zoom is a continuous slider that snaps (ARCHITECTURE.md).
 *
 * The question behind it was "shouldn't there be a ratio?", which is a question
 * about a range, not about four buttons — but the snaps are what keep it usable,
 * because getting exactly back to 1:1 by dragging is otherwise luck.
 *
 * `"fit"` is not a smaller ratio, it is "whatever this window can show", and it
 * is what a laptop needs: a 5120x2880 desktop shows an iPad's 1194pt at 1:1, a
 * 1920x1080 laptop does not, and a HiDPI laptop with 900 logical points cannot
 * manage even an iPhone.
 */
const ZOOM_MIN = 0.25;
const ZOOM_SNAP = [0.5, 0.75, 1];
/** How close a drag has to land before it snaps, as a fraction. */
const ZOOM_SNAP_RANGE = 0.03;

function snapZoom(value) {
  for (const point of ZOOM_SNAP) {
    if (Math.abs(value - point) <= ZOOM_SNAP_RANGE) return point;
  }
  return value;
}

/**
 * What the *user* asked for, or null if they never said.
 *
 * The distinction is the whole point: a device too big for the screen drops to
 * a smaller step on its own, but only while nobody has expressed a preference.
 * Once someone picks 75%, changing device must not quietly overrule them.
 */
let zoomChoice = (() => {
  const stored = localStorage.getItem(ZOOM_KEY);
  if (stored === "fit") return "fit";
  const n = Number(stored);
  return n >= ZOOM_MIN && n <= 1 ? n : null;
})();

/** The zoom popover is a piece of UI state, so a re-render has to preserve it. */
let zoomPopOpen = false;

/**
 * With no preference expressed: the largest snap point that fits, else `"fit"`.
 *
 * Landing on a round number when there is room for one is worth a little
 * arithmetic — "75%" is a number someone can reason about, "73%" is noise.
 */
function autoZoom(fits) {
  for (const point of [...ZOOM_SNAP].reverse()) {
    if (point <= fits + 0.001) return point;
  }
  return "fit";
}

/**
 * The telemetry line is off unless asked for (ARCHITECTURE.md).
 *
 * It was permanent, and it is the third thing in a row that turned out to be
 * clutter on a window that hangs beside an editor all day: the numbers matter
 * when you are chasing frame rate and never otherwise. The `info` key in the
 * rail brings it back, and the choice survives a restart.
 */
let readoutShown = localStorage.getItem(READOUT_KEY) === "1";
/** Show the "show all" row rather than 28 shut-down simulators by default. */
const SEARCH_THRESHOLD = 8;

/**
 * Room the picture may use, once the chrome is out of the way.
 *
 * The rail's strip is read from CSS rather than repeated here: `--rail-gutter`
 * is what actually reserves the column (`.stage` pads by it), and a second copy
 * of the number in JS is a copy that will eventually disagree with it — which
 * would show up as the rail creeping back over the picture.
 *
 * Vertically only the device pill is reserved. It floats over empty space above
 * the picture and does not cover it, so it needs room in the *window*, not a
 * column of its own.
 */
const railGutter = () =>
  parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--rail-gutter")) || 72;

/**
 * The device body, per platform (ARCHITECTURE.md).
 *
 * `pad` is how much wider and taller the *window* has to be; it never comes out
 * of the picture, which stays 1:1. `radius` is the outer corner — the screen's
 * own corner is derived from the two, because that is the geometry a real
 * device has.
 */
const BEZEL = {
  ios: { pad: 13, radius: 46 },
  android: { pad: 11, radius: 32 },
  wechat: { pad: 11, radius: 32 },
  mock: { pad: 8, radius: 18 },
};

const bezelFor = (kind) => BEZEL[kind] ?? BEZEL.mock;

/**
 * How long to wait for a first frame before saying something useful.
 *
 * Long enough that a cold WeChat encoder (measured: 1.6s to the first H.264
 * frame) or a simulator still waking up is not accused of being broken, short
 * enough that nobody sits watching a spinner wondering.
 */
const FIRST_FRAME_GRACE_MS = 10000;

const TOP_PILL_HEIGHT = 56;
const avail = () => ({
  width: innerWidth - 24 - railGutter(),
  height: innerHeight - 24 - TOP_PILL_HEIGHT,
});

/**
 * The outer window size a device wants, clamped to the screen.
 *
 * Pure, and separated out because it is the half that can be wrong in a way
 * nothing would notice: `resizeTo` silently does nothing in a normal tab, so a
 * bad number here only shows up in the app window the plugin opens — as a
 * picture with its left-hand column of icons walked off the edge.
 *
 * @returns `{width, height, fits}` — `fits: false` means even the clamped size
 * cannot show the device 1:1, which is the caller's cue to let `layout()` scale.
 */
function windowTargetFor(pt, chrome, avail, gutter = railGutter(), frame = 0, zoom = 1) {
  const want = {
    // The rail gets its own column and the bezel its own border, so the window
    // is wider by both. They add to the same sum; neither replaces the other.
    width: Math.round(pt.width * zoom) + frame + gutter + 24 + chrome.width,
    height: Math.round(pt.height * zoom) + frame + TOP_PILL_HEIGHT + 24 + chrome.height,
  };
  return {
    width: Math.round(Math.min(want.width, avail.width)),
    height: Math.round(Math.min(want.height, avail.height)),
    fits: want.width <= avail.width && want.height <= avail.height,
  };
}

/**
 * Grow or shrink the window to the device, so 1:1 keeps fitting.
 *
 * An iPhone is 402x874pt and an iPad is 834x1194pt; switching between them in a
 * fixed window means either a lot of empty void or a picture that no longer
 * fits. `resizeTo` is a no-op in an ordinary tab but works in the
 * `chromium --app` window the plugin opens, which is the case that matters.
 *
 * Only for the active stream, and only when the device's point size actually
 * changed — otherwise this races the ResizeObserver that fires because of it.
 */
/**
 * The largest scale this *screen* could show the device at, 1:1 or less.
 *
 * Measured against `screen.availWidth/availHeight`, not the window: the window
 * is the thing we are about to resize, so asking it how big it is would be
 * circular — and it is the screen, not the current window, that decides whether
 * an iPad's 1194pt is possible at all.
 */
function screenFitFor(pt, chrome, frame) {
  const room = {
    width: screen.availWidth - chrome.width - railGutter() - 24 - frame,
    height: screen.availHeight - chrome.height - TOP_PILL_HEIGHT - 24 - frame,
  };
  return Math.max(0.1, Math.min(1, room.width / pt.width, room.height / pt.height));
}

let sizedFor = "";

function sizeWindowFor(view) {
  const pt = view.points();
  if (!pt.width || !pt.height) return true;
  const key = `${view.device.kind}:${pt.width}x${pt.height}:${zoomChoice ?? "auto"}`;
  if (key === sizedFor) return true;
  sizedFor = key;

  const body = bezelFor(view.device.kind);
  const frame = body.pad * 2 + 2;
  const chrome = {
    width: Math.max(0, outerWidth - innerWidth),
    height: Math.max(0, outerHeight - innerHeight),
  };
  // Ask for the window the *degraded* scale needs, not a 1:1 one that the
  // screen would then have to clamp.
  const fits = screenFitFor(pt, chrome, frame);
  const wanted = zoomChoice ?? autoZoom(fits);
  const target = windowTargetFor(
    pt,
    chrome,
    { width: screen.availWidth, height: screen.availHeight },
    railGutter(),
    frame,
    wanted === "fit" ? fits : Math.min(wanted, fits),
  );
  try {
    resizeTo(target.width, target.height);
  } catch {
    // Not an app window. `layout()` scales to whatever room there is instead.
  }
  return target.fits;
}

let ws = null;
let nextId = 1;
const pending = new Map();
/** streamId -> StreamView. A map, not a single slot: the protocol multiplexes
    and the UI must not be the reason that stops being true (ARCHITECTURE.md). */
const streams = new Map();
let devices = [];
let activeStreamId = null;
/** the device we are attaching to right now, so the picker can show it */
let connectingTo = null;

// ---------------------------------------------------------------------------
// theme  (ARCHITECTURE.md)
// ---------------------------------------------------------------------------

/**
 * The nine keys the Omarchy plugin sends, which are also the CSS custom
 * property names in style.css. Keeping them identical means the plugin's
 * fallback path — it writes the variables itself if these functions are missing
 * — lands on the same names as the supported path.
 */
const THEME_KEYS = ["bg", "bgAlt", "fg", "fgDim", "line", "accent", "ok", "warn", "bad"];

/** Only ever a colour. See `applyTheme`. */
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * Adopt an Omarchy theme.
 *
 * The panel follows the desktop completely, light themes included. That reverses
 * the earlier rule ("a bright panel corrupts your judgement of the app's
 * colours") for a reason worth writing down: **the device bezel is the buffer**.
 * Once the picture sits inside a drawn body, the thing next to the app under
 * test is the bezel, not the desktop's cream — so the panel is free to match its
 * surroundings, which is what makes it read as part of the desktop rather than a
 * black hole in it.
 *
 * `accent` stays reserved for the status dot. It is the one saturated colour in
 * the theme that has no semantic meaning here, and letting it onto borders or
 * buttons is exactly how an instrument stops being neutral.
 *
 * Unknown keys and non-colours are dropped rather than written: these values go
 * straight into custom properties that the whole stylesheet reads, and a half
 * applied palette is harder to diagnose than one that did not change.
 */
function applyTheme(theme) {
  if (!theme || typeof theme !== "object") return false;
  const root = document.documentElement;
  let applied = 0;
  for (const key of THEME_KEYS) {
    const value = theme[key];
    if (typeof value !== "string" || !HEX.test(value.trim())) continue;
    root.style.setProperty(`--${key}`, value.trim());
    applied++;
  }
  if (theme.mode === "light" || theme.mode === "dark") setMode(theme.mode);
  return applied > 0;
}

/** Which way round the theme is; drives `color-scheme` and the device below. */
let desktopMode = null;

function setMode(mode) {
  if (mode !== "light" && mode !== "dark") return;
  desktopMode = mode;
  document.documentElement.dataset.mode = mode;
}

/**
 * `?theme=<base64url of the theme JSON>`, which is how the plugin hands the
 * theme over at launch — there is no chance to call into the page before it
 * paints, so the first frame would otherwise be the wrong colour.
 *
 * base64url is standard base64 with `-_` for `+/` and no padding.
 */
function themeFromUrl() {
  const param = new URLSearchParams(location.search).get("theme");
  if (!param) return null;
  try {
    const b64 = param.replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "=")), (c) =>
      c.charCodeAt(0),
    );
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    // A malformed parameter must not take the page down with it; the built-in
    // dark palette is a perfectly good fallback and is what a plain
    // http://127.0.0.1:8801/ gets anyway.
    console.warn("simfarm: ?theme= is not base64url JSON, keeping the defaults");
    return null;
  }
}

/**
 * Push the desktop's light/dark down into the guest.
 *
 * This is the capability the panel has that serve-sim's does not: `appearance`
 * is a typed op on the protocol (PROTOCOL §4), not a shell channel. Devices
 * that do not declare it are skipped in silence — WeChat cannot do this at all,
 * and a client that complained once per theme change would be unusable.
 */
function pushAppearance(view) {
  if (!desktopMode || !view?.device.capabilities.appearance) return;
  request({ op: "appearance", streamId: view.streamId, mode: desktopMode }).catch((err) => {
    // The device said it could, and then could not. That is worth saying.
    showError(`appearance: ${err.message}`);
  });
}

applyTheme(themeFromUrl());

// ---------------------------------------------------------------------------
// connection  (engine — unchanged behaviour)
// ---------------------------------------------------------------------------

function connect() {
  if (ws) {
    ws.onclose = null;
    ws.close();
  }
  for (const s of streams.values()) s.destroy();
  streams.clear();
  activeStreamId = null;

  const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/v1`;
  ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    request({ op: "list" }).catch(() => {});
    renderChrome();
  };

  ws.onclose = () => {
    for (const [id, p] of pending) {
      p.reject(new Error("socket closed"));
      pending.delete(id);
    }
    for (const s of streams.values()) s.destroy();
    streams.clear();
    activeStreamId = null;
    renderAll();
    setTimeout(connect, 2000);
  };

  ws.onmessage = (ev) => {
    const buf = new Uint8Array(ev.data);
    let frame;
    try {
      frame = decodeFrame(buf);
    } catch {
      return;
    }
    if (frame.channel === "video") streams.get(frame.streamId)?.onFrame(frame.tag, frame.data);
    else if (frame.channel === "control") onControl(frame.json);
    else if (frame.channel === "event") onEvent(frame.json);
  };
}

function request(req) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reject(new Error("not connected"));
      return;
    }
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(encodeControl({ id, ...req }));
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`op "${req.op}" timed out`));
    }, 20000);
  });
}

function onControl(json) {
  const p = pending.get(json.id);
  if (!p) return;
  pending.delete(json.id);
  if (json.ok === false) p.reject(new Error(json.error ?? "failed"));
  else p.resolve(json);
}

function onEvent(json) {
  switch (json.ev) {
    case "devices":
      devices = json.devices ?? [];
      renderMenu();
      // A device we were offering to start may have come up — by our button or
      // by someone starting it elsewhere. Either way, that is the moment to
      // connect: the person already said which one they wanted.
      if (offered) {
        const now = devices.find((d) => d.id === offered.id);
        if (now?.state === "booted") void select(offered.id);
        else if (now) offered = now;
      }
      restoreOrPick();
      renderChrome();
      break;
    case "screen":
      streams.get(json.streamId)?.onScreen(json);
      break;
    case "error":
      streams.get(json.streamId)?.markStalled(json.message);
      renderChrome();
      break;
    case "foreground":
      streams.get(json.streamId)?.setForeground(json.bundleId);
      break;
    case "dialog":
      streams.get(json.streamId)?.onDialog(json);
      break;
    default:
      break;
  }
}

const connected = () => ws?.readyState === WebSocket.OPEN;

// ---------------------------------------------------------------------------
// attach / detach
// ---------------------------------------------------------------------------

/**
 * Selecting a device *is* connecting to it (ARCHITECTURE.md): there is no attach
 * button and no codec choice anywhere in this UI. The codec is deliberately not
 * sent — PROTOCOL §4 says the server picks the best one the device offers, and
 * a client that second-guesses that is a client that has to be updated when a
 * backend gains h264.
 */
async function select(deviceId) {
  if (connectingTo) return;
  const device = devices.find((d) => d.id === deviceId);

  /*
   * A shut-down device is picked, not started.
   *
   * "Selecting is connecting" (§8) holds for a device that is already running.
   * Booting one is a different sort of act: a cold simulator takes tens of
   * seconds and a lot of machine, so it gets one deliberate press rather than
   * happening because the pointer landed on a row in a list. Before this, the
   * stage said "pick a device above" — which was both wrong (one *was* picked)
   * and a dead end.
   */
  if (device && device.state !== "booted") {
    for (const id of [...streams.keys()]) await detach(id);
    offered = device;
    startError = "";
    renderAll();
    return;
  }

  offered = null;
  connectingTo = device?.name ?? deviceId;
  renderChrome();
  try {
    for (const id of [...streams.keys()]) await detach(id);
    await attach(deviceId);
    localStorage.setItem(LAST_DEVICE_KEY, deviceId);
  } catch (err) {
    showError(err.message);
  } finally {
    connectingTo = null;
    renderAll();
  }
}

/** The picked-but-not-running device the stage is offering to start. */
let offered = null;
let starting = false;

/**
 * Start it, then connect — one press, not two.
 *
 * Failure shows the server's own words. `boot` reaches very different machinery
 * per backend (`simctl` for iOS, reopening the project for WeChat), so a
 * generic "could not start" would throw away the only useful part.
 */
async function startOffered() {
  const device = offered;
  if (!device || starting) return;
  starting = true;
  renderAll();
  try {
    await request({ op: "boot", deviceId: device.id });
    offered = null;
    starting = false;
    await select(device.id);
  } catch (err) {
    starting = false;
    startError = err.message;
    renderAll();
  }
}

let startError = "";

/**
 * Whether this page can decode H.264 at all.
 *
 * **WebCodecs only exists in a secure context.** Served from `http://<ip>:8801/`
 * — which is how this is reached over Tailscale — `VideoDecoder` is simply
 * undefined, and the failure is the quiet kind: the server happily streams
 * h264, the frame and byte counters tick up, and the canvas stays black. Over
 * `http://127.0.0.1` the same build decodes fine, which is why this went
 * unnoticed: every measurement so far was taken on loopback.
 *
 * The fix here is only the client's half — ask for a codec we can actually
 * draw. The other half is to serve this over TLS (`tailscale cert` issues a
 * real certificate for the MagicDNS name), after which h264 works and this
 * check stops firing.
 */
const canDecodeH264 = typeof VideoDecoder !== "undefined";

/**
 * The codec is deliberately not chosen by the user (ARCHITECTURE.md) — the server
 * picks the best one the device offers (PROTOCOL §4). The one thing we do say is
 * what this *browser* cannot decode, which is a fact about the client, not a
 * preference.
 */
function codecFor(deviceId, requested) {
  if (requested) return requested;
  if (canDecodeH264) return undefined;
  const device = devices.find((d) => d.id === deviceId);
  const video = device?.capabilities?.video ?? [];
  if (!video.includes("jpeg")) {
    // Android offers h264 only. Saying so is better than a black rectangle.
    showError(
      "this page has no WebCodecs, so h264 cannot be decoded — serve simfarm " +
        "over https (or open it on 127.0.0.1) to see this device",
    );
    return undefined;
  }
  return "jpeg";
}

async function attach(deviceId, requested) {
  const codec = codecFor(deviceId, requested);
  const reply = await request(
    codec ? { op: "attach", deviceId, codec } : { op: "attach", deviceId },
  );
  const view = new StreamView(reply.streamId, reply.device, reply.codec);
  streams.set(reply.streamId, view);
  activeStreamId = reply.streamId;
  els.stage.replaceChildren(...[...streams.values()].map((s) => s.el));
  view.el.focus({ preventScroll: true });
  // A device that comes up after the theme was set still has to catch up — the
  // theme change happened while it was not attached.
  pushAppearance(view);
  renderAll();
  return reply;
}

async function detach(streamId) {
  const view = streams.get(streamId);
  if (!view) return;
  streams.delete(streamId);
  view.destroy();
  sizedFor = "";
  if (activeStreamId === streamId) {
    activeStreamId = streams.size ? [...streams.keys()][0] : null;
  }
  try {
    await request({ op: "detach", streamId });
  } catch {
    // the stream is gone from our side either way
  }
  renderAll();
}

/**
 * Opening the window should show a picture with no clicks (ARCHITECTURE.md):
 * whatever was on last time, or the only running device if that one is gone.
 */
const autoTried = new Set();

function restoreOrPick() {
  if (streams.size > 0 || connectingTo) return;
  const booted = devices.filter((d) => d.state === "booted" && !autoTried.has(d.id));
  if (booted.length === 0) return;
  const last = localStorage.getItem(LAST_DEVICE_KEY);
  const target = booted.find((d) => d.id === last) ?? (booted.length === 1 ? booted[0] : null);
  if (!target) return;
  // Auto-pick happens once per device per session. Otherwise a device that
  // refuses to open would be retried on every devices event forever, and a
  // deliberate detach would be undone by the next one. Choosing it by hand
  // still works, and still reports the error.
  autoTried.add(target.id);
  void select(target.id);
}

const active = () => (activeStreamId === null ? null : (streams.get(activeStreamId) ?? null));

// ---------------------------------------------------------------------------
// chrome: the two clusters and the readout
// ---------------------------------------------------------------------------

function renderAll() {
  renderChrome();
  renderControls();
  renderMenu();
}

function renderChrome() {
  const view = active();
  const name = connectingTo ?? view?.device.name ?? (connected() ? "no device" : "connecting…");
  els.deviceName.textContent = name;
  // The pill shows the human name; the id — which carries the serial or the
  // udid — is the thing you actually need when something is wrong, so it goes
  // where it costs no space.
  els.deviceButton.title = view?.device.id ?? "";
  document.title = view?.device.name ?? "simfarm";

  const state = !connected()
    ? "off"
    : connectingTo
      ? "idle"
      : (view?.health() ?? "off");
  els.dot.className = `dot dot-${state}`;
  els.dot.title = {
    live: "receiving frames",
    idle: "still — only the idle fallback",
    stalled: "no frames / error",
    off: "not connected",
  }[state];

  renderReadout();
  if (!view) {
    els.stage.replaceChildren(emptyNote());
  }
}

function emptyNote() {
  const p = document.createElement("p");
  p.className = "empty";

  if (offered) {
    const name = document.createElement("div");
    name.className = "empty-name";
    name.textContent = offered.name;
    const state = document.createElement("div");
    state.textContent = starting ? "starting…" : "not running";
    p.append(name, state);

    // No button when the provider cannot do it. adb cannot start an AVD, and a
    // button that does nothing reads as a broken panel, not a missing feature.
    if (offered.capabilities?.boot) {
      const start = document.createElement("button");
      start.type = "button";
      start.className = "start";
      start.textContent = starting ? "starting…" : "start";
      start.disabled = starting;
      start.onclick = startOffered;
      p.append(start);
    } else {
      const why = document.createElement("div");
      why.className = "empty-why";
      why.textContent = "this backend cannot start it — start it yourself, it will appear here";
      p.append(why);
    }

    if (startError) {
      const err = document.createElement("div");
      err.className = "empty-why bad";
      err.textContent = startError;
      p.append(err);
    }
    return p;
  }

  p.textContent = connected()
    ? devices.length === 0
      ? "no devices — start a simulator"
      : "pick a device above"
    : "connecting to the server…";
  return p;
}

/**
 * The readout (ARCHITECTURE.md): size first, fps last. The pixel size and the
 * point size are what tell you whether you are looking at the real thing, so
 * they lead; a zoom percentage other than 100% is the warning that you are not.
 */
function renderReadout() {
  const view = active();
  els.readout.hidden = !readoutShown && !errorUntil;
  if (!view) {
    els.readout.textContent = "";
    return;
  }
  els.readout.replaceChildren(...view.readout());
}

/**
 * Icons, inline, as `d` attributes on a 24×24 grid.
 *
 * Inline and hand-written because **the page may not make an outbound request**
 * (ARCHITECTURE.md): it is served over a tunnel to a machine whose traffic goes
 * through a proxy, so an icon font is a stall, not a look. Everything is stroked
 * in `currentColor`, so the buttons inherit the same three greys as the rest of
 * the chrome and nothing here can smuggle in a saturated colour (§3).
 *
 * Keys are `capabilities.buttons` names (PROTOCOL §5) plus the three tools.
 */
const ICONS = {
  home: ["M3 10.6 12 3.2l9 7.4", "M5.6 9.4V20.4h12.8V9.4"],
  lock: ["M4.8 10.6h14.4v9.8H4.8z", "M8.4 10.6V7.2a3.6 3.6 0 0 1 7.2 0v3.4"],
  back: ["M15 4.8 8 12l7 7.2"],
  // Android draws recents as a plain square; `action` below is deliberately
  // nothing like it, because those two sit next to each other on no device but
  // do sit next to each other in this list.
  app_switch: ["M5 5h14v14H5z"],
  menu: ["M4 7h16", "M4 12h16", "M4 17h16"],
  power: ["M12 3.2v8.6", "M7.4 6.4a8 8 0 1 0 9.2 0"],
  siri: ["M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z", "M12 8.6a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8z"],
  volume_up: ["M3.6 9.4h3.4L11.4 5.6v12.8L7 14.6H3.6z", "M15.4 12h5", "M17.9 9.5v5"],
  volume_down: ["M3.6 9.4h3.4L11.4 5.6v12.8L7 14.6H3.6z", "M15.4 12h5"],
  camera: ["M3.6 8h4.2l1.6-2.2h5.2L16.2 8h4.2v11.6H3.6z", "M12 10a3.2 3.2 0 1 0 0 6.4 3.2 3.2 0 0 0 0-6.4z"],
  ringer_mute: ["M7.8 17V11a4.2 4.2 0 0 1 8.4 0v6", "M5.8 17h12.4", "M10.3 20h3.4", "M4 4l16 16"],
  action: ["M12 4v16", "M5 8l14 8", "M19 8 5 16"],
  rotate: ["M4.2 12a7.8 7.8 0 0 1 13.4-5.4", "M18 2.8v4h-4", "M19.8 12a7.8 7.8 0 0 1-13.4 5.4", "M6 21.2v-4h4"],
  text: [
    "M3.2 7.4h17.6v9.2H3.2z",
    "M6.6 10.6h.02", "M10 10.6h.02", "M13.6 10.6h.02", "M17 10.6h.02",
    "M7.6 13.6h8.8",
  ],
  info: ["M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z", "M12 11v5.2", "M12 8.1h.01"],
  zoom: ["M10.8 4a6.8 6.8 0 1 0 0 13.6 6.8 6.8 0 0 0 0-13.6z", "M15.8 15.8 20.4 20.4"],
  chevron_left: ["M15 5 8 12l7 7"],
  chevron_right: ["M9 5l7 7-7 7"],
  /** shrink to fit: arrows pointing in */
  fit: ["M9 4.4v4.6H4.4", "M15 4.4v4.6h4.6", "M9 19.6V15H4.4", "M15 19.6V15h4.6"],
  /** back to 1:1: arrows pointing out */
  actual: ["M4.4 9V4.4H9", "M19.6 9V4.4H15", "M4.4 15v4.6H9", "M19.6 15v4.6H15"],
};

/** Build one of the ICONS above as an inline SVG; no request, no icon font. */
function iconSvg(name) {
  const paths = ICONS[name];
  if (!paths) return null;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  for (const d of paths) {
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", d);
    svg.append(p);
  }
  return svg;
}

/**
 * One rail button: an icon, plus a label that only appears on hover.
 *
 * The label slides out to the *left*, because the rail is against the right
 * edge of the window and there is nothing to the right of it.
 */
function railButton(icon, label, onClick, abbrText = "") {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "rail-button";
  b.setAttribute("aria-label", label);
  b.onclick = onClick;

  const svg = abbrText ? null : iconSvg(icon);
  if (svg) {
    b.append(svg);
  } else {
    // A button we have no glyph for still has to be pressable — a device that
    // declares `camera` must not silently lose it because this table is short.
    const abbr = document.createElement("span");
    abbr.className = "rail-abbr";
    abbr.textContent = abbrText || label.slice(0, 2);
    b.append(abbr);
  }

  const tag = document.createElement("span");
  tag.className = "rail-label";
  tag.textContent = label;
  b.append(tag);
  return b;
}

/**
 * Only the buttons this device actually has (ARCHITECTURE.md, §8).
 *
 * Hardware keys first, then a hairline, then the tools — `rotate`, `text` and
 * the zoom toggle are things *this client* does, not keys the device has, and
 * mixing them into the same run was reading as if the phone had a "100%" key.
 */
function renderControls() {
  const view = active();
  els.rail.replaceChildren();
  els.textRow.hidden = true;
  els.bottomCluster.hidden = true;

  if (!view) {
    // No device is a different thing from a closed drawer, and should not
    // animate: `hidden` removes it, the `rail-open` class slides it.
    els.rail.hidden = true;
    els.railHandle.hidden = true;
    return;
  }
  els.rail.hidden = false;
  els.railHandle.hidden = false;
  els.railHandle.replaceChildren(iconSvg(railOpen ? "chevron_right" : "chevron_left"));
  const caps = view.device.capabilities;

  for (const name of caps.buttons ?? []) {
    const id = BUTTON_ID[name];
    if (id === undefined) continue;
    els.rail.append(
      railButton(name, name, () => {
        view.send({ kind: "button", phase: KEY_PHASE.DOWN, buttonId: id });
        setTimeout(() => view.send({ kind: "button", phase: KEY_PHASE.UP, buttonId: id }), 60);
      }),
    );
  }

  const tools = document.createDocumentFragment();
  if (caps.rotate) {
    tools.append(
      railButton("rotate", "rotate", () => {
        const next = nextOrientation(view.screen?.orientation ?? "portrait");
        request({ op: "rotate", streamId: view.streamId, orientation: next }).catch((e) =>
          showError(e.message),
        );
      }),
    );
  }

  if (caps.text) {
    const toggle = railButton("text", "text", () => {
      els.bottomCluster.hidden = false;
      els.textRow.hidden = !els.textRow.hidden;
      els.bottomCluster.hidden = els.textRow.hidden;
      toggle.classList.toggle("on", !els.textRow.hidden);
      if (!els.textRow.hidden) $(".text-input", els.textRow).focus();
    });
    tools.append(toggle);
  }

  /*
   * Zoom (ARCHITECTURE.md): a magnifier in the rail, a slider in a popover.
   *
   * The rail is icons only — that is the whole reason it is narrow enough to
   * have its own column — so the value does not live on it. It used to, as a
   * key labelled "100", next to a hover label saying "zoom 100%": the same fact
   * twice, in the one place on the page that had promised to be pictures.
   * The slider goes in a popover because the rail is ~44px wide and a slider
   * is not.
   */
  const zoom = railButton("zoom", "zoom", () => {
    zoomPopOpen = !zoomPopOpen;
    renderControls();
  });
  zoom.classList.toggle("on", zoomPopOpen || (zoomChoice !== null && zoomChoice !== 1));
  if (zoomPopOpen) zoom.append(zoomPopover(view));
  tools.append(zoom);

  // The telemetry line, off by default (ARCHITECTURE.md). A tool, not a key:
  // it tells you about this *session*, not about the device.
  const info = railButton("info", "info", () => {
    readoutShown = !readoutShown;
    localStorage.setItem(READOUT_KEY, readoutShown ? "1" : "0");
    renderControls();
    renderReadout();
  });
  info.classList.toggle("on", readoutShown);
  tools.append(info);

  if (els.rail.childElementCount > 0 && tools.childElementCount > 0) {
    const sep = document.createElement("div");
    sep.className = "rail-sep";
    els.rail.append(sep);
  }
  els.rail.append(tools);
}

/**
 * The zoom slider, floated to the left of the rail — the rail is against the
 * right edge of the window and there is nothing to its right.
 *
 * Dragging re-scales live but does *not* re-render the rail: rebuilding the
 * button mid-drag would destroy the slider under the pointer. The window is only
 * resized on `change`, when the drag ends, because resizing on every tick of a
 * drag is unusable.
 */
function zoomPopover(view) {
  const pop = document.createElement("div");
  pop.className = "zoom-pop";
  // The popover lives inside the button; without this every click in it would
  // bubble up and toggle the popover shut again.
  pop.onclick = (e) => e.stopPropagation();

  const value = document.createElement("span");
  value.className = "zoom-value";

  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = String(Math.round(ZOOM_MIN * 100));
  slider.max = "100";
  slider.step = "1";
  slider.setAttribute("aria-label", "zoom");

  const fit = document.createElement("button");
  fit.type = "button";
  fit.className = "zoom-fit";
  fit.textContent = "fit";

  const paint = () => {
    const shown = zoomChoice ?? autoZoom(view.zoom ?? 1);
    value.textContent =
      shown === "fit"
        ? `fit · ${Math.round((view.zoom ?? 1) * 100)}%`
        : `${Math.round(shown * 100)}%`;
    if (shown !== "fit") slider.value = String(Math.round(shown * 100));
    fit.classList.toggle("on", shown === "fit");
    value.classList.toggle("auto", zoomChoice === null);
  };

  const applyLive = () => {
    for (const v of streams.values()) v.layout();
    paint();
    renderReadout();
  };

  slider.oninput = () => {
    zoomChoice = snapZoom(Number(slider.value) / 100);
    localStorage.setItem(ZOOM_KEY, String(zoomChoice));
    applyLive();
  };
  // Resizing the window follows the drag rather than riding along with it.
  slider.onchange = () => {
    sizedFor = "";
    const active = streams.get(activeStreamId);
    if (active) sizeWindowFor(active);
    applyLive();
  };

  fit.onclick = () => {
    zoomChoice = "fit";
    localStorage.setItem(ZOOM_KEY, "fit");
    sizedFor = "";
    const active = streams.get(activeStreamId);
    if (active) sizeWindowFor(active);
    applyLive();
  };

  paint();
  pop.append(slider, value, fit);
  return pop;
}

/** Outside click and Esc both close it; see `zoomPopover`. */
function closeZoomPop() {
  if (!zoomPopOpen) return;
  zoomPopOpen = false;
  renderControls();
}

function nextOrientation(current) {
  const ring = ["portrait", "landscape_left", "portrait_upside_down", "landscape_right"];
  return ring[(ring.indexOf(current) + 1) % ring.length] ?? "portrait";
}

/**
 * Errors ride the readout line — and the readout is hidden by default now, so
 * showing one has to reveal it. A failure that reports itself into a hidden
 * element is the same as no report at all, and that is precisely the failure
 * mode this codebase keeps running into.
 */
let errorUntil = 0;

function showError(message) {
  const span = document.createElement("span");
  span.className = "bad";
  span.textContent = ` · ${message}`;
  els.readout.append(span);
  errorUntil = Date.now() + 6000;
  els.readout.hidden = false;
  setTimeout(() => {
    span.remove();
    if (Date.now() >= errorUntil) {
      errorUntil = 0;
      renderReadout();
    }
  }, 6000);
}

// ---------------------------------------------------------------------------
// the device dropdown
// ---------------------------------------------------------------------------

let menuOpen = false;
let showAll = false;
let menuIndex = 0;

function openMenu() {
  menuOpen = true;
  showAll = false;
  menuIndex = 0;
  els.menu.hidden = false;
  els.deviceButton.setAttribute("aria-expanded", "true");
  els.menuSearch.value = "";
  renderMenu();
  if (!els.menuSearch.hidden) els.menuSearch.focus();
}

function closeMenu() {
  menuOpen = false;
  els.menu.hidden = true;
  els.deviceButton.setAttribute("aria-expanded", "false");
  els.deviceButton.focus();
}

function menuRows() {
  const booted = devices.filter((d) => d.state === "booted");
  const rest = devices.filter((d) => d.state !== "booted");
  const query = els.menuSearch.value.trim().toLowerCase();
  const match = (d) => !query || d.name.toLowerCase().includes(query);

  const rows = [];
  for (const d of (showAll || query ? devices : booted).filter(match)) {
    rows.push({ kind: "device", device: d });
  }
  if (!showAll && !query && rest.length > 0) {
    rows.push({ kind: "all", count: devices.length });
  }
  if (streams.size > 0) rows.push({ kind: "detach" });
  return rows;
}

function renderMenu() {
  if (!menuOpen) return;
  // A search box only earns its place once the list is long enough to need it.
  els.menuSearch.hidden = devices.length <= SEARCH_THRESHOLD;

  const rows = menuRows();
  if (menuIndex >= rows.length) menuIndex = Math.max(0, rows.length - 1);

  const nodes = rows.map((row, i) => {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "menu-row";
    el.setAttribute("role", "option");
    if (i === menuIndex) el.classList.add("active");

    if (row.kind === "device") {
      // Name only. No UDID, no capability summary, no platform tag — the name
      // already carries the OS version, and which buttons appear below the
      // picture is a better statement of capability than a string (§8).
      el.textContent = row.device.name;
      if (row.device.state !== "booted") el.classList.add("dim");
      if (active()?.device.id === row.device.id) el.classList.add("current");
      el.onclick = () => {
        closeMenu();
        void select(row.device.id);
      };
    } else if (row.kind === "all") {
      el.className += " quiet";
      el.textContent = `show all (${row.count})`;
      el.onclick = () => {
        showAll = true;
        renderMenu();
      };
    } else {
      el.className += " quiet";
      el.textContent = "detach";
      el.onclick = () => {
        closeMenu();
        void detach(activeStreamId);
      };
    }
    return el;
  });

  if (nodes.length === 0) {
    const empty = document.createElement("div");
    empty.className = "menu-empty";
    empty.textContent = devices.length ? "nothing matches" : "no devices";
    nodes.push(empty);
  }
  els.menuList.replaceChildren(...nodes);
}

function moveMenu(delta) {
  const rows = menuRows();
  if (rows.length === 0) return;
  menuIndex = (menuIndex + delta + rows.length) % rows.length;
  renderMenu();
  els.menuList.children[menuIndex]?.scrollIntoView({ block: "nearest" });
}

els.deviceButton.onclick = () => (menuOpen ? closeMenu() : openMenu());

els.railHandle.onclick = () => {
  railOpen = !railOpen;
  localStorage.setItem(RAIL_KEY, railOpen ? "1" : "0");
  if (!railOpen) zoomPopOpen = false;
  applyRailState();
  renderControls();
};

applyRailState();
els.menuSearch.oninput = () => {
  menuIndex = 0;
  renderMenu();
};

// A click anywhere that is not inside the zoom control closes it. Capture phase,
// so it runs before the rail's own handlers rebuild anything.
addEventListener(
  "pointerdown",
  (e) => {
    if (!zoomPopOpen) return;
    if (e.target instanceof Element && e.target.closest(".rail-button")) return;
    closeZoomPop();
  },
  true,
);

/*
 * There is no auto-fade.
 *
 * The chrome used to dim after two seconds of stillness and come back when the
 * pointer neared an edge. It was a deliberate gamble on screen area — this
 * window lives beside an editor all day — and it lost: with the rail appearing
 * and disappearing, the layout reads as if it keeps going out of alignment.
 * Steadiness is worth more than the strip of pixels it saved.
 */

// ---------------------------------------------------------------------------
// window-level keys
// ---------------------------------------------------------------------------

const isTypingTarget = (el) => el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;

addEventListener("keydown", (e) => {
  if (e.key === "Escape" && zoomPopOpen) {
    e.preventDefault();
    closeZoomPop();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    menuOpen ? closeMenu() : openMenu();
    return;
  }
  if (!menuOpen) return;
  if (e.key === "Escape") {
    e.preventDefault();
    closeMenu();
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    moveMenu(1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    moveMenu(-1);
  } else if (e.key === "Enter") {
    e.preventDefault();
    els.menuList.children[menuIndex]?.click();
  }
});

addEventListener("pointerdown", (e) => {
  if (menuOpen && !els.topCluster.contains(e.target)) closeMenu();
});

/**
 * Keystrokes go to the device (ARCHITECTURE.md) unless they are meant for us:
 * the text field, or the open dropdown. Bound at the window so the device is
 * typeable the moment the window has focus, without clicking the picture first.
 */
for (const [type, phase] of [
  ["keydown", KEY_PHASE.DOWN],
  ["keyup", KEY_PHASE.UP],
]) {
  addEventListener(type, (e) => {
    if (menuOpen || isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return;
    if (e.metaKey || e.ctrlKey) return; // browser and window-manager shortcuts
    active()?.onKey(e, phase);
  });
}

// text injection: one row, revealed by the `text` button
{
  const input = $(".text-input", els.textRow);
  const send = () => {
    const view = active();
    if (!view || !input.value) return;
    view.send({ kind: "text", text: input.value });
    input.value = "";
  };
  $(".send-text", els.textRow).onclick = send;
  // `keydown` cannot see an IME's composed text — a Chinese phrase committed
  // with Enter arrives as keyCode 229 with the field still mid-composition. So
  // Enter only sends when nothing is being composed (ARCHITECTURE.md).
  let composing = false;
  input.addEventListener("compositionstart", () => (composing = true));
  input.addEventListener("compositionend", () => (composing = false));
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter" && !composing && !e.isComposing) send();
  });
}

// ---------------------------------------------------------------------------
// one attached device
// ---------------------------------------------------------------------------

class StreamView {
  constructor(streamId, device, codec) {
    this.streamId = streamId;
    this.device = device;
    this.codec = codec;
    this.seq = 1;
    this.pointerDown = false;
    this.frames = 0;
    this.bytes = 0;
    this.fps = 0;
    this.kbps = 0;
    this.lastStatsAt = performance.now();
    this.attachedAt = performance.now();
    this.lastFrameAt = 0;
    this.stalled = false;
    this.decoding = false;
    this.queued = null;
    this.decoder = null; // h264: WebCodecs VideoDecoder
    this.foreground = "";

    this.el = els.template.content.firstElementChild.cloneNode(true);
    this.canvas = $("canvas.screen", this.el);
    this.ctx = this.canvas.getContext("2d");
    this.sheet = $(".sheet", this.el);
    this.bezel = $(".bezel", this.el);
    this.loadingEl = $(".loading", this.el);
    this.loadingText = $(".loading-text", this.loadingEl);
    /** true once something has actually been drawn on the canvas */
    this.painted = false;
    /** PROTOCOL §3: the server sends one immediately on attach */
    this.sawSeed = false;
    this.gaveUp = false;
    this.waitTimer = setTimeout(() => {
      if (this.painted) return;
      this.gaveUp = true;
      this.renderLoading();
    }, FIRST_FRAME_GRACE_MS);
    const body = bezelFor(device.kind);
    this.bezel.style.setProperty("--bezel-pad", `${body.pad}px`);
    this.bezel.style.setProperty("--bezel-radius", `${body.radius}px`);

    this.applyScreen(
      device.screen ?? { width: 320, height: 640, scale: 1, orientation: "portrait" },
    );
    this.wireInput();
    this.renderLoading();
  }

  destroy() {
    clearTimeout(this.waitTimer);
    try {
      this.decoder?.close();
    } catch {
      /* already closed */
    }
    this.el.remove();
  }

  onScreen(screen) {
    this.applyScreen(screen);
    renderControls();
  }

  setForeground(bundleId) {
    this.foreground = bundleId ?? "";
  }

  /**
   * Draw a sheet the device is showing that the video cannot contain.
   *
   * The WeChat simulator renders `wx.showModal`, action sheets, toasts and the
   * authorization / payment sheets in the IDE's own window, over the page frame
   * rather than inside it — so with a modal up the stream keeps showing an
   * undimmed page while every touch goes nowhere. The server pushes what is
   * there and this puts it back, at the rect the simulator used.
   */
  onDialog(info) {
    const overlays = info.overlays ?? [];
    this.sheet.replaceChildren(...overlays.map((o) => this.sheetBox(o)));
    this.sheet.hidden = overlays.length === 0;
  }

  sheetBox(overlay) {
    const box = document.createElement("div");
    box.className = "sheet-box";
    const r = overlay.rect ?? { x: 0.1, y: 0.35, width: 0.8, height: 0.25 };
    const pct = (n) => `${(n * 100).toFixed(2)}%`;
    Object.assign(box.style, {
      left: pct(r.x),
      top: pct(r.y),
      width: pct(r.width),
      height: pct(r.height),
    });

    // Labelled, because this is our drawing of a dialog and not the device's
    // own pixels; nothing else on this canvas is.
    const kind = document.createElement("div");
    kind.className = "sheet-kind";
    kind.textContent = overlay.kind;
    box.append(kind);

    const body = document.createElement("div");
    body.className = "sheet-body";
    if (overlay.title) {
      const t = document.createElement("div");
      t.className = "sheet-title";
      t.textContent = overlay.title;
      body.append(t);
    }
    if (overlay.content) {
      const c = document.createElement("div");
      c.className = "sheet-content";
      c.textContent = overlay.content;
      body.append(c);
    }
    box.append(body);

    const buttons = overlay.buttons ?? [];
    if (buttons.length) {
      const row = document.createElement("div");
      row.className = "sheet-buttons";
      for (const b of buttons) {
        const el = document.createElement("button");
        el.className = b.role;
        // The payment sheet's only control is a ✕ with no text at all.
        el.textContent = b.label || (b.role === "close" ? "✕" : b.role);
        el.onclick = () => this.press(row, b.index);
        row.append(el);
      }
      box.append(row);
    }
    return box;
  }

  /**
   * Press by index rather than by role: an action sheet's rows have no role
   * beyond "item", and the index is what the server matched them by anyway.
   */
  async press(row, index) {
    for (const b of row.children) b.disabled = true;
    try {
      const reply = await request({
        op: "dialogPress",
        streamId: this.streamId,
        which: index,
      });
      // `pressed: null` means the sheet was already gone — someone dismissed it
      // in the IDE. Nothing will arrive to replace this layer, so let go of it.
      // Provider-specific ops answer inside `result` (PROTOCOL §4).
      if (!reply.result?.pressed) this.onDialog({ overlays: [] });
    } catch (err) {
      showError(err.message);
      for (const b of row.children) b.disabled = false;
    }
    // On success the device's own `dialog` event replaces this whole layer, so
    // there is nothing to re-enable — and leaving it disabled until then is the
    // honest state: the press is in flight.
  }

  markStalled(message) {
    this.stalled = true;
    if (message) showError(message);
  }

  // -- size ------------------------------------------------------------------

  applyScreen(screen) {
    this.screen = screen;
    this.frameRotation = screen.frameRotation ?? 0;
    // Assigning canvas.width clears the canvas even when the value is
    // unchanged — and a still device may not send another frame for a long
    // time, leaving a blank panel. Only resize when it actually changed.
    if (this.canvas.width !== screen.width) this.canvas.width = screen.width;
    if (this.canvas.height !== screen.height) this.canvas.height = screen.height;
    if (this.streamId === activeStreamId) sizeWindowFor(this);
    this.layout();
  }

  /** Device points: what the screen measures in the units its own UI is in. */
  points() {
    const scale = this.screen?.scale || 1;
    return {
      width: Math.round((this.screen?.width ?? 0) / scale),
      height: Math.round((this.screen?.height ?? 0) / scale),
    };
  }

  /**
   * ARCHITECTURE.md, the whole point of the redesign.
   *
   * The canvas keeps the full frame as its backing store and is *displayed* at
   * the device's point size. On a HiDPI screen that is a downsample, which is
   * why the picture looks sharp rather than soft — and it means 17pt type on
   * the device is 17pt here. Scaling only happens when the window genuinely
   * cannot fit the device, and then the readout says so, because judging
   * rendering from a picture you did not know was shrunk is worse than useless.
   */
  layout() {
    const { width: ptW, height: ptH } = this.points();
    if (!ptW || !ptH) return;

    /*
     * Never clip. 1:1 is the requirement (§4.1) but a picture whose left column
     * of icons has walked off the edge of the window is worse than a scaled
     * one — and clipping is what a fixed-size centred canvas does when the
     * window turns out narrower than asked for, which happens whenever the
     * window manager has its own opinion about the size. So the scale is
     * clamped to the room that exists, and the readout says the percentage.
     */
    const room = avail();
    const body = bezelFor(this.device.kind);
    const frame = body.pad * 2 + 2; // padding both sides plus the 1px border
    // The largest scale this window can show without clipping.
    const fits = Math.min(1, (room.width - frame) / ptW, (room.height - frame) / ptH);
    const wanted = zoomChoice ?? autoZoom(fits);
    // Whatever was asked for, never clip: a picture whose left column of icons
    // has walked off the window is worse than a scaled one, and `resizeTo` is a
    // request the window manager gets a vote on.
    this.zoom = wanted === "fit" ? fits : Math.min(wanted, fits);
    // CSS size only. Touching the width/height *attributes* would reset the
    // drawing context and blank the picture (ARCHITECTURE.md).
    this.canvas.style.width = `${Math.round(ptW * this.zoom)}px`;
    this.canvas.style.height = `${Math.round(ptH * this.zoom)}px`;
  }

  readout() {
    const s = this.screen ?? { width: 0, height: 0, scale: 1 };
    const pt = this.points();
    const percent = Math.round((this.zoom ?? 1) * 100);
    const parts = [
      `${s.width}×${s.height} @${s.scale}x`,
      `${pt.width}×${pt.height}pt`,
    ];

    const nodes = [document.createTextNode(parts.join(" · "))];

    if (percent !== 100) {
      /*
       * Not knowing you are looking at a shrunken picture is the one genuinely
       * misleading state this panel can be in — soft type and dropped hairlines
       * are exactly what someone is here to judge. So it is loud, not a
       * parenthetical.
       */
      const warn = document.createElement("span");
      warn.className = "warn strong";
      warn.textContent = ` · ${percent}% NOT 1:1`;
      nodes.push(warn);
    } else {
      nodes.push(document.createTextNode(" · 100%"));
    }

    const tail = ` · ${this.codec} · ${this.fps.toFixed(1)} fps · ${formatRate(this.kbps)}`;
    nodes.push(document.createTextNode(tail));
    if (this.foreground) {
      nodes.push(document.createTextNode(` · ${this.foreground}`));
    }
    return nodes;
  }

  /**
   * ARCHITECTURE.md: the status dot's four states.
   *
   * "No frames for a while" is deliberately *not* stalled. The three backends
   * disagree about what a still screen costs — iOS and WeChat resend at 5fps,
   * scrcpy sends literally nothing until a pixel moves (measured: 0.0 fps on an
   * idle Android emulator) — so a timeout would leave Android permanently
   * orange while working perfectly. Stalled means an error, or never having
   * produced a picture at all.
   */
  health() {
    if (this.stalled) return "stalled";
    if (this.lastFrameAt === 0) {
      return performance.now() - this.attachedAt > 5000 ? "stalled" : "idle";
    }
    // The idle fallback runs at 5fps, so anything at or under that is a still
    // picture rather than a live one.
    return this.fps > 6 ? "live" : "idle";
  }

  // -- video  (engine — unchanged) --------------------------------------------

  onFrame(tag, data) {
    if (tag === VIDEO_TAG.SEED) this.sawSeed = true;
    this.frames++;
    this.bytes += data.length;
    this.lastFrameAt = performance.now();
    this.stalled = false;
    this.tickStats();

    if (this.codec === "jpeg" || tag === VIDEO_TAG.SEED) this.drawJpeg(data);
    else this.decodeH264(tag, data);
  }

  drawJpeg(data) {
    // Keep only the newest frame while a decode is in flight; dropping is
    // better than growing latency.
    if (this.decoding) {
      this.queued = data;
      return;
    }
    this.decoding = true;
    createImageBitmap(new Blob([data], { type: "image/jpeg" }))
      .then((bmp) => {
        this.paint(bmp, bmp.width, bmp.height);
        bmp.close();
      })
      .catch(() => {})
      .finally(() => {
        this.decoding = false;
        const next = this.queued;
        this.queued = null;
        if (next) this.drawJpeg(next);
      });
  }

  /** The overlay that stands in for the picture until there is one. */
  renderLoading() {
    if (!this.loadingEl) return;
    this.loadingEl.hidden = this.painted;
    this.loadingEl.classList.toggle("gave-up", this.gaveUp);
    if (this.painted) return;

    if (!this.gaveUp) {
      this.loadingText.textContent = "waiting for the picture…";
      return;
    }
    /*
     * The seed is the tell. PROTOCOL §3 has the server send one JPEG the moment
     * a stream attaches, precisely so a client is never black while it waits for
     * a key frame — so "no seed at all" and "a seed but nothing since" are two
     * different faults and want two different next moves.
     */
    this.loadingText.textContent = this.sawSeed
      ? "the first frame arrived but nothing since — is the device still running?"
      : "no picture at all, not even the seed frame — check the device and the server log";
  }

  /**
   * Draw one decoded frame, applying `screen.frameRotation`.
   *
   * Backends differ: Android's encoder rotates for us, but CoreSimulator keeps
   * a portrait framebuffer and renders the rotated UI inside it, so an iOS
   * landscape frame arrives lying on its side. `frameRotation` says how far
   * clockwise to turn it; the canvas is always sized to the upright picture,
   * which is also the space input coordinates are normalized against.
   *
   * The server's inverse of these four matrices is asserted against them in
   * test/providers/ios/rotation.test.ts — do not change one half alone.
   */
  paint(source, srcW, srcH) {
    if (!this.painted) {
      this.painted = true;
      clearTimeout(this.waitTimer);
      this.renderLoading();
    }
    const rot = this.frameRotation ?? 0;
    const wantW = rot === 90 || rot === 270 ? srcH : srcW;
    const wantH = rot === 90 || rot === 270 ? srcW : srcH;
    if (this.canvas.width !== wantW || this.canvas.height !== wantH) {
      this.canvas.width = wantW;
      this.canvas.height = wantH;
      // The backing store changed, so the displayed size has to be recomputed.
      this.layout();
      renderReadout();
    }

    const ctx = this.ctx;
    switch (rot) {
      case 90:
        ctx.setTransform(0, 1, -1, 0, this.canvas.width, 0);
        break;
      case 180:
        ctx.setTransform(-1, 0, 0, -1, this.canvas.width, this.canvas.height);
        break;
      case 270:
        ctx.setTransform(0, -1, 1, 0, 0, this.canvas.height);
        break;
      default:
        ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    ctx.drawImage(source, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  decodeH264(tag, data) {
    if (tag === VIDEO_TAG.CONFIG) {
      this.configureDecoder(data);
      return;
    }
    if (!this.decoder || this.decoder.state !== "configured") return;
    try {
      this.decoder.decode(
        new EncodedVideoChunk({
          type: tag === VIDEO_TAG.KEY ? "key" : "delta",
          timestamp: performance.now() * 1000,
          data,
        }),
      );
    } catch {
      /* a dropped DELTA leaves the picture smeared until the next IDR */
    }
  }

  configureDecoder(avcC) {
    if (typeof VideoDecoder === "undefined") {
      showError("this browser has no WebCodecs");
      return;
    }
    try {
      this.decoder?.close();
    } catch {
      /* already closed */
    }
    // avcC: [0]=1 [1]=profile [2]=compat [3]=level
    const codec = `avc1.${[...avcC.slice(1, 4)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
    this.decoder = new VideoDecoder({
      output: (frame) => {
        this.paint(frame, frame.displayWidth, frame.displayHeight);
        frame.close();
      },
      error: (err) => showError(String(err)),
    });
    this.decoder.configure({ codec, description: avcC, optimizeForLatency: true });
  }

  tickStats() {
    const now = performance.now();
    const dt = now - this.lastStatsAt;
    if (dt < 1000) return;
    this.fps = (this.frames * 1000) / dt;
    this.kbps = (this.bytes * 8) / dt;
    this.frames = 0;
    this.bytes = 0;
    this.lastStatsAt = now;
    if (this.streamId === activeStreamId) {
      renderReadout();
      renderChrome();
    }
  }

  // -- input  (engine — unchanged) --------------------------------------------

  wireInput() {
    const c = this.canvas;

    c.addEventListener("pointerdown", (e) => {
      c.setPointerCapture(e.pointerId);
      this.pointerDown = true;
      // Pointer capture means the press survives leaving the canvas, so `:active`
      // is not reliable here — the class follows the state we actually track.
      c.classList.add("dragging");
      this.el.focus({ preventScroll: true });
      activeStreamId = this.streamId;
      this.sendPointer(e, TOUCH_PHASE.BEGIN);
    });
    c.addEventListener("pointermove", (e) => {
      if (!this.pointerDown) return;
      this.sendPointer(e, TOUCH_PHASE.MOVE);
    });
    const up = (e) => {
      if (!this.pointerDown) return;
      this.pointerDown = false;
      c.classList.remove("dragging");
      this.sendPointer(e, TOUCH_PHASE.END);
    };
    c.addEventListener("pointerup", up);
    c.addEventListener("pointercancel", up);

    c.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        if (!this.device.capabilities.scroll) return;
        const { x, y } = this.normalize(e);
        this.send({
          kind: "scroll",
          dx: -e.deltaX / this.canvas.clientWidth,
          dy: -e.deltaY / this.canvas.clientHeight,
          anchorX: x,
          anchorY: y,
        });
      },
      { passive: false },
    );

    // Keys are routed at the window, not here — see the listener below. Binding
    // them to this element would mean typing only worked while the canvas
    // happened to hold focus, and the picture is the one thing you click on
    // that should *not* need a click first.
  }

  onKey(e, phase) {
    const usage = hidUsage(e.code);
    if (usage === undefined) return;
    e.preventDefault();
    this.send({ kind: "key", phase, usage });
  }

  normalize(e) {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: clamp01((e.clientX - r.left) / r.width),
      y: clamp01((e.clientY - r.top) / r.height),
    };
  }

  sendPointer(e, phase) {
    const { x, y } = this.normalize(e);
    const seq = this.seq++ & 0xffff;

    // Shift-drag fakes a pinch: second finger mirrored through the centre.
    if (e.shiftKey && this.device.capabilities.multitouch) {
      this.send({
        kind: "multitouch",
        phase,
        x1: x,
        y1: y,
        x2: clamp01(1 - x),
        y2: clamp01(1 - y),
        seq,
      });
      return;
    }

    this.send({ kind: "touch", phase, x, y, seq, edge: this.edgeFor(phase, x, y) });
  }

  /**
   * An edge gesture is decided at BEGIN and held for the whole gesture — that
   * is what iOS wants (ARCHITECTURE.md): a swipe up from the bottom is only a home
   * gesture if it *started* on the edge. Devices without the capability always
   * send 0, so there is no toggle for this any more; on iOS you simply start
   * the swipe at the very bottom, like you would on the phone.
   */
  edgeFor(phase, x, y) {
    if (!this.device.capabilities.edgeGesture) return TOUCH_EDGE.NONE;
    if (phase === TOUCH_PHASE.BEGIN) {
      const m = 0.03;
      this.edge =
        y > 1 - m
          ? TOUCH_EDGE.BOTTOM
          : y < m
            ? TOUCH_EDGE.TOP
            : x < m
              ? TOUCH_EDGE.LEFT
              : x > 1 - m
                ? TOUCH_EDGE.RIGHT
                : TOUCH_EDGE.NONE;
    }
    return this.edge ?? TOUCH_EDGE.NONE;
  }

  send(msg) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(encodeInput(this.streamId, msg));
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function formatRate(kbps) {
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbit/s` : `${Math.round(kbps)} kbit/s`;
}

/** USB HID Usage Page 0x07, keyed by KeyboardEvent.code. */
function hidUsage(code) {
  if (/^Key[A-Z]$/.test(code)) return 0x04 + (code.charCodeAt(3) - 65);
  if (/^Digit[1-9]$/.test(code)) return 0x1e + (code.charCodeAt(5) - 49);
  if (code === "Digit0") return 0x27;
  if (/^F([1-9]|1[0-2])$/.test(code)) return 0x3a + Number(code.slice(1)) - 1;
  return {
    Enter: 0x28,
    Escape: 0x29,
    Backspace: 0x2a,
    Tab: 0x2b,
    Space: 0x2c,
    Minus: 0x2d,
    Equal: 0x2e,
    BracketLeft: 0x2f,
    BracketRight: 0x30,
    Backslash: 0x31,
    Semicolon: 0x33,
    Quote: 0x34,
    Backquote: 0x35,
    Comma: 0x36,
    Period: 0x37,
    Slash: 0x38,
    CapsLock: 0x39,
    Home: 0x4a,
    PageUp: 0x4b,
    Delete: 0x4c,
    End: 0x4d,
    PageDown: 0x4e,
    ArrowRight: 0x4f,
    ArrowLeft: 0x50,
    ArrowDown: 0x51,
    ArrowUp: 0x52,
  }[code];
}

// Whether the device still fits at 1:1 depends on the window (ARCHITECTURE.md).
new ResizeObserver(() => {
  const view = active();
  if (!view) return;
  view.layout();
  renderReadout();
}).observe(document.body);

renderAll();
connect();

/*
 * The Omarchy plugin's contract (ARCHITECTURE.md).
 *
 * The desktop's Omarchy plugin calls these two through CDP
 * `Runtime.evaluate` when the desktop theme changes. They are deliberately on
 * `window` rather than inside the `simfarm` debug handle below: that one is a
 * convenience for tooling and may change, these two are a published interface.
 *
 * The plugin has a fallback that writes the CSS variables itself when these are
 * missing — which is why the variable names match the theme JSON keys exactly.
 * But the fallback cannot do the interesting half: only `simfarmSetAppearance`
 * pushes the desktop's light/dark down into the simulator.
 */
window.simfarmApplyTheme = (theme) => applyTheme(theme);

window.simfarmSetAppearance = (mode) => {
  setMode(mode);
  for (const view of streams.values()) pushAppearance(view);
};

// Debug handle for tools/capture-evidence.ts (and for poking at a live session
// from devtools). Not part of the protocol; the Omarchy client does not need it.
window.simfarm = {
  attach,
  detach,
  select,
  request,
  get devices() {
    return devices;
  },
  get streams() {
    return streams;
  },
  connected,
  /** true while a device is being connected — the page auto-connects on load,
      so a script that wants to drive the attach itself has to wait this out */
  get busy() {
    return connectingTo !== null;
  },
  /** send a raw input message on a stream, bypassing the pointer handlers */
  send: (streamId, msg) => streams.get(streamId)?.send(msg),
  canvasOf: (streamId) => streams.get(streamId)?.canvas ?? null,
  /** the window-sizing arithmetic, so it can be checked without an app window */
  windowTargetFor,
};
