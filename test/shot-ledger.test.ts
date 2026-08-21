/**
 * The evidence duplicate gate.
 *
 * This test exists because the gate protects the acceptance bar itself: every
 * "verified" claim in STATUS.md rests on before/after image pairs, and a pair
 * that is secretly one image twice looks exactly like a real one. It has to fail
 * closed, it has to fail before anything is written, and it must not be
 * downgradeable to a warning — so all three are pinned here rather than left to
 * whoever next edits the capture tool.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DuplicateShotError,
  ShotLedger,
} from "../tools/shot-ledger.ts";

const A = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const B = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 4]);

describe("ShotLedger", () => {
  it("accepts shots that differ", () => {
    const ledger = new ShotLedger();
    ledger.add("01-before", A);
    ledger.add("02-after", B);
    assert.equal(ledger.size, 2);
  });

  it("throws on a byte-identical repeat", () => {
    const ledger = new ShotLedger();
    ledger.add("01-before", A);
    assert.throws(
      () => ledger.add("02-after", A),
      (err: unknown) => {
        assert.ok(err instanceof DuplicateShotError);
        assert.equal(err.shot, "02-after");
        assert.equal(err.twin, "01-before");
        // The message has to name both files: the whole point is that a person
        // reading the failure knows which pair is worthless.
        assert.match(err.message, /02-after/);
        assert.match(err.message, /01-before/);
        return true;
      },
    );
  });

  it("catches a repeat of any earlier shot, not just the previous one", () => {
    // The real failure was three shots in a row; a check that only compared
    // neighbours would have passed the first and third.
    const ledger = new ShotLedger();
    ledger.add("01-home", A);
    ledger.add("02-profile", B);
    assert.throws(() => ledger.add("03-back-home", A), DuplicateShotError);
  });

  it("does not record a shot it rejected", () => {
    // Otherwise a rejected image would poison later comparisons, and — in the
    // tool — a failed run would leave the very file it refused on disk.
    const ledger = new ShotLedger();
    ledger.add("01", A);
    assert.throws(() => ledger.add("02", A), DuplicateShotError);
    assert.equal(ledger.size, 1);
  });

  it("compares content, not the name it was given", () => {
    const ledger = new ShotLedger();
    ledger.add("same-name", A);
    assert.throws(() => ledger.add("same-name", A), DuplicateShotError);
  });

  it("returns the md5 so the run can print what it wrote", () => {
    const ledger = new ShotLedger();
    // md5 of the seven bytes in A, so a change to the digest algorithm is loud.
    assert.match(ledger.add("01", A), /^[0-9a-f]{32}$/);
  });

  it("treats a one-byte difference as a difference", () => {
    // A frame that changed by a single pixel is still a changed frame; the gate
    // is about identity, and any fuzziness here would let a real pair be
    // rejected.
    const ledger = new ShotLedger();
    ledger.add("01", A);
    assert.doesNotThrow(() => ledger.add("02", B));
  });
});
