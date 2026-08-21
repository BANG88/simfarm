/**
 * The parts of the simulator that are not inside the mini program.
 *
 * `wx.showModal`, `wx.showActionSheet`, `wx.showToast`, the authorization sheet
 * and the payment sheet are drawn by the IDE, in the project window's own DOM —
 * **not** in the `__pageframe__` we capture. Two consequences:
 *
 *   1. Ordinary touch cannot reach them. `Input.dispatchTouchEvent` on the page
 *      frame lands in the mini program's document, where the dialog does not
 *      exist. They have to be driven here instead.
 *   2. **They are invisible in the video.** Measured 2026-08-21: with a modal up,
 *      a screenshot of the page frame is the page, undimmed, with no dialog in
 *      it — while the device is in fact blocked. Left alone that is the worst
 *      kind of failure: the picture looks fine and nothing responds. So this
 *      file also *describes* what is up, the provider pushes it as a `dialog`
 *      event (PROTOCOL §6), and the client draws it.
 *
 * ## Two things the previous attempt got wrong, both now measured
 *
 * **`element.click()` is not how you press these.** It runs the mini program's
 * own callback and nothing else: the IDE's close path never happens, so the
 * dialog stays on screen forever, its click handler now detached. Every later
 * `wx.showModal` queues up behind a dialog that can no longer be dismissed —
 * a state the IDE does not recover from on its own.
 * `Input.dispatchMouseEvent` at the button's own rect is what works; the console
 * then shows the real `{"errMsg":"showModal:ok","confirm":true}` and the node
 * leaves the DOM.
 *
 * **"Is the element there?" is a fine discriminant — once you stop using
 * `.click()`.** The received wisdom was that weui leaves its dialog in the page
 * after closing, so presence proves nothing. Measured: a dialog closed through a
 * real mouse press is *removed*, and the clean state has no `.weui-dialog`, no
 * `.weui-mask` and no `.weui-actionsheet` under `.simulator` at all. The stale
 * DOM was self-inflicted by `.click()`. Presence plus a non-empty rect is
 * therefore the discriminant, and it is checked inside `.simulator` only, so
 * nothing here can ever click a control in the rest of the IDE.
 *
 * The official automation protocol has `Native.confirmModal` and friends for
 * exactly this, and `cli auto` does start a working JSON-RPC server — but every
 * `Native.*` method answers "unimplemented" on this devtools build
 * (2.01.2510290 / SDK 3.16.1), so that route is closed.
 */

import { CdpConnection, fetchTargets } from "./cdp.ts";
import { logger } from "./../../util/log.ts";
import { findProjects, type CdpTarget } from "./wechat-targets.ts";

const log = logger("wechat/shell");

/** A rectangle in the project window's CSS pixels: x, y, width, height. */
export type Rect = [number, number, number, number];

/** What the injected script reports about one button. Classified in TS below. */
export interface RawButton {
  id: string;
  cls: string;
  parentCls: string;
  text: string;
  rect: Rect;
}

/** What the injected script reports about one overlay. */
export interface RawOverlay {
  cls: string;
  title: string;
  content: string;
  /** class of the first icon inside, which is how a spinner is told from a tick */
  iconCls: string;
  rect: Rect;
  /** a hit test at the overlay's own top edge landed inside it */
  onTop: boolean;
  buttons: RawButton[];
}

export interface RawShell {
  /** the simulator screen's box, which the overlay rects are relative to */
  screen: Rect | null;
  overlays: RawOverlay[];
}

export type OverlayKind =
  | "modal"
  | "actionsheet"
  | "toast"
  | "loading"
  | "payment"
  | "dialog";

/**
 * `confirm` / `cancel` are the two answers a mini program's callback can get,
 * `close` is the payment sheet's ✕ (it has no text buttons at all), and `item`
 * is an action sheet row.
 */
export type ButtonRole = "confirm" | "cancel" | "close" | "item";

export interface OverlayButton {
  label: string;
  role: ButtonRole;
  /** index within this overlay's buttons; what `press` takes for action sheets */
  index: number;
}

