import { BOX_R, CONN_R, MINE_R, FORGE_R, SOURCE_R, RECEIVER_R } from '../core/constants.js';

// Central description of the physical objects that live on the field — the
// "logical space" for object rules. Add new kinds and new properties here as
// the game grows (e.g. immaterial objects, pushable objects, heavier items).
//
//   material  : occupies physical space — nothing may overlap it (the player,
//               walls, barriers, or other material objects). This is the SINGLE
//               source of truth for movement + placement blocking: the player
//               cannot walk through a material object and nothing may be dropped
//               overlapping one (see motion.move_player / world.material_nodes /
//               world.object_pos_blocked). Materiality is a SEPARATE concern from
//               light occlusion — what a ray passes through is governed by
//               RAY_OCCLUSION (sim/occlusion.js) and the engine's blocker builder
//               (`_leveled_blockers`), which decide independently which material
//               kinds also block light (carriable devices, forges, and now sources
//               / receivers do; buttons would not, were they material). Immaterial
//               objects use material:false. Materiality does NOT stop the player
//               from carrying the object.
//   pushable  : can be shoved by the player walking into it. None today.
//   carriable : can be picked up and carried.
//   requiresTarget : the object is aimed at a target node when carried (a
//               connector wires to nodes; a box just sits). Drives the
//               click-to-target / golden-arrow wiring interaction in the UI.
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
  // light and is never confused — incoming rays are dead weight). An EMPTY one is
  // a charging SINK: it behaves like a relay for INTAKE only (it gathers feeders
  // by tier and would radiate their additive sum — and, having no forbidden
  // colour, it is never confused), but it radiates nothing outward and holds the
  // weakest rank, so everything reaching it is absorbed. It charges over a few
  // uninterrupted seconds of a steady OUTCOME colour, then becomes charged, cuts
  // exactly its feeder links (keeping every other intent), and emits as a source.
  // While charging it grows a second external contour (its layer), enlarging its
  // footprint. It can be wired (targeted) like a connector. Material, carriable;
  // same base footprint as a relay. NOT a relay (`relay` unset) so it stays out of
  // the relay machinery — its intake is handled by a dedicated engine pass.
  accumulator: { material: true, pushable: false, carriable: true, requiresTarget: true, programmable: false, jammable: false, radius: CONN_R },
  // A light SOURCE and a RECEIVER — stationary environment fixtures (like the
  // forge: not carriable, not pushable). They are MATERIAL (the robot may not walk
  // through them and nothing may be placed overlapping them) AND they occlude light
  // like any standard obstacle: a beam passing THROUGH one toward something else is
  // stopped at its near face. What keeps their function intact is the solver's
  // owner filter — a beam a fixture is a genuine ENDPOINT of (a source it emits
  // from, a receiver it delivers to) is not blocked by its own body — so "what they
  // actually take, they take", and a delivering beam is drawn only to the fixture's
  // outer contour (see engine `_leveled_blockers` / `_endpointBodyCap`).
  source:    { material: true, pushable: false, carriable: false, requiresTarget: false, programmable: false, jammable: false, radius: SOURCE_R },
  receiver:  { material: true, pushable: false, carriable: false, requiresTarget: false, programmable: false, jammable: false, radius: RECEIVER_R },
};

export function objType(kind) {
  return OBJECT_TYPES[kind] || null;
}

// Does this kind occupy physical space (block the player and object placement)?
// Single source of truth, read straight off the table above. Buttons / logic
// gates have no entry, so they are immaterial (the robot stands on them).
export function isMaterialKind(kind) {
  return Boolean(OBJECT_TYPES[kind]?.material);
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
