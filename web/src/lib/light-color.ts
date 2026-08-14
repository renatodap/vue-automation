import type { LampView } from "./types";

/**
 * What a lamp actually looks like, as CSS colour.
 *
 * Load-bearing rather than decorative: the room map draws each lamp in its own
 * colour, so this is the difference between the screen showing the room and the
 * screen showing four identical dots. Ported from ios/Sources/VueCore —
 * both surfaces must tint the same lamp the same way.
 */

export type Rgb = [number, number, number];

const clamp255 = (v: number) => Math.min(255, Math.max(0, v));

/**
 * Colour temperature to RGB — Tanner Helland's piecewise fit to the Planckian
 * locus. An approximation, and the right kind: smooth, monotonic, and visually
 * correct across the whole range. Nobody is matching a swatch here, they are
 * recognising "that lamp is the warm one".
 */
export function rgbFromKelvin(kelvin: number): Rgb {
  const t = Math.min(40_000, Math.max(1_000, kelvin)) / 100;

  let r: number;
  let g: number;
  let b: number;

  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    // Below 1900K the blue channel is genuinely zero; the log would go to -inf.
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }

  return [clamp255(r), clamp255(g), clamp255(b)];
}

/**
 * Hue/saturation as Home Assistant reports it — hue 0–360, saturation 0–100 —
 * at full value, because brightness is carried separately.
 */
export function rgbFromHs(hue: number, saturation: number): Rgb {
  const h = ((((hue % 360) + 360) % 360) / 60);
  const s = Math.min(1, Math.max(0, saturation / 100));
  const c = s;
  const x = c * (1 - Math.abs((h % 2) - 1));
  const m = 1 - c;

  const [r, g, b]: Rgb = (() => {
    switch (Math.floor(h)) {
      case 0:
        return [c, x, 0];
      case 1:
        return [x, c, 0];
      case 2:
        return [0, c, x];
      case 3:
        return [0, x, c];
      case 4:
        return [x, 0, c];
      default:
        return [c, 0, x];
    }
  })();

  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

/** A 2700K bulb's own colour — the fallback when a lamp reports nothing. */
const WARM_WHITE: Rgb = [255, 168, 88];

/**
 * The colour to paint a lamp with, given everything known about it.
 *
 * Precedence matters and is not arbitrary. A bulb in xy/hs mode is showing a
 * colour, and its `color_temp_kelvin` is stale from whenever it last did white
 * — reading kelvin first would paint a green lamp amber.
 */
export function lampRgb(lamp: LampView): Rgb {
  const inColour = lamp.colorMode !== null && lamp.colorMode !== "color_temp";
  if (lamp.rgb && inColour) return lamp.rgb.map(clamp255) as Rgb;
  if (lamp.hs && inColour) return rgbFromHs(lamp.hs[0], lamp.hs[1]);
  if (lamp.kelvin) return rgbFromKelvin(lamp.kelvin);
  return WARM_WHITE;
}

export function cssRgb([r, g, b]: Rgb, alpha = 1): string {
  const round = (v: number) => Math.round(v);
  return alpha >= 1
    ? `rgb(${round(r)} ${round(g)} ${round(b)})`
    : `rgb(${round(r)} ${round(g)} ${round(b)} / ${alpha})`;
}

/** Convenience for the common "tint this lamp" case. */
export function lampCss(lamp: LampView, alpha = 1): string {
  return cssRgb(lampRgb(lamp), alpha);
}