export interface Overlay {
  kind: OverlayKind;
  title: string;
  content: string;
  buttons: OverlayButton[];
  /**
   * Where it sits on the simulator screen, normalized to [0,1]. The client
   * draws its own dialog, but this lets it put it where the IDE put it instead
   * of guessing.
   */
  rect: { x: number; y: number; width: number; height: number };
  /** the one a press lands on */
  onTop: boolean;
}

export interface PressResult {
  kind: OverlayKind;
  label: string;
  role: ButtonRole;
}

// ---------------------------------------------------------------------------
// classification — pure, so every rule above has a unit test
// ---------------------------------------------------------------------------

export function kindOf(o: RawOverlay): OverlayKind {
  if (o.cls.includes("weui-actionsheet")) return "actionsheet";
  if (o.cls.includes("weui-toast")) {
    return o.iconCls.includes("weui-loading") ? "loading" : "toast";
  }
  if (o.buttons.some((b) => b.cls.includes("close-payment-dialog"))) {
    return "payment";
  }
  if (o.buttons.some((b) => b.id.startsWith("wx.showModal."))) return "modal";
  return "dialog";
}

export function roleOf(b: RawButton, kind: OverlayKind): ButtonRole {
  if (b.id === "wx.showModal.confirm") return "confirm";
  if (b.id === "wx.showModal.cancel") return "cancel";
  if (b.cls.includes("close-payment-dialog") || b.cls.includes("icon-close")) {
    return "close";
  }
  if (kind === "actionsheet") {
    // The cancel row is the cell inside `weui-actionsheet__action`; the ones in
    // `__menu` are the app's own items. They are the same element class, so the
    // parent is the only thing that separates them.
    return b.parentCls.includes("weui-actionsheet__action") ? "cancel" : "item";
  }
  if (b.cls.includes("weui-dialog__btn_primary")) return "confirm";
  if (b.cls.includes("weui-dialog__btn_default")) return "cancel";
  return "item";
}

export function classify(raw: RawShell): Overlay[] {
  const screen = raw.screen;
  return raw.overlays.map((o) => {
    const kind = kindOf(o);
    return {
      kind,
      title: o.title,
      content: o.content,
      buttons: o.buttons.map((b, index) => ({
        label: b.text,
        role: roleOf(b, kind),
        index,
      })),
      rect: normalize(o.rect, screen),
      onTop: o.onTop,
    };
  });
}

/** The overlay a press should go to: the top-most one, else the last drawn. */
export function topOf<T extends { onTop: boolean }>(overlays: T[]): T | null {
  if (overlays.length === 0) return null;
  return overlays.filter((o) => o.onTop).pop() ?? overlays[overlays.length - 1]!;
}

/**
 * Which button `which` names on `overlay`: a role, or an index into the
 * overlay's own buttons (which is how an action sheet row is chosen).
 *
 * A payment sheet has no text buttons, so asking it to `cancel` resolves to its
 * ✕ — otherwise "dismiss this" would need the caller to know which kind of
 * sheet it is looking at before it can dismiss it.
 */
export function resolveButton(
  overlay: Overlay,
  which: string | number,
): OverlayButton | null {
  if (typeof which === "number") return overlay.buttons[which] ?? null;
  const exact = overlay.buttons.find((b) => b.role === which);
  if (exact) return exact;
  if (which === "cancel" || which === "close") {
    return overlay.buttons.find((b) => b.role === "close" || b.role === "cancel") ?? null;
  }
  return null;
}

function normalize(
  rect: Rect,
  screen: Rect | null,
): { x: number; y: number; width: number; height: number } {
  if (!screen || screen[2] <= 0 || screen[3] <= 0) {
    return { x: 0, y: 0, width: 1, height: 1 };
  }
  const round = (n: number): number => Math.round(n * 1e4) / 1e4;
  return {
    x: round((rect[0] - screen[0]) / screen[2]),
    y: round((rect[1] - screen[1]) / screen[3]),
    width: round(rect[2] / screen[2]),
    height: round(rect[3] / screen[3]),
  };
}

// ---------------------------------------------------------------------------
// the injected script
// ---------------------------------------------------------------------------

