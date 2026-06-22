import { BOX_R, CONN_R, MINE_R, FORGE_R } from '../core/constants.js';

// Central description of the physical objects that live on the field — the
// "logical space" for object rules. Add new kinds and new properties here as
// the game grows (e.g. immaterial objects, pushable objects, heavier items).
//
//   material  : occupies space — nothing may overlap it (the player, walls,
//               barriers, or other material objects). Immaterial objects can
//               be added later with material:false. Materiality does NOT stop
//               the player from carrying the object.
//   pushable  : can be shoved by the player walking into it. None today.
//   carriable : can be picked up and carried.
//   requiresTarget : the object is aimed at a target node when carried (a
//               connector wires to nodes; a box just sits). Drives the
//               wire-drag / click-by-click targeting gesture in the UI.
//   programmable   : the object holds a player-settable value (a fuse time, a
//               colour, …) configured via the programming sequence in the UI.
//   jammable  : a jammer can target it. When a live jam ray reaches it, it is
//               forced into the disabled (inert) state and held there. Force
//               fields are jammable too, but they are entities, not carriable
//               objects, so their jammability is intrinsic (see isJammable).
//   radius    : circular collision half-extent, in world units.
//   relay     : a light relay — it receives beams and re-emits (connector,
//               inverter, and future sisters). Drives the shared occlusion /
//               solver / stacking / corruption treatment (see sim/relays.js).
export const OBJECT_TYPES = {
  box:       { material: true, pushable: false, carriable: true, requiresTarget: false, programmable: false, jammable: false, radius: BOX_R },
  // Programmable too: at a Forge, a connector can be cleaned (back to a plain
  // relay) or corrupted to a fixed colour — the same locked-colour state a fired
  // rewirer leaves. The colour lives in the node's `color` field (null = clean).
  connector: { material: true, pushable: false, carriable: true, requiresTarget: true,  programmable: true,  jammable: false, radius: CONN_R, relay: true },
  // Inverter — a sister of the connector. A clean inverter swaps within a colour
  // pair (default red↔blue): in-pair light comes out as the other half, anything
  // else confuses it. Corruption (`color`) and recolouring work exactly as for a
  // connector; programming also reprograms its `pair`. Same physical footprint.
  inverter:  { material: true, pushable: false, carriable: true, requiresTarget: true,  programmable: true,  jammable: false, radius: CONN_R, relay: true },
  // Mixer — another sister. It COMBINES its inputs into their additive sum and
  // emits that (two primaries → a secondary; all three → white). A lone secondary
  // passes through; a single base colour, or any white on the input, confuses it.
  // It is NOT programmable and NOT corruptible — a singular device that always
  // mixes. Wiring works as for any relay.
  mixer:     { material: true, pushable: false, carriable: true, requiresTarget: true,  programmable: false, jammable: false, radius: CONN_R, relay: true },
  // Programmable only — a portable mine. Fuse (seconds) is reprogrammable and
  // counts down from its first drop; on zero it destroys walls in a small radius.
  // Jammable: a jam ray freezes it (its countdown is held).
  mine:      { material: true, pushable: false, carriable: true, requiresTarget: false, programmable: true,  jammable: true,  radius: MINE_R },
  // Programmable + targeting — a rewirer. Holds a colour (red/green/blue) and,
  // with line of sight, recolours a source or receiver it targets.
  rewirer:   { material: true, pushable: false, carriable: true, requiresTarget: true,  programmable: true,  jammable: false, radius: CONN_R },
  // Targeting only — a jammer. With line of sight it forces a force field or a
  // deployed mine into the disabled state; its effect is live only while the
  // jammer itself is on the ground.
  jammer:    { material: true, pushable: false, carriable: true, requiresTarget: true,  programmable: false, jammable: false, radius: CONN_R },
  // A Forge — a stationary environment fixture (like a source / receiver: not
  // carriable, not pushable). It is the only place programming may be summoned:
  // while the robot stands within its (generous) radius carrying a programmable
  // item. Material, so it occludes light and blocks movement like other objects.
  forge:     { material: true, pushable: false, carriable: false, requiresTarget: false, programmable: false, jammable: false, radius: FORGE_R },
  // An Accumulator — a PORTABLE source with a charge. Two states keyed by its
  // `color` field: EMPTY (null) and CHARGED (a colour). A charged accumulator is
  // a rank-0 source that emits ONLY its own colour (it never relays incoming
  // light and is never confused — incoming rays are dead weight); an empty one is
  // a sink that fills over a couple of uninterrupted seconds of a single incoming
  // colour, then becomes charged and drops the link that filled it. It can be
  // wired (targeted) like a connector. Material, carriable; same footprint as a
  // relay. NOT a relay (`relay` unset) so it stays out of the relay machinery.
  accumulator: { material: true, pushable: false, carriable: true, requiresTarget: true, programmable: false, jammable: false, radius: CONN_R },
};

export function objType(kind) {
  return OBJECT_TYPES[kind] || null;
}

// Is this an accumulator (a portable source)? One physical source of truth.
export function isAccumulatorKind(kind) {
  return kind === 'accumulator';
}

// Is this a light relay (connector / inverter / future sister)? Single physical
// source of truth; the emit behaviour itself lives in sim/relays.js.
export function isRelay(kind) {
  return Boolean(OBJECT_TYPES[kind]?.relay);
}

// May a jammer target this thing? Force fields are always jammable (they are
// entities, not carriable objects); carriable kinds carry the flag in the table
// above. `target` is either a kind string or null.
export function kindIsJammable(kind) {
  return Boolean(OBJECT_TYPES[kind]?.jammable);
}
