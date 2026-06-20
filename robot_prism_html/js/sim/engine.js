import {
  EPS, PLAYER_R, BOX_R, CONN_R, BTN_R,
  CUT_LINGER, CROSSING_CUT_INSTANT, LOGIC_KINDS, RECOLOR_DELAY,
} from '../core/constants.js';
import { seg_inter, first_block_t, dist } from '../core/geometry.js';
import { objType, kindIsJammable } from './objects.js';
import { isRelayKind, relayEmit } from './relays.js';
import { rayProfile, rayBlockerSegments } from './occlusion.js';

const PLAYER_OWNER = '__player__';

export class Engine {
  constructor(world) {
    this.world = world;
    this.emit = {};
    this.lit = {};
    this.logic_val = {};
    this.charge = {};
    this.active = {};
    this._fill_instant = false;
    this._charge_t = null;
    this.beams_draw = [];
    this.beam_anim = new Map();
    this._last_solve = null;
    this.beam_eff = new Map();
    this._beam_targets = new Map();
    this._beam_instant = new Map();
    this._last_beams_t = [];
    this.dead_conns = new Set();   // connectors killed by conflicting incoming colours
    // Live jammer rays for the renderer: [{ from, to, live, reaches }]. `live`
    // means the jammer is deployed (on the ground); `reaches` means its ray is
    // currently unobstructed and so its target is held disabled.
    this.jam_rays_draw = [];
    // Live rewirer rays for the renderer: [{ rid, from, to, color, frac, reaches }].
    // `frac` is charge / RECOLOR_DELAY; `reaches` whether the shot is currently clear.
    this.recolor_rays_draw = [];
    this._recolor_t = null;   // last timestamp the recolor charge advanced
  }

  // ---- blockers ----
  _square(c, r) {
    const [x, y] = c;
    const p = [[x-r,y-r],[x+r,y-r],[x+r,y+r],[x-r,y+r]];
    return [[p[0],p[1]],[p[1],p[2]],[p[2],p[3]],[p[3],p[0]]];
  }

  _leveled_blockers() {
    const w = this.world;
    const segs = [];
    for (const wl of w.walls) segs.push([wl.p1, wl.p2, null, null]);
    for (const ff of w.ffs) {
      if (!ff.is_passable()) segs.push([ff.p1, ff.p2, null, null]);
    }
    for (const bx of w.boxes) {
      for (const [s1,s2] of this._square(bx, BOX_R)) segs.push([s1,s2,0,null]);
    }
    // Every material object interrupts a laser beam (RAY_OCCLUSION.laser.object).
    // A connector carries its own id as owner AND its elevation level, so a beam
    // it is a deliberate endpoint of re-emits instead of stopping (handled by the
    // owner filter in _beams_and_cross). A mine / rewirer / jammer is never a beam
    // endpoint, so it always blocks — a device not wired into the chain is just an
    // obstacle. The carried object is skipped (it is in hand, not on the field).
    for (const n of w.carriable_nodes()) {
      if (isRelayKind(n.kind)) {
        if (n.id === w.carrying) continue;
        const lvl = w._conn_elevated(n.id) ? 1 : 0;
        for (const [s1,s2] of this._square(n.pos, CONN_R)) segs.push([s1,s2,lvl,n.id]);
      } else {
        if (n.id === w.carrying) continue;
        const r = objType(n.kind)?.radius ?? CONN_R;
        for (const [s1,s2] of this._square(n.pos, r)) segs.push([s1,s2,0,n.id]);
      }
    }
    // Forges are material fixtures: they occlude beams at every level and are
    // never a beam endpoint, so they always block.
    for (const f of w.forges()) {
      const r = objType(f.kind)?.radius ?? CONN_R;
      for (const [s1,s2] of this._square(f.pos, r)) segs.push([s1,s2,null,f.id]);
    }
    if (w.player_block && w.player) {
      for (const [s1,s2] of this._square(w.player, PLAYER_R))
        segs.push([s1,s2,0,PLAYER_OWNER]);
    }
    return segs;
  }

  light_blockers() {
    return this._leveled_blockers().map(([p1,p2]) => [p1,p2]);
  }

