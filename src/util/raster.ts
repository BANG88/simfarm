/**
 * Tiny software rasterizer + 5x7 bitmap font, used by the mock provider to
 * synthesize frames without any native image library.
 */

import jpeg from "jpeg-js";

export type RGB = [number, number, number];

export class Raster {
  readonly width: number;
  readonly height: number;
  /** RGBA8888, row-major */
  readonly data: Uint8Array;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.data = new Uint8Array(width * height * 4);
    this.data.fill(0xff);
  }

  clear(c: RGB): void {
    this.fillRect(0, 0, this.width, this.height, c);
  }

  fillRect(x: number, y: number, w: number, h: number, c: RGB): void {
    const x0 = Math.max(0, Math.trunc(x));
    const y0 = Math.max(0, Math.trunc(y));
    const x1 = Math.min(this.width, Math.trunc(x + w));
    const y1 = Math.min(this.height, Math.trunc(y + h));
    for (let py = y0; py < y1; py++) {
      let i = (py * this.width + x0) * 4;
      for (let px = x0; px < x1; px++) {
        this.data[i++] = c[0];
        this.data[i++] = c[1];
        this.data[i++] = c[2];
        this.data[i++] = 0xff;
      }
    }
  }

  setPixel(x: number, y: number, c: RGB): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (Math.trunc(y) * this.width + Math.trunc(x)) * 4;
    this.data[i] = c[0];
    this.data[i + 1] = c[1];
    this.data[i + 2] = c[2];
    this.data[i + 3] = 0xff;
  }

  disc(cx: number, cy: number, r: number, c: RGB): void {
    const r2 = r * r;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy <= r2) this.setPixel(cx + dx, cy + dy, c);
      }
    }
  }

  ring(cx: number, cy: number, r: number, thickness: number, c: RGB): void {
    const outer = r * r;
    const inner = Math.max(0, r - thickness) ** 2;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const d = dx * dx + dy * dy;
        if (d <= outer && d >= inner) this.setPixel(cx + dx, cy + dy, c);
      }
    }
  }

  line(x0: number, y0: number, x1: number, y1: number, c: RGB): void {
    let x = Math.trunc(x0);
    let y = Math.trunc(y0);
    const ex = Math.trunc(x1);
    const ey = Math.trunc(y1);
    const dx = Math.abs(ex - x);
    const dy = -Math.abs(ey - y);
    const sx = x < ex ? 1 : -1;
    const sy = y < ey ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.setPixel(x, y, c);
      if (x === ex && y === ey) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y += sy;
      }
    }
  }

  /** Draws `s` with the 5x7 font; returns the advance width in pixels. */
  text(s: string, x: number, y: number, scale: number, c: RGB): number {
    let cursor = x;
    for (const ch of s.toUpperCase()) {
      const glyph = GLYPHS[ch] ?? GLYPHS["?"]!;
      for (let row = 0; row < GLYPH_H; row++) {
        const bits = glyph[row]!;
        for (let col = 0; col < GLYPH_W; col++) {
          if (bits[col] === "1") {
            this.fillRect(
              cursor + col * scale,
              y + row * scale,
              scale,
              scale,
              c,
            );
          }
        }
      }
      cursor += (GLYPH_W + 1) * scale;
    }
    return cursor - x;
  }
}

export function textWidth(s: string, scale: number): number {
  return s.length * (GLYPH_W + 1) * scale - scale;
}

export function encodeJpeg(r: Raster, quality = 70): Uint8Array {
  const out = jpeg.encode(
    { data: r.data as unknown as Buffer, width: r.width, height: r.height },
    quality,
  );
  return new Uint8Array(out.data);
}

// ---------------------------------------------------------------------------
// 5x7 font
// ---------------------------------------------------------------------------

const GLYPH_W = 5;
const GLYPH_H = 7;

