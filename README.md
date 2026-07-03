# skin-gen

Lightweight character-image → Minecraft-skin pipeline. Any character image in,
valid 64x64 skin PNG out.

```
character image
  → Nano Banana Pro (gemini-3-pro-image)
      Branch A "atlas" (default): model emits the flat UV atlas directly,
        with a real skin (assets/steve512.png) attached as layout reference
      Branch B "panel" (fallback): model emits a canonical front+back
        dual-panel render → deterministic panel→atlas projection
  → dominant-color downsample (8x cells → 64x64, modal color per cell)
  → layout enforcement (whitespace transparent, base opaque, overlay
      background-keyed transparent)
  → validate → skin.png + preview render
```

## Usage

```sh
# .env must contain GEMINI_API_KEY
set -a && source .env && set +a

node src/pipeline.js tests/inputs/sui.png out/sui-skin.png                 # Branch A
node src/pipeline.js tests/inputs/sui.png out/sui-skin.png --branch panel  # Branch B
node src/pipeline.js in.png out.png --variant slim                         # 3px arms
node src/pipeline.js unused out.png --mock some-atlas.png                  # skip API

node src/validate.js out/sui-skin.png            # layout validity check
node probe/probe-atlas.js tests/inputs/sui.png out/probe 3   # consistency probe
```

## Tests (no API needed)

```sh
node tests/mock-test.js        # Branch A chain: degraded real skin -> reconstruction
node tests/panel-roundtrip.js  # Branch B chain: rendered panel -> atlas round-trip
```

Both must PASS. mock-test reconstructs a real skin from a blurred/noised 8x
atlas with ≤2% pixel error; panel-roundtrip requires exact front/back face
recovery.

## Modules

| file | role |
|---|---|
| `src/layout.js` | 64x64 UV layout computed from box-unwrap geometry (classic + slim) |
| `src/gemini.js` | minimal REST client for Gemini image models |
| `src/prompts.js` | ATLAS_PROMPT (Branch A), PANEL_PROMPT (Branch B) |
| `src/downsample.js` | dominant-color (modal bucket) downsampler |
| `src/panelmap.js` | front+back panel → atlas projection, synthesizes side/top/bottom faces |
| `src/enforce.js` | whitespace/base/overlay alpha enforcement, flat-face detection |
| `src/render.js` | front/back preview renderer (pure JS blit) |
| `src/validate.js` | structural validity check |

## Design notes

See `references/NOTES.md` — Monadical SDXL post-processing (transparency
restore via background-distance keying, whitespace mask) and BLOCK's bi-stage
canonicalize-then-translate design informed both branches.

Status: deterministic chain fully tested; live Gemini validation pending
API credits (prepay depleted 2026-07-03; poller in place).
