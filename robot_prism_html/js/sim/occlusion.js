/**
 * Ray OCCLUSION — what each emitted *effect* passes through, in one table.
 *
 * Three ray types exist (more colour-emitting ones will join the laser family):
 *
 *                wall  tan   purple  ffActive   object         player
 *   laser        stop  pass  pass    stop       stop¹          stop²
 *   jammer       stop  pass  pass    stop³       pass           pass
 *   rewirer      stop  stop  pass    stop        stop           stop²
 *
 *   ¹ a connector that is a deliberate link endpoint RE-EMITS instead of
 *     blocking (the light-translation mechanic); any other object stops it.
 *     That per-beam exception lives in the engine's laser builder, not here.
 *   ² the player only cuts a ray while `world.player_block` is set (the same
 *     flag the laser already uses).
 *   ³ a jammer ray never stops on the force field it itself targets.
 *
 * A force field only ever blocks while *active* (solid); once open or disabled
 * it is passable to everything — so `ffActive` is the only force-field knob.
 *
 * The laser keeps its own blocker builder in the engine because it also carries
 * elevation levels, owner-based re-emit, and beam-vs-beam cutting that the other
 * rays do not. `rayBlockerSegments` below serves the pure line-of-sight rays
 * (jammer today, rewirer next) so they read straight from this table.
 */

import { PLAYER_R, BOX_R, CONN_R } from '../core/constants.js';
import { objType } from './objects.js';

export const RAY_OCCLUSION = {
  laser:   { wall: true, barrierTan: false, barrierPurple: false, ffActive: true, object: true,  player: true },
  jammer:  { wall: true, barrierTan: false, barrierPurple: false, ffActive: true, object: false, player: false },
  rewirer: { wall: true, barrierTan: true,  barrierPurple: false, ffActive: true, object: true,  player: true },
};

export function rayProfile(type) {
  return RAY_OCCLUSION[type] || null;
}

function squareSegs(c, r) {
  const [x, y] = c;
  const p = [[x - r, y - r], [x + r, y - r], [x + r, y + r], [x - r, y + r]];
  return [[p[0], p[1]], [p[1], p[2]], [p[2], p[3]], [p[3], p[0]]];
}

// The segments a SIMPLE line-of-sight ray of `profile` is blocked by. Used by
// the jammer (and, when it lands, the rewirer). `excludeFieldId` is the ray's
// own target force field, which never self-blocks.
export function rayBlockerSegments(world, profile, { excludeFieldId = null, excludeNodeIds = null } = {}) {
  const segs = [];
  if (profile.wall) {
    for (const wl of world.walls) segs.push([wl.p1, wl.p2]);
  }
  if (profile.ffActive) {
    for (const ff of world.ffs) {
      if (ff.is_passable()) continue;             // open / disabled never blocks
      if (ff.id === excludeFieldId) continue;     // never blocks on its own target
      segs.push([ff.p1, ff.p2]);
    }
  }
  for (const bar of world.barriers) {
    const on = bar.kind === 'purple' ? profile.barrierPurple : profile.barrierTan;
    if (on) segs.push([bar.p1, bar.p2]);
  }
  if (profile.object) {
    for (const bx of world.boxes) for (const s of squareSegs(bx, BOX_R)) segs.push(s);
    for (const n of world.carriable_nodes()) {
      if (n.id === world.carrying) continue;      // not the one in hand
      if (excludeNodeIds && excludeNodeIds.has(n.id)) continue;  // ray's own emitter / target
      const r = objType(n.kind)?.radius ?? CONN_R;
      for (const s of squareSegs(n.pos, r)) segs.push(s);
    }
  }
  if (profile.player && world.player_block && world.player) {
    for (const s of squareSegs(world.player, PLAYER_R)) segs.push(s);
  }
  return segs;
}