  // Source-distance RANK of every emitting node, by breadth-first search over the
  // LINK graph (purely topological — walls are irrelevant here). Sources are 0,
  // relays linked to a source are 1, relays linked to those are 2, and so on; the
  // shortest link-path wins. Receivers are sinks (never forward), and a carried
  // relay is inert, so neither propagates rank. Unreached relays are absent from
  // the map (treated as +Infinity). Used to make light directional: it flows from
  // lower rank to higher, never back upstream along a connection that is complete.
  _linkRanks() {
    const w = this.world;
    const adj = new Map();
    for (const [a, b] of w.links_pairs) {
      if (!adj.has(a)) adj.set(a, []);
      if (!adj.has(b)) adj.set(b, []);
      adj.get(a).push(b); adj.get(b).push(a);
    }
    const rank = new Map();
    const queue = [];
    for (const n of Object.values(w.nodes))
      if (n.kind === 'source') { rank.set(n.id, 0); queue.push(n.id); }
    for (let head = 0; head < queue.length; head++) {
      const u = queue[head], ru = rank.get(u);
      for (const v of (adj.get(u) || [])) {
        if (rank.has(v) || v === w.carrying) continue;
        const nv = w.nodes[v];
        if (nv && isRelayKind(nv.kind)) { rank.set(v, ru + 1); queue.push(v); }
      }
    }
    return rank;
  }

  beam_level(o, t) {
    const w = this.world;
    return (w._conn_elevated(o) || w._conn_elevated(t)) ? 1 : 0;
  }

  // What a relay (connector / inverter / sister) emits given the set of distinct
  // delivered incoming colours. A *corrupted* relay always emits its own locked
  // colour whenever it receives any light at all — conflicts never kill it ("blue
  // in, red out"). A clean relay defers to its kind's rule (relays.js): a clean
  // connector relays a single colour and goes dark on a conflict; a clean inverter
  // swaps within its pair. One generic call, no per-kind branching here.
  _relay_emit(cid, incoming) {
    return relayEmit(this.world.nodes[cid], incoming);
  }

  // ---- light: beams + crossings ----
  _beams_and_cross(emit) {
    const w = this.world;
    const blockers = this._leveled_blockers();
    const rank = this._linkRanks();
    const RANK = id => (rank.has(id) ? rank.get(id) : Infinity);
    const beams = [];
    for (const [a, b] of w.links_pairs) {
      for (const [o, t] of [[a,b],[b,a]]) {
        const no = w.nodes[o], nt = w.nodes[t];
        if (!no || !nt) continue;
        if (o === w.carrying || t === w.carrying) continue;
        if (emit[o] == null || no.kind === 'receiver') continue;
        const O = no.pos, T = nt.pos;
        const dl = dist(O, T);
        if (dl < 1e-6) continue;
        const level = this.beam_level(o, t);
        const blk = blockers
          .filter(([,, lvl, own]) => (lvl === null || lvl === level) && own !== o && own !== t)
          .map(([p1,p2]) => [p1,p2]);
        const blk_mat = blockers
          .filter(([,, lvl, own]) => (lvl === null || lvl === level) && own !== o && own !== t && own !== PLAYER_OWNER)
          .map(([p1,p2]) => [p1,p2]);
        const bt = first_block_t(O, T, blk);
        const bt_mat = first_block_t(O, T, blk_mat);
        const hard = bt === null ? dl : bt * dl;
        const hard_mat = bt_mat === null ? dl : bt_mat * dl;
        // Directional law: light flows from a lower rank to a higher one, never
        // back. So a higher→lower beam is suppressed WHEN the connection is
        // complete — i.e. nothing material stands between them (hard_mat reaches).
        // With a wall between, the connection is incomplete and BOTH ends radiate
        // at it (no suppression). Same-rank / unreached pairs are never suppressed.
        const clear = hard_mat >= dl - 1e-6;
        if (clear && RANK(o) > RANK(t)) continue;
        // Same-rank head-on on a clear path: two equal-priority relays are peers.
        // If they carry DIFFERENT colours they clash — each beam is capped at the
        // MIDPOINT so it splits there and feeds neither end. But if BOTH ends carry
        // the SAME colour there is nothing to clash over, so the ray simply
        // connects (full length, delivers across). Capping per beam (rather than a
        // mutual cut needing both ends lit) keeps the clash stable — a lit peer
        // still only reaches halfway whether or not the other is lit — so no
        // feedback loop can form (e.g. a mixer that consumes a same-rank relay).
        let H = hard, HM = hard_mat;
        const sameColour = emit[o] != null && emit[o] === emit[t];
        if (clear && RANK(o) === RANK(t) && !sameColour) { H = Math.min(H, dl / 2); HM = Math.min(HM, dl / 2); }
        const dx = (T[0]-O[0])/dl, dy = (T[1]-O[1])/dl;
        beams.push({ o, t, color: emit[o], O, T, dl, hard: H, hard_mat: HM, level, dx, dy });
      }
    }
    const n = beams.length;
    const cross = [];
    for (let i = 0; i < n; i++) {
      const bi = beams[i];
      const Ei = [bi.O[0]+bi.dx*bi.hard, bi.O[1]+bi.dy*bi.hard];
      for (let j = i+1; j < n; j++) {
        const bj = beams[j];
        if (bi.o===bj.o||bi.o===bj.t||bi.t===bj.o||bi.t===bj.t) continue;
        if (bi.level !== bj.level) continue;
        const Ej = [bj.O[0]+bj.dx*bj.hard, bj.O[1]+bj.dy*bj.hard];
        const r = seg_inter(bi.O, Ei, bj.O, Ej);
        if (!r) continue;
        const [, tA, tB] = r;
        if (EPS < tA && tA < 1-EPS && EPS < tB && tB < 1-EPS)
          cross.push([i, j, tA*bi.hard, tB*bj.hard]);
      }
    }
    return [beams, cross];
  }

