/**
 * Generates the PWA icon set from one vector source.
 *
 * Run: node scripts/generate-icons.mjs
 *
 * Three separate files, because the roles genuinely differ:
 *   - any (192/512): edge-to-edge, used as-is.
 *   - maskable (512): Android crops it to whatever shape the launcher wants,
 *     so everything meaningful stays inside the centre 80%.
 *   - apple-touch (180): iOS ignores the manifest entirely AND composites
 *     white behind any transparency, so this one is opaque by construction.
 */
import sharp from "sharp";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

const BG = "#14120e";
const GLOW_OUTER = "#8a5f1e";
const GLOW_MID = "#e8a54d";
const GLOW_CORE = "#fff0d2";

/** A lamp seen head-on: a warm core bleeding into the dark. */
function svg(size, inset) {
  const c = size / 2;
  // `inset` shrinks the artwork for the maskable variant's safe zone.
  const r = (size / 2) * inset;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <radialGradient id="g" cx="50%" cy="50%" r="50%">
      <stop offset="0%"   stop-color="${GLOW_CORE}"/>
      <stop offset="34%"  stop-color="${GLOW_MID}"/>
      <stop offset="66%"  stop-color="${GLOW_OUTER}"/>
      <stop offset="100%" stop-color="${BG}"/>
    </radialGradient>
  </defs>
  <rect width="${size}" height="${size}" fill="${BG}"/>
  <circle cx="${c}" cy="${c}" r="${r * 0.92}" fill="url(#g)"/>
  <circle cx="${c}" cy="${c}" r="${r * 0.30}" fill="${GLOW_CORE}"/>
</svg>`;
}

async function write(name, size, inset) {
  const buffer = Buffer.from(svg(size, inset));
  await sharp(buffer).png().toFile(join(PUBLIC, name));
  console.log(`  ${name}  ${size}×${size}`);
}

await mkdir(PUBLIC, { recursive: true });
console.log("Generating icons:");
await write("icon-192.png", 192, 0.86);
await write("icon-512.png", 512, 0.86);
// Centre 80% only — launcher masks bite into the edges.
await write("icon-512-maskable.png", 512, 0.62);
await write("apple-touch-icon.png", 180, 0.86);
console.log("Done.");
