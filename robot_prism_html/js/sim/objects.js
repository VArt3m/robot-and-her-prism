import { BOX_R, CONN_R, MINE_R } from '../core/constants.js';

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
//   radius    : circular collision half-extent, in world units.
export const OBJECT_TYPES = {
  box:       { material: true, pushable: false, carriable: true, requiresTarget: false, programmable: false, radius: BOX_R },
  connector: { material: true, pushable: false, carriable: true, requiresTarget: true,  programmable: false, radius: CONN_R },
  // Programmable only — a portable mine. Fuse (seconds) is reprogrammable and
  // counts down from its first drop; on zero it destroys walls in a small radius.
  mine:      { material: true, pushable: false, carriable: true, requiresTarget: false, programmable: true,  radius: MINE_R },
  // Programmable + targeting — a rewirer. Holds a colour (red/green/blue) and,
  // with line of sight, recolours a source or receiver it targets.
  rewirer:   { material: true, pushable: false, carriable: true, requiresTarget: true,  programmable: true,  radius: CONN_R },
  // Targeting only — a jammer. With line of sight it freezes a force field or a
  // deployed mine; its effect is live only while the jammer itself is down.
  jammer:    { material: true, pushable: false, carriable: true, requiresTarget: true,  programmable: false, radius: CONN_R },
};

export function objType(kind) {
  return OBJECT_TYPES[kind] || null;
}
