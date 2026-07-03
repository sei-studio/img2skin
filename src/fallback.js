// Deterministic no-LLM fallback: locate the character in the input image,
// extract its primary colors (hair, face, torso, legs), and paint a simple
// but always-valid skin with fixed pixels for eyes and mouth.
// No API calls, no randomness: the same input image always produces a
// byte-identical skin. Used as the automatic backup when generation fails,
// or explicitly via --branch fallback.
import { SKIN_SIZE, parts } from './layout.js';
import { loadRaw, borderBackground, isForeground, bbox } from './panelmap.js';

const AIDX = (x, y) => (y * SKIN_SIZE + x) * 4;
const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
const darken = (c, f) => c.map((v) => clamp(v * f));

// Deterministic per-pixel brightness jitter so faces read as texture, not
// flat fills. Pure function of atlas coordinates.
const jitter = (x, y) => 1 + ((((x * 31 + y * 17) % 7) - 3) * 0.02);

// Dominant color (modal 4-bit bucket) among foreground pixels of a region.
function dominantColor(img, region, bg) {
  const { data, w } = img;
  const buckets = new Map();
  for (let y = region.y; y < region.y + region.h; y++) {
    for (let x = region.x; x < region.x + region.w; x++) {
      if (!isForeground(data, w, x, y, bg)) continue;
      const i = (y * w + x) * 4;
      const key = `${data[i] >> 4},${data[i + 1] >> 4},${data[i + 2] >> 4}`;
      let b = buckets.get(key);
      if (!b) buckets.set(key, (b = { n: 0, r: 0, g: 0, b: 0 }));
      b.n++; b.r += data[i]; b.g += data[i + 1]; b.b += data[i + 2];
    }
  }
  let best = null;
  for (const b of buckets.values()) if (!best || b.n > best.n) best = b;
  if (!best) return null;
  return [best.r / best.n, best.g / best.n, best.b / best.n].map(Math.round);
}

// Extract the character's primary palette from the image.
// Full-body inputs (tall bbox) split into head/torso/leg bands; portraits
// take hair from the top, face from the center, torso from the bottom and
// derive the leg color by darkening the torso.
export async function extractPalette(characterImage) {
  const img = await loadRaw(characterImage);
  const bg = borderBackground(img);
  let box;
  try {
    box = bbox(img, 0, img.w, bg);
  } catch {
    box = { x: 0, y: 0, w: img.w, h: img.h };
  }
  if (box.w * box.h < img.w * img.h * 0.02) box = { x: 0, y: 0, w: img.w, h: img.h };

  const region = (x0, x1, y0, y1) => ({
    x: box.x + Math.floor(box.w * x0),
    y: box.y + Math.floor(box.h * y0),
    w: Math.max(1, Math.floor(box.w * (x1 - x0))),
    h: Math.max(1, Math.floor(box.h * (y1 - y0))),
  });

  const fullBody = box.h / box.w >= 1.5;
  const hairR = fullBody ? region(0.25, 0.75, 0, 0.1) : region(0.2, 0.8, 0, 0.2);
  const faceR = fullBody ? region(0.35, 0.65, 0.08, 0.25) : region(0.3, 0.7, 0.22, 0.5);
  const torsoR = fullBody ? region(0.15, 0.85, 0.3, 0.6) : region(0.1, 0.9, 0.6, 1);
  const legR = fullBody ? region(0.25, 0.75, 0.62, 0.95) : null;

  const DEFAULTS = { hair: [82, 60, 43], skin: [206, 165, 128], shirt: [92, 120, 158] };
  const hair = dominantColor(img, hairR, bg) ?? DEFAULTS.hair;
  const skin = dominantColor(img, faceR, bg) ?? DEFAULTS.skin;
  const shirt = dominantColor(img, torsoR, bg) ?? DEFAULTS.shirt;
  const pants = (legR && dominantColor(img, legR, bg)) ?? darken(shirt, 0.6);
  return { hair, skin, shirt, pants, fullBody };
}

