/**
 * PROTOCOL §6 — `frameRotation` and the input transform that has to go with it.
 *
 * CoreSimulator never resizes its framebuffer, so an iOS landscape frame
 * arrives lying on its side. The client turns it upright and normalizes input
 * against *that* picture; the provider has to turn the coordinates back.
 *
 * The two halves live in different languages and different repos-worth of code
 * (`web/app.js`'s `paint()` and `src/providers/ios/rotation.ts`), and a sign
 * error in either is invisible in a unit test that only talks to itself. So the
 * central test here re-implements `paint()` from its literal canvas matrices
 * and asserts our transform is its exact inverse.
 *
 * The corners matter most: (0,0) (1,0) (0,1) (1,1) landing on the wrong corner
 * is the failure mode where every tap goes somewhere plausible-looking but
 * wrong. And `edge` matters second-most: a bottom-edge swipe in landscape does
 * not start on the framebuffer's bottom edge.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  INDIGO_EDGE,
  HID_OP,
  inputToHid,
} from "../../../src/providers/ios/hid-protocol.ts";
import {
  displayedScreen,
  frameRotationFor,
  swapsAxes,
  toFramebufferDelta,
  toFramebufferEdge,
  toFramebufferInput,
  toFramebufferPoint,
} from "../../../src/providers/ios/rotation.ts";
import {
  KEY_PHASE,
  TOUCH_EDGE,
  TOUCH_PHASE,
  type InputMessage,
} from "../../../src/protocol.ts";
import type { FrameRotation, Orientation } from "../../../src/types.ts";

/** iPhone 17 Pro / iOS 26.5 — the framebuffer every capture in docs/evidence used. */
const FB_W = 1206;
const FB_H = 2622;

const ROTATIONS: FrameRotation[] = [0, 90, 180, 270];

const near = (actual: number, expected: number, what: string): void => {
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `${what}: expected ${expected}, got ${actual}`,
  );
};

// ---------------------------------------------------------------------------
// web/app.js paint(), transcribed
// ---------------------------------------------------------------------------

/**
 * The exact `ctx.setTransform(...)` arguments from `web/app.js`. A canvas
 * transform (a,b,c,d,e,f) maps (x,y) -> (a*x + c*y + e, b*x + d*y + f), and the
 * frame is drawn at (0,0) unscaled, so this *is* where a source pixel lands.
 */
function paintMatrix(rot: FrameRotation, W: number, H: number): number[] {
  switch (rot) {
    case 90:
      return [0, 1, -1, 0, W, 0];
    case 180:
      return [-1, 0, 0, -1, W, H];
    case 270:
      return [0, -1, 1, 0, 0, H];
    default:
      return [1, 0, 0, 1, 0, 0];
  }
}

/** Where the client puts framebuffer pixel (sx,sy), in normalized canvas coords. */
function paintNormalized(
  sx: number,
  sy: number,
  rot: FrameRotation,
): { x: number; y: number } {
  const W = swapsAxes(rot) ? FB_H : FB_W;
  const H = swapsAxes(rot) ? FB_W : FB_H;
  const [a, b, c, d, e, f] = paintMatrix(rot, W, H) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  return { x: (a * sx + c * sy + e) / W, y: (b * sx + d * sy + f) / H };
}

// ---------------------------------------------------------------------------

describe("frameRotationFor", () => {
  // Measured on a live iPhone 17 Pro, not derived from UIInterfaceOrientation's
  // naming — see rotation.ts and NOTES.md §5.
  it("is 0 in portrait: the framebuffer is already upright", () => {
    assert.equal(frameRotationFor("portrait"), 0);
  });

  it("is 90 for landscape_left and 270 for landscape_right", () => {
    assert.equal(frameRotationFor("landscape_left"), 90);
    assert.equal(frameRotationFor("landscape_right"), 270);
  });

  it("is 180 upside down", () => {
    assert.equal(frameRotationFor("portrait_upside_down"), 180);
  });

  it("gives the two landscapes opposite rotations", () => {
    const a = frameRotationFor("landscape_left");
    const b = frameRotationFor("landscape_right");
    assert.equal((a + 180) % 360, b);
  });
});

