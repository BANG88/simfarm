/**
 * Parser for serve-sim's `/stream.mjpeg` framing.
 *
 * Each frame is
 *
 *     --frame\r\nContent-Type: image/jpeg\r\nContent-Length: N\r\n\r\n<N bytes>\r\n
 *
 * `?raw=1` only changes the response's own Content-Type header (from
 * `multipart/x-mixed-replace` to `application/octet-stream`); the per-frame
 * envelope is identical either way, so this parser handles both.
 *
 * Content-Length is authoritative — we never scan for JPEG markers, so a JPEG
 * that happens to contain the boundary bytes cannot desynchronise the stream.
 */

const HEADER_END = new Uint8Array([0x0d, 0x0a, 0x0d, 0x0a]); // CRLFCRLF
const MAX_HEADER_BYTES = 4096;
const MAX_FRAME_BYTES = 32 * 1024 * 1024;

export class MjpegParser {
  private buf: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

  /** Feed one chunk; returns every complete JPEG it completed. */
  push(chunk: Uint8Array): Uint8Array[] {
    this.buf = concat(this.buf, chunk);
    const out: Uint8Array[] = [];

    for (;;) {
      const headerEnd = indexOf(this.buf, HEADER_END);
      if (headerEnd === -1) {
        if (this.buf.length > MAX_HEADER_BYTES) {
          throw new Error("mjpeg: part header never terminated");
        }
        break;
      }
      const header = new TextDecoder("utf-8", { fatal: false }).decode(
        this.buf.subarray(0, headerEnd),
      );
      const match = /content-length:\s*(\d+)/i.exec(header);
      if (!match) throw new Error("mjpeg: part without Content-Length");
      const len = Number(match[1]);
      if (!Number.isSafeInteger(len) || len > MAX_FRAME_BYTES) {
        throw new Error(`mjpeg: implausible part length ${match[1]}`);
      }

      const start = headerEnd + HEADER_END.length;
      if (this.buf.length < start + len) break;

      out.push(this.buf.slice(start, start + len));
      // Skip the frame plus the trailing CRLF, when it has arrived.
      let next = start + len;
      if (this.buf[next] === 0x0d && this.buf[next + 1] === 0x0a) next += 2;
      this.buf = this.buf.subarray(next);
    }

    if (this.buf.byteOffset !== 0) this.buf = this.buf.slice();
    return out;
  }
}

function indexOf(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