  resolve(emit) {
    const [beams, cross] = this._beams_and_cross(emit);
    const n = beams.length;
    let length = beams.map(b => b.hard);
    for (let iter = 0; iter < 4*n+10; iter++) {
      const newl = beams.map(b => b.hard);
      for (const [i, j, di, dj] of cross) {
        if (length[j] >= dj-EPS && di < newl[i]) newl[i] = di;
        if (length[i] >= di-EPS && dj < newl[j]) newl[j] = dj;
      }
      if (newl.every((v,k) => Math.abs(v-length[k]) < 1e-6)) { length = newl; break; }
      length = newl;
    }
    const delivery = length.map((v,k) => v >= beams[k].dl - 1e-6);
    return [beams, length, delivery];
  }

  propagate() {
    const w = this.world;
    const conns = Object.values(w.nodes)
      .filter(n => isRelayKind(n.kind) && n.id !== w.carrying)
      .map(n => n.id);
    const emit = {};
    for (const [nid, nd] of Object.entries(w.nodes))
      emit[nid] = nd.kind === 'source' ? nd.color : null;
    let last = null;
    for (let iter = 0; iter < 2*conns.length+6; iter++) {
      const [beams, length, delivery] = this.resolve(emit);
      const incoming = {};
      for (const c of conns) incoming[c] = new Set();
      for (let k = 0; k < beams.length; k++) {
        if (delivery[k] && isRelayKind(w.nodes[beams[k].t]?.kind))
          incoming[beams[k].t].add(beams[k].color);
      }
      let changed = false;
      for (const c of conns) {
        const nc = this._relay_emit(c, incoming[c]);
        if (nc !== emit[c]) { emit[c] = nc; changed = true; }
      }
      last = [beams, length, delivery];
      if (!changed) break;
    }
    if (last === null) last = this.resolve(emit);
    return [emit, last];
  }

  _lit_map(beams, delivery) {
    const w = this.world;
    const lit = {};
    for (const n of Object.values(w.nodes))
      if (n.kind === 'receiver') lit[n.id] = false;
    for (let k = 0; k < beams.length; k++) {
      if (delivery[k]) {
        const nt = w.nodes[beams[k].t];
        if (nt?.kind === 'receiver' && beams[k].color === nt.color) lit[nt.id] = true;
      }
    }
    return lit;
  }

  // Relays that received light but emit nothing — "dead" / confused. For a clean
  // connector that means two or more distinct incoming colours; for a clean
  // inverter, also a single off-pair colour. A corrupted relay emits its locked
  // colour regardless, so it is never dead. Their links render dotted, the same
  // inert look a carried relay's links have.
  _conflict_map(beams, delivery) {
    const w = this.world;
    const inc = {};
    for (const n of Object.values(w.nodes))
      if (isRelayKind(n.kind)) inc[n.id] = new Set();
    for (let k = 0; k < beams.length; k++) {
      if (!delivery[k]) continue;
      const t = beams[k].t;
      if (isRelayKind(w.nodes[t]?.kind)) inc[t].add(beams[k].color);
    }
    const dead = new Set();
    for (const id in inc) {
      const nd = w.nodes[id];
      if (nd?.color) continue;                 // corrupted relays never die
      if (inc[id].size >= 1 && this._relay_emit(id, inc[id]) === null) dead.add(id);
    }
    return dead;
  }