describe("reported screen size", () => {
  const fb = (orientation: Orientation) => ({
    width: FB_W,
    height: FB_H,
    orientation,
  });

  it("reports the framebuffer as-is in portrait", () => {
    assert.deepEqual(displayedScreen(fb("portrait"), 3), {
      width: 1206,
      height: 2622,
      scale: 3,
      orientation: "portrait",
      frameRotation: 0,
    });
  });

  it("swaps width and height in landscape even though the frame did not", () => {
    // This is the whole point: serve-sim keeps saying 1206x2622, and we say
    // 2622x1206 because that is the picture the user is looking at.
    for (const o of ["landscape_left", "landscape_right"] as const) {
      const screen = displayedScreen(fb(o), 3);
      assert.equal(screen.width, 2622, o);
      assert.equal(screen.height, 1206, o);
      assert.equal(screen.orientation, o);
    }
  });

  it("does not swap upside down", () => {
    const screen = displayedScreen(fb("portrait_upside_down"), 3);
    assert.equal(screen.width, 1206);
    assert.equal(screen.height, 2622);
    assert.equal(screen.frameRotation, 180);
  });

  it("always reports the dimensions the client's canvas will end up with", () => {
    // paint() sizes the canvas itself from the decoded frame; if our numbers
    // disagreed the canvas would be cleared and resized on every single frame.
    for (const o of [
      "portrait",
      "portrait_upside_down",
      "landscape_left",
      "landscape_right",
    ] as const) {
      const screen = displayedScreen(fb(o), 3);
      const rot = frameRotationFor(o);
      assert.equal(screen.width, swapsAxes(rot) ? FB_H : FB_W, o);
      assert.equal(screen.height, swapsAxes(rot) ? FB_W : FB_H, o);
    }
  });
});

describe("coordinate transform is the exact inverse of paint()", () => {
  const samples: Array<[number, number]> = [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
    [0.5, 0.5],
    [0.25, 0.75],
    [0.9, 0.1],
    [0.03, 0.62],
  ];

  for (const rot of ROTATIONS) {
    it(`round-trips through the client's canvas matrix at ${rot} deg`, () => {
      for (const [dx, dy] of samples) {
        const fb = toFramebufferPoint(dx, dy, rot);
        // ...and now let the client draw that framebuffer pixel.
        const back = paintNormalized(fb.x * FB_W, fb.y * FB_H, rot);
        near(back.x, dx, `rot ${rot} x of (${dx},${dy})`);
        near(back.y, dy, `rot ${rot} y of (${dx},${dy})`);
      }
    });
  }

  it("leaves portrait completely alone", () => {
    assert.deepEqual(toFramebufferPoint(0.3, 0.8, 0), { x: 0.3, y: 0.8 });
  });
});