function fill(atlas, rect, color, mul = 1) {
  for (let y = 0; y < rect.h; y++) {
    for (let x = 0; x < rect.w; x++) {
      const i = AIDX(rect.x + x, rect.y + y);
      const j = jitter(rect.x + x, rect.y + y) * mul;
      atlas[i] = clamp(color[0] * j);
      atlas[i + 1] = clamp(color[1] * j);
      atlas[i + 2] = clamp(color[2] * j);
      atlas[i + 3] = 255;
    }
  }
}

function px(atlas, rect, x, y, color) {
  const i = AIDX(rect.x + x, rect.y + y);
  atlas[i] = clamp(color[0]);
  atlas[i + 1] = clamp(color[1]);
  atlas[i + 2] = clamp(color[2]);
  atlas[i + 3] = 255;
}

/**
 * Paint a valid 64x64 skin atlas from the input image's palette.
 * Overlay layer is left fully transparent.
 */
export async function fallbackAtlas(characterImage, { variant = 'classic' } = {}) {
  const { hair, skin, shirt, pants } = await extractPalette(characterImage);
  const P = parts(variant);
  const atlas = Buffer.alloc(SKIN_SIZE * SKIN_SIZE * 4);

  // Head: hair everywhere except the face and the neck bottom.
  const H = P.head.base;
  fill(atlas, H.top, hair, 0.95);
  fill(atlas, H.back, hair, 0.92);
  fill(atlas, H.right, hair, 0.85);
  fill(atlas, H.left, hair, 0.85);
  fill(atlas, H.bottom, skin, 0.7);
  fill(atlas, H.front, skin);
  for (let y = 0; y < 3; y++)
    for (let x = 0; x < H.front.w; x++) px(atlas, H.front, x, y, hair); // fringe
  // Fixed facial pixels: eye whites, pupils, mouth.
  const white = [245, 245, 245];
  const pupil = [38, 38, 48];
  px(atlas, H.front, 1, 5, white);
  px(atlas, H.front, 6, 5, white);
  px(atlas, H.front, 2, 5, pupil);
  px(atlas, H.front, 5, 5, pupil);
  px(atlas, H.front, 3, 7, darken(skin, 0.55)); // mouth
  px(atlas, H.front, 4, 7, darken(skin, 0.55));

  // Body: shirt.
  const B = P.body.base;
  fill(atlas, B.front, shirt);
  fill(atlas, B.back, shirt, 0.92);
  fill(atlas, B.right, shirt, 0.85);
  fill(atlas, B.left, shirt, 0.85);
  fill(atlas, B.top, shirt, 0.9);
  fill(atlas, B.bottom, shirt, 0.7);

  // Arms: sleeves for the top half, skin below.
  for (const arm of [P.rightArm, P.leftArm]) {
    const A = arm.base;
    for (const [face, mul] of [['front', 1], ['back', 0.92], ['right', 0.85], ['left', 0.85]]) {
      const r = A[face];
      const sleeve = { ...r, h: 6 };
      const bare = { ...r, y: r.y + 6, h: r.h - 6 };
      fill(atlas, sleeve, shirt, mul);
      fill(atlas, bare, skin, mul);
    }
    fill(atlas, A.top, shirt, 0.9);
    fill(atlas, A.bottom, skin, 0.75);
  }

  // Legs: pants with darker shoes on the last two rows.
  const shoe = darken(pants, 0.5);
  for (const leg of [P.rightLeg, P.leftLeg]) {
    const L = leg.base;
    for (const [face, mul] of [['front', 1], ['back', 0.92], ['right', 0.85], ['left', 0.85]]) {
      const r = L[face];
      fill(atlas, { ...r, h: r.h - 2 }, pants, mul);
      fill(atlas, { ...r, y: r.y + r.h - 2, h: 2 }, shoe, mul);
    }
    fill(atlas, L.top, pants, 0.9);
    fill(atlas, L.bottom, shoe, 0.9);
  }

  return atlas;
}
