/**
 * Frame painter for the mock provider: scrolling colour bars, a clock, and an
 * echo of the most recent input so the end-to-end input path is visible.
 */

import { Raster, textWidth, type RGB } from "../../util/raster.ts";
import type { Orientation } from "../../types.ts";

export interface TouchEcho {
  /** normalized [0,1] */
  x: number;
  y: number;
  phase: number;
  seq: number;
  edge: number;
  down: boolean;
}

export interface MockRenderState {
  name: string;
  width: number;
  height: number;
  orientation: Orientation;
  frame: number;
  fps: number;
  now: Date;
  touch: TouchEcho | null;
  /** normalized recent touch positions, oldest first */
  trail: Array<{ x: number; y: number }>;
  /** most recent non-touch input, rendered as text */
  lastEvent: string;
}

const BARS: RGB[] = [
  [192, 192, 192],
  [192, 192, 0],
  [0, 192, 192],
  [0, 192, 0],
  [192, 0, 192],
  [192, 0, 0],
  [0, 0, 192],
  [24, 24, 24],
];

const WHITE: RGB = [255, 255, 255];
const BLACK: RGB = [0, 0, 0];
const ACCENT: RGB = [255, 96, 0];
const DIM: RGB = [150, 150, 150];

export function renderMockFrame(s: MockRenderState): Raster {
  const r = new Raster(s.width, s.height);

  // --- scrolling colour bars ------------------------------------------------
  const barW = Math.max(8, Math.round(s.width / BARS.length));
  const offset = (s.frame * 2) % (barW * BARS.length);
  for (let i = -BARS.length; i <= BARS.length * 2; i++) {
    const c = BARS[((i % BARS.length) + BARS.length) % BARS.length]!;
    r.fillRect(i * barW + offset, 0, barW, s.height, c);
  }

  // --- header ---------------------------------------------------------------
  // text scale follows the short edge so landscape does not get giant type
  const scale = Math.max(1, Math.round(Math.min(s.width, s.height) / 180));
  const headerH = 12 * scale + 12;
  r.fillRect(0, 0, s.width, headerH, [12, 12, 16]);
  r.text(s.name, 6, 6, scale, WHITE);
  r.text(
    `${s.width}X${s.height} ${orientationLabel(s.orientation)}`,
    6,
    6 + 8 * scale,
    scale,
    DIM,
  );

  // --- clock ----------------------------------------------------------------
  const clock = formatClock(s.now);
  const clockScale = Math.max(2, Math.round(Math.min(s.width, s.height) / 90));
  const clockW = textWidth(clock, clockScale);
  const clockX = Math.round((s.width - clockW) / 2);
  const clockY = Math.round(s.height / 2) - 4 * clockScale;
  r.fillRect(clockX - 8, clockY - 8, clockW + 16, 7 * clockScale + 16, BLACK);
  r.text(clock, clockX, clockY, clockScale, WHITE);

  const sub = `FRAME ${s.frame} ${s.fps.toFixed(0)}FPS`;
  const subScale = Math.max(1, clockScale - 2);
  const subW = textWidth(sub, subScale);
  r.fillRect(
    Math.round((s.width - subW) / 2) - 6,
    clockY + 7 * clockScale + 10,
    subW + 12,
    7 * subScale + 8,
    BLACK,
  );
  r.text(
    sub,
    Math.round((s.width - subW) / 2),
    clockY + 7 * clockScale + 14,
    subScale,
    DIM,
  );

  // --- input echo -----------------------------------------------------------
  for (let i = 0; i < s.trail.length; i++) {
    const p = s.trail[i]!;
    const px = Math.round(p.x * (s.width - 1));
    const py = Math.round(p.y * (s.height - 1));
    const age = s.trail.length - i;
    r.disc(px, py, Math.max(1, 6 - Math.round(age / 3)), [255, 200, 120]);
  }

  if (s.touch) {
    const px = Math.round(s.touch.x * (s.width - 1));
    const py = Math.round(s.touch.y * (s.height - 1));
    const c: RGB = s.touch.down ? ACCENT : [120, 120, 120];
    r.disc(px, py, 8, c);
    r.ring(px, py, 22, 3, c);
    r.line(0, py, s.width, py, [80, 80, 80]);
    r.line(px, 0, px, s.height, [80, 80, 80]);
  }

  // --- footer ---------------------------------------------------------------
  const subLineScale = Math.max(1, scale - 1);
  const footerH = 7 * scale + 7 * subLineScale + 11;
  r.fillRect(0, s.height - footerH, s.width, footerH, [12, 12, 16]);
  const line = s.touch
    ? `T ${phaseLabel(s.touch.phase)} ${s.touch.x.toFixed(3)},${s.touch.y.toFixed(3)} S${s.touch.seq} E${s.touch.edge}`
    : "NO INPUT YET";
  r.text(line, 6, s.height - footerH + 4, scale, WHITE);
  if (s.lastEvent) {
    r.text(
      s.lastEvent.slice(0, Math.floor(s.width / (6 * subLineScale))),
      6,
      s.height - footerH + 7 * scale + 7,
      subLineScale,
      [255, 200, 120],
    );
  }

  // Edge highlight last: it must stay visible over the footer, since the
  // bottom edge is exactly where the iOS home gesture starts.
  if (s.touch && s.touch.edge !== 0) highlightEdge(r, s.touch.edge, ACCENT);

  return r;
}

function highlightEdge(r: Raster, edge: number, c: RGB): void {
  const t = 6;
  switch (edge) {
    case 1:
      r.fillRect(0, 0, r.width, t, c);
      break;
    case 2:
      r.fillRect(0, r.height - t, r.width, t, c);
      break;
    case 3:
      r.fillRect(0, 0, t, r.height, c);
      break;
    case 4:
      r.fillRect(r.width - t, 0, t, r.height, c);
      break;
  }
}

function phaseLabel(p: number): string {
  return p === 0 ? "BEGIN" : p === 1 ? "MOVE" : "END";
}

function orientationLabel(o: Orientation): string {
  switch (o) {
    case "portrait":
      return "PORTRAIT";
    case "portrait_upside_down":
      return "UPSIDE DOWN";
    case "landscape_left":
      return "LANDSCAPE L";
    case "landscape_right":
      return "LANDSCAPE R";
  }
}

function formatClock(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}
