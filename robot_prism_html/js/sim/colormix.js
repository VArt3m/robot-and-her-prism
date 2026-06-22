/**
 * Additive colour model for the prism engine.
 *
 * The three PRIMARIES are single RGB bits — red=R, green=G, blue=B. Mixing is the
 * bitwise OR of those bits, which yields the SECONDARIES and white:
 *
 *     red|green   = yellow      red|blue   = magenta     green|blue = cyan
 *     red|green|blue = white
 *
 * BLACK is a real, carriable colour whose mask is 0 (no RGB bits) — the additive
 * "negative" of white. It is NOT the same as the absence of light (`null`): an
 * emitter with nothing to emit emits `null` (no beam at all), whereas a black RAY
 * is a real beam that happens to carry the zero colour. Because `maskColor(0)`
 * stays `null`, generic mixing never spontaneously invents black from an empty
 * sum; black is only produced where a device explicitly means it (the complement
 * inverter making black from a full white). Used by relays in sim/relays.js.
 */

const MASK = { black: 0, red: 1, green: 2, blue: 4, yellow: 3, magenta: 5, cyan: 6, white: 7 };
const NAME = { 1: 'red', 2: 'green', 4: 'blue', 3: 'yellow', 5: 'magenta', 6: 'cyan', 7: 'white' };

export const WHITE_MASK = 7;

// Colour → RGB bitmask (0 for black, unknown, or "no light").
export function colorMask(c) {
  return MASK[c] ?? 0;
}

// RGB bitmask → colour name. 0 maps to null (an EMPTY additive sum is "no light",
// not black — black is only ever emitted explicitly, never derived from a 0 sum).
export function maskColor(m) {
  return NAME[m] ?? null;
}

// A primary is a single RGB bit (red / green / blue).
export function isBaseColor(c) {
  const m = MASK[c];
  return m === 1 || m === 2 || m === 4;
}

// The additive sum (bitwise OR) of a collection of colours → a colour name, or
// null if the collection is empty.
export function addColors(colors) {
  return NAME[combineMask(colors)] ?? null;
}

// The combined RGB bitmask (bitwise OR) of a collection of colour names. Black
// and unknown colours contribute 0, so an empty collection yields 0.
export function combineMask(colors) {
  let m = 0;
  for (const c of colors) m |= (MASK[c] ?? 0);
  return m;
}

// Number of set RGB bits in a 3-bit mask (how many primaries it contains).
export function bitCount(m) {
  return (m & 1) + ((m >> 1) & 1) + ((m >> 2) & 1);
}
