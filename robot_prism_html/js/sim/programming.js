/**
 * The programming FRAMEWORK — sister to the targeting one (js/sim/targeting.js).
 *
 * Every object whose type sets `programmable` shares ONE interaction core: at a
 * Forge (press F / the panel's Program button while carrying the device within a
 * Forge's radius) a chooser menu is summoned; picking an option sets one of the
 * device's fields and spends one of that Forge's uses. That access pattern is
 * identical for all of them and lives in the UI.
 *
 * What differs per object is ONLY its data, declared as a spec here. A spec is a
 * list of FACETS — most devices have one, but a device may expose several (the
 * inverter offers a corruption facet AND a colour-pair facet from the same menu).
 * Each facet declares:
 *
 *   field     the node property this facet writes ('color', 'fuse', 'pair', …).
 *   default   the value stamped on first pickup, so a fresh device is usable.
 *   values    the choosable values, in menu order.
 *   labelKey  STR.menu[labelKey](value) → the menu label for a value.
 *   flashKey  STR.flash[flashKey](value) → the confirmation flash.
 *   live      does applying re-run the sim? (false for inert fields.)
 *   corrupts  (optional) this facet's non-clean values are "corruptions" — only a
 *             corrupting Forge may apply them; `cleanValue` is the one value that
 *             is NOT a corruption (cleaning is always allowed).
 *
 * Resolving labelKey / flashKey to text is left to the UI, so this module stays
 * free of presentation strings. The chooser is built generically from the facets
 * (programOptions): no-op options and — at a clean-only Forge — corruption options
 * are filtered out, and every surviving option carries its own field/labels.
 */

import { MINE_FUSE_DEFAULT } from '../core/constants.js';

// The shared corruption facet for relays (connector, inverter, future sisters):
// clean (null) or a locked colour. Identical wherever it appears.
const COLOR_CORRUPTION_FACET = {
  field: 'color',
  default: null,
  values: [null, 'red', 'green', 'blue'],
  labelKey: 'connColor',
  flashKey: 'connColorSet',
  live: true,
  corrupts: true,
  cleanValue: null,
};

export const PROGRAM_SPECS = {
  // Connector — only its corruption colour (null = "clean", a plain relay).
  connector: { facets: [COLOR_CORRUPTION_FACET] },

  // Inverter — corruption (exactly as a connector) PLUS its colour pair. The two
  // facets share one chooser: clean/corrupt, and which two colours it swaps.
  inverter: {
    facets: [
      COLOR_CORRUPTION_FACET,
      {
        field: 'pair',
        default: ['red', 'blue'],
        values: [['red', 'blue'], ['red', 'green'], ['blue', 'green']],
        labelKey: 'invPair',
        flashKey: 'invPairSet',
        live: true,
      },
    ],
  },

  // Mine — a reprogrammable fuse, in seconds. Inert until deployed, so setting it
  // does not re-run the sim.
  mine: {
    facets: [{
      field: 'fuse',
      default: MINE_FUSE_DEFAULT,
      values: [1, 2, 3, 5, 8],
      labelKey: 'fuse',
      flashKey: 'fuseSet',
      live: false,
    }],
  },

  // Rewirer — the colour it would recolour a target to. (Not a corruption facet:
  // this is the device's own payload colour, never gated by a Forge.)
  rewirer: {
    facets: [{
      field: 'color',
      default: 'red',
      values: ['red', 'green', 'blue'],
      labelKey: 'color',
      flashKey: 'colourSet',
      live: true,
    }],
  },
};

export function programSpec(kind) {
  return PROGRAM_SPECS[kind] || null;
}

// Equality for a programmed field's value. `null`/`undefined` both mean
// "unset / clean", so they compare equal; arrays compare as unordered SETS (a
// colour pair is order-independent); everything else is strict. Centralised so
// "the same programmed state" has one definition.
export function sameProgramValue(a, b) {
  if (a == null && b == null) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    const sa = [...a].sort(), sb = [...b].sort();
    return sa.every((v, i) => v === sb[i]);
  }
  return a === b;
}

// The firm, kind-agnostic rule for what a Forge may offer: an option is a NO-OP —
// and so should NOT be offered — when applying it would leave the device in a
// state equivalent to the one it is already in. Compares the facet's field BEFORE
// against what it WOULD BECOME ("set field = value").
export function programIsNoop(facet, node, value) {
  if (!facet || !node) return false;
  return sameProgramValue(node[facet.field], value);
}

// Is applying `value` a CORRUPTION — something only a corrupting Forge may do?
// True only for a corruption facet (`corrupts`) and only when the value is not its
// clean value. Cleaning (→ cleanValue) is never a corruption.
export function isCorruptionValue(facet, value) {
  if (!facet || !facet.corrupts) return false;
  return !sameProgramValue(value, facet.cleanValue);
}

// Stamp every facet's default onto a freshly-picked-up device (only where the
// field is unset), so a new device is usable without opening its chooser.
export function stampProgramDefaults(node, spec) {
  if (!node || !spec) return;
  for (const f of spec.facets) {
    if (node[f.field] == null) node[f.field] = Array.isArray(f.default) ? [...f.default] : f.default;
  }
}

// Build the chooser options for a device at a Forge. Walks every facet, dropping
// no-op values (would not change the device) and — when the Forge cannot corrupt
// — every corruption value. Each surviving option is self-describing (its own
// field / labels / liveness), so the UI core needs no per-kind branches and a
// multi-facet device "just works".
export function programOptions(spec, node, { canCorrupt = true } = {}) {
  const out = [];
  if (!spec) return out;
  for (const facet of spec.facets) {
    for (const v of facet.values) {
      if (programIsNoop(facet, node, v)) continue;
      if (!canCorrupt && isCorruptionValue(facet, v)) continue;
      out.push({ field: facet.field, value: v, labelKey: facet.labelKey, flashKey: facet.flashKey, live: !!facet.live });
    }
  }
  return out;
}