  button_pressed(bid) {
    const w = this.world;
    const bp = w.nodes[bid].pos;
    if (w.player && dist(w.player, bp) < BTN_R) return true;
    if (w.boxes.some(bx => dist(bx, bp) < BTN_R)) return true;
    return Object.values(w.nodes).some(
      n => isRelayKind(n.kind) && n.id !== w.carrying && dist(n.pos, bp) < BTN_R
    );
  }

  // ---- receiver charging ----
  _receiver_on(nid, lit) {
    if (!lit[nid]) return false;
    if (this._fill_instant) return true;
    const ft = this.world.nodes[nid].fill_time;
    if (ft <= 0) return true;
    return (this.charge[nid] ?? 0) >= ft - 1e-9;
  }

  _update_charge(lit, now) {
    const dt = this._charge_t === null ? 0 : Math.max(0, now - this._charge_t);
    this._charge_t = now;
    let changed = false;
    for (const n of Object.values(this.world.nodes)) {
      if (n.kind !== 'receiver') continue;
      const cur = this.charge[n.id] ?? 0;
      let nv;
      if (lit[n.id] && n.fill_time > 0) nv = Math.min(n.fill_time, cur + dt);
      else nv = 0;
      if (Math.abs(nv - cur) > 1e-9) changed = true;
      this.charge[n.id] = nv;
    }
    return changed;
  }

  _active_map(lit) {
    const out = {};
    for (const n of Object.values(this.world.nodes))
      if (n.kind === 'receiver') out[n.id] = this._receiver_on(n.id, lit);
    return out;
  }

  // ---- boolean logic ----
  evaluate_logic(lit, pressed) {
    const w = this.world;
    const val = {};
    for (const [nid, nd] of Object.entries(w.nodes)) {
      if (nd.kind === 'receiver') val[nid] = this._receiver_on(nid, lit);
      else if (nd.kind === 'button') val[nid] = pressed[nid] ?? false;
      else if (LOGIC_KINDS.includes(nd.kind)) val[nid] = false;
    }
    const gates = Object.values(w.nodes).filter(n => LOGIC_KINDS.includes(n.kind));
    for (let iter = 0; iter < gates.length+2; iter++) {
      let changed = false;
      for (const g of gates) {
        const ins = w.logic_links
          .filter(([,dst]) => dst === g.id)
          .map(([src,,neg]) => neg !== Boolean(val[src] ?? false));
        const nv = ins.length === 0 ? false
          : (g.kind === 'and' ? ins.every(Boolean) : ins.some(Boolean));
        if (nv !== val[g.id]) { val[g.id] = nv; changed = true; }
      }
      if (!changed) break;
    }
    return val;
  }

  field_open(ff, val) {
    const ins = this.world.logic_links
      .filter(([,dst]) => dst === ff.id)
      .map(([src,,neg]) => neg !== Boolean(val[src] ?? false));
    return ins.length > 0 && ins.some(Boolean);
  }

  // ---- line of sight (shared) ----
  // Is a simple ray of `type` (per RAY_OCCLUSION) unobstructed from `a` to `b`?
  // The single chokepoint every line-of-sight check goes through — the jammer
  // and rewirer reach tests below, plus the UI's "possible targets" highlight.
  // `opts` forwards the per-ray exclusions (excludeFieldId / excludeNodeIds) so a
  // ray never self-blocks on its own target / emitter.
  ray_clear(a, b, type, opts = {}) {
    const prof = rayProfile(type);
    if (!prof) return true;
    const segs = rayBlockerSegments(this.world, prof, opts);
    return first_block_t(a, b, segs) === null;
  }

