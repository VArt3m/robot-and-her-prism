import { EPS, PLAYER_R, BOX_R, CONN_R, BTN_R, BEAM_TOUCH } from '../core/constants.js';
import { seg_inter, first_block_t, dist, pt_seg_dist } from '../core/geometry.js';
import { OBJECT_TYPES } from './objects.js';

export class Motion {
  constructor(world, engine) {
    this.world = world;
    this.engine = engine;
  }

  _static_blocked(old, new_, carry) {
    const w = this.world;
    const segs = w.walls.map(wl => [wl.p1, wl.p2]);
    for (const ff of w.ffs) if (!ff.is_passable()) segs.push([ff.p1, ff.p2]);
    for (const bar of w.barriers) {
      if (bar.kind === 'tan' || (bar.kind === 'purple' && carry)) segs.push([bar.p1, bar.p2]);
    }
    for (const [s1, s2] of segs) {
      const r = seg_inter(old, new_, s1, s2);
      if (r) { const [,t,u] = r; if (-EPS<=t&&t<=1+EPS&&-EPS<=u&&u<=1+EPS) return true; }
    }
    return false;
  }

  _box_blocked(idx, old, new_) {
    const w = this.world;
    const segs = w.walls.map(wl => [wl.p1, wl.p2]);
    for (const ff of w.ffs) if (!ff.is_passable()) segs.push([ff.p1, ff.p2]);
    for (const bar of w.barriers) segs.push([bar.p1, bar.p2]);
    for (const [s1, s2] of segs) {
      const r = seg_inter(old, new_, s1, s2);
      if (r) { const [,t,u] = r; if (-EPS<=t&&t<=1+EPS&&-EPS<=u&&u<=1+EPS) return true; }
    }
    for (let j = 0; j < w.boxes.length; j++) {
      if (j !== idx && dist(new_, w.boxes[j]) < 2*BOX_R - 2) return true;
    }
    return false;
  }

  _press_set(player_pos, boxes) {
    const w = this.world;
    const out = {};
    for (const n of Object.values(w.nodes)) {
      if (n.kind !== 'button') continue;
      const bp = n.pos;
      out[n.id] = Boolean(
        (player_pos && dist(player_pos, bp) < BTN_R)
        || boxes.some(b => dist(b, bp) < BTN_R)
        || Object.values(w.nodes).some(c => c.kind==='connector' && c.id!==w.carrying && dist(c.pos,bp)<BTN_R)
      );
    }
    return out;
  }

  _hypothetical_open(player_pos, boxes) {
    const w = this.world, eng = this.engine;
    if (!w.ffs.length) return {};
    const saved_player = w.player ? [...w.player] : null;
    const saved_boxes = w.boxes.map(b => [...b]);
    const saved_pressed = { ...w.pressed };
    const saved_open = w.ffs.map(ff => ff.is_open);
    w.player = player_pos ? [...player_pos] : null;
    w.boxes = boxes.map(b => [...b]);
    try {
      for (let iter = 0; iter < 30; iter++) {
        for (const n of Object.values(w.nodes))
          if (n.kind === 'button') w.pressed[n.id] = eng.button_pressed(n.id);
        const [emit, [beams, length, delivery]] = eng.propagate();
        const lit = eng._lit_map(beams, delivery);
        const val = eng.evaluate_logic(lit, w.pressed);
        let changed = false;
        for (const ff of w.ffs) {
          const nw = eng.field_open(ff, val);
          if (nw !== ff.is_open) { ff.is_open = nw; changed = true; }
        }
        if (!changed) break;
      }
      return Object.fromEntries(w.ffs.map(ff => [ff.id, ff.is_open]));
    } finally {
      w.player = saved_player;
      w.boxes = saved_boxes;
      w.pressed = saved_pressed;
      for (let i = 0; i < w.ffs.length; i++) w.ffs[i].is_open = saved_open[i];
    }
  }

  _box_critical_fields(box_index, boxes) {
    const w = this.world;
    if (!w.ffs.length || box_index === null) return [];
    // Only gates the box is actually holding open can close when it is stolen.
    // A jammer-disabled gate stays down regardless of the box, so it can never
    // crush — exclude it even if logic would also have it open.
    const open_now = new Set(w.ffs.filter(ff => ff.is_open && !ff.disabled).map(ff => ff.id));
    if (!open_now.size) return [];
    const far = boxes.map(b => [...b]);
    far[box_index] = [1e7, 1e7];
    const after = this._hypothetical_open(w.player, far);
    return w.ffs
      .filter(ff => open_now.has(ff.id) && !after[ff.id])
      .map(ff => [ff.p1, ff.p2]);
  }

