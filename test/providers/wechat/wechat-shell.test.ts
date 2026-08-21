/**
 * Classifying the sheets the WeChat IDE draws over the simulator.
 *
 * The fixtures are real DOM readings taken from the running tool on
 * 2026-08-21 (devtools 2.01.2510290 / SDK 3.16.1) by driving each `wx.*` call
 * from the logic layer and dumping what appeared under `.simulator`. Two of
 * them are the awkward ones and are the reason this file exists:
 *
 *   - the **payment** sheet has no text buttons at all, only a ✕ in its header,
 *     so anything that dismisses dialogs by matching on button text cannot
 *     close it;
 *   - the **action sheet's** cancel row has the same element class as the app's
 *     own items (`weui-actionsheet__cell`) and is told apart only by its parent.
 *
 * The closed fixture matters just as much: measured, a dialog dismissed with a
 * real mouse press is *removed* from the DOM, so presence is a valid
 * discriminant. It stops being one if anything ever calls `element.click()`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  classify,
  kindOf,
  resolveButton,
  roleOf,
  topOf,
  type RawOverlay,
  type RawShell,
} from "../../../src/providers/wechat/wechat-shell.ts";

/** `.simulator`'s own box in every fixture below. */
const SCREEN: [number, number, number, number] = [855, 91, 357, 769];

const CLOSED: RawShell = { screen: SCREEN, overlays: [] };

const MODAL: RawOverlay = {
  cls: "weui-dialog",
  title: "确认",
  content: "内容",
  iconCls: "",
  rect: [891, 389, 286, 173],
  onTop: true,
  buttons: [
    {
      id: "wx.showModal.cancel",
      cls: "weui-dialog__btn weui-dialog__btn_default auto_test_btn_default",
      parentCls: "weui-dialog__ft",
      text: "取消",
      rect: [891, 509, 143, 53],
    },
    {
      id: "wx.showModal.confirm",
      cls: "weui-dialog__btn weui-dialog__btn_primary auto_test_btn_primary",
      parentCls: "weui-dialog__ft",
      text: "确定",
      rect: [1033, 509, 143, 53],
    },
  ],
};

/** `wx.authorize` on a scope the app has not declared: no ids on the buttons. */
const AUTH: RawOverlay = {
  cls: "weui-dialog",
  title: "",
  content: "需要在 app.json 中声明 permission scope.userLocation 字段",
  iconCls: "",
  rect: [891, 378, 286, 195],
  onTop: true,
  buttons: [
    {
      id: "",
      cls: "weui-dialog__btn weui-dialog__btn_default auto_test_btn_default",
      parentCls: "weui-dialog__ft",
      text: "取消",
      rect: [891, 519, 143, 53],
    },
    {
      id: "",
      cls: "weui-dialog__btn weui-dialog__btn_primary auto_test_btn_primary",
      parentCls: "weui-dialog__ft",
      text: "查看详情",
      rect: [1033, 519, 143, 53],
    },
  ],
};

const ACTION_SHEET: RawOverlay = {
  cls: "weui-actionsheet ui-animate-swipeInUp",
  title: "",
  content: "",
  iconCls: "",
  rect: [855, 692, 357, 167],
  onTop: true,
  buttons: [
    {
      id: "",
      cls: "weui-actionsheet__cell",
      parentCls: "weui-actionsheet__menu",
      text: "选项一",
      rect: [855, 692, 357, 53],
    },
    {
      id: "",
      cls: "weui-actionsheet__cell",
      parentCls: "weui-actionsheet__menu",
      text: "选项二",
      rect: [855, 746, 357, 53],
    },
    {
      id: "",
      cls: "weui-actionsheet__cell",
      parentCls: "weui-actionsheet__action",
      text: "取消",
      rect: [855, 806, 357, 53],
    },
  ],
};

const PAYMENT: RawOverlay = {
  cls: "weui-dialog",
  title: "微信支付",
  // The real sheet interpolates the developer's own WeChat display name here;
  // it is not part of what this test checks, so the fixture leaves it out.
  content: "请用开发者本人微信扫描以上二维码进行支付调试",
  iconCls: "",
  rect: [891, 339, 286, 272],
  onTop: false,
  buttons: [
    {
      id: "",
      cls: "payment-dialog-hd close-payment-dialog",
      parentCls: "weui-dialog__bd",
      text: "",
      rect: [913, 353, 240, 22],
    },
  ],
};

const TOAST: RawOverlay = {
  cls: "weui-toast",
  title: "",
  content: "已完成",
  iconCls: "weui-icon_toast weui-icon-success-no-circle",
  rect: [976, 373, 114, 114],
  onTop: true,
  buttons: [],
};

