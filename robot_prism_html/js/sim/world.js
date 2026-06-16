import { BOX_R, CONN_R, PLAYER_R } from '../core/constants.js';
import { dist, pt_seg_dist } from '../core/geometry.js';
import { OBJECT_TYPES } from './objects.js';
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

  new_id(prefix) { this._uid++; return `${prefix}${this._uid}`; }

  add(node) { this.nodes[node.id] = node; return node; }

  connectors() {
    return Object.values(this.nodes).filter(n => n.kind === 'connector');
  }

  field_by_id(fid) {
    return this.ffs.find(ff => ff.id === fid) ?? null;
  }

  // ---- light links ----
  // Links are stored as sorted "a\x00b" keys so each pair is unique.
  _link_key(a, b) { return a < b ? `${a}\x00${b}` : `${b}\x00${a}`; }

  toggle_link(a, b) {
    if (a === b || !this.nodes[a] || !this.nodes[b]) return;
    if (this.nodes[a].kind !== 'connector' && this.nodes[b].kind !== 'connector') return;
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

  remove_node(nid) {
    delete this.nodes[nid];
    this.clear_links_of(nid);
    this.logic_links = this.logic_links.filter(l => l[0]!==nid && l[1]!==nid);
  }

  remove_field(ff) {
    const i = this.ffs.indexOf(ff);
    if (i !== -1) this.ffs.splice(i, 1);
    this.logic_links = this.logic_links.filter(l => l[1] !== ff.id);
  }

  consumer_pos(dst) {
    if (this.nodes[dst]) return this.nodes[dst].pos;
    const ff = this.field_by_id(dst);
    return ff ? ff.mid() : null;
  }

  // A connector is elevated only when it has been placed onto a box (an
  // explicit state set at placement time) — not merely by being near one.
  _conn_elevated(nid) {
    const nd = this.nodes[nid];
    if (!nd || nd.kind !== 'connector' || nid === this.carrying) return false;
    return nd.elevated === true;
  }

  // Would a material object of radius r placed at `pos` overlap anything solid
  // (walls / barriers / closed force fields), another material object, or the
  // player? Validates where dropped or placed objects may legally rest.
  object_pos_blocked(pos, r, opts = {}) {
    const { ignoreConn = null, ignoreBox = null } = opts;
    const segs = this.walls.map(wl => [wl.p1, wl.p2]);
    for (const ff of this.ffs) if (!ff.is_open) segs.push([ff.p1, ff.p2]);
    for (const bar of this.barriers) segs.push([bar.p1, bar.p2]);
    for (const [s1, s2] of segs) if (pt_seg_dist(pos, s1, s2) < r) return true;
    const boxR = OBJECT_TYPES.box.radius, connR = OBJECT_TYPES.connector.radius;
    for (const b of this.boxes) { if (b === ignoreBox) continue; if (dist(pos, b) < r + boxR) return true; }
    for (const c of this.connectors()) {
      if (c.id === this.carrying || c.id === ignoreConn) continue;
      if (dist(pos, c.pos) < r + connR) return true;
    }
    if (this.player && dist(pos, this.player) < r + PLAYER_R) return true;
    return false;
  }

  // ---- solving ----
  solve(cold = false, fill_instant = true) { this.engine.solve(cold, fill_instant); }
  step(now = null) { return this.engine.step(now); }
  beams_live() { return this.engine.beams_live(); }
  light_blockers() { return this.engine.light_blockers(); }

  // ---- player / boxes ----
  move_player(dx, dy) { this.motion.move_player(dx, dy); }
  reach_blocked(a, b) { return this.motion.reach_blocked(a, b); }
  at_goal() { return this.motion.at_goal(); }
  player_touching_beam() { return this.motion.player_touching_beam(); }
}
