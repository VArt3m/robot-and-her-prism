"""2-D segment intersection and distance helpers used by the beam solver."""

import math

from .constants import EPS


def seg_inter(p, p2, q, q2):
    rx, ry = p2[0] - p[0], p2[1] - p[1]
    sx, sy = q2[0] - q[0], q2[1] - q[1]
    rxs = rx * sy - ry * sx
    if abs(rxs) < 1e-12:
        return None
    qpx, qpy = q[0] - p[0], q[1] - p[1]
    t = (qpx * sy - qpy * sx) / rxs
    u = (qpx * ry - qpy * rx) / rxs
    if -EPS <= t <= 1 + EPS and -EPS <= u <= 1 + EPS:
        return (p[0] + t * rx, p[1] + t * ry), t, u
    return None


def first_block_t(a, b, blockers):
    best = None
    for (w1, w2) in blockers:
        r = seg_inter(a, b, w1, w2)
        if r:
            _, t, u = r
            if EPS < t < 1 - EPS and -EPS <= u <= 1 + EPS:
                if best is None or t < best:
                    best = t
    return best


def dist(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])


def pt_seg_dist(p, a, b):
    ax, ay = a; bx, by = b; px, py = p
    dx, dy = bx - ax, by - ay
    L2 = dx * dx + dy * dy
    if L2 < 1e-9:
        return dist(p, a)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L2))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))