  // ---- jammer rays ----
  // The jammer ray is "dark matter": per RAY_OCCLUSION.jammer it ignores light
  // beams, other rays, the player, boxes and connectors — it is stopped ONLY by
  // black walls and by a force field that is currently *active* (and not the
  // one it targets). `excludeFieldId` is that target. Reads live is_open /
  // disabled state, so it is re-evaluated every iteration as fields settle.
  _jam_blocked(a, b, excludeFieldId = null) {
    return !this.ray_clear(a, b, 'jammer', { excludeFieldId });
  }

  // Resolve a jam target id to { pos, excludeFieldId } or null. A force field
  // targets its own midpoint (and excludes itself from blockers); a jammable
  // node (a mine) targets its position.
  _jam_target(tid) {
    const w = this.world;
    const ff = w.field_by_id(tid);
    if (ff) return { pos: ff.mid(), excludeFieldId: ff.id };
    const nd = w.nodes[tid];
    if (nd && kindIsJammable(nd.kind)) return { pos: nd.pos, excludeFieldId: null };
    return null;
  }

  // The set of target ids currently held disabled by a live, reaching jam ray.
  // Only deployed jammers (not the carried one) bite; a target is disabled if
  // ANY reaching ray hits it, so several jammers stack independently.
  _compute_jam_disabled() {
    const w = this.world;
    const out = new Set();
    for (const [jid, tid] of w.jam_links) {
      const jn = w.nodes[jid];
      if (!jn || jn.kind !== 'jammer' || jid === w.carrying) continue;
      const tg = this._jam_target(tid);
      if (!tg) continue;
      if (!this._jam_blocked(jn.pos, tg.pos, tg.excludeFieldId)) out.add(tid);
    }
    return out;
  }

  // Write a freshly-computed disabled set onto the world's fields and jammable
  // nodes. Returns true if anything changed (drives the solve fixed point).
  _apply_jam_disabled(set) {
    const w = this.world;
    let changed = false;
    for (const ff of w.ffs) {
      const nv = set.has(ff.id);
      if (nv !== ff.disabled) { ff.disabled = nv; changed = true; }
    }
    for (const n of Object.values(w.nodes)) {
      if (!kindIsJammable(n.kind)) continue;
      const nv = set.has(n.id);
      if (nv !== n.disabled) { n.disabled = nv; changed = true; }
    }
    return changed;
  }

  // Rebuild the renderer's jam-ray list from settled state. Includes the carried
  // jammer's intent (drawn as a faint preview, never live) so the mark is visible
  // while positioning, plus every deployed jammer's live ray.
  _build_jam_rays() {
    const w = this.world;
    const out = [];
    for (const [jid, tid] of w.jam_links) {
      const jn = w.nodes[jid];
      if (!jn || jn.kind !== 'jammer') continue;
      const tg = this._jam_target(tid);
      if (!tg) continue;
      const live = jid !== w.carrying;
      const reaches = live && !this._jam_blocked(jn.pos, tg.pos, tg.excludeFieldId);
      out.push({ from: [...jn.pos], to: [...tg.pos], live, reaches });
    }
    this.jam_rays_draw = out;
  }

  // ---- rewirer rays (recolour) ----
  // Can a deployed rewirer see its target? The rewirer ray profile stops on
  // walls, tan barriers, active force fields, objects and the player; only purple
  // barriers and passable fields let it through. The rewirer's own body and the
  // target's body are excluded so they never self-block.
  _recolor_reaches(rw, tgt) {
    return this.ray_clear(rw.pos, tgt.pos, 'rewirer',
      { excludeNodeIds: new Set([rw.id, tgt.id]) });
  }

  // Advance each deployed rewirer's charge while it holds a clear shot; reset it
  // to zero whenever it is carried, has no target, or cannot reach (the delay
  // must run from a continuous clear shot). Firing itself is committed by the UI
  // (so it can be made undoable) — see ready_rewirers. Returns whether anything
  // changed (keeps the loop live while charging).
  _update_recolor(now) {
    const w = this.world;
    const dt = this._recolor_t === null ? 0 : Math.max(0, now - this._recolor_t);
    this._recolor_t = now;
    let changed = false;
    for (const [rid, tid] of w.recolor_links) {
      const rw = w.nodes[rid];
      if (!rw || rw.kind !== 'rewirer' || rw.spent) continue;
      const tgt = w.nodes[tid];
      const cur = rw.recolor_charge ?? 0;
      let nv;
      if (rid === w.carrying || !tgt || !this._recolor_reaches(rw, tgt)) nv = 0;
      else nv = Math.min(RECOLOR_DELAY, cur + dt);
      if (Math.abs(nv - cur) > 1e-9) changed = true;
      rw.recolor_charge = nv;
    }
    return changed;
  }