// prettier-ignore
const GLYPHS: Record<string, string[]> = {
  " ": ["00000","00000","00000","00000","00000","00000","00000"],
  "0": ["01110","10001","10011","10101","11001","10001","01110"],
  "1": ["00100","01100","00100","00100","00100","00100","01110"],
  "2": ["01110","10001","00001","00010","00100","01000","11111"],
  "3": ["11111","00010","00100","00010","00001","10001","01110"],
  "4": ["00010","00110","01010","10010","11111","00010","00010"],
  "5": ["11111","10000","11110","00001","00001","10001","01110"],
  "6": ["00110","01000","10000","11110","10001","10001","01110"],
  "7": ["11111","00001","00010","00100","01000","01000","01000"],
  "8": ["01110","10001","10001","01110","10001","10001","01110"],
  "9": ["01110","10001","10001","01111","00001","00010","01100"],
  "A": ["01110","10001","10001","11111","10001","10001","10001"],
  "B": ["11110","10001","10001","11110","10001","10001","11110"],
  "C": ["01110","10001","10000","10000","10000","10001","01110"],
  "D": ["11100","10010","10001","10001","10001","10010","11100"],
  "E": ["11111","10000","10000","11110","10000","10000","11111"],
  "F": ["11111","10000","10000","11110","10000","10000","10000"],
  "G": ["01110","10001","10000","10111","10001","10001","01111"],
  "H": ["10001","10001","10001","11111","10001","10001","10001"],
  "I": ["01110","00100","00100","00100","00100","00100","01110"],
  "J": ["00111","00010","00010","00010","00010","10010","01100"],
  "K": ["10001","10010","10100","11000","10100","10010","10001"],
  "L": ["10000","10000","10000","10000","10000","10000","11111"],
  "M": ["10001","11011","10101","10101","10001","10001","10001"],
  "N": ["10001","10001","11001","10101","10011","10001","10001"],
  "O": ["01110","10001","10001","10001","10001","10001","01110"],
  "P": ["11110","10001","10001","11110","10000","10000","10000"],
  "Q": ["01110","10001","10001","10001","10101","10010","01101"],
  "R": ["11110","10001","10001","11110","10100","10010","10001"],
  "S": ["01111","10000","10000","01110","00001","00001","11110"],
  "T": ["11111","00100","00100","00100","00100","00100","00100"],
  "U": ["10001","10001","10001","10001","10001","10001","01110"],
  "V": ["10001","10001","10001","10001","10001","01010","00100"],
  "W": ["10001","10001","10001","10101","10101","11011","10001"],
  "X": ["10001","10001","01010","00100","01010","10001","10001"],
  "Y": ["10001","10001","01010","00100","00100","00100","00100"],
  "Z": ["11111","00001","00010","00100","01000","10000","11111"],
  ":": ["00000","00100","00100","00000","00100","00100","00000"],
  ".": ["00000","00000","00000","00000","00000","01100","01100"],
  ",": ["00000","00000","00000","00000","01100","01100","10000"],
  "-": ["00000","00000","00000","01110","00000","00000","00000"],
  "+": ["00000","00100","00100","11111","00100","00100","00000"],
  "=": ["00000","00000","11111","00000","11111","00000","00000"],
  "_": ["00000","00000","00000","00000","00000","00000","11111"],
  "/": ["00001","00010","00010","00100","01000","01000","10000"],
  "(": ["00010","00100","01000","01000","01000","00100","00010"],
  ")": ["01000","00100","00010","00010","00010","00100","01000"],
  "[": ["01110","01000","01000","01000","01000","01000","01110"],
  "]": ["01110","00010","00010","00010","00010","00010","01110"],
  "<": ["00010","00100","01000","10000","01000","00100","00010"],
  ">": ["01000","00100","00010","00001","00010","00100","01000"],
  "#": ["01010","01010","11111","01010","11111","01010","01010"],
  "%": ["11001","11010","00010","00100","01000","01011","10011"],
  "*": ["00000","10101","01110","11111","01110","10101","00000"],
  "!": ["00100","00100","00100","00100","00100","00000","00100"],
  "?": ["01110","10001","00001","00010","00100","00000","00100"],
};
