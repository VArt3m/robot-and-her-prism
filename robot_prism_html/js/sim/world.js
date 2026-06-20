import { BOX_R, CONN_R, PLAYER_R } from '../core/constants.js';
import { dist, pt_seg_dist } from '../core/geometry.js';
import { OBJECT_TYPES, kindIsJammable, isRelay, isAccumulatorKind } from './objects.js';
import { Engine } from './engine.js';
import { Motion } from './motion.js';

export class World {
  constructor() {
    this.nodes = {};
    this.walls = [];
    this.ffs = [];
    this.barriers = [];
    this.boxes = [];
    this.links = new Set();       // Set of "a\x00b" strings (sorted)
    this.logic_links = [];        // [[src, dst, negate], ...]
    // Jammer intents: jammer-id → target-id (a force-field id or a jammable
    // node id such as a mine). A jammer holds at most ONE intent — a Map gives
    // that for free, and re-marking simply overwrites. The intent persists
    // while the jammer is carried, but only bites while it is on the ground.
    this.jam_links = new Map();
    // Rewirer intents: rewirer-id → target-id (a source / receiver / connector).
    // One intent per rewirer (a Map), like the jammer; re-marking overwrites.
    this.recolor_links = new Map();
    this.goal = null;
    this.player = null;
    this.player_start = null;
    this.carrying = null;
    this.carry_box = null;     // a box [x,y] when one is being carried (else null)
    this.facing = [0, 1];      // unit vector: direction the player last moved
    this.player_block = false;
    this.pressed = {};
    this._uid = 0;
    this.engine = new Engine(this);
    this.motion = new Motion(this, this.engine);
  }

  // ---- solver output properties (read-through) ----
  get emit()      { return this.engine.emit; }
  get lit()       { return this.engine.lit; }
  get active()    { return this.engine.active; }
  get charge()    { return this.engine.charge; }
  get logic_val() { return this.engine.logic_val; }
  get beams_draw(){ return this.engine.beams_draw; }
  get dead_conns(){ return this.engine.dead_conns; }
  get jam_rays_draw(){ return this.engine.jam_rays_draw; }
  get recolor_rays_draw(){ return this.engine.recolor_rays_draw; }
  ready_rewirers(){ return this.engine.ready_rewirers(); }
  ready_accumulators(){ return this.engine.ready_accumulators(); }

  new_id(prefix) { this._uid++; return `${prefix}${this._uid}`; }

  add(node) { this.nodes[node.id] = node; return node; }

  connectors() {
    return Object.values(this.nodes).filter(n => n.kind === 'connector');
  }

  // All light relays (connector / inverter / future sisters) — the generalised
  // counterpart of connectors(), used wherever the physics treats relays alike
  // (material ground objects, box stacking, elevation).
  relays() {
    return Object.values(this.nodes).filter(n => isRelay(n.kind));
  }

  // Forges — stationary programming stations. Material (they occlude and block)
  // but not carriable, so they are tracked here rather than via carriable_nodes.
  forges() {
    return Object.values(this.nodes).filter(n => n.kind === 'forge');
  }

  // Carriable objects that live as nodes (the connector plus the programmable /
  // targeting devices: mine, rewirer, jammer). Boxes are tracked separately as
  // bare [x,y] points, not nodes.
  carriable_nodes() {
    return Object.values(this.nodes).filter(n => OBJECT_TYPES[n.kind]?.carriable && !n.spent);
  }

  field_by_id(fid) {
    return this.ffs.find(ff => ff.id === fid) ?? null;
  }

  // ---- light links ----
  // Links are stored as sorted "a\x00b" keys so each pair is unique.
  _link_key(a, b) { return a < b ? `${a}\x00${b}` : `${b}\x00${a}`; }

  toggle_link(a, b) {
    if (a === b || !this.nodes[a] || !this.nodes[b]) return;
    // A light link needs at least one "wireable initiator" — a relay or an
    // accumulator (a portable source). Sources/receivers never wire to each other.
    const wireable = (k) => isRelay(k) || isAccumulatorKind(k);
    if (!wireable(this.nodes[a].kind) && !wireable(this.nodes[b].kind)) return;
    const key = this._link_key(a, b);
    if (this.links.has(key)) this.links.delete(key); else this.links.add(key);
  }

  clear_links_of(nid) {
    for (const key of [...this.links])
      if (key.split('\x00').includes(nid)) this.links.delete(key);
  }

  // Iterate links as [a, b] pairs
  get links_pairs() {
    return [...this.links].map(k => k.split('\x00'));
  }

  // ---- logic links ----
  toggle_logic_link(src, dst) {
    for (const l of this.logic_links) {
      if (l[0]===src && l[1]===dst) {
        if (l[2]===false) { l[2]=true; return `set NOT on ${src} -> ${dst}`; }
        this.logic_links.splice(this.logic_links.indexOf(l), 1);
        return `removed ${src} -> ${dst}`;
      }
    }
    this.logic_links.push([src, dst, false]);
    return `linked ${src} -> ${dst}`;
  }