  // Deployed rewirers whose charge has completed — ready for the UI to fire.
  ready_rewirers() {
    const w = this.world;
    const out = [];
    for (const [rid] of w.recolor_links) {
      const rw = w.nodes[rid];
      if (rw && !rw.spent && rid !== w.carrying && (rw.recolor_charge ?? 0) >= RECOLOR_DELAY - 1e-6)
        out.push(rid);
    }
    return out;
  }

  _build_recolor_rays() {
    const w = this.world;
    const out = [];
    for (const [rid, tid] of w.recolor_links) {
      const rw = w.nodes[rid], tgt = w.nodes[tid];
      if (!rw || !tgt || rw.spent) continue;
      const live = rid !== w.carrying;
      const reaches = live && this._recolor_reaches(rw, tgt);
      out.push({
        rid, from: [...rw.pos], to: [...tgt.pos], color: rw.color,
        frac: Math.max(0, Math.min(1, (rw.recolor_charge ?? 0) / RECOLOR_DELAY)),
        live, reaches,
      });
    }
    this.recolor_rays_draw = out;
  }

  solve(cold = false, fill_instant = true) {
    const w = this.world;
    this._fill_instant = fill_instant;
    w.pressed = {};
    for (const n of Object.values(w.nodes))
      if (n.kind === 'button') w.pressed[n.id] = this.button_pressed(n.id);
    if (cold) {
      for (const ff of w.ffs) { ff.is_open = false; ff.disabled = false; }
      for (const n of Object.values(w.nodes)) if (kindIsJammable(n.kind)) n.disabled = false;
      for (const n of Object.values(w.nodes)) if (n.kind === 'rewirer') n.recolor_charge = 0;
      this._recolor_t = null;
      this.beam_anim.clear();
      this.charge = {};
      for (const n of Object.values(w.nodes))
        if (n.kind === 'receiver') this.charge[n.id] = 0;
      this._charge_t = null;
    }
    for (let iter = 0; iter < 30; iter++) {
      let changed = this._apply_jam_disabled(this._compute_jam_disabled());
      const [emit, [beams, length, delivery]] = this.propagate();
      const lit = this._lit_map(beams, delivery);
      const val = this.evaluate_logic(lit, w.pressed);
      for (const ff of w.ffs) {
        const nw = this.field_open(ff, val);
        if (nw !== ff.is_open) { ff.is_open = nw; changed = true; }
      }
      if (!changed) break;
    }
    this._apply_jam_disabled(this._compute_jam_disabled());
    const [emit, [beams, length, delivery]] = this.propagate();
    this.emit = emit;
    this.lit = this._lit_map(beams, delivery);
    this.active = this._active_map(this.lit);
    this.logic_val = this.evaluate_logic(this.lit, w.pressed);
    for (const ff of w.ffs) ff.is_open = this.field_open(ff, this.logic_val);
    this._build_jam_rays();
    this._build_recolor_rays();
    this._last_solve = [beams, length, delivery];
    this.dead_conns = this._conflict_map(beams, delivery);
    this.beams_draw = this._animate_beams(beams, length, delivery);
    // Sync timed-step store with settled snapshot
    this.beam_eff = new Map();
    this._beam_targets = new Map();
    this._beam_instant = new Map();
    for (let k = 0; k < beams.length; k++) {
      const b = beams[k];
      const key = `${b.o}\x00${b.t}`;
      this.beam_eff.set(key, { len: length[k], since: null });
      this._beam_targets.set(key, length[k]);
      this._beam_instant.set(key, length[k]);
    }
    this._last_beams_t = beams;
  }

