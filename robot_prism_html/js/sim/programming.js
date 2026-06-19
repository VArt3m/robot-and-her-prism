/**
 * The programming FRAMEWORK — sister to the targeting one (js/sim/targeting.js).
 *
 * Every object whose type sets `programmable` shares ONE interaction core: at a
 * Forge (press F / the panel's Program button while carrying the device within a
 * Forge's radius) a chooser menu is summoned; picking a value sets one of the
 * device's fields and spends one of that Forge's uses. That access pattern is
 * identical for all of them and lives in the UI. (Programming used to be summoned
 * by a long press anywhere; it is now gated behind Forges — see app._invokeForge.)
 *
 * What differs per object is ONLY its data, declared in one spec here — the menu
 * has different contents, and the value lands in a different field:
 *
 *   field     the node property the chooser writes ('fuse', 'colour', …).
 *   default   the value stamped on first pickup, so a fresh device is usable.
 *   values    the choosable values, in menu order.
 *   labelKey  STR.menu[labelKey](value) → the menu label for a value.
 *   flashKey  STR.flash[flashKey](value) → the confirmation flash.
 *   live      does applying a value re-run the sim? (false for inert fields.)
 *
 * Resolving labelKey / flashKey to text is left to the UI, so this module stays
 * free of presentation strings. A device may also be targetable (see
 * targeting.js); the two frameworks compose — that is the rewirer and, later,
 * any "programmable + targeting" object.
 *
 * To add a new programmable object (say one whose menu picks a movement axis):
 * set `programmable: true` on its type, add an entry here
 *   axis: { field:'axis', default:'horizontal', values:['horizontal','vertical'],
 *           labelKey:'axis', flashKey:'axisSet', live:true }
 * plus the matching STR.menu.axis / STR.flash.axisSet strings. The core does not
 * change.
 */

import { MINE_FUSE_DEFAULT } from '../core/constants.js';

export const PROGRAM_SPECS = {
  // Connector — its locked colour (null = "clean", a plain relay). At a Forge it
  // can be cleaned, freshly corrupted, or corrupted to a different colour. The
  // default is `null`, so first-pickup stamping is a harmless no-op (a connector
  // is born clean). Re-runs the sim — the corruption changes what it emits.
  connector: {
    field: 'color',
    default: null,
    values: [null, 'red', 'green', 'blue'],
    labelKey: 'connColor',
    flashKey: 'connColorSet',
    live: true,
  },

  // Mine — a reprogrammable fuse, in seconds. Inert until the mine is deployed,
  // so setting it does not re-run the sim.
  mine: {
    field: 'fuse',
    default: MINE_FUSE_DEFAULT,
    values: [1, 2, 3, 5, 8],
    labelKey: 'fuse',
    flashKey: 'fuseSet',
    live: false,
  },

  // Rewirer — the colour it would recolour a target to (red / green / blue).
  rewirer: {
    field: 'color',
    default: 'red',
    values: ['red', 'green', 'blue'],
    labelKey: 'color',
    flashKey: 'colourSet',
    live: true,
  },
};

export function programSpec(kind) {
  return PROGRAM_SPECS[kind] || null;
}

// Equality for a programmed field's value. `null` and `undefined` both mean
// "unset / clean" (an unstamped device, a plain connector), so they compare
// equal; every other value is compared strictly. Centralised so the notion of
// "the same programmed state" has one definition.
export function sameProgramValue(a, b) {
  if (a == null && b == null) return true;
  return a === b;
}

// The firm, kind-agnostic rule for what a Forge may offer: an option is a NO-OP
// — and so should NOT be offered — when applying it would leave the device in a
// state equivalent to the one it is already in. We compare the field's value
// BEFORE against what it WOULD BECOME after the change ("set field = value"),
// rather than hard-coding any one kind, so the rule keeps holding for every
// present and future programmable device. A clean connector is not offered
// "clean", a red rewirer is not offered "red", a 3 s mine is not offered "3 s".
export function programIsNoop(spec, node, value) {
  if (!spec || !node) return false;
  const before = node[spec.field];      // the field as it stands now
  const after = value;                  // apply is `node[spec.field] = value`
  return sameProgramValue(before, after);
}
