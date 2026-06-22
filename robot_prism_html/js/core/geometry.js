import { EPS } from './constants.js';

export function seg_inter(p, p2, q, q2) {
  const rx = p2[0] - p[0], ry = p2[1] - p[1];
  const sx = q2[0] - q[0], sy = q2[1] - q[1];
  const rxs = rx * sy - ry * sx;
  if (Math.abs(rxs) < 1e-12) return null;
  const qpx = q[0] - p[0], qpy = q[1] - p[1];
  const t = (qpx * sy - qpy * sx) / rxs;
  const u = (qpx * ry - qpy * rx) / rxs;
  if (-EPS <= t && t <= 1 + EPS && -EPS <= u && u <= 1 + EPS) {
    return [[p[0] + t * rx, p[1] + t * ry], t, u];
  }
  return null;
}

export function first_block_t(a, b, blockers) {
  let best = null;
  for (const [w1, w2] of blockers) {
    const r = seg_inter(a, b, w1, w2);
    if (r) {
      const [, t, u] = r;
      if (EPS < t && t < 1 - EPS && -EPS <= u && u <= 1 + EPS) {
        if (best === null || t < best) best = t;
      }
    }
  }
  return best;
}

export function dist(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

export function pt_seg_dist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L2 = dx * dx + dy * dy;
  if (L2 < 1e-9) return dist(p, a);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

// Does the segment a→b cross ANY segment in `segs` (each `[s1, s2]`)? The
// shared form of the inline intersection-with-clamped-(t,u) test that movement
// collision used in several places.
export function segments_cross(a, b, segs) {
  for (const [s1, s2] of segs) {
    const r = seg_inter(a, b, s1, s2);
    if (r) {
      const [, t, u] = r;
      if (-EPS <= t && t <= 1 + EPS && -EPS <= u && u <= 1 + EPS) return true;
    }
  }
  return false;
}

// The four edge segments of an axis-aligned square centred at `c` with
// half-extent `r`, as [[p0,p1],[p1,p2],[p2,p3],[p3,p0]]. One source of truth for
// the box-outline blockers built by both the engine and the occlusion module.
export function squareSegs(c, r) {
  const [x, y] = c;
  const p = [[x - r, y - r], [x + r, y - r], [x + r, y + r], [x - r, y + r]];
  return [[p[0], p[1]], [p[1], p[2]], [p[2], p[3]], [p[3], p[0]]];
}

// Pointwise inside-rect test for a `[rx, ry, rw, rh]` rectangle.
export function pointInRect(x, y, [rx, ry, rw, rh]) {
  return x >= rx && x <= rx + rw && y >= ry && y <= ry + rh;
}

// The player's facing as a unit vector, defaulting to [0, 1] (down) when facing
// is unset or zero. Scale-invariant uses (atan2) get the same answer.
export function facingUnit(facing) {
  const f = (facing && (facing[0] || facing[1])) ? facing : [0, 1];
  const l = Math.hypot(f[0], f[1]) || 1;
  return [f[0] / l, f[1] / l];
}