describe("the four corners land on the four corners", () => {
  // A rotation that is 90 degrees out looks almost right — taps land on the
  // screen, just in the wrong place — so name every corner explicitly.
  const CORNERS = {
    "top-left": [0, 0],
    "top-right": [1, 0],
    "bottom-left": [0, 1],
    "bottom-right": [1, 1],
  } as const;

  /**
   * Where each *displayed* corner sits in the framebuffer. Turning the frame
   * clockwise moves its corners clockwise, so the inverse walks the other way:
   * at 90 deg the displayed top-left is the framebuffer's bottom-left.
   */
  const EXPECTED: Record<FrameRotation, Record<keyof typeof CORNERS, [number, number]>> = {
    0: {
      "top-left": [0, 0],
      "top-right": [1, 0],
      "bottom-left": [0, 1],
      "bottom-right": [1, 1],
    },
    90: {
      "top-left": [0, 1], // fb bottom-left
      "top-right": [0, 0], // fb top-left
      "bottom-left": [1, 1], // fb bottom-right
      "bottom-right": [1, 0], // fb top-right
    },
    180: {
      "top-left": [1, 1],
      "top-right": [0, 1],
      "bottom-left": [1, 0],
      "bottom-right": [0, 0],
    },
    270: {
      "top-left": [1, 0], // fb top-right
      "top-right": [1, 1], // fb bottom-right
      "bottom-left": [0, 0], // fb top-left
      "bottom-right": [0, 1], // fb bottom-left
    },
  };

  for (const rot of ROTATIONS) {
    it(`at ${rot} deg`, () => {
      for (const [name, [dx, dy]] of Object.entries(CORNERS)) {
        const got = toFramebufferPoint(dx, dy, rot);
        const want = EXPECTED[rot][name as keyof typeof CORNERS];
        assert.deepEqual(
          [got.x, got.y],
          want,
          `rot ${rot}: displayed ${name} should be framebuffer (${want.join(",")})`,
        );
      }
    });

    it(`at ${rot} deg the corners stay four distinct corners`, () => {
      const seen = new Set(
        Object.values(CORNERS).map(([dx, dy]) => {
          const p = toFramebufferPoint(dx, dy, rot);
          return `${p.x},${p.y}`;
        }),
      );
      assert.equal(seen.size, 4, `rot ${rot} collapsed corners: ${[...seen]}`);
    });
  }

  it("a tap near the top-right of a landscape_left picture is near the top-left of the frame", () => {
    // The concrete case docs/evidence/ios/12+13 exercise: Safari's tab button.
    const p = toFramebufferPoint(0.93, 0.08, 90);
    assert.ok(p.x < 0.1, `expected the left of the frame, got x=${p.x}`);
    assert.ok(p.y < 0.1, `expected the top of the frame, got y=${p.y}`);
  });
});

describe("edge rotation", () => {
  // Displayed edge -> framebuffer edge, in PROTOCOL §5 numbering. Read the
  // 90 deg column as "the user swiped up from what looks like the bottom; that
  // is the right-hand side of the sideways frame".
  const TABLE: Record<FrameRotation, Record<string, number>> = {
    0: {
      top: TOUCH_EDGE.TOP,
      bottom: TOUCH_EDGE.BOTTOM,
      left: TOUCH_EDGE.LEFT,
      right: TOUCH_EDGE.RIGHT,
    },
    90: {
      top: TOUCH_EDGE.LEFT,
      bottom: TOUCH_EDGE.RIGHT,
      left: TOUCH_EDGE.BOTTOM,
      right: TOUCH_EDGE.TOP,
    },
    180: {
      top: TOUCH_EDGE.BOTTOM,
      bottom: TOUCH_EDGE.TOP,
      left: TOUCH_EDGE.RIGHT,
      right: TOUCH_EDGE.LEFT,
    },
    270: {
      top: TOUCH_EDGE.RIGHT,
      bottom: TOUCH_EDGE.LEFT,
      left: TOUCH_EDGE.TOP,
      right: TOUCH_EDGE.BOTTOM,
    },
  };

  const DISPLAY_EDGE: Record<string, number> = {
    top: TOUCH_EDGE.TOP,
    bottom: TOUCH_EDGE.BOTTOM,
    left: TOUCH_EDGE.LEFT,
    right: TOUCH_EDGE.RIGHT,
  };

  for (const rot of ROTATIONS) {
    it(`maps all four displayed edges at ${rot} deg`, () => {
      for (const [name, want] of Object.entries(TABLE[rot])) {
        assert.equal(
          toFramebufferEdge(DISPLAY_EDGE[name]!, rot),
          want,
          `rot ${rot}: displayed ${name} edge`,
        );
      }
    });

    it(`keeps the four edges distinct at ${rot} deg`, () => {
      const mapped = Object.values(DISPLAY_EDGE).map((e) => toFramebufferEdge(e, rot));
      assert.equal(new Set(mapped).size, 4, `rot ${rot}: ${mapped}`);
    });

    it(`leaves "no edge" as "no edge" at ${rot} deg`, () => {
      assert.equal(toFramebufferEdge(TOUCH_EDGE.NONE, rot), TOUCH_EDGE.NONE);
      assert.equal(toFramebufferEdge(99, rot), TOUCH_EDGE.NONE);
    });
  }

  it("agrees with the coordinate transform", () => {
    // The edge table is not allowed to drift from the point transform: a touch
    // that starts hard against the displayed bottom must land hard against
    // whatever framebuffer edge the table names.
    const EDGE_PROBE: Array<[string, number, number]> = [
      ["top", 0.5, 0],
      ["bottom", 0.5, 1],
      ["left", 0, 0.5],
      ["right", 1, 0.5],
    ];
    for (const rot of ROTATIONS) {
      for (const [name, dx, dy] of EDGE_PROBE) {
        const p = toFramebufferPoint(dx, dy, rot);
        const mapped = toFramebufferEdge(DISPLAY_EDGE[name]!, rot);
        const onEdge =
          mapped === TOUCH_EDGE.TOP
            ? p.y === 0
            : mapped === TOUCH_EDGE.BOTTOM
              ? p.y === 1
              : mapped === TOUCH_EDGE.LEFT
                ? p.x === 0
                : p.x === 1;
        assert.ok(onEdge, `rot ${rot}: ${name} maps to ${mapped} but lands at ${p.x},${p.y}`);
      }
    }
  });
});

