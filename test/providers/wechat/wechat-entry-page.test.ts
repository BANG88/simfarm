/**
 * The `home` key's target.
 *
 * Measured 2026-08-21 on the target project: `__wxConfig.entryPagePath` is
 * `pages/home/index.html`, and `wx.reLaunch` rejects that — it wants the route.
 * The symptom was the whole point of catching this in a test: the key returned
 * without an error to the client and the screen simply did not move.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { entryPageUrl } from "../../../src/providers/wechat/wechat-provider.ts";

describe("entryPageUrl", () => {
  it("drops the .html the IDE reports", () => {
    assert.equal(entryPageUrl("pages/home/index.html"), "/pages/home/index");
  });

  it("leaves a plain route alone", () => {
    assert.equal(entryPageUrl("pages/index/index"), "/pages/index/index");
  });

  it("does not double the leading slash", () => {
    assert.equal(entryPageUrl("/pages/home/index"), "/pages/home/index");
  });

  it("drops a query, which reLaunch would not take here either", () => {
    assert.equal(entryPageUrl("pages/home/index.html?from=share"), "/pages/home/index");
  });

  it("is empty when the app declares nothing, so the caller can say so", () => {
    assert.equal(entryPageUrl(""), "");
    assert.equal(entryPageUrl("   "), "");
  });
});
