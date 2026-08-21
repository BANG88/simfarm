/**
 * Rotation — the one place iOS differs from every other backend.
 *
 * CoreSimulator's framebuffer **does not change shape when the guest rotates**.
 * An iPhone 17 Pro is 1206x2622 while it is portrait, and it is still 1206x2622
 * while Safari is drawing a landscape layout — the guest just renders the
 * rotated UI lying on its side inside the portrait frame. (Android is the
 * opposite: scrcpy rotates on the device, so its frames really do swap.)
 *
 * PROTOCOL §6 resolves that with `screen.frameRotation`:
 *
 *   * `screen.width/height` describe **the picture a human sees**, i.e. already
 *     rotated. Landscape on iOS is therefore reported as 2622x1206.
 *   * `frameRotation` is how far **clockwise** the client must turn the decoded
 *     frame to make it upright.
 *   * Input coordinates are **always** normalized against that upright picture.
 *     The client does no coordinate maths at all — so the inverse transform,
 *     back into framebuffer space, has to happen here.
 *
 * Everything below is that inverse. `web/app.js`'s `paint()` is the forward
 * direction; the two must stay exact inverses of each other, which is what
 * `test/providers/ios/rotation.test.ts` pins.
 *
 * The forward transform, for reference (canvas is WxH = the upright picture,
 * source frame is srcW x srcH):
 *
 *   rot 90   setTransform(0, 1,-1, 0, W, 0)   src(sx,sy) -> (srcH-sy,  sx)
 *   rot 180  setTransform(-1,0, 0,-1, W, H)   src(sx,sy) -> (srcW-sx,  srcH-sy)
 *   rot 270  setTransform(0,-1, 1, 0, 0, H)   src(sx,sy) -> (sy,       srcW-sx)
 *
 * In normalized coordinates (which is all serve-sim wants — it hands the
 * CGPoint to IndigoHIDMessageForMouseNSEvent with NSSize(1,1)) the frame sizes
 * cancel out entirely, so the inverse is four lines of arithmetic and no screen
 * geometry is needed.
 */

import { TOUCH_EDGE } from "../../protocol.ts";
import type { InputMessage } from "../../protocol.ts";
import type { FrameRotation, Orientation, Screen } from "../../types.ts";

/**
 * Which way a landscape frame lies, per orientation.
 *
 * **Measured, not derived.** `landscape_left` was rotated onto a live iPhone 17
 * Pro / iOS 26.5 and the raw frame captured through our own client with
 * `frameRotation` still 0: Safari's toolbar came out down the *left* edge of
 * the frame and the page text read bottom-to-top, i.e. the picture is 90 CCW
 * from upright, i.e. the client must turn it 90 CW. `landscape_right` is the
 * mirror of that and was captured the same way. See
 * `docs/evidence/ios/NOTES.md` §5.
 *
 * (Do not try to reason about this from UIInterfaceOrientation's naming. The
 * names describe where the *home button* went, the sign flips between
 * UIDeviceOrientation and UIInterfaceOrientation, and serve-sim's GSEvent path
 * adds a third convention on top. The picture is the only honest source.)
 */
export function frameRotationFor(orientation: Orientation): FrameRotation {
  switch (orientation) {
    case "landscape_left":
      return 90;
    case "landscape_right":
      return 270;
    case "portrait_upside_down":
      return 180;
    default:
      return 0;
  }
}

/** True when the rotation swaps width and height. */
export function swapsAxes(rot: FrameRotation): boolean {
  return rot === 90 || rot === 270;
}

/**
 * A serve-sim screen config -> the `Screen` we put on the wire.
 *
 * `width`/`height` come out **as displayed**: swapped whenever the frame has to
 * be turned a quarter turn. The client sizes its canvas from these, and
 * `paint()` produces exactly that shape from the raw frame.
 */
export function displayedScreen(
  fb: { width: number; height: number; orientation: Orientation },
  scale: number,
): Screen {
  const rot = frameRotationFor(fb.orientation);
  return {
    width: swapsAxes(rot) ? fb.height : fb.width,
    height: swapsAxes(rot) ? fb.width : fb.height,
    scale,
    orientation: fb.orientation,
    frameRotation: rot,
  };
}

/**
 * Displayed (upright) normalized point -> framebuffer normalized point.
 *
 * Inverse of `paint()`. Read it as "where in the sideways frame is the pixel
 * the user actually clicked on".
 */
