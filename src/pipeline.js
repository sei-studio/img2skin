// Character image -> valid Minecraft skin.
// Usage:
//   node src/pipeline.js <characterImage> <outSkin.png> [--variant classic|slim]
//                        [--mock <atlasImage>] [--keep-raw]
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { generateImage } from './gemini.js';
import { ATLAS_PROMPT, PANEL_PROMPT } from './prompts.js';
import { downsampleToSkin, writeSkinPng } from './downsample.js';
import { panelToAtlas } from './panelmap.js';
import { enforceLayout, flatBaseFaces } from './enforce.js';
import { renderPreview } from './render.js';
import { validateSkin } from './validate.js';

const REFERENCE_ATLAS = new URL('../assets/steve512.png', import.meta.url).pathname;

export async function characterToSkin(characterImage, outSkin, opts = {}) {
  const {
    variant = 'classic',
    branch = 'atlas', // 'atlas' (Branch A) | 'panel' (Branch B)
    mockAtlas = null, // pre-made generator output; skips the API call
    keepRaw = false,
  } = opts;
  const rawOut = outSkin.replace(/\.png$/, `.raw-${branch}.png`);

  let genOutput;
  if (mockAtlas) {
    genOutput = mockAtlas;
  } else {
    const [buf] = await generateImage({
      prompt: branch === 'panel' ? PANEL_PROMPT : ATLAS_PROMPT,
      images: branch === 'panel' ? [characterImage] : [REFERENCE_ATLAS, characterImage],
    });
    await writeFile(rawOut, buf);
    genOutput = rawOut;
  }

  const raw =
    branch === 'panel'
      ? await panelToAtlas(genOutput, { variant })
      : await downsampleToSkin(genOutput);
  const flat = flatBaseFaces(raw, { variant });
  const skin = enforceLayout(raw, { variant });
  await writeSkinPng(skin, outSkin);

  const problems = await validateSkin(outSkin, variant);
  const previewOut = outSkin.replace(/\.png$/, '.preview.png');
  await renderPreview(skin, previewOut, { variant });

  void keepRaw;
  return {
    skin: outSkin,
    preview: previewOut,
    branch,
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
    console.error('usage: node src/pipeline.js <characterImage> <outSkin.png> [--variant classic|slim] [--branch atlas|panel] [--mock <generatorOutput>]');
    process.exit(1);
  }
  const res = await characterToSkin(path.resolve(characterImage), path.resolve(outSkin), {
    variant: flag('variant') ?? 'classic',
    branch: flag('branch') ?? 'atlas',
    mockAtlas: flag('mock') ? path.resolve(flag('mock')) : null,
    keepRaw: args.includes('--keep-raw'),
  });
  console.log(JSON.stringify(res, null, 2));
}
