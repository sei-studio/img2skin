// Deterministic no-LLM fallback: locate the character in the input image,
// split it into head / torso / arm / leg regions, and grid-sample each region
// onto the matching skin faces so clothing colors and patterns land on the
// body. Fixed pixels are stamped for eyes and mouth. No API calls, no
// randomness: the same input always produces a byte-identical skin.
//
// Subject detection ladder (works across art, full-body renders, busts,
// selfies with busy backgrounds):
//   1. Background palette from the image border ring: every frequent border
//      color bucket counts as background, so gradients and multi-color
//      backdrops key out, not just solid fills.
//   2. Foreground mask -> largest connected component -> bounding box.
//   3. Sanity checks: if the mask ate (almost) everything or found (almost)
//      nothing, background keying failed (typical for photos), so fall back
//      to a center-prior box: subject assumed centered and large.
//   4. Head/torso/leg split from the silhouette width profile: the first
//      sustained widening below the head is the shoulder line. No widening
//      means a bust or selfie: top of the box is the head, bottom is the
//      torso, and there are no legs.
import sharp from 'sharp';
import { SKIN_SIZE, parts } from './layout.js';
import { synthSide, synthCap } from './panelmap.js';

const AIDX = (x, y) => (y * SKIN_SIZE + x) * 4;
const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
const darken = (c, f) => c.map((v) => clamp(v * f));

const ANALYZE_MAX_W = 256;
const BG_TOL = 36;

async function loadScaled(input) {
  const meta = await sharp(input).metadata();
  let s = sharp(input).ensureAlpha();
  if (meta.width > ANALYZE_MAX_W) {
    s = s.resize(ANALYZE_MAX_W, Math.max(1, Math.round((meta.height * ANALYZE_MAX_W) / meta.width)));
  }
  const { data, info } = await s.raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height };
}

// --- subject detection -------------------------------------------------------

// Frequent color buckets in the border ring. Anything matching one of these
// is background; a busy photo background produces no frequent bucket at all.
function backgroundPalette(img) {
  const { data, w, h } = img;
  const m = Math.max(2, Math.round(Math.min(w, h) * 0.04));
  const buckets = new Map();
  let total = 0;
  let transparent = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x >= m && x < w - m && y >= m && y < h - m) continue;
      total++;
      const i = (y * w + x) * 4;
      if (data[i + 3] < 128) { transparent++; continue; }
      const key = `${data[i] >> 4},${data[i + 1] >> 4},${data[i + 2] >> 4}`;
      let b = buckets.get(key);
      if (!b) buckets.set(key, (b = { n: 0, r: 0, g: 0, b: 0 }));
      b.n++; b.r += data[i]; b.g += data[i + 1]; b.b += data[i + 2];
    }
  }
  const colors = [];
  let top = 0;
  for (const b of buckets.values()) {
    top = Math.max(top, b.n);
    if (b.n >= total * 0.02) colors.push([b.r / b.n, b.g / b.n, b.b / b.n]);
  }
  return {
    colors,
    transparentBg: transparent > total / 2,
    keyable: transparent > total / 2 || top >= total * 0.25,
  };
}

function foregroundMask(img, pal) {
  const { data, w, h } = img;
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (data[i + 3] < 128) continue;
      if (!pal.transparentBg) {
        let bg = false;
        for (const c of pal.colors) {
          const d = Math.hypot(data[i] - c[0], data[i + 1] - c[1], data[i + 2] - c[2]);
          if (d <= BG_TOL) { bg = true; break; }
        }
        if (bg) continue;
      }
      mask[y * w + x] = 1;
    }
  }
  return mask;
}

// Keep only the largest 4-connected component of the mask.
function largestComponent(mask, w, h) {
  const seen = new Uint8Array(w * h);
  let best = null;
  const stack = [];
  for (let start = 0; start < w * h; start++) {
    if (!mask[start] || seen[start]) continue;
    const px = [];
    stack.length = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const p = stack.pop();
      px.push(p);
      const x = p % w, y = (p / w) | 0;
      for (const q of [p - 1, p + 1, p - w, p + w]) {
        if (q < 0 || q >= w * h || seen[q] || !mask[q]) continue;
        if (q === p - 1 && x === 0) continue;
        if (q === p + 1 && x === w - 1) continue;
        seen[q] = 1;
        stack.push(q);
      }
    }
    if (!best || px.length > best.length) best = px;
  }
  const out = new Uint8Array(w * h);
  if (best) for (const p of best) out[p] = 1;
  return out;
}

