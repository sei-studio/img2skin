// Fallback branch tests, no API needed.
//  1. Determinism + validity on a real bust image.
//  2. Full-body figure on a solid background: head/torso/leg colors must land
//     on the right skin faces (red head, green torso, blue legs).
//  3. Selfie-like photo: busy noise background (border keying impossible),
//     large centered face; must still produce a valid skin deterministically.
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { characterToSkin } from '../src/pipeline.js';
import { fallbackAtlas, identifyCharacter } from '../src/fallback.js';
import { parts } from '../src/layout.js';
import { SKIN_SIZE } from '../src/layout.js';

const BUST = new URL('../examples/sui-input.png', import.meta.url).pathname;
const AIDX = (x, y) => (y * SKIN_SIZE + x) * 4;
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok' : 'FAIL'} - ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures++;
};

// --- deterministic synthetic fixtures ---------------------------------------

function rgbaCanvas(w, h, fill) {
  const buf = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b] = fill(x, y);
      const i = (y * w + x) * 4;
      buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255;
    }
  return buf;
}

const inRect = (x, y, x0, x1, y0, y1) => x >= x0 && x < x1 && y >= y0 && y < y1;

async function makeFullBody(path) {
  const w = 200, h = 400;
  const buf = rgbaCanvas(w, h, (x, y) => {
    if (inRect(x, y, 80, 120, 30, 80)) return [200, 40, 40]; // head: red
    if (inRect(x, y, 55, 145, 80, 215)) return [40, 170, 60]; // torso+arms: green
    if (inRect(x, y, 70, 130, 215, 380)) return [40, 70, 200]; // legs: blue
    return [232, 232, 236]; // solid light background
  });
  await sharp(buf, { raw: { width: w, height: h, channels: 4 } }).png().toFile(path);
}

async function makeSelfie(path) {
  const w = 300, h = 400;
  const noise = (x, y, s) => (x * 73 + y * 151 + s * 37) % 256; // deterministic
  const buf = rgbaCanvas(w, h, (x, y) => {
    // centered face ellipse
    const fx = (x - 150) / 95, fy = (y - 160) / 120;
    if (fx * fx + fy * fy <= 1) {
      if (y < 90) return [72, 52, 36]; // hair
      return [224, 178, 140]; // skin
    }
    if (inRect(x, y, 55, 245, 290, 400)) return [120, 60, 160]; // purple shirt
    return [noise(x, y, 1), noise(x, y, 2), noise(x, y, 3)]; // busy background
  });
  await sharp(buf, { raw: { width: w, height: h, channels: 4 } }).png().toFile(path);
}

function faceMean(atlas, rect) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = 0; y < rect.h; y++)
    for (let x = 0; x < rect.w; x++) {
      const i = AIDX(rect.x + x, rect.y + y);
      if (!atlas[i + 3]) continue;
      r += atlas[i]; g += atlas[i + 1]; b += atlas[i + 2]; n++;
    }
  return n ? [r / n, g / n, b / n] : [0, 0, 0];
}

// --- 1. real bust image: valid + byte-identical ------------------------------

const r1 = await characterToSkin(BUST, 'out/fallback-a.png', { branch: 'fallback' });
const r2 = await characterToSkin(BUST, 'out/fallback-b.png', { branch: 'fallback' });
const [a, b] = await Promise.all([readFile('out/fallback-a.png'), readFile('out/fallback-b.png')]);
check('bust: valid skin', r1.valid && r2.valid);
check('bust: deterministic', a.equals(b));
check('bust: fallback branch reported', r1.branch === 'fallback');

// --- 2. full body on solid background: region mapping ------------------------

await makeFullBody('out/fixture-fullbody.png');
const id = await identifyCharacter('out/fixture-fullbody.png');
check('fullbody: border keying used', id.method === 'border-key', id.method);
check('fullbody: legs detected', id.hasLegs);

const P = parts('classic');
const atlas = await fallbackAtlas('out/fixture-fullbody.png');
const headC = faceMean(atlas, P.head.base.front);
const bodyC = faceMean(atlas, P.body.base.front);
const legC = faceMean(atlas, P.rightLeg.base.front);
check('fullbody: head face is red', headC[0] > headC[1] && headC[0] > headC[2], headC.map(Math.round).join(','));
check('fullbody: body face is green', bodyC[1] > bodyC[0] && bodyC[1] > bodyC[2], bodyC.map(Math.round).join(','));
check('fullbody: leg face is blue', legC[2] > legC[0] && legC[2] > legC[1], legC.map(Math.round).join(','));

// --- 3. selfie with busy background: still valid + deterministic -------------

await makeSelfie('out/fixture-selfie.png');
const s1 = await characterToSkin('out/fixture-selfie.png', 'out/fallback-selfie.png', { branch: 'fallback' });
const s2 = await characterToSkin('out/fixture-selfie.png', 'out/fallback-selfie2.png', { branch: 'fallback' });
const [sa, sb] = await Promise.all([readFile('out/fallback-selfie.png'), readFile('out/fallback-selfie2.png')]);
check('selfie: valid skin', s1.valid && s2.valid);
check('selfie: deterministic', sa.equals(sb));
const sid = await identifyCharacter('out/fixture-selfie.png');
check('selfie: no legs invented', !sid.hasLegs);

console.log(failures === 0 ? 'FALLBACK: PASS' : `FALLBACK: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