  // ---- jam links ----
  // A jammer targets at most one thing; setting a new target overwrites the old.
  set_jam(jammer, target) {
    if (!this.nodes[jammer] || this.nodes[jammer].kind !== 'jammer') return;
    if (!this.is_jammable(target)) return;
    this.jam_links.set(jammer, target);
  }

  clear_jam(jammer) { this.jam_links.delete(jammer); }

  // ---- recolor links ----
  // A rewirer targets at most one source / receiver / relay (connector or
  // inverter); re-marking overwrites. (The "exactly one" is this device's rule,
  // not a framework assumption — other objects may allow a different fixed count.)
  set_recolor(rewirer, target) {
    const rw = this.nodes[rewirer];
    if (!rw || rw.kind !== 'rewirer') return;
    const tg = this.nodes[target];
    if (!tg || !(tg.kind === 'source' || tg.kind === 'receiver' || isRelay(tg.kind))) return;
    this.recolor_links.set(rewirer, target);
  }

  clear_recolor(rewirer) { this.recolor_links.delete(rewirer); }

  // Iterate jam intents as [jammer, target] pairs.
  get jam_pairs() { return [...this.jam_links]; }

  // Is `target` (an id) something a jammer may target right now? Force fields
  // always; jammable carriable kinds (the mine) when present as a node.
  is_jammable(target) {
    if (this.field_by_id(target)) return true;
    const nd = this.nodes[target];
    return Boolean(nd && kindIsJammable(nd.kind));
  }

  remove_node(nid) {
    delete this.nodes[nid];
    this.clear_links_of(nid);
    this.logic_links = this.logic_links.filter(l => l[0]!==nid && l[1]!==nid);
    this.jam_links.delete(nid);                                   // as a jammer
    for (const [j, t] of [...this.jam_links])                     // as a target
      if (t === nid) this.jam_links.delete(j);
    this.recolor_links.delete(nid);                               // as a rewirer
    for (const [r, t] of [...this.recolor_links])                 // as a target
      if (t === nid) this.recolor_links.delete(r);
  }

  remove_field(ff) {
    const i = this.ffs.indexOf(ff);
    if (i !== -1) this.ffs.splice(i, 1);
    this.logic_links = this.logic_links.filter(l => l[1] !== ff.id);
    for (const [j, t] of [...this.jam_links])
      if (t === ff.id) this.jam_links.delete(j);
  }

  consumer_pos(dst) {
    if (this.nodes[dst]) return this.nodes[dst].pos;
    const ff = this.field_by_id(dst);
    return ff ? ff.mid() : null;
  }

  // A relay is elevated only when it has been placed onto a box (an explicit
  // state set at placement time) — not merely by being near one.
  _conn_elevated(nid) {
    const nd = this.nodes[nid];
    if (!nd || !isRelay(nd.kind) || nid === this.carrying) return false;
    return nd.elevated === true;
  }

  // Would a material object of radius r placed at `pos` overlap anything solid
  // (walls / barriers / closed force fields), another material object, or the
  // player? Validates where dropped or placed objects may legally rest.
  object_pos_blocked(pos, r, opts = {}) {
    const { ignoreConn = null, ignoreBox = null } = opts;
    const segs = this.walls.map(wl => [wl.p1, wl.p2]);
    for (const ff of this.ffs) if (!ff.is_passable()) segs.push([ff.p1, ff.p2]);
    for (const bar of this.barriers) segs.push([bar.p1, bar.p2]);
    for (const [s1, s2] of segs) if (pt_seg_dist(pos, s1, s2) < r) return true;
    const boxR = OBJECT_TYPES.box.radius;
    for (const b of this.boxes) { if (b === ignoreBox) continue; if (dist(pos, b) < r + boxR) return true; }
    for (const c of this.carriable_nodes()) {
      if (c.id === this.carrying || c.id === ignoreConn) continue;
      const cr = OBJECT_TYPES[c.kind].radius;
      if (dist(pos, c.pos) < r + cr) return true;
    }
    for (const f of this.forges()) {
      if (dist(pos, f.pos) < r + OBJECT_TYPES.forge.radius) return true;
    }
    if (this.player && dist(pos, this.player) < r + PLAYER_R) return true;
    return false;
  }

  // ---- solving ----
  solve(cold = false, fill_instant = true) { this.engine.solve(cold, fill_instant); }
  step(now = null) { return this.engine.step(now); }
  beams_live() { return this.engine.beams_live(); }
  light_blockers() { return this.engine.light_blockers(); }
  // Unobstructed line of sight for a simple ray of `type` (see RAY_OCCLUSION).
  ray_clear(a, b, type, opts = {}) { return this.engine.ray_clear(a, b, type, opts); }

  // ---- player / boxes ----
  move_player(dx, dy) { this.motion.move_player(dx, dy); }
  reach_blocked(a, b) { return this.motion.reach_blocked(a, b); }
  placement_spot(player, ux, uy, r, gap, maxD, wantDist, ignoreConn = null) {
    return this.motion.placement_spot(player, ux, uy, r, gap, maxD, wantDist, ignoreConn);
  }
  at_goal() { return this.motion.at_goal(); }
  player_touching_beam() { return this.motion.player_touching_beam(); }
}