// Warmth-based skin-tone rule: bright, red dominant over blue, green in
// between. Loose on purpose so pale anime skin qualifies; warm clothing and
// hair also match, which the band statistics below sort out.
const skinTone = (r, g, b) => r > 100 && r >= g - 2 && r > b + 12 && r + g + b > 330;

// Locate the face as a ROW BAND rather than a connected blob: for each row in
// the upper part of the subject box, measure how many warm skin-tone pixels
// it has and how spread out they are. A face row is dense AND horizontally
// compact; a warm coat or bare torso row is wide. Scoring count against an
// absolute spread penalty makes narrow bands win, so the face beats clothing.
// Returns null when no row qualifies (stylized or unusually colored
// characters), in which case the caller falls back to the silhouette split.
function findFaceBox(img, mask, box) {
  const { data, w } = img;
  const rows = Math.round(box.h * 0.8);
  const count = new Array(rows).fill(0);
  const mean = new Array(rows).fill(0);
  const sd = new Array(rows).fill(0);
  const silWidth = new Array(rows).fill(0);
  for (let ry = 0; ry < rows; ry++) {
    const y = box.y + ry;
    let n = 0, sx = 0, sxx = 0;
    for (let x = box.x; x < box.x + box.w; x++) {
      const p = y * w + x;
      if (!mask[p]) continue;
      silWidth[ry]++;
      const i = p * 4;
      if (!skinTone(data[i], data[i + 1], data[i + 2])) continue;
      n++; sx += x; sxx += x * x;
    }
    count[ry] = n;
    if (n) {
      mean[ry] = sx / n;
      sd[ry] = Math.sqrt(Math.max(0, sxx / n - (sx / n) ** 2));
    }
  }
  // Smooth over +-2 rows, then score: dense and compact wins, with a mild
  // prior for the upper half of the box.
  const smooth = (arr, ry) => {
    let s = 0, n = 0;
    for (let d = -2; d <= 2; d++) if (ry + d >= 0 && ry + d < rows) { s += arr[ry + d]; n++; }
    return s / n;
  };
  let best = -1, bestScore = 0;
  const minCount = Math.max(6, box.w * 0.06);
  for (let ry = 0; ry < rows; ry++) {
    const c = smooth(count, ry);
    if (c < minCount) continue;
    // A face is narrower than the body silhouette at the same row. A row
    // whose warm pixels span most of the silhouette is clothing, not a face.
    if (c > smooth(silWidth, ry) * 0.5) continue;
    const spread = smooth(sd, ry);
    let score = c / (1 + Math.pow(spread, 1.4));
    score *= ry / box.h < 0.5 ? 1.15 : 0.85;
    if (score > bestScore) { bestScore = score; best = ry; }
  }
  if (best < 0) return null;
  // Width from the horizontal extent of warm pixels (about 4 standard
  // deviations), not the raw count: desaturated skin passes the tone rule
  // only in patches, but the patches still span the face.
  const extent = Math.max(smooth(count, best), 3.3 * smooth(sd, best));
  const faceW = Math.round(Math.min(Math.max(6, extent), smooth(silWidth, best) * 0.5));
  const faceH = Math.max(4, Math.min(Math.round(faceW * 1.25), Math.round(box.h * 0.55)));
  const cx = mean[best] || box.x + box.w / 2;
  return {
    x: Math.round(cx - faceW / 2),
    y: Math.max(box.y, Math.round(box.y + best - faceH / 2)),
    w: faceW,
    h: faceH,
  };
}

function maskBox(mask, w, h) {
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1, n = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (mask[y * w + x]) {
        n++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, n };
}

/**
 * Identify the character: foreground mask, bounding box, and the
 * head / torso / leg split. Exported for tests.
 */