  // ---- cut animation ----
  _animate_beams(beams, length, delivery, now = null) {
    if (now === null) now = performance.now() / 1000;
    const out = [];
    const seen = new Set();
    for (let k = 0; k < beams.length; k++) {
      const b = beams[k];
      const key = `${b.o}\x00${b.t}`;
      seen.add(key);
      const Lnew = length[k], dnew = delivery[k];
      let st = this.beam_anim.get(key);
      if (!st) { st = { len: Lnew, deliv: dnew, since: null }; this.beam_anim.set(key, st); }
      if (Lnew >= st.len - 1e-6) {
        st.len = Lnew; st.deliv = dnew; st.since = null;
      } else {
        if (st.since === null) st.since = now;
        if (now - st.since >= CUT_LINGER) { st.len = Lnew; st.deliv = dnew; st.since = null; }
      }
      out.push([[...b.O], [b.O[0]+b.dx*st.len, b.O[1]+b.dy*st.len], b.color, st.deliv]);
    }
    for (const key of [...this.beam_anim.keys()])
      if (!seen.has(key)) this.beam_anim.delete(key);
    return out;
  }

  refresh_beams() {
    if (!this._last_solve) return false;
    const [beams, length, delivery] = this._last_solve;
    const nd = this._animate_beams(beams, length, delivery);
    if (JSON.stringify(nd) !== JSON.stringify(this.beams_draw)) {
      this.beams_draw = nd; return true;
    }
    return false;
  }

  // ---- time-stepped solve ----
  resolve_timed(emit) {
    const [beams, cross] = this._beams_and_cross(emit);
    const n = beams.length;
    const is_new = beams.map(b => !this.beam_eff.has(`${b.o}\x00${b.t}`));
    const eff = beams.map((b,k) =>
      is_new[k] ? b.hard : (this.beam_eff.get(`${b.o}\x00${b.t}`)?.len ?? b.hard)
    );
    for (let iter = 0; iter < 4*n+10; iter++) {
      let changed = false;
      for (const [i,j,di,dj] of cross) {
        if (is_new[i] && eff[j]>=dj-EPS && eff[i]>di+EPS) { eff[i]=di; changed=true; }
        if (is_new[j] && eff[i]>=di-EPS && eff[j]>dj+EPS) { eff[j]=dj; changed=true; }
      }
      if (!changed) break;
    }
    const target = beams.map(b => b.hard);
    const instant = beams.map(b => b.hard_mat);
    for (const [i,j,di,dj] of cross) {
      if (eff[j]>=dj-EPS && di<target[i]) target[i]=di;
      if (eff[i]>=di-EPS && dj<target[j]) target[j]=dj;
      if (CROSSING_CUT_INSTANT) {
        if (eff[j]>=dj-EPS && di<instant[i]) instant[i]=di;
        if (eff[i]>=di-EPS && dj<instant[j]) instant[j]=dj;
      }
    }
    for (let k = 0; k < n; k++) instant[k] = Math.max(instant[k], target[k]);
    const delivery = eff.map((v,k) => v >= beams[k].dl - 1e-6);
    return [beams, target, instant, eff, delivery];
  }

  propagate_timed() {
    const w = this.world;
    const conns = Object.values(w.nodes)
      .filter(n => isRelayKind(n.kind) && n.id !== w.carrying)
      .map(n => n.id);
    const emit = {};
    for (const [nid, nd] of Object.entries(w.nodes))
      emit[nid] = nd.kind === 'source' ? nd.color : null;
    let last = null;
    for (let iter = 0; iter < 2*conns.length+6; iter++) {
      const [beams, target, instant, eff, delivery] = this.resolve_timed(emit);
      const incoming = {};
      for (const c of conns) incoming[c] = new Set();
      for (let k = 0; k < beams.length; k++) {
        if (delivery[k] && isRelayKind(w.nodes[beams[k].t]?.kind))
          incoming[beams[k].t].add(beams[k].color);
      }
      let changed = false;
      for (const c of conns) {
        const nc = this._relay_emit(c, incoming[c]);
        if (nc !== emit[c]) { emit[c] = nc; changed = true; }
      }
      last = [beams, target, instant, eff, delivery];
      if (!changed) break;
    }
    if (last === null) last = this.resolve_timed(emit);
    return [emit, last];
  }