  _theft_blocked(old, new_, reach_to, boxes_after, push_idx = null, box_new = null) {
    const w = this.world;
    function crosses(a, b, segs) {
      for (const [s1,s2] of segs) {
        const r = seg_inter(a, b, s1, s2);
        if (r) { const [,t,u] = r; if (-EPS<=t&&t<=1+EPS&&-EPS<=u&&u<=1+EPS) return true; }
      }
      return false;
    }
    const closed_now = w.ffs.filter(ff => !ff.is_passable()).map(ff => [ff.p1, ff.p2]);
    const need_dry = Boolean(w.ffs.length) && (
      reach_to !== null
      || w.player_block
      || JSON.stringify(this._press_set(old, w.boxes)) !== JSON.stringify(this._press_set(new_, boxes_after))
    );
    let closed_after;
    if (need_dry) {
      const after_open = this._hypothetical_open(new_, boxes_after);
      closed_after = w.ffs.filter(ff => !after_open[ff.id] && !ff.disabled).map(ff => [ff.p1, ff.p2]);
    } else {
      closed_after = closed_now;
    }
    if (crosses(old, new_, closed_after)) return true;
    const barrier_segs = w.barriers.map(b => [b.p1, b.p2]);
    const wall_segs = w.walls.map(wl => [wl.p1, wl.p2]);
    if (reach_to !== null && crosses(old, reach_to, [...wall_segs, ...barrier_segs, ...closed_now, ...closed_after]))
      return true;
    if (push_idx !== null) {
      const crit = this._box_critical_fields(push_idx, w.boxes);
      if (crit.length && (
        crosses(old, reach_to, crit)
        || crosses(old, new_, crit)
        || (box_new !== null && crosses(reach_to, box_new, crit))
      )) return true;
    }
    return false;
  }

  move_player(dx, dy) {
    const w = this.world;
    if (!w.player) return;
    const old = [...w.player];
    const new_ = [old[0]+dx, old[1]+dy];
    const carry = w.carrying !== null || w.carry_box !== null;
    // Material objects block the player. Boxes are not pushable (see
    // OBJECT_TYPES); the push branch stays here for future pushable kinds.
    for (let i = 0; i < w.boxes.length; i++) {
      if (dist(new_, w.boxes[i]) < PLAYER_R + BOX_R - 2) {
        if (OBJECT_TYPES.box.pushable) {
          const bx = [...w.boxes[i]];
          const nb = [bx[0]+dx, bx[1]+dy];
          if (this._box_blocked(i, bx, nb) || this._static_blocked(old, new_, carry)) return;
          const boxes_after = w.boxes.map(b => [...b]);
          boxes_after[i] = [...nb];
          if (this._theft_blocked(old, new_, bx, boxes_after, i, nb)) return;
          w.boxes[i] = [...nb];
          w.player = [...new_];
        }
        return;   // non-pushable: the box simply stops the player
      }
    }
    // Ground connectors are material and not pushable, too.
    for (const c of w.connectors()) {
      if (c.id === w.carrying) continue;
      if (dist(new_, c.pos) < PLAYER_R + CONN_R - 2) return;
    }
    // Forges are material fixtures — they stop the player like any solid object.
    for (const f of w.forges()) {
      if (dist(new_, f.pos) < PLAYER_R + OBJECT_TYPES.forge.radius - 2) return;
    }
    if (this._static_blocked(old, new_, carry)) return;
    if (this._theft_blocked(old, new_, null, w.boxes)) return;
    w.player = [...new_];
  }

  reach_blocked(a, b) {
    const w = this.world;
    // A drop may never cross a wall, a barrier, or a force field — and a force
    // field's frame blocks object placement in EVERY state. A gate that is open
    // (by logic) or down (jammed) is passable to the player, light, and rays,
    // but you still cannot toss an object across its line: walk through and
    // place it on the far side instead.
    const segs = [
      ...w.walls.map(wl => [wl.p1, wl.p2]),
      ...w.ffs.map(ff => [ff.p1, ff.p2]),
      ...w.barriers.map(bar => [bar.p1, bar.p2]),
    ];
    return first_block_t(a, b, segs) !== null;
  }

  // Find a legal, reachable resting spot for a carried object of radius `r`,
  // in unit direction (ux, uy) from `player`. It prefers `wantDist`, slides
  // inward to `gap` (so a spot aimed past a wall lands just short of it rather
  // than across it), and if the whole ray is blocked sweeps clockwise outward
  // to `maxD`. "Legal" = clear of every solid and other material object;
  // "reachable" = an unobstructed straight line from the player. This is the
  // continuously-evaluated form of the old place-time no-teleport safeguard;
  // because every returned spot satisfies it, the caller needs no further test.
  // Returns [x, y] or null when nothing in reach is legal.
  placement_spot(player, ux, uy, r, gap, maxD, wantDist, ignoreConn = null) {
    const w = this.world;
    const clear = (spot) =>
      !w.object_pos_blocked(spot, r, { ignoreConn }) && !this.reach_blocked(player, spot);
    const want = Math.min(Math.max(wantDist, gap), maxD);
    for (let dd = want; dd >= gap - 1e-6; dd -= 3) {
      const spot = [player[0] + ux * dd, player[1] + uy * dd];
      if (clear(spot)) return spot;
    }
    const base = Math.atan2(uy, ux);
    const STEP_A = Math.PI / 12;   // 15°, clockwise (screen y points down)
    for (let radius = gap; radius <= maxD + 1e-6; radius += Math.max(3, r / 2)) {
      for (let k = 1; k < 24; k++) {            // k = 0 is the ray, already tried
        const ang = base + k * STEP_A;
        const spot = [player[0] + Math.cos(ang) * radius, player[1] + Math.sin(ang) * radius];
        if (clear(spot)) return spot;
      }
    }
    return null;
  }

  at_goal() {
    const w = this.world;
    return Boolean(w.player && w.goal && dist(w.player, w.goal) < 18);
  }

  player_touching_beam() {
    const w = this.world;
    return w.beams_draw.some(([a, b]) => pt_seg_dist(w.player, a, b) < BEAM_TOUCH);
  }
}
