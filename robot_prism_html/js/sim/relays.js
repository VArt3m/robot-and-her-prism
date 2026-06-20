/**
 * The RELAY framework — connectors, inverters, and the further "sisters" still to
 * come: field nodes that RECEIVE beams and RE-EMIT light. Every relay shares the
 * same surrounding machinery and differs only in its CLEAN emit rule, declared
 * here, so a new sister is a one-entry addition (plus its type flag) rather than a
 * scatter of `kind === 'connector'` branches.
 *
 * What relays share (handled generically elsewhere, NOT per kind):
 *   • occlusion — a relay is a laser endpoint that re-emits instead of stopping
 *     (engine `_leveled_blockers`, occlusion `carriedRayType`);
 *   • corruption — a Forge or a fired rewirer can lock a `color` onto any relay
 *     (null = clean). A corrupted relay emits that colour on ANY incoming light
 *     and never "dies" on a conflict — identical for every kind (`relayEmit`);
 *   • the solver loop, the dead/confused map, links, buttons, carrying, stacking
 *     on boxes, recolour targeting — all keyed off `isRelayKind`, not the kind.
 *
 * What differs per kind is ONLY `cleanEmit(node, incoming)`: given the set of
 * distinct delivered incoming colours, what a CLEAN (uncorrupted) relay of this
 * kind emits (or null for "dark / confused").
 */

import { colorMask, maskColor, WHITE_MASK } from './colormix.js';

export const RELAY_SPECS = {
  // Connector — a plain relay: pass a single incoming colour straight through;
  // go dark on none, or on a conflict (two or more distinct colours).
  connector: {
    cleanEmit: (_node, incoming) => (incoming.size === 1 ? [...incoming][0] : null),
  },

  // Inverter — swaps within a colour pair (default red↔blue). A single incoming
  // colour that is IN the pair is re-emitted as the OTHER half. Anything else
  // confuses it → dark: no light, a conflict (2+ distinct colours), or a single
  // colour that is not in the pair.
  inverter: {
    cleanEmit: (node, incoming) => {
      if (incoming.size !== 1) return null;
      const c = [...incoming][0];
      const pair = node.pair || ['red', 'blue'];
      const i = pair.indexOf(c);
      return i === -1 ? null : pair[1 - i];
    },
  },

  // Mixer — COMBINES its inputs; a single PRIMARY always confuses it (there is
  // nothing to mix). It has two programmable forms (node.mode):
  //   'blend'  (default) — sums (additively ORs) everything it receives and
  //            succeeds only when that sum is a SECONDARY, i.e. exactly two of the
  //            three primaries are present. So: two distinct primaries → their
  //            secondary; a lone secondary → itself (retranslated); a secondary
  //            plus a primary already inside it → that same secondary. It is
  //            confused by a single primary (sum is one primary), by white, and by
  //            anything whose sum reaches white (all three primaries).
  //   'whiten' — tries to make WHITE from whatever it receives, primary or
  //            secondary. It succeeds (emits white, and so can relay/retranslate
  //            white) exactly when the inputs together cover all three primaries
  //            (their additive sum is white); otherwise it is confused. This form
  //            can produce nothing but white.
  mixer: {
    cleanEmit: (node, incoming) => {
      let m = 0;
      for (const c of incoming) m |= colorMask(c);
      if (node.mode === 'whiten') return m === WHITE_MASK ? 'white' : null;
      // 'blend' (the original form): the sum must be a secondary — exactly two of
      // the three primary bits set (one primary = too little, white = too much).
      const bits = (m & 1) + ((m >> 1) & 1) + ((m >> 2) & 1);
      return bits === 2 ? maskColor(m) : null;
    },
  },
};

export function relaySpec(kind) {
  return RELAY_SPECS[kind] || null;
}

export function isRelayKind(kind) {
  return Object.prototype.hasOwnProperty.call(RELAY_SPECS, kind);
}

// The full emit of a relay node given its delivered incoming colours: a corrupted
// relay (`color` set) emits that locked colour whenever it receives any light at
// all and never dies on a conflict; a clean relay defers to its kind's cleanEmit.
// One definition, shared by every sister.
export function relayEmit(node, incoming) {
  if (!node) return null;
  if (node.color) return incoming.size >= 1 ? node.color : null;
  const spec = RELAY_SPECS[node.kind];
  return spec ? spec.cleanEmit(node, incoming) : null;
}