const LOADING: RawOverlay = {
  ...TOAST,
  content: "加载中",
  iconCls: "weui-icon_toast weui-loading",
};

describe("kindOf", () => {
  it("names each sheet the IDE can draw", () => {
    assert.equal(kindOf(MODAL), "modal");
    assert.equal(kindOf(AUTH), "dialog");
    assert.equal(kindOf(ACTION_SHEET), "actionsheet");
    assert.equal(kindOf(PAYMENT), "payment");
    assert.equal(kindOf(TOAST), "toast");
  });

  it("tells a spinner from a tick — both are .weui-toast", () => {
    assert.equal(kindOf(LOADING), "loading");
  });
});

describe("roleOf", () => {
  it("uses the ids wx.showModal puts on its own buttons", () => {
    assert.equal(roleOf(MODAL.buttons[0]!, "modal"), "cancel");
    assert.equal(roleOf(MODAL.buttons[1]!, "modal"), "confirm");
  });

  it("falls back to the weui class when there are no ids", () => {
    assert.equal(roleOf(AUTH.buttons[0]!, "dialog"), "cancel");
    assert.equal(roleOf(AUTH.buttons[1]!, "dialog"), "confirm");
  });

  it("separates an action sheet's cancel from its items by the parent", () => {
    const roles = ACTION_SHEET.buttons.map((b) => roleOf(b, "actionsheet"));
    assert.deepEqual(roles, ["item", "item", "cancel"]);
  });

  it("finds the payment sheet's ✕", () => {
    assert.equal(roleOf(PAYMENT.buttons[0]!, "payment"), "close");
  });
});

describe("classify", () => {
  it("says nothing is open when nothing is open", () => {
    assert.deepEqual(classify(CLOSED), []);
  });

  it("normalizes the rect against the simulator screen, not the window", () => {
    const [modal] = classify({ screen: SCREEN, overlays: [MODAL] });
    // 891 is 36px into a 357px-wide screen that starts at x=855.
    assert.equal(modal!.rect.x, 0.1008);
    assert.equal(modal!.rect.width, 0.8011);
    assert.ok(modal!.rect.y > 0 && modal!.rect.y < 1);
  });

  it("keeps the buttons in the order they are drawn", () => {
    const [sheet] = classify({ screen: SCREEN, overlays: [ACTION_SHEET] });
    assert.deepEqual(
      sheet!.buttons.map((b) => [b.index, b.label, b.role]),
      [
        [0, "选项一", "item"],
        [1, "选项二", "item"],
        [2, "取消", "cancel"],
      ],
    );
  });

  it("survives a screen it could not measure", () => {
    const [modal] = classify({ screen: null, overlays: [MODAL] });
    assert.deepEqual(modal!.rect, { x: 0, y: 0, width: 1, height: 1 });
  });
});

describe("topOf", () => {
  it("prefers the one the hit test lands on", () => {
    // Measured: the payment sheet opened *under* an authorization dialog that
    // was already up, so DOM order alone would have pressed the wrong one.
    const overlays = classify({ screen: SCREEN, overlays: [PAYMENT, AUTH] });
    assert.equal(topOf(overlays)!.kind, "dialog");
  });

  it("falls back to the last one when nothing claims the top", () => {
    const overlays = classify({
      screen: SCREEN,
      overlays: [{ ...MODAL, onTop: false }, { ...PAYMENT, onTop: false }],
    });
    assert.equal(topOf(overlays)!.kind, "payment");
  });

  it("is null when the stack is empty", () => {
    assert.equal(topOf([]), null);
  });
});

describe("resolveButton", () => {
  const modal = classify({ screen: SCREEN, overlays: [MODAL] })[0]!;
  const payment = classify({ screen: SCREEN, overlays: [PAYMENT] })[0]!;
  const sheet = classify({ screen: SCREEN, overlays: [ACTION_SHEET] })[0]!;

  it("finds a role", () => {
    assert.equal(resolveButton(modal, "confirm")!.label, "确定");
    assert.equal(resolveButton(modal, "cancel")!.label, "取消");
  });

  it("takes an index, which is how an action sheet row is chosen", () => {
    assert.equal(resolveButton(sheet, 1)!.label, "选项二");
    assert.equal(resolveButton(sheet, 9), null);
  });

  it("dismisses a payment sheet, which has no cancel button", () => {
    // "close this" must not require the caller to know which sheet it is.
    assert.equal(resolveButton(payment, "cancel")!.role, "close");
    assert.equal(resolveButton(payment, "close")!.role, "close");
  });

  it("will not invent a confirm button that is not there", () => {
    assert.equal(resolveButton(payment, "confirm"), null);
  });
});
