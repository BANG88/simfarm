/**
 * INPUT channel (PROTOCOL §5) -> serve-sim HID.
 *
 * The edge tests are the important ones. iOS is the only backend with real
 * system edge gestures, our `edge` byte and serve-sim's `IndigoHIDEdge` use
 * *different* numbering, and a wrong mapping fails silently — a bottom swipe
 * would be delivered as a top-edge gesture and pull down notification centre
 * instead of going home.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  HID_CONFIG_TAG,
  HID_OP,
  INDIGO_EDGE,
  SUPPORTED_BUTTONS,
  decodeConfigFrame,
  encodeHidFrame,
  inputToHid,
  orientationFrame,
  textToHid,
  toIndigoEdge,
  usageForChar,
} from "../../../src/providers/ios/hid-protocol.ts";
import {
  BUTTON_ID,
  KEY_PHASE,
  TOUCH_EDGE,
  TOUCH_PHASE,
  type InputMessage,
} from "../../../src/protocol.ts";

function only(msg: InputMessage): { op: number; payload: Record<string, unknown> } {
  const frames = inputToHid(msg);
  assert.equal(frames.length, 1, `expected one HID frame for ${msg.kind}`);
  return {
    op: frames[0]!.op,
    payload: frames[0]!.payload as Record<string, unknown>,
  };
}

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

describe("edge translation", () => {
  it("maps every simfarm edge onto its IndigoHIDEdge counterpart", () => {
    // PROTOCOL §5:      none=0 top=1 bottom=2 left=3 right=4
    // IndigoHIDEdge:    none=0 left=1 top=2  bottom=3 right=4
    assert.equal(toIndigoEdge(TOUCH_EDGE.NONE), INDIGO_EDGE.NONE);
    assert.equal(toIndigoEdge(TOUCH_EDGE.TOP), INDIGO_EDGE.TOP);
    assert.equal(toIndigoEdge(TOUCH_EDGE.BOTTOM), INDIGO_EDGE.BOTTOM);
    assert.equal(toIndigoEdge(TOUCH_EDGE.LEFT), INDIGO_EDGE.LEFT);
    assert.equal(toIndigoEdge(TOUCH_EDGE.RIGHT), INDIGO_EDGE.RIGHT);
  });

  it("is not the identity — the two enums really do differ", () => {
    assert.notEqual(toIndigoEdge(TOUCH_EDGE.TOP), TOUCH_EDGE.TOP);
    assert.notEqual(toIndigoEdge(TOUCH_EDGE.BOTTOM), TOUCH_EDGE.BOTTOM);
    assert.notEqual(toIndigoEdge(TOUCH_EDGE.LEFT), TOUCH_EDGE.LEFT);
  });

  it("sends the bottom edge as IndigoHIDEdge 3, the swipe-to-home value", () => {
    const { payload } = only(touch({ edge: TOUCH_EDGE.BOTTOM, y: 0.99 }));
    assert.equal(payload.edge, 3);
  });

  it("degrades unknown edge bytes to none rather than guessing", () => {
    assert.equal(toIndigoEdge(9), INDIGO_EDGE.NONE);
    assert.equal(toIndigoEdge(-1), INDIGO_EDGE.NONE);
    assert.equal(only(touch({ edge: 200 })).payload.edge, 0);
  });

  it("carries the edge through every phase of a gesture", () => {
    // iOS only honours a gesture that *began* on the edge, and the client holds
    // one value for the whole gesture (PROTOCOL §5) — we must not drop it on
    // the move/end frames.
    for (const phase of [TOUCH_PHASE.BEGIN, TOUCH_PHASE.MOVE, TOUCH_PHASE.END]) {
      const { payload } = only(touch({ phase, edge: TOUCH_EDGE.BOTTOM }));
      assert.equal(payload.edge, INDIGO_EDGE.BOTTOM, `phase ${phase}`);
    }
  });
});

describe("touch", () => {
  it("keeps coordinates normalized", () => {
    // serve-sim passes the CGPoint straight through with NSSize(1,1), so these
    // must stay in [0,1] — converting to pixels here would put the touch in the
    // top-left corner.
    const { op, payload } = only(touch({ x: 0.25, y: 0.75 }));
    assert.equal(op, HID_OP.TOUCH);
    assert.equal(payload.x, 0.25);
    assert.equal(payload.y, 0.75);
  });

  it("maps phases to serve-sim touch types", () => {
    assert.equal(only(touch({ phase: TOUCH_PHASE.BEGIN })).payload.type, "begin");
    assert.equal(only(touch({ phase: TOUCH_PHASE.MOVE })).payload.type, "move");
    assert.equal(only(touch({ phase: TOUCH_PHASE.END })).payload.type, "end");
  });

  it("clamps out-of-range coordinates", () => {
    const { payload } = only(touch({ x: -3, y: 42 }));
    assert.equal(payload.x, 0);
    assert.equal(payload.y, 1);
  });
});

describe("multitouch", () => {
  it("sends both fingers on opcode 5", () => {
    const { op, payload } = only({
      kind: "multitouch",
      phase: TOUCH_PHASE.MOVE,
      x1: 0.1,
      y1: 0.2,
      x2: 0.8,
      y2: 0.9,
      seq: 7,
    });
    assert.equal(op, HID_OP.MULTITOUCH);
    assert.deepEqual(payload, { type: "move", x1: 0.1, y1: 0.2, x2: 0.8, y2: 0.9 });
  });
});

describe("keyboard", () => {
  it("forwards HID usages with a down/up type", () => {
    assert.deepEqual(only({ kind: "key", phase: KEY_PHASE.DOWN, usage: 0x28 }), {
      op: HID_OP.KEY,
      payload: { type: "down", usage: 0x28 },
    });
    assert.deepEqual(only({ kind: "key", phase: KEY_PHASE.UP, usage: 0x28 }), {
      op: HID_OP.KEY,
      payload: { type: "up", usage: 0x28 },
    });
  });
});

describe("text", () => {
  it("types lowercase letters as bare key presses", () => {
    const frames = textToHid("ab");
    assert.deepEqual(
      frames.map((f) => f.payload),
      [
        { type: "down", usage: 0x04 },
        { type: "up", usage: 0x04 },
        { type: "down", usage: 0x05 },
        { type: "up", usage: 0x05 },
      ],
    );
  });

  it("wraps shifted characters in LeftShift", () => {
    const frames = textToHid("A");
    assert.deepEqual(
      frames.map((f) => f.payload),
      [
        { type: "down", usage: 0xe1 },
        { type: "down", usage: 0x04 },
        { type: "up", usage: 0x04 },
        { type: "up", usage: 0xe1 },
      ],
    );
  });

  it("knows the digits, space and common punctuation", () => {
    assert.deepEqual(usageForChar("1"), { usage: 0x1e, shift: false });
    assert.deepEqual(usageForChar("0"), { usage: 0x27, shift: false });
    assert.deepEqual(usageForChar(" "), { usage: 0x2c, shift: false });
    assert.deepEqual(usageForChar("\n"), { usage: 0x28, shift: false });
    assert.deepEqual(usageForChar("."), { usage: 0x37, shift: false });
    assert.deepEqual(usageForChar("!"), { usage: 0x1e, shift: true });
    assert.deepEqual(usageForChar(":"), { usage: 0x33, shift: true });
  });

  it("drops characters no US keyboard can produce instead of typing garbage", () => {
    assert.equal(usageForChar("字"), null);
    assert.equal(usageForChar("🙂"), null);
    assert.deepEqual(textToHid("a字b").length, 4);
  });

  it("goes through inputToHid as a text message", () => {
    assert.equal(inputToHid({ kind: "text", text: "hi" }).length, 4);
  });
});

describe("buttons", () => {
  it("sends named buttons once, on the down edge only", () => {
    const down = inputToHid({
      kind: "button",
      phase: KEY_PHASE.DOWN,
      buttonId: BUTTON_ID.home,
    });
    assert.deepEqual(down, [{ op: HID_OP.BUTTON, payload: { button: "home" } }]);

    // A second press on UP would be a double home press, i.e. the app switcher.
    assert.deepEqual(
      inputToHid({ kind: "button", phase: KEY_PHASE.UP, buttonId: BUTTON_ID.home }),
      [],
    );
  });

  it("maps app_switch to serve-sim's app_switcher", () => {
    const [frame] = inputToHid({
      kind: "button",
      phase: KEY_PHASE.DOWN,
      buttonId: BUTTON_ID.app_switch,
    });
    assert.deepEqual(frame!.payload, { button: "app_switcher" });
  });

  it("sends volume/power/action as arbitrary HID with a real down and up", () => {
    const cases: Array<[number, number, number]> = [
      [BUTTON_ID.volume_up, 0x0c, 0xe9],
      [BUTTON_ID.volume_down, 0x0c, 0xea],
      [BUTTON_ID.power, 0x0c, 0x30],
      [BUTTON_ID.action, 0x0b, 0x2d],
    ];
    for (const [buttonId, page, usage] of cases) {
      assert.deepEqual(
        inputToHid({ kind: "button", phase: KEY_PHASE.DOWN, buttonId }),
        [{ op: HID_OP.BUTTON, payload: { page, usage, phase: "down" } }],
      );
      assert.deepEqual(
        inputToHid({ kind: "button", phase: KEY_PHASE.UP, buttonId }),
        [{ op: HID_OP.BUTTON, payload: { page, usage, phase: "up" } }],
      );
    }
  });

  it("ignores buttons this platform has no path for", () => {
    assert.deepEqual(
      inputToHid({ kind: "button", phase: KEY_PHASE.DOWN, buttonId: BUTTON_ID.back }),
      [],
    );
  });

  it("only advertises buttons it can actually deliver", () => {
    for (const name of SUPPORTED_BUTTONS) {
      const id = BUTTON_ID[name as keyof typeof BUTTON_ID];
      assert.notEqual(id, undefined, `${name} is not in the protocol table`);
      const frames = inputToHid({
        kind: "button",
        phase: KEY_PHASE.DOWN,
        buttonId: id,
      });
      assert.equal(frames.length, 1, `${name} produced no HID frame`);
    }
  });
});

describe("scroll", () => {
  it("stays normalized — serve-sim multiplies by the screen size itself", () => {
    const { op, payload } = only({
      kind: "scroll",
      dx: 0.1,
      dy: -0.25,
      anchorX: 0.5,
      anchorY: 0.6,
    });
    assert.equal(op, HID_OP.SCROLL);
    assert.deepEqual(payload, { dx: 0.1, dy: -0.25, x: 0.5, y: 0.6 });
  });
});

describe("orientation", () => {
  it("uses the same orientation strings the protocol does", () => {
    assert.deepEqual(orientationFrame("landscape_left"), {
      op: HID_OP.ORIENTATION,
      payload: { orientation: "landscape_left" },
    });
  });
});

describe("framing", () => {
  it("encodes as [1B opcode][UTF-8 JSON]", () => {
    const bytes = encodeHidFrame({ op: HID_OP.TOUCH, payload: { type: "end" } });
    assert.equal(bytes[0], HID_OP.TOUCH);
    assert.deepEqual(JSON.parse(new TextDecoder().decode(bytes.subarray(1))), {
      type: "end",
    });
  });

  it("decodes the 0x82 screen-config push", () => {
    const json = JSON.stringify({
      width: 1206,
      height: 2622,
      orientation: "portrait",
    });
    const buf = new Uint8Array(1 + json.length);
    buf[0] = HID_CONFIG_TAG;
    buf.set(new TextEncoder().encode(json), 1);
    assert.deepEqual(decodeConfigFrame(buf), {
      width: 1206,
      height: 2622,
      orientation: "portrait",
    });
  });

  it("ignores anything that is not a config frame", () => {
    assert.equal(decodeConfigFrame(new Uint8Array([0x01, 0x02])), null);
    assert.equal(decodeConfigFrame(new Uint8Array([HID_CONFIG_TAG])), null);
    assert.equal(
      decodeConfigFrame(new Uint8Array([HID_CONFIG_TAG, 0x7b, 0x7b])),
      null,
    );
  });
});