export async function identifyCharacter(input) {
  const img = await loadScaled(input);
  const { w, h } = img;
  const pal = backgroundPalette(img);

  let mask = pal.keyable ? largestComponent(foregroundMask(img, pal), w, h) : null;
  let box = mask && maskBox(mask, w, h);
  const coverage = box ? box.n / (w * h) : 0;
  let method = 'border-key';

  if (!box || coverage < 0.02 || coverage > 0.9) {
    // Keying failed (busy photo background, or subject fills the frame).
    // Assume a centered subject.
    method = 'center-prior';
    box = {
      x: Math.round(w * 0.14),
      y: Math.round(h * 0.04),
      w: Math.round(w * 0.72),
      h: Math.round(h * 0.92),
    };
    mask = new Uint8Array(w * h);
    for (let y = box.y; y < box.y + box.h; y++)
      for (let x = box.x; x < box.x + box.w; x++) mask[y * w + x] = 1;
  }

  // Head placement. Preferred: anchor on a detected face, so big hair or
  // hats cannot push the face down into the torso. Fallback: silhouette
  // width profile (shoulder line).
  const face = findFaceBox(img, mask, box);
  let headH; // rows from box top to the chin line
  if (face) {
    const chin = Math.round(face.y + face.h * 1.05 - box.y);
    headH = Math.min(Math.max(chin, Math.round(box.h * 0.12)), box.h - 1);
  } else {
    // Silhouette width per row inside the box.
    const widths = new Array(box.h).fill(0);
    for (let ry = 0; ry < box.h; ry++)
      for (let x = box.x; x < box.x + box.w; x++)
        if (mask[(box.y + ry) * w + x]) widths[ry]++;

    // Head width estimate: median over the first rows.
    const headZone = widths.slice(0, Math.max(3, Math.round(box.h * 0.15))).filter((v) => v > 0);
    headZone.sort((a, b) => a - b);
    const headW = headZone[Math.floor(headZone.length / 2)] || box.w;

    // Shoulder line: first sustained widening past 1.35x head width.
    let shoulder = -1;
    const from = Math.round(box.h * 0.08);
    const to = Math.round(box.h * 0.65);
    for (let ry = from; ry < to - 2; ry++) {
      if (widths[ry] >= headW * 1.35 && widths[ry + 1] >= headW * 1.35 && widths[ry + 2] >= headW * 1.35) {
        shoulder = ry;
        break;
      }
    }
    headH = shoulder < 0
      ? Math.round(box.h * 0.6) // bust or selfie: no shoulders in the box
      : Math.min(Math.max(shoulder, Math.round(box.h * 0.12)), Math.round(box.h * 0.6));
  }

  const rest = box.h - headH;
  const hasLegs = rest >= headH * 1.6;
  const torsoEnd = hasLegs ? headH + Math.round(rest * 0.5) : box.h;

  const rowsBox = (ry0, ry1) => {
    let minX = Infinity, maxX = -1;
    for (let ry = ry0; ry < ry1; ry++)
      for (let x = box.x; x < box.x + box.w; x++)
        if (mask[(box.y + ry) * w + x]) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); }
    if (maxX < 0) { minX = box.x; maxX = box.x + box.w - 1; }
    return { x: minX, y: box.y + ry0, w: maxX - minX + 1, h: ry1 - ry0 };
  };

  // Head sample region: silhouette rows from a bounded hair-top down to the
  // chin, clamped around the face center so oversized hair cannot drown the
  // face. Without a detected face, the silhouette rows above the split.
  let head;
  if (face) {
    const y0r = Math.max(0, Math.round(face.y - 1.2 * face.h - box.y));
    const rb = rowsBox(y0r, headH);
    const cx = face.x + face.w / 2;
    const half = Math.round(face.w * 1.3);
    const x0 = Math.max(rb.x, Math.round(cx - half));
    const x1 = Math.min(rb.x + rb.w, Math.round(cx + half));
    head = { x: x0, y: rb.y, w: Math.max(1, x1 - x0), h: rb.h };
  } else {
    head = rowsBox(0, headH);
  }
  const torso = rowsBox(headH, torsoEnd);
  const legs = hasLegs ? rowsBox(torsoEnd, box.h) : null;
  return { img, mask, box, method, faceFound: !!face, head, torso, legs, hasLegs };
}

