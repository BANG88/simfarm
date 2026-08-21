/**
 * The gate that stops an evidence run producing images that prove nothing.
 *
 * Why this exists: on 2026-08-20 a WeChat capture wrote three PNGs that were
 * byte-for-byte the same file. Each one was a perfectly good picture of the mini
 * program, so nothing about them looked wrong — but "before" and "after" being
 * the same bytes means no input was demonstrated at all. Every backend here is
 * event-driven and sends nothing while the screen is still, so screenshotting
 * straight after dispatching an input captures the frame from *before* it.
 *
 * The rule is therefore absolute and has no severity dial: within one run, two
 * identical images are a failure of the run, not a warning on it. It is kept
 * apart from the capture tool so it can be tested without a browser, a server or
 * a simulator — a gate nobody has ever seen fail closed is not a gate.
 */

import crypto from "node:crypto";

export class DuplicateShotError extends Error {
  override readonly name = "DuplicateShotError";
  readonly shot: string;
  readonly twin: string;
  readonly digest: string;

  constructor(shot: string, twin: string, digest: string) {
    super(
      `"${shot}" is byte-identical to "${twin}" (md5 ${digest}). ` +
        `The picture did not change between them, so the pair demonstrates ` +
        `nothing — refusing to write it.`,
    );
    this.shot = shot;
    this.twin = twin;
    this.digest = digest;
  }
}

export class ShotLedger {
  private readonly byDigest = new Map<string, string>();

  /**
   * Record a shot about to be written.
   *
   * @throws DuplicateShotError if an identical image was already recorded. Call
   * this *before* writing the file: a rejected shot must leave nothing behind,
   * or a failed run still litters the evidence directory with the very files it
   * was rejecting.
   * @returns the md5 of the image
   */
  add(name: string, bytes: Uint8Array): string {
    const digest = crypto.createHash("md5").update(bytes).digest("hex");
    const twin = this.byDigest.get(digest);
    if (twin !== undefined) throw new DuplicateShotError(name, twin, digest);
    this.byDigest.set(digest, name);
    return digest;
  }

  get size(): number {
    return this.byDigest.size;
  }
}
