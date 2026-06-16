import { BOX_R, CONN_R } from '../core/constants.js';

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
//   radius    : circular collision half-extent, in world units.
export const OBJECT_TYPES = {
  box:       { material: true, pushable: false, carriable: true, radius: BOX_R },
  connector: { material: true, pushable: false, carriable: true, radius: CONN_R },
};

export function objType(kind) {
  return OBJECT_TYPES[kind] || null;
}
