// Fallback branch test, no API needed: the deterministic no-LLM painter must
// produce a structurally valid skin, and running it twice on the same input
// must produce byte-identical output.
import { readFile } from 'node:fs/promises';
import { characterToSkin } from '../src/pipeline.js';

const SRC = new URL('../examples/sui-input.png', import.meta.url).pathname;

const r1 = await characterToSkin(SRC, 'out/fallback-a.png', { branch: 'fallback' });
const r2 = await characterToSkin(SRC, 'out/fallback-b.png', { branch: 'fallback' });
console.log('pipeline result:', JSON.stringify(r1, null, 2));

const [a, b] = await Promise.all([readFile('out/fallback-a.png'), readFile('out/fallback-b.png')]);
const deterministic = a.equals(b);
console.log(`valid=${r1.valid} deterministic=${deterministic} branch=${r1.branch}`);

const pass = r1.valid && r2.valid && deterministic && r1.branch === 'fallback';
console.log(pass ? 'FALLBACK: PASS' : 'FALLBACK: FAIL');
process.exit(pass ? 0 : 1);
