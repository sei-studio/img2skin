// Prompt templates for Nano Banana Pro.

// Branch A: direct flat UV atlas, with a real skin atlas as layout reference.
export const ATLAS_PROMPT = `TASK: Create a Minecraft player skin texture atlas for the character shown in the SECOND image.

The FIRST image is a real Minecraft skin texture atlas (64x64 format, shown upscaled 8x to 512x512). Use it as an exact LAYOUT REFERENCE: your output must place every body-part region in exactly the same position as the reference — head faces in the top-left block, hat/overlay layer in the top-right block, right leg / body / right arm in the middle band, left leg / left arm and their overlays in the bottom band.

OUTPUT REQUIREMENTS:
- A single flat 2D texture atlas. NOT a 3D character render, NOT a character preview, no mannequin. No text, no labels, no grid lines, no borders.
- Same layout as the reference: wherever the reference has background, output background; wherever the reference has a textured body-part face, output the character's corresponding texture.
- Background (unused areas): solid pure black #000000.
- Blocky pixel-art style with hard square edges, as if a 64x64 image were upscaled with nearest-neighbor. No gradients, no anti-aliasing.
- Texture content: the character's face on the head front face; their hair color and style on the head top/sides/back and on the hat layer; their clothing on the body and arms; lower clothing and footwear on the legs.
- Classic 4-pixel-wide arms. Keep colors flat and consistent.`;

// Branch B stage 1: canonical dual-panel preview (BLOCK-style), used if the
// direct-atlas branch proves inconsistent.
export const PANEL_PROMPT = `TASK: Render the character from the image as a Minecraft player character (blocky, cubic limbs, pixel-art texture), shown as TWO full-body orthographic views side by side on a plain white background: FRONT view on the left half, BACK view on the right half.

STRICT LAYOUT: square image; each view centered in its half; character standing straight, arms at sides, legs together; head top at 5% image height, feet at 95%; no shadows, no props, no text, no ground.

The character's face, hair, clothing and colors must match the input character faithfully, translated into Minecraft pixel-art style.`;