/**
 * Read the overlay stack out of the project window.
 *
 * Everything is scoped to `.simulator`, the box the phone is drawn in. That is
 * not tidiness: an unscoped search for a confirm button would happily find one
 * in the IDE's own settings panel and press that instead.
 */
const READ_EXPR = `(() => {
  const sim = document.querySelector('.simulator');
  if (!sim) return JSON.stringify({ screen: null, overlays: [] });
  const box = (e) => { const r = e.getBoundingClientRect();
    return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; };
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const text = (root, sel) => { const e = root.querySelector(sel); return e ? (e.textContent || '').trim() : ''; };
  const overlays = [];
  for (const e of sim.querySelectorAll('.weui-dialog, .weui-actionsheet, .weui-toast')) {
    if (!vis(e)) continue;
    const r = e.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + 2);
    const icon = e.querySelector('[class*=weui-icon], [class*=weui-loading]');
    const found = [...e.querySelectorAll(
      '.weui-dialog__btn, .weui-actionsheet__cell, .close-payment-dialog, [class*=icon-close]')]
      .filter(vis);
    const buttons = found
      // The payment sheet's ✕ matches twice: the header bar carries
      // \`close-payment-dialog\` and the glyph inside it carries \`ui-icon-close\`.
      // Keep the outer one — same handler, far bigger target.
      .filter((b) => !found.some((other) => other !== b && other.contains(b)))
      .map((b) => ({
        id: b.id || '',
        cls: (b.className || '').toString(),
        parentCls: b.parentElement ? (b.parentElement.className || '').toString() : '',
        text: (b.textContent || '').trim().slice(0, 40),
        rect: box(b),
      }));
    overlays.push({
      cls: (e.className || '').toString(),
      title: text(e, '[id="wx.showModal.title"], .weui-dialog__title, .payment-dialog-title'),
      content: text(e, '[id="wx.showModal.content"], .payment-dialog-tips, .weui-toast__content, .weui-dialog__bd'),
      iconCls: icon ? (icon.className || '').toString() : '',
      rect: box(e),
      onTop: !!hit && e.contains(hit),
      buttons,
    });
  }
  return JSON.stringify({ screen: box(sim), overlays });
})()`;

/**
 * Report when the overlay stack changes, instead of asking a devtools we are
 * also streaming video out of. `Runtime.addBinding` plus a `MutationObserver`
 * costs nothing while nothing happens, which a poll does not.
 */
const BINDING = "__simfarmOverlayChanged";

/** Long enough for the IDE's slide-in and fade-in to have finished. */
const ANIMATION_SETTLE_MS = 400;

const OBSERVE_EXPR = `(() => {
  const sim = document.querySelector('.simulator');
  if (!sim) return 'no simulator';
  if (window.__simfarmObserver) window.__simfarmObserver.disconnect();
  const key = () => [...sim.querySelectorAll('.weui-dialog, .weui-actionsheet, .weui-toast')]
    .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
    .map((e) => (e.className || '') + ':' + (e.textContent || '').trim().slice(0, 40))
    .join('|');
  let last = key();
  window.__simfarmObserver = new MutationObserver(() => {
    const now = key();
    if (now === last) return;
    last = now;
    ${BINDING}(now);
  });
  window.__simfarmObserver.observe(sim, { childList: true, subtree: true, attributes: true });
  return 'observing';
})()`;

export class WechatShell {
  private readonly endpoint: string;
  private readonly appid: string;
  private conn: CdpConnection | null = null;
  private observing = false;
  private settle: NodeJS.Timeout | null = null;
  private lastReported = "";

  /** Called whenever the set of open overlays changes. */
  onChange: ((overlays: Overlay[]) => void) | null = null;

  constructor(endpoint: string, appid: string) {
    this.endpoint = endpoint;
    this.appid = appid;
  }

  /** Everything the IDE is currently drawing over the phone, bottom-most first. */
  async overlays(): Promise<Overlay[]> {
    return classify(await this.read());
  }

