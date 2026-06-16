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