// --- sampling and painting ---------------------------------------------------

// Dominant-color grid sample of a masked region onto a face rect.
// Cells with no foreground stay transparent (layout enforcement fills them
// from the face average later).
function sampleFace(atlas, img, mask, region, rect, { mul = 1 } = {}) {
  const { data, w } = img;
  for (let cy = 0; cy < rect.h; cy++) {
    for (let cx = 0; cx < rect.w; cx++) {
      const px0 = region.x + Math.floor((cx * region.w) / rect.w);
      const px1 = Math.max(px0 + 1, region.x + Math.floor(((cx + 1) * region.w) / rect.w));
      const py0 = region.y + Math.floor((cy * region.h) / rect.h);
      const py1 = Math.max(py0 + 1, region.y + Math.floor(((cy + 1) * region.h) / rect.h));
      const buckets = new Map();
      for (let y = py0; y < py1; y++) {
        for (let x = px0; x < px1; x++) {
          if (!mask[y * w + x]) continue;
          const i = (y * w + x) * 4;
          const key = `${data[i] >> 4},${data[i + 1] >> 4},${data[i + 2] >> 4}`;
          let b = buckets.get(key);
          if (!b) buckets.set(key, (b = { n: 0, r: 0, g: 0, b: 0 }));
          b.n++; b.r += data[i]; b.g += data[i + 1]; b.b += data[i + 2];
        }
      }
      let best = null;
      for (const b of buckets.values()) if (!best || b.n > best.n) best = b;
      const o = AIDX(rect.x + cx, rect.y + cy);
      if (!best) { atlas[o + 3] = 0; continue; }
      atlas[o] = clamp((best.r / best.n) * mul);
      atlas[o + 1] = clamp((best.g / best.n) * mul);
      atlas[o + 2] = clamp((best.b / best.n) * mul);
      atlas[o + 3] = 255;
    }
  }
}

// Copy a front face onto the same-size back face, darkened.
function copyFace(atlas, src, dst, mul) {
  for (let y = 0; y < dst.h; y++) {
    for (let x = 0; x < dst.w; x++) {
      const s = AIDX(src.x + Math.min(x, src.w - 1), src.y + Math.min(y, src.h - 1));
      const d = AIDX(dst.x + x, dst.y + y);
      atlas[d] = clamp(atlas[s] * mul);
      atlas[d + 1] = clamp(atlas[s + 1] * mul);
      atlas[d + 2] = clamp(atlas[s + 2] * mul);
      atlas[d + 3] = atlas[s + 3];
    }
  }
}

// Dominant color over the whole mask, as a backstop for faces that sampled
// completely empty.
function globalDominant(img, mask) {
  const { data, w, h } = img;
  const buckets = new Map();
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      const i = (y * w + x) * 4;
      const key = `${data[i] >> 4},${data[i + 1] >> 4},${data[i + 2] >> 4}`;
      let b = buckets.get(key);
      if (!b) buckets.set(key, (b = { n: 0, r: 0, g: 0, b: 0 }));
      b.n++; b.r += data[i]; b.g += data[i + 1]; b.b += data[i + 2];
    }
  let best = null;
  for (const b of buckets.values()) if (!best || b.n > best.n) best = b;
  return best ? [best.r / best.n, best.g / best.n, best.b / best.n].map(Math.round) : [128, 128, 128];
}

function faceEmpty(atlas, rect) {
  for (let y = 0; y < rect.h; y++)
    for (let x = 0; x < rect.w; x++)
      if (atlas[AIDX(rect.x + x, rect.y + y) + 3]) return false;
  return true;
}

function flatFill(atlas, rect, color) {
  for (let y = 0; y < rect.h; y++)
    for (let x = 0; x < rect.w; x++) {
      const i = AIDX(rect.x + x, rect.y + y);
      atlas[i] = clamp(color[0]);
      atlas[i + 1] = clamp(color[1]);
      atlas[i + 2] = clamp(color[2]);
      atlas[i + 3] = 255;
    }
}

function px(atlas, rect, x, y, color) {
  const i = AIDX(rect.x + x, rect.y + y);
  atlas[i] = clamp(color[0]);
  atlas[i + 1] = clamp(color[1]);
  atlas[i + 2] = clamp(color[2]);
  atlas[i + 3] = 255;
}

