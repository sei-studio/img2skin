// Layout enforcement: turn a raw 64x64 RGBA buffer into a structurally valid
// Minecraft skin.
//  - Never-rendered whitespace -> fully transparent.
//  - Base layer -> fully opaque (no holes; the game renders base as opaque).
//  - Overlay layer -> restore transparency: pixels close to the estimated
//    background color become transparent (Monadical's technique), everything
//    else opaque.
import { SKIN_SIZE, usedGrid, faceRects } from './layout.js';

const idx = (x, y) => (y * SKIN_SIZE + x) * 4;

// Estimate what the generator used as "background" from the modal color
// bucket across ALL never-rendered whitespace pixels. Mode (not mean) so a
// minority of garbage pixels can't skew it.
export function estimateBackground(rgba, variant = 'classic') {
  const any = usedGrid(variant, 'both');
  const buckets = new Map();
  let transparent = 0;
  let total = 0;
  for (let y = 0; y < SKIN_SIZE; y++) {
    for (let x = 0; x < SKIN_SIZE; x++) {
      if (any[y][x]) continue;
      total++;
      const i = idx(x, y);
      if (rgba[i + 3] < 128) { transparent++; continue; }
      const key = `${rgba[i] >> 4},${rgba[i + 1] >> 4},${rgba[i + 2] >> 4}`;
      let b = buckets.get(key);
      if (!b) buckets.set(key, (b = { n: 0, r: 0, g: 0, b: 0 }));
      b.n++; b.r += rgba[i]; b.g += rgba[i + 1]; b.b += rgba[i + 2];
    }
  }
  if (transparent > total / 2) return { transparentBg: true };
  let best = null;
  for (const b of buckets.values()) if (!best || b.n > best.n) best = b;
  return { transparentBg: false, color: [best.r / best.n, best.g / best.n, best.b / best.n] };
}

const dist = (rgba, i, [cr, cg, cb]) =>
  Math.hypot(rgba[i] - cr, rgba[i + 1] - cg, rgba[i + 2] - cb);

export function enforceLayout(rgba, { variant = "classic", cutoff = 30 } = {}) {
  const out = Buffer.from(rgba);
  const base = usedGrid(variant, 'base');
  const any = usedGrid(variant, 'both');
  const bg = estimateBackground(rgba);

  for (let y = 0; y < SKIN_SIZE; y++) {
    for (let x = 0; x < SKIN_SIZE; x++) {
      const i = idx(x, y);
      if (!any[y][x]) {
        // whitespace: always fully transparent
        out[i] = 0; out[i + 1] = 0; out[i + 2] = 0; out[i + 3] = 0;
      } else if (base[y][x]) {
        // base layer: always fully opaque
        out[i + 3] = 255;
      } else {
        // overlay: background-ish pixels -> transparent, rest opaque
        const isBg = bg.transparentBg
          ? rgba[i + 3] < 128
          : dist(rgba, i, bg.color) <= cutoff;
        if (isBg) {
          out[i] = 0; out[i + 1] = 0; out[i + 2] = 0; out[i + 3] = 0;
        } else {
          out[i + 3] = 255;
        }
      }
    }
  }
  return out;
}

// If the generator left a base face entirely background-colored (it drew
// nothing there), that face would come out as flat background color. Detect
// faces whose pixels are all within cutoff of the background — callers can
// warn or in-paint from neighboring faces.
export function flatBaseFaces(rgba, { variant = 'classic', cutoff = 30 } = {}) {
  const bg = estimateBackground(rgba);
  if (bg.transparentBg) return [];
  const flat = [];
  for (const r of faceRects(variant, 'base')) {
    let allBg = true;
    for (let y = r.y; y < r.y + r.h && allBg; y++)
      for (let x = r.x; x < r.x + r.w && allBg; x++)
        if (dist(rgba, idx(x, y), bg.color) > cutoff) allBg = false;
    if (allBg) flat.push(`${r.part}.${r.face}`);
  }
  return flat;
}