  _advance_eff(beams, target, instant, now) {
    let changed = false;
    const seen = new Set();
    for (let k = 0; k < beams.length; k++) {
      const b = beams[k];
      const key = `${b.o}\x00${b.t}`;
      seen.add(key);
      const tgt = target[k], inst = instant[k];
      let st = this.beam_eff.get(key);
      if (!st) {
        st = { len: tgt, since: null };
        this.beam_eff.set(key, st);
        changed = true;
        continue;
      }
      const cur = st.len;
      if (tgt >= cur - 1e-6) {
        if (Math.abs(cur-tgt) > 1e-6 || st.since !== null) changed = true;
        st.len = tgt; st.since = null;
      } else if (cur > inst + 1e-6) {
        st.len = inst;
        st.since = (tgt < inst - 1e-6) ? now : null;
        changed = true;
      } else {
        if (tgt >= inst - 1e-6) {
          if (st.since !== null) changed = true;
          st.since = null;
        } else {
          if (st.since === null) { st.since = now; changed = true; }
          else if (now - st.since >= CUT_LINGER) {
            if (Math.abs(st.len - tgt) > 1e-6) changed = true;
            st.len = tgt; st.since = null;
          }
        }
      }
    }
    for (const key of [...this.beam_eff.keys()]) {
      if (!seen.has(key)) { this.beam_eff.delete(key); changed = true; }
    }
    this._beam_targets = new Map(beams.map((b,k) => [`${b.o}\x00${b.t}`, target[k]]));
    this._beam_instant = new Map(beams.map((b,k) => [`${b.o}\x00${b.t}`, instant[k]]));
    this._last_beams_t = beams;
    return changed;
  }

  _build_draw_timed(beams) {
    return beams.map(b => {
      const L = this.beam_eff.get(`${b.o}\x00${b.t}`)?.len ?? b.hard;
      return [[...b.O], [b.O[0]+b.dx*L, b.O[1]+b.dy*L], b.color, L >= b.dl - 1e-6];
    });
  }

  beams_live() {
    for (const st of this.beam_eff.values()) if (st.since !== null) return true;
    return false;
  }

  step(now = null) {
    if (now === null) now = performance.now() / 1000;
    const w = this.world;
    this._fill_instant = false;
    const old_emit = { ...this.emit };
    const old_open = w.ffs.map(ff => ff.is_open);
    const old_disabled = w.ffs.map(ff => ff.disabled);
    w.pressed = {};
    for (const n of Object.values(w.nodes))
      if (n.kind === 'button') w.pressed[n.id] = this.button_pressed(n.id);
    for (let iter = 0; iter < 30; iter++) {
      let changed = this._apply_jam_disabled(this._compute_jam_disabled());
      const [emit, [beams, target, instant, eff, delivery]] = this.propagate_timed();
      const lit = this._lit_map(beams, delivery);
      const val = this.evaluate_logic(lit, w.pressed);
      for (const ff of w.ffs) {
        const nw = this.field_open(ff, val);
        if (nw !== ff.is_open) { ff.is_open = nw; changed = true; }
      }
      if (!changed) break;
    }
    this._apply_jam_disabled(this._compute_jam_disabled());
    const [emit, [beams, target, instant, eff, delivery]] = this.propagate_timed();
    this.emit = emit;
    this.lit = this._lit_map(beams, delivery);
    const charge_changed = this._update_charge(this.lit, now);
    const recolor_changed = this._update_recolor(now);
    this.active = this._active_map(this.lit);
    this.logic_val = this.evaluate_logic(this.lit, w.pressed);
    for (const ff of w.ffs) ff.is_open = this.field_open(ff, this.logic_val);
    this._build_jam_rays();
    this._build_recolor_rays();
    this.dead_conns = this._conflict_map(beams, delivery);
    const eff_changed = this._advance_eff(beams, target, instant, now);
    this.beams_draw = this._build_draw_timed(beams);
    return eff_changed || charge_changed || recolor_changed
      || JSON.stringify(old_emit) !== JSON.stringify(this.emit)
      || w.ffs.some((ff,i) => ff.is_open !== old_open[i])
      || w.ffs.some((ff,i) => ff.disabled !== old_disabled[i]);
  }

  refresh_timed(now = null) {
    if (!this._last_beams_t.length) return false;
    if (now === null) now = performance.now() / 1000;
    const beams = this._last_beams_t;
    const target = beams.map(b => this._beam_targets.get(`${b.o}\x00${b.t}`) ?? b.hard);
    const instant = beams.map(b => this._beam_instant.get(`${b.o}\x00${b.t}`) ?? b.hard_mat);
    const changed = this._advance_eff(beams, target, instant, now);
    this.beams_draw = this._build_draw_timed(beams);
    return changed;
  }
}
