import {
  EPS, PLAYER_R, BOX_R, CONN_R, BTN_R,
  CUT_LINGER, CROSSING_CUT_INSTANT, LOGIC_KINDS,
} from '../core/constants.js';
import { seg_inter, first_block_t, dist } from '../core/geometry.js';

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
      if (!ff.is_open) segs.push([ff.p1, ff.p2, null, null]);
    }
    for (const bx of w.boxes) {
      for (const [s1,s2] of this._square(bx, BOX_R)) segs.push([s1,s2,0,null]);
    }
    for (const n of Object.values(w.nodes)) {
      if (n.kind !== 'connector' || n.id === w.carrying) continue;
      const lvl = w._conn_elevated(n.id) ? 1 : 0;
      for (const [s1,s2] of this._square(n.pos, CONN_R)) segs.push([s1,s2,lvl,n.id]);
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

  beam_level(o, t) {
    const w = this.world;
    return (w._conn_elevated(o) || w._conn_elevated(t)) ? 1 : 0;
  }

  // ---- light: beams + crossings ----
  _beams_and_cross(emit) {
    const w = this.world;
    const blockers = this._leveled_blockers();
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
        const dx = (T[0]-O[0])/dl, dy = (T[1]-O[1])/dl;
        beams.push({ o, t, color: emit[o], O, T, dl, hard, hard_mat, level, dx, dy });
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
      .filter(n => n.kind === 'connector' && n.id !== w.carrying)
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
        if (delivery[k] && w.nodes[beams[k].t]?.kind === 'connector')
          incoming[beams[k].t].add(beams[k].color);
      }
      let changed = false;
      for (const c of conns) {
        const s = incoming[c];
        const nc = s.size === 1 ? [...s][0] : null;
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

  // Connectors that received two or more distinct delivered colours and so
  // emit nothing — "dead" by colour conflict. Their links render dotted, the
  // same inert look a carried connector's links have.
  _conflict_map(beams, delivery) {
    const w = this.world;
    const inc = {};
    for (const n of Object.values(w.nodes))
      if (n.kind === 'connector') inc[n.id] = new Set();
    for (let k = 0; k < beams.length; k++) {
      if (!delivery[k]) continue;
      const t = beams[k].t;
      if (w.nodes[t]?.kind === 'connector') inc[t].add(beams[k].color);
    }
    const dead = new Set();
    for (const id in inc) if (inc[id].size >= 2) dead.add(id);
    return dead;
  }

  button_pressed(bid) {
    const w = this.world;
    const bp = w.nodes[bid].pos;
    if (w.player && dist(w.player, bp) < BTN_R) return true;
    if (w.boxes.some(bx => dist(bx, bp) < BTN_R)) return true;
    return Object.values(w.nodes).some(
      n => n.kind === 'connector' && n.id !== w.carrying && dist(n.pos, bp) < BTN_R
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

  solve(cold = false, fill_instant = true) {
    const w = this.world;
    this._fill_instant = fill_instant;
    w.pressed = {};
    for (const n of Object.values(w.nodes))
      if (n.kind === 'button') w.pressed[n.id] = this.button_pressed(n.id);
    if (cold) {
      for (const ff of w.ffs) ff.is_open = false;
      this.beam_anim.clear();
      this.charge = {};
      for (const n of Object.values(w.nodes))
        if (n.kind === 'receiver') this.charge[n.id] = 0;
      this._charge_t = null;
    }
    for (let iter = 0; iter < 30; iter++) {
      const [emit, [beams, length, delivery]] = this.propagate();
      const lit = this._lit_map(beams, delivery);
      const val = this.evaluate_logic(lit, w.pressed);
      let changed = false;
      for (const ff of w.ffs) {
        const nw = this.field_open(ff, val);
        if (nw !== ff.is_open) { ff.is_open = nw; changed = true; }
      }
      if (!changed) break;
    }
    const [emit, [beams, length, delivery]] = this.propagate();
    this.emit = emit;
    this.lit = this._lit_map(beams, delivery);
    this.active = this._active_map(this.lit);
    this.logic_val = this.evaluate_logic(this.lit, w.pressed);
    for (const ff of w.ffs) ff.is_open = this.field_open(ff, this.logic_val);
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
      out.push([[...b.O], [b.O[0]+b.dx*st.len, b.O[1]+b.dy*st.len], b.color, st.deliv, b.o, b.t]);
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
      .filter(n => n.kind === 'connector' && n.id !== w.carrying)
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
        if (delivery[k] && w.nodes[beams[k].t]?.kind === 'connector')
          incoming[beams[k].t].add(beams[k].color);
      }
      let changed = false;
      for (const c of conns) {
        const s = incoming[c];
        const nc = s.size === 1 ? [...s][0] : null;
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
      return [[...b.O], [b.O[0]+b.dx*L, b.O[1]+b.dy*L], b.color, L >= b.dl - 1e-6, b.o, b.t];
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
    w.pressed = {};
    for (const n of Object.values(w.nodes))
      if (n.kind === 'button') w.pressed[n.id] = this.button_pressed(n.id);
    for (let iter = 0; iter < 30; iter++) {
      const [emit, [beams, target, instant, eff, delivery]] = this.propagate_timed();
      const lit = this._lit_map(beams, delivery);
      const val = this.evaluate_logic(lit, w.pressed);
      let changed = false;
      for (const ff of w.ffs) {
        const nw = this.field_open(ff, val);
        if (nw !== ff.is_open) { ff.is_open = nw; changed = true; }
      }
      if (!changed) break;
    }
    const [emit, [beams, target, instant, eff, delivery]] = this.propagate_timed();
    this.emit = emit;
    this.lit = this._lit_map(beams, delivery);
    const charge_changed = this._update_charge(this.lit, now);
    this.active = this._active_map(this.lit);
    this.logic_val = this.evaluate_logic(this.lit, w.pressed);
    for (const ff of w.ffs) ff.is_open = this.field_open(ff, this.logic_val);
    this.dead_conns = this._conflict_map(beams, delivery);
    const eff_changed = this._advance_eff(beams, target, instant, now);
    this.beams_draw = this._build_draw_timed(beams);
    return eff_changed || charge_changed
      || JSON.stringify(old_emit) !== JSON.stringify(this.emit)
      || w.ffs.some((ff,i) => ff.is_open !== old_open[i]);
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