const sub = (region, x0, x1, y0, y1) => ({
  x: region.x + Math.floor(region.w * x0),
  y: region.y + Math.floor(region.h * y0),
  w: Math.max(1, Math.floor(region.w * (x1 - x0))),
  h: Math.max(1, Math.floor(region.h * (y1 - y0))),
});

/**
 * Paint a valid 64x64 skin atlas by mapping the identified character regions
 * onto the skin faces. Overlay layer is left fully transparent.
 */
export async function fallbackAtlas(characterImage, { variant = 'classic' } = {}) {
  const { img, mask, head, torso, legs, hasLegs } = await identifyCharacter(characterImage);
  const P = parts(variant);
  const atlas = Buffer.alloc(SKIN_SIZE * SKIN_SIZE * 4);
  const backstop = globalDominant(img, mask);

  // Head front: sampled straight from the head region, so hair, face, and
  // accessories land roughly where they belong.
  sampleFace(atlas, img, mask, head, P.head.base.front);

  // Torso: middle 64% is the body, the outer strips are the arms hanging at
  // the sides. Image-left maps to the character's RIGHT limb (mirror view).
  const core = sub(torso, 0.18, 0.82, 0, 1);
  const rightStrip = sub(torso, 0, 0.18, 0.05, 1);
  const leftStrip = sub(torso, 0.82, 1, 0.05, 1);
  sampleFace(atlas, img, mask, core, P.body.base.front);
  sampleFace(atlas, img, mask, rightStrip, P.rightArm.base.front);
  sampleFace(atlas, img, mask, leftStrip, P.leftArm.base.front);

  // Legs: split the leg region into the two legs; without legs in the image,
  // continue the lower torso downward, darkened.
  const legSrc = hasLegs ? legs : sub(torso, 0.15, 0.85, 0.55, 1);
  const legMul = hasLegs ? 1 : 0.75;
  sampleFace(atlas, img, mask, sub(legSrc, 0, 0.5, 0, 1), P.rightLeg.base.front, { mul: legMul });
  sampleFace(atlas, img, mask, sub(legSrc, 0.5, 1, 0, 1), P.leftLeg.base.front, { mul: legMul });

  // Backstop: a face that sampled entirely empty gets the character's
  // dominant color instead of ending up black.
  const fills = [
    [P.head, 1], [P.body, 0.95],
    [P.rightArm, 0.9], [P.leftArm, 0.9],
    [P.rightLeg, 0.8], [P.leftLeg, 0.8],
  ];
  for (const [part, f] of fills)
    if (faceEmpty(atlas, part.base.front)) flatFill(atlas, part.base.front, darken(backstop, f));

  // Unseen faces: back is a darkened copy of the front; sides, tops, and
  // bottoms are synthesized from the front edges like the panel mapper does.
  for (const [name, part] of Object.entries(P)) {
    const f = part.base.front;
    copyFace(atlas, f, part.base.back, 0.88);
    synthSide(atlas, f, 0, part.base.right, { darken: 0.85 });
    synthSide(atlas, f, f.w - 1, part.base.left, { darken: 0.85 });
    synthCap(atlas, f, 0, part.base.top, { darken: name === 'head' ? 0.95 : 0.8 });
    synthCap(atlas, f, f.h - 1, part.base.bottom, { darken: 0.7 });
  }

  // Fixed facial pixels stamped over the sampled face: eye whites, pupils,
  // and a mouth, so the head always reads as a face.
  const H = P.head.base.front;
  const chin = [atlas[AIDX(H.x + 3, H.y + 6)], atlas[AIDX(H.x + 3, H.y + 6) + 1], atlas[AIDX(H.x + 3, H.y + 6) + 2]];
  px(atlas, H, 1, 5, [245, 245, 245]);
  px(atlas, H, 6, 5, [245, 245, 245]);
  px(atlas, H, 2, 5, [38, 38, 48]);
  px(atlas, H, 5, 5, [38, 38, 48]);
  px(atlas, H, 3, 7, darken(chin, 0.55));
  px(atlas, H, 4, 7, darken(chin, 0.55));

  return atlas;
}