  /**
   * Press a button on the top-most overlay with a real mouse event.
   *
   * The rect is re-read immediately before dispatching rather than reused from
   * an earlier `overlays()` call: the IDE window can be moved, resized or
   * scrolled in between, and a stale rect means clicking whatever is now there.
   *
   * @returns what was pressed, or null when there was nothing to press.
   */
  async press(which: string | number): Promise<PressResult | null> {
    const raw = await this.read();
    const overlays = classify(raw);
    const top = topOf(overlays);
    if (!top) return null;
    const button = resolveButton(top, which);
    if (!button) return null;

    // Same index in the raw list — classify() preserves order on both levels.
    const rect = raw.overlays[overlays.indexOf(top)]?.buttons[button.index]?.rect;
    if (!rect) return null;

    await this.clickAt(rect[0] + rect[2] / 2, rect[1] + rect[3] / 2);
    log.debug(`pressed "${button.label}" (${button.role}) on a ${top.kind}`);
    return { kind: top.kind, label: button.label, role: button.role };
  }

  /** Start reporting overlay changes through `onChange`. */
  async watch(): Promise<void> {
    const conn = await this.connect();
    if (this.observing) return;
    await conn.send("Runtime.addBinding", { name: BINDING });
    conn.on("Runtime.bindingCalled", (params) => {
      if (params.name !== BINDING) return;
      this.report();
      // Action sheets arrive with `ui-animate-swipeInUp` and are still off the
      // bottom of the screen when the mutation fires, so the first rect is the
      // one they slide *from* — a client drawing it puts the buttons where
      // nobody can click them. The animation ends without another mutation, so
      // it has to be re-read on a timer rather than waited for.
      if (this.settle) clearTimeout(this.settle);
      this.settle = setTimeout(() => this.report(), ANIMATION_SETTLE_MS);
      this.settle.unref?.();
    });
    await conn.send("Runtime.evaluate", { expression: OBSERVE_EXPR, returnByValue: true });
    this.observing = true;
  }

  close(): void {
    if (this.settle) clearTimeout(this.settle);
    this.settle = null;
    this.conn?.close();
    this.conn = null;
    this.observing = false;
  }

  /** Read now and hand on through `onChange`; used to prime a new client. */
  refresh(): void {
    this.report();
  }

  // -------------------------------------------------------------------------

  /** Read and hand on, but only when the answer is different from last time. */
  private report(): void {
    void this.overlays()
      .then((overlays) => {
        const key = JSON.stringify(overlays);
        if (key === this.lastReported) return;
        this.lastReported = key;
        this.onChange?.(overlays);
      })
      .catch((err) => log.debug(`overlay read failed: ${String(err)}`));
  }

  // -------------------------------------------------------------------------

  private async read(): Promise<RawShell> {
    const conn = await this.connect();
    const res = await conn.send("Runtime.evaluate", {
      expression: READ_EXPR,
      returnByValue: true,
    });
    const value = (res.result as { value?: unknown } | undefined)?.value;
    if (typeof value !== "string") return { screen: null, overlays: [] };
    return JSON.parse(value) as RawShell;
  }

  /**
   * A press is move → down → up, not a bare `mousePressed`/`mouseReleased`
   * pair: the IDE's buttons are ordinary anchors and Chromium only synthesises
   * the `click` that their handler is bound to when the pointer is over them.
   */
  private async clickAt(x: number, y: number): Promise<void> {
    const conn = await this.connect();
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"] as const) {
      await conn.send("Input.dispatchMouseEvent", {
        type,
        x,
        y,
        button: "left",
        buttons: type === "mousePressed" ? 1 : 0,
        clickCount: type === "mouseMoved" ? 0 : 1,
      });
    }
  }

  private async connect(): Promise<CdpConnection> {
    if (this.conn?.isOpen) return this.conn;
    this.observing = false;
    const targets = await fetchTargets(this.endpoint);
    const target = this.projectTarget(targets);
    if (!target?.webSocketDebuggerUrl) {
      throw new Error("the IDE project window is not attachable");
    }
    this.conn = await CdpConnection.open(target.webSocketDebuggerUrl);
    await this.conn.send("Runtime.enable");
    return this.conn;
  }

  private projectTarget(targets: CdpTarget[]): CdpTarget | undefined {
    const projects = findProjects(targets);
    const mine = projects.find((p) => p.appid === this.appid) ?? projects[0];
    return mine ? targets.find((t) => t.id === mine.targetId) : undefined;
  }
}
