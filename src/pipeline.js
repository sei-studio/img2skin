// Character image -> valid Minecraft skin.
// Usage:
//   node src/pipeline.js <characterImage> <outSkin.png> [--variant classic|slim]
//                        [--mock <atlasImage>] [--keep-raw]
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { generateImage } from './gemini.js';
import { ATLAS_PROMPT } from './prompts.js';
import { downsampleToSkin, writeSkinPng } from './downsample.js';
import { enforceLayout, flatBaseFaces } from './enforce.js';
import { renderPreview } from './render.js';
import { validateSkin } from './validate.js';

const REFERENCE_ATLAS = new URL('../assets/steve512.png', import.meta.url).pathname;

export async function characterToSkin(characterImage, outSkin, opts = {}) {
  const { variant = 'classic', mockAtlas = null, keepRaw = false } = opts;
  const rawOut = outSkin.replace(/\.png$/, '.raw-atlas.png');

  let atlasInput;
  if (mockAtlas) {
    atlasInput = mockAtlas;
  } else {
    const [buf] = await generateImage({
      prompt: ATLAS_PROMPT,
      images: [REFERENCE_ATLAS, characterImage],
    });
    await writeFile(rawOut, buf);
    atlasInput = rawOut;
  }

  const raw = await downsampleToSkin(atlasInput);
  const flat = flatBaseFaces(raw, { variant });
  const skin = enforceLayout(raw, { variant });
  await writeSkinPng(skin, outSkin);

  const problems = await validateSkin(outSkin, variant);
  const previewOut = outSkin.replace(/\.png$/, '.preview.png');
  await renderPreview(skin, previewOut, { variant });

  if (!keepRaw && !mockAtlas) {
    // keep raw atlas around by default only when debugging
  }
  return {
    skin: outSkin,
    preview: previewOut,
    rawAtlas: mockAtlas ? null : rawOut,
    flatBaseFaces: flat,
    valid:
      problems.transparentBase.length === 0 &&
      problems.opaqueWhitespace.length === 0,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const pos = args.filter((a) => !a.startsWith('--'));
  const flag = (name) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const [characterImage, outSkin] = pos;
  if (!characterImage || !outSkin) {
    console.error('usage: node src/pipeline.js <characterImage> <outSkin.png> [--variant classic|slim] [--mock <atlasImage>]');
    process.exit(1);
  }
  const res = await characterToSkin(path.resolve(characterImage), path.resolve(outSkin), {
    variant: flag('variant') ?? 'classic',
    mockAtlas: flag('mock') ? path.resolve(flag('mock')) : null,
    keepRaw: args.includes('--keep-raw'),
  });
  console.log(JSON.stringify(res, null, 2));
}
