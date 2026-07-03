// Branch B: map a canonical dual-panel (front|back) Minecraft-style character
// render onto the 64x64 skin atlas.
//
// Panel contract (see PANEL_PROMPT): square image, front view centered in the
// left half, back view centered in the right half, plain light background,
// character standing straight, arms at sides.
//
// Method: find the character's bounding box in each half, sample it onto a
// 16x32 cell grid (the same canvas geometry renderView uses), then invert
// renderView's placement to write the front/back faces of every part.
// Side/top/bottom faces are synthesized from the adjacent front/back edges.
import sharp from 'sharp';
import { SKIN_SIZE, parts } from './layout.js';
import { dominantCell } from './downsample.js';

const AIDX = (x, y) => (y * SKIN_SIZE + x) * 4;

// --- panel loading ---------------------------------------------------------

export async function loadRaw(input) {
  const { data, info } = await sharp(input)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height };
}

// Estimate the background color from the image border pixels (modal bucket).
export function borderBackground(img) {
  const { data, w, h } = img;
  const buckets = new Map();
  let transparent = 0;
  const push = (x, y) => {
    const i = (y * w + x) * 4;
    if (data[i + 3] < 128) { transparent++; return; }
    const key = `${data[i] >> 4},${data[i + 1] >> 4},${data[i + 2] >> 4}`;
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { n: 0, r: 0, g: 0, b: 0 }));
    b.n++; b.r += data[i]; b.g += data[i + 1]; b.b += data[i + 2];
  };
  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
  let best = null;
  for (const b of buckets.values()) if (!best || b.n > best.n) best = b;
  // If transparency dominates the border, the background IS transparency —
  // opaque border pixels are just the character touching the edge.
  if (!best || transparent > best.n) return null;
  return [best.r / best.n, best.g / best.n, best.b / best.n];
}

export function isForeground(data, w, x, y, bg, tol = 40) {
  const i = (y * w + x) * 4;
  if (data[i + 3] < 128) return false;
  if (!bg) return true;
  const d = Math.hypot(data[i] - bg[0], data[i + 1] - bg[1], data[i + 2] - bg[2]);
  return d > tol;
}

export function bbox(img, x0, x1, bg) {
  const { data, w, h } = img;
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = x0; x < x1; x++) {
      if (isForeground(data, w, x, y, bg)) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) throw new Error('no character found in panel half');
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

// Sample a bbox region onto a cw x ch cell grid with dominant color.
// Background-colored dominant cells come back transparent.
function gridSample(img, box, cw, ch, bg) {
  const { data, w } = img;
  const grid = Buffer.alloc(cw * ch * 4);
  for (let cy = 0; cy < ch; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      const px0 = box.x + Math.floor((cx * box.w) / cw);
      const px1 = Math.max(px0 + 1, box.x + Math.floor(((cx + 1) * box.w) / cw));
      const py0 = box.y + Math.floor((cy * box.h) / ch);
      const py1 = Math.max(py0 + 1, box.y + Math.floor(((cy + 1) * box.h) / ch));
      // dominant color over the cell, counting bg-ish pixels as transparent
      const buckets = new Map();
      for (let y = py0; y < py1; y++) {
        for (let x = px0; x < px1; x++) {
          const fg = isForeground(data, w, x, y, bg);
          const i = (y * w + x) * 4;
          const key = fg ? `${data[i] >> 4},${data[i + 1] >> 4},${data[i + 2] >> 4}` : 'T';
          let b = buckets.get(key);
          if (!b) buckets.set(key, (b = { n: 0, r: 0, g: 0, b: 0 }));
          b.n++;
          if (fg) { b.r += data[i]; b.g += data[i + 1]; b.b += data[i + 2]; }
        }
      }
      let best = null, bestKey = null;
      for (const [key, b] of buckets) if (!best || b.n > best.n) { best = b; bestKey = key; }
      const o = (cy * cw + cx) * 4;
      if (bestKey === 'T') { grid[o + 3] = 0; continue; }
      grid[o] = Math.round(best.r / best.n);
      grid[o + 1] = Math.round(best.g / best.n);
      grid[o + 2] = Math.round(best.b / best.n);
      grid[o + 3] = 255;
    }
  }
  return grid;
}

// --- atlas writing ---------------------------------------------------------

