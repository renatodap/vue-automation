# Room map assets

The spatial map's background. A top-down plan of the living room, generated from
photographs of the real room and shipped as a **static bundle asset** — no API
key in the app, no per-launch cost.

```
room-plate-dark.png   the plate itself, 896×1200, dark theme
lamp-placement.svg    the plate with the four lamps marked; open in a browser
orimg.py              the generator, for when the furniture moves
```

## What is in the image and what is not

**In:** sofa and chaise, side table, ladder shelf, round table, rug, ottoman, TV
console with television and soundbar, framed picture, L-shaped desk with two
monitors and chair, digital piano, four wall-hung instruments, window, glass
door, entry door, oak flooring.

**Deliberately not in: any lamp, any light fixture, any glow.** Every
state-bearing pixel is drawn live in SwiftUI on top of this plate, tinted from
the lamp's real `color_temp_kelvin` or `hs_color`, with a glow radius tracking
brightness. Baking light into the image would mean the picture and the room
disagreeing the moment anything changed — the same failure as invariant #3.

## Lamp placement

Normalized `(x, y)` over the plate, read off the wide photo. These seed
`lamp_placement`; the in-app editor is what corrects them.

| Entity | x | y | Where |
|---|---|---|---|
| `light.abajour` | 0.215 | 0.795 | side table, near end of the sofa |
| `light.floor_lamp` | 0.215 | 0.445 | arc lamp head, over the sofa |
| `light.shelf_lamp` | 0.185 | 0.235 | on the ladder shelf |
| `light.0x7cb94c68286a0000` | 0.790 | 0.455 | far side of the TV — **entity still unnamed** |

## Regenerating

`orimg.py` posts to OpenRouter's `POST /api/v1/images` and reads
`OPENROUTER_API_KEY` from the environment. It never writes the key anywhere.

```bash
export OPENROUTER_API_KEY=...        # not in this repo, not in .env
python3 orimg.py --model google/gemini-3-pro-image \
  --ref room-plate-dark.png \
  --prompt "Edit the supplied floor plan. Keep everything identical except …" \
  --out room-plate-dark.png
```

Model was `google/gemini-3-pro-image` (Nano Banana Pro), ~$0.14 per image.
`google/gemini-3.1-flash-image` (Nano Banana 2) is ~half that and good enough
for style probes.

**Editing beats regenerating.** Passing the current plate as `--ref` and
describing only what changes preserves the rest; regenerating from the prompt
re-rolls the whole composition.

## The constraint that decided the approach

**Google's image models cannot output an alpha channel.** Asking for a
transparent background yields flat white, flat black, or a *painted*
checkerboard. That rules out cut-out furniture sprites, which is why this is one
full-bleed plate rather than a sprite sheet. Recovering alpha is possible —
render the same subject on white and on black and difference them — but it is
not worth it for a background that never needs to be composited.

Output also carries an invisible SynthID watermark.

## Light mode

Not generated yet. When it is, it must be a **separate plate**, not a filter:
the plan reads as a lit room from above, and inverting it produces mud. Same
prompt, with the palette clause swapped for warm off-whites and the background
set to `#f6f4ef`.