export function toFramebufferPoint(
  x: number,
  y: number,
  rot: FrameRotation,
): { x: number; y: number } {
  switch (rot) {
    // display = (srcH - sy, sx)  =>  sx = dy, sy = 1 - dx
    case 90:
      return { x: y, y: 1 - x };
    // display = (srcW - sx, srcH - sy)
    case 180:
      return { x: 1 - x, y: 1 - y };
    // display = (sy, srcW - sx)  =>  sx = 1 - dy, sy = dx
    case 270:
      return { x: 1 - y, y: x };
    default:
      return { x, y };
  }
}

/**
 * Same rotation applied to a *delta* (scroll). A vector has no origin, so the
 * translation terms drop out and only the sign flips survive.
 *
 * Note the deltas stay normalized against different axes after the swap —
 * serve-sim multiplies dx by the framebuffer width and dy by its height, so a
 * quarter turn rescales the gesture by the aspect ratio. Direction is exact;
 * magnitude is off by 1206/2622 on the swapped axis. Scroll distance is not a
 * thing any client can rely on being pixel-exact anyway (serve-sim converts the
 * wheel into a synthetic drag, because iOS ignores real scroll events), so this
 * is left alone deliberately rather than papered over with a screen-size
 * dependency in what is otherwise pure arithmetic.
 */
export function toFramebufferDelta(
  dx: number,
  dy: number,
  rot: FrameRotation,
): { dx: number; dy: number } {
  switch (rot) {
    case 90:
      return { dx: dy, dy: -dx };
    case 180:
      return { dx: -dx, dy: -dy };
    case 270:
      return { dx: -dy, dy: dx };
    default:
      return { dx, dy };
  }
}

/**
 * Displayed edge -> framebuffer edge, still in PROTOCOL §5 numbering.
 *
 * This is the one that is easy to get wrong and impossible to notice: a
 * bottom-edge swipe in landscape does not start on the framebuffer's bottom
 * edge, it starts on its left or right. Get it wrong and swipe-to-home silently
 * becomes a notification-centre pull, or nothing at all.
 *
 * Derived from `toFramebufferPoint`, not written by hand:
 *   rot 90  — display bottom (y=1) maps to framebuffer x=1, the RIGHT edge.
 *   rot 270 — display bottom (y=1) maps to framebuffer x=0, the LEFT edge.
 *
 * The result still has to go through `toIndigoEdge()` afterwards, because
 * serve-sim numbers the enum differently again (NOTES.md §3).
 */
export function toFramebufferEdge(edge: number, rot: FrameRotation): number {
  const cycle = [TOUCH_EDGE.TOP, TOUCH_EDGE.RIGHT, TOUCH_EDGE.BOTTOM, TOUCH_EDGE.LEFT];
  const at = cycle.indexOf(edge as (typeof cycle)[number]);
  if (at < 0) return TOUCH_EDGE.NONE; // NONE, and anything we do not recognise
  // The client turns the picture `rot` clockwise, so the framebuffer edge that
  // ends up displayed as `edge` is `rot` *counter*-clockwise from it.
  const steps = rot / 90;
  return cycle[(at - steps + 4) % 4]!;
}

/**
 * One INPUT message, restated in framebuffer coordinates.
 *
 * Pure and total: anything without coordinates (keys, buttons, text) comes back
 * untouched, and `rot === 0` is the identity for everything.
 */
export function toFramebufferInput(msg: InputMessage, rot: FrameRotation): InputMessage {
  if (rot === 0) return msg;
  switch (msg.kind) {
    case "touch": {
      const p = toFramebufferPoint(msg.x, msg.y, rot);
      return { ...msg, x: p.x, y: p.y, edge: toFramebufferEdge(msg.edge, rot) };
    }
    case "multitouch": {
      const a = toFramebufferPoint(msg.x1, msg.y1, rot);
      const b = toFramebufferPoint(msg.x2, msg.y2, rot);
      return { ...msg, x1: a.x, y1: a.y, x2: b.x, y2: b.y };
    }
    case "scroll": {
      const anchor = toFramebufferPoint(msg.anchorX, msg.anchorY, rot);
      const d = toFramebufferDelta(msg.dx, msg.dy, rot);
      return { ...msg, dx: d.dx, dy: d.dy, anchorX: anchor.x, anchorY: anchor.y };
    }
    default:
      return msg;
  }
}