describe("scroll deltas rotate as vectors", () => {
  it("has no translation term — only the axes turn", () => {
    assert.deepEqual(toFramebufferDelta(0, 0, 90), { dx: 0, dy: -0 });
    assert.deepEqual(toFramebufferDelta(0, 0, 270), { dx: -0, dy: 0 });
  });

  it("turns 'content moves down' into 'content moves left' at 90 deg", () => {
    // Displayed +y (down) becomes framebuffer +x... which at 90 deg is the
    // direction the *picture's* down points in the sideways frame.
    assert.deepEqual(toFramebufferDelta(0, 0.25, 90), { dx: 0.25, dy: -0 });
    assert.deepEqual(toFramebufferDelta(0.25, 0, 90), { dx: 0, dy: -0.25 });
  });

  it("is the opposite at 270 deg", () => {
    assert.deepEqual(toFramebufferDelta(0, 0.25, 270), { dx: -0.25, dy: 0 });
    assert.deepEqual(toFramebufferDelta(0.25, 0, 270), { dx: -0, dy: 0.25 });
  });

  it("flips both axes at 180 deg", () => {
    assert.deepEqual(toFramebufferDelta(0.1, -0.2, 180), { dx: -0.1, dy: 0.2 });
  });

  it("composes back to the identity after four quarter turns", () => {
    let v = { dx: 0.3, dy: -0.4 };
    for (let i = 0; i < 4; i++) v = toFramebufferDelta(v.dx, v.dy, 90);
    near(v.dx, 0.3, "dx after four turns");
    near(v.dy, -0.4, "dy after four turns");
  });
});