// Same placement as renderView: where each part's front/back face sits on the
// 16x32 (classic) canvas grid.
function viewPlacement(side, variant) {
  const P = parts(variant);
  const aw = P.rightArm.dims.w;
  const bodyX = aw;
  const [armL, armR, legL, legR] =
    side === 'front'
      ? [P.rightArm, P.leftArm, P.rightLeg, P.leftLeg]
      : [P.leftArm, P.rightArm, P.leftLeg, P.rightLeg];
  return [
    { rect: P.head[side === 'front' ? 'base' : 'base'][side], part: P.head, dx: bodyX, dy: 0 },
    { rect: P.body.base[side], part: P.body, dx: bodyX, dy: 8 },
    { rect: armL.base[side], part: armL, dx: 0, dy: 8 },
    { rect: armR.base[side], part: armR, dx: bodyX + 8, dy: 8 },
    { rect: legL.base[side], part: legL, dx: bodyX, dy: 20 },
    { rect: legR.base[side], part: legR, dx: bodyX + 4, dy: 20 },
  ];
}

function writeFace(atlas, grid, cw, rect, dx, dy) {
  for (let y = 0; y < rect.h; y++) {
    for (let x = 0; x < rect.w; x++) {
      const g = ((dy + y) * cw + dx + x) * 4;
      const a = AIDX(rect.x + x, rect.y + y);
      atlas[a] = grid[g];
      atlas[a + 1] = grid[g + 1];
      atlas[a + 2] = grid[g + 2];
      atlas[a + 3] = grid[g + 3] ? 255 : 0;
    }
  }
}

// Synthesize a side face by tiling the edge column of a source face.
function synthSide(atlas, srcRect, srcEdgeX, dstRect, { darken = 0.9 } = {}) {
  for (let y = 0; y < dstRect.h; y++) {
    const s = AIDX(srcRect.x + srcEdgeX, srcRect.y + Math.min(y, srcRect.h - 1));
    for (let x = 0; x < dstRect.w; x++) {
      const d = AIDX(dstRect.x + x, dstRect.y + y);
      atlas[d] = Math.round(atlas[s] * darken);
      atlas[d + 1] = Math.round(atlas[s + 1] * darken);
      atlas[d + 2] = Math.round(atlas[s + 2] * darken);
      atlas[d + 3] = atlas[s + 3];
    }
  }
}

// Synthesize top/bottom by tiling a source row.
function synthCap(atlas, srcRect, srcEdgeY, dstRect, { darken = 1 } = {}) {
  for (let y = 0; y < dstRect.h; y++) {
    for (let x = 0; x < dstRect.w; x++) {
      const s = AIDX(srcRect.x + Math.min(x, srcRect.w - 1), srcRect.y + srcEdgeY);
      const d = AIDX(dstRect.x + x, dstRect.y + y);
      atlas[d] = Math.round(atlas[s] * darken);
      atlas[d + 1] = Math.round(atlas[s + 1] * darken);
      atlas[d + 2] = Math.round(atlas[s + 2] * darken);
      atlas[d + 3] = atlas[s + 3];
    }
  }
}

/**
 * Convert a dual-panel (front|back) render into a 64x64 skin atlas buffer.
 */
export async function panelToAtlas(panelImage, { variant = 'classic' } = {}) {
  const img = await loadRaw(panelImage);
  const bg = borderBackground(img);
  const half = Math.floor(img.w / 2);
  const P = parts(variant);
  const aw = P.rightArm.dims.w;
  const cw = 8 + 2 * aw;
  const ch = 32;

  const atlas = Buffer.alloc(SKIN_SIZE * SKIN_SIZE * 4);
  for (const [side, x0, x1] of [
    ['front', 0, half],
    ['back', half, img.w],
  ]) {
    const box = bbox(img, x0, x1, bg);
    const grid = gridSample(img, box, cw, ch, bg);
    for (const p of viewPlacement(side, variant)) {
      writeFace(atlas, grid, cw, p.rect, p.dx, p.dy);
    }
  }

  // Synthesize the unseen faces per part from front/back edges.
  for (const [name, part] of Object.entries(P)) {
    const f = part.base.front;
    const b = part.base.back;
    // right face: front's left edge; left face: front's right edge
    synthSide(atlas, f, 0, part.base.right, { darken: 0.85 });
    synthSide(atlas, f, f.w - 1, part.base.left, { darken: 0.85 });
    // top: head gets front top row (hair); others darkened
    synthCap(atlas, f, 0, part.base.top, { darken: name === 'head' ? 0.95 : 0.8 });
    synthCap(atlas, f, f.h - 1, part.base.bottom, { darken: 0.7 });
    void b;
  }
  return atlas;
}
