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
import { seg_inter } from '../core/geometry.js';
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

// The ray "kind" a carried object would emit, for highlight previews — the same
// occlusion profile its real effect uses. Returns null for objects that aim no
// ray at all (a box, a mine — the mine is programmable-only, not targeting), so
// the "passable ray area" highlight simply shows nothing for them.
export function carriedRayType(kind) {
  switch (kind) {
    case 'connector': return 'laser';
    case 'rewirer':   return 'rewirer';
    case 'jammer':    return 'jammer';
    default:          return null;
  }
}

// The reach region of a ray fired from `origin` in every direction at once — as
// if the carried item were a light source there, its rays travelling outward and
// stopping on whatever its `profile` cannot pass. The result is the (star-shaped)
// visibility polygon: a list of boundary points in angular order, ready to fill.
//
// `bounds` is the world rectangle [x0, y0, x1, y1]; rays that hit nothing else
// terminate on it, so the polygon is always closed and finite. The emitter's own
// body is never a blocker (the carried object is in hand — rayBlockerSegments
// already skips `world.carrying`) and the player is excluded by the caller
// passing a profile with `player:false`, since the origin sits on her.
export function visibilityPolygon(world, profile, origin, bounds) {
  const [x0, y0, x1, y1] = bounds;
  const segs = rayBlockerSegments(world, profile, {});
  // The world frame, so a ray that escapes every obstacle still terminates.
  segs.push([[x0, y0], [x1, y0]], [[x1, y0], [x1, y1]],
            [[x1, y1], [x0, y1]], [[x0, y1], [x0, y0]]);

  // Aim a ray a hair to either side of every blocker corner so the boundary
  // wraps cleanly around occluders (the classic visibility-polygon trick).
  const NUDGE = 1e-4;
  const angles = [];
  for (const [a, b] of segs) {
    for (const p of [a, b]) {
      const ang = Math.atan2(p[1] - origin[1], p[0] - origin[0]);
      angles.push(ang - NUDGE, ang, ang + NUDGE);
    }
  }
  angles.sort((m, n) => m - n);

  const FAR = 1e4;
  const out = [];
  for (const ang of angles) {
    const far = [origin[0] + Math.cos(ang) * FAR, origin[1] + Math.sin(ang) * FAR];
    let bestT = 1, hit = far;
    for (const [s1, s2] of segs) {
      const r = seg_inter(origin, far, s1, s2);   // u clamped to the blocker
      if (!r) continue;
      const t = r[1];
      if (t > 1e-6 && t < bestT) { bestT = t; hit = r[0]; }
    }
    out.push([hit[0], hit[1]]);
  }
  return out;   // already in angular order
}