describe("toFramebufferInput", () => {
  const touch = (over: Partial<Extract<InputMessage, { kind: "touch" }>> = {}) =>
    ({
      kind: "touch",
      phase: TOUCH_PHASE.BEGIN,
      x: 0.5,
      y: 0.5,
      seq: 1,
      edge: TOUCH_EDGE.NONE,
      ...over,
    }) as InputMessage;

  it("is the identity at 0 deg, object and all", () => {
    const msg = touch({ x: 0.2, y: 0.3 });
    assert.equal(toFramebufferInput(msg, 0), msg);
  });

  it("rotates both fingers of a multitouch", () => {
    const out = toFramebufferInput(
      {
        kind: "multitouch",
        phase: TOUCH_PHASE.MOVE,
        x1: 0,
        y1: 0,
        x2: 1,
        y2: 1,
        seq: 7,
      },
      90,
    ) as Extract<InputMessage, { kind: "multitouch" }>;
    assert.deepEqual([out.x1, out.y1], [0, 1]);
    assert.deepEqual([out.x2, out.y2], [1, 0]);
    assert.equal(out.phase, TOUCH_PHASE.MOVE);
    assert.equal(out.seq, 7);
  });

  it("rotates a scroll's anchor and its delta together", () => {
    const out = toFramebufferInput(
      { kind: "scroll", dx: 0, dy: 0.5, anchorX: 1, anchorY: 0 },
      90,
    ) as Extract<InputMessage, { kind: "scroll" }>;
    assert.deepEqual([out.anchorX, out.anchorY], [0, 0]);
    assert.deepEqual([out.dx, out.dy], [0.5, -0]);
  });

  it("leaves keys, buttons and text untouched at every rotation", () => {
    const others: InputMessage[] = [
      { kind: "key", phase: KEY_PHASE.DOWN, usage: 0x28 },
      { kind: "button", phase: KEY_PHASE.DOWN, buttonId: 0x01 },
      { kind: "text", text: "hello simfarm" },
    ];
    for (const rot of ROTATIONS) {
      for (const msg of others) {
        assert.deepEqual(toFramebufferInput(msg, rot), msg, `rot ${rot} ${msg.kind}`);
      }
    }
  });

  it("does not mutate the caller's message", () => {
    const msg = touch({ x: 0.25, y: 0.75, edge: TOUCH_EDGE.BOTTOM });
    toFramebufferInput(msg, 90);
    assert.deepEqual(msg, touch({ x: 0.25, y: 0.75, edge: TOUCH_EDGE.BOTTOM }));
  });
});

describe("inputToHid applies the rotation before serve-sim's numbering", () => {
  const swipeUpFromBottom = {
    kind: "touch",
    phase: TOUCH_PHASE.BEGIN,
    x: 0.5,
    y: 0.995,
    seq: 1,
    edge: TOUCH_EDGE.BOTTOM,
  } as InputMessage;

  it("still sends a portrait home swipe as IndigoHIDEdge BOTTOM", () => {
    const [frame] = inputToHid(swipeUpFromBottom, 0);
    assert.equal(frame!.op, HID_OP.TOUCH);
    assert.equal((frame!.payload as { edge: number }).edge, INDIGO_EDGE.BOTTOM);
  });

  it("sends the same swipe as IndigoHIDEdge RIGHT in landscape_left", () => {
    // Displayed bottom -> framebuffer right (rotation) -> Indigo 4 (renumber).
    // Two independent renumberings stacked; either one alone is wrong.
    const [frame] = inputToHid(swipeUpFromBottom, frameRotationFor("landscape_left"));
    const payload = frame!.payload as { x: number; y: number; edge: number };
    assert.equal(payload.edge, INDIGO_EDGE.RIGHT);
    near(payload.x, 0.995, "x");
    near(payload.y, 0.5, "y");
  });

  it("sends it as IndigoHIDEdge LEFT in landscape_right", () => {
    const [frame] = inputToHid(swipeUpFromBottom, frameRotationFor("landscape_right"));
    const payload = frame!.payload as { x: number; y: number; edge: number };
    assert.equal(payload.edge, INDIGO_EDGE.LEFT);
    near(payload.x, 0.005, "x");
    near(payload.y, 0.5, "y");
  });

  it("sends it as IndigoHIDEdge TOP upside down", () => {
    const [frame] = inputToHid(
      swipeUpFromBottom,
      frameRotationFor("portrait_upside_down"),
    );
    assert.equal((frame!.payload as { edge: number }).edge, INDIGO_EDGE.TOP);
  });

  it("defaults to no rotation when the caller does not pass one", () => {
    assert.deepEqual(inputToHid(swipeUpFromBottom), inputToHid(swipeUpFromBottom, 0));
  });

  it("still clamps after rotating", () => {
    const [frame] = inputToHid(
      { kind: "touch", phase: TOUCH_PHASE.BEGIN, x: 5, y: -3, seq: 1, edge: 0 },
      90,
    );
    const payload = frame!.payload as { x: number; y: number };
    assert.ok(payload.x >= 0 && payload.x <= 1, `x=${payload.x}`);
    assert.ok(payload.y >= 0 && payload.y <= 1, `y=${payload.y}`);
  });
});
