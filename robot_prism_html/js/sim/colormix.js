/**
 * Additive colour model for the prism engine.
 *
 * The three PRIMARIES are single RGB bits — red=R, green=G, blue=B. Mixing is the
 * bitwise OR of those bits, which yields the SECONDARIES and white:
 *
 *     red|green   = yellow      red|blue   = magenta     green|blue = cyan
 *     red|green|blue = white
 *
 * So every colour the engine can carry is one of seven: the three primaries, the
 * three secondaries, and white. "No light" is the absence of a colour (null), not
 * a colour here. Used by the Mixer relay (sim/relays.js) to combine its inputs.
 */

const MASK = { red: 1, green: 2, blue: 4, yellow: 3, magenta: 5, cyan: 6, white: 7 };
const NAME = { 1: 'red', 2: 'green', 4: 'blue', 3: 'yellow', 5: 'magenta', 6: 'cyan', 7: 'white' };

export const WHITE_MASK = 7;

// Colour → RGB bitmask (0 for unknown / "no light").
export function colorMask(c) {
  return MASK[c] ?? 0;
}

// RGB bitmask → colour name (null for 0 / out of range).
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
  let m = 0;
  for (const c of colors) m |= (MASK[c] ?? 0);
  return NAME[m] ?? null;
}
