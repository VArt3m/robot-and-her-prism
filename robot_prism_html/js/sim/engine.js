import {
  EPS, PLAYER_R, BOX_R, CONN_R, BTN_R, BEAM_TOUCH,
  CUT_LINGER, CROSSING_CUT_INSTANT, LOGIC_KINDS, RECOLOR_DELAY, ACCUM_FILL_SEC,
  ACCUM_FLICKER_GRACE, ACCUM_LAYER_GAP, ACCUM_LAYER_WIDTH,
} from '../core/constants.js';
import { seg_inter, first_block_t, dist, pt_seg_dist, squareSegs } from '../core/geometry.js';
import { objType, kindIsJammable, isAccumulatorKind } from './objects.js';
import { isRelayKind, relayEmit, relayConfused, accumulatorEmit } from './relays.js';
import { rayProfile, rayBlockerSegments } from './occlusion.js';

const PLAYER_OWNER = '__player__';
const EMPTY_SET = new Set();

// The stable per-beam key (origin → target). One source of truth for every map
// the timed/animated beam stores key by.
const beamKey = (o, t) => `${o}\x00${t}`;

// A node that emits as a rank-0 SOURCE of its own colour: a real source, or a
// CHARGED accumulator (a portable source). An empty accumulator emits nothing.
function emitsAsSource(n) {
  return n.kind === 'source' || (isAccumulatorKind(n.kind) && !!n.color);
}

// An EMPTY accumulator on the field is a charging SINK: it COMPUTES a charge
// colour (the additive sum of its strongest feeders) but radiates NOTHING outward
// and holds the weakest rank, so it never pushes back — every beam reaching it is
// absorbed. (A CHARGED accumulator is a source — see emitsAsSource — and a carried
// one is inert.) It is intentionally not a relay kind, so it stays out of the
// relay fixpoint; its intake is computed in a dedicated post-pass.
function isChargingSink(n, carrying) {
  return isAccumulatorKind(n.kind) && !n.color && n.id !== carrying;
}

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
    // Live beams treated as wall-like for the DIRECTIONAL suppression decision
    // only (see _beams_and_cross). Set to the previous frame's beams on the timed
    // path (step), left null on the cold path (solve) so static snapshots and the
    // headless suites are unaffected.
    this._ray_obstacles = null;
    this.dead_conns = new Set();   // connectors killed by conflicting incoming colours
    // Live jammer rays for the renderer: [{ from, to, live, reaches }]. `live`
    // means the jammer is deployed (on the ground); `reaches` means its ray is
    // currently unobstructed and so its target is held disabled.
    this.jam_rays_draw = [];
    // Live rewirer rays for the renderer: [{ rid, from, to, color, frac, reaches }].
    // `frac` is charge / RECOLOR_DELAY; `reaches` whether the shot is currently clear.
    this.recolor_rays_draw = [];
    this._recolor_t = null;   // last timestamp the recolor charge advanced
    // Empty-accumulator charging: accum_charge[id] = seconds of an uninterrupted
    // single incoming colour so far; accum_in[id] = that colour (null when zero or
    // a conflict). At ACCUM_FILL_SEC the UI commits the fill (sets the colour, drops
    // the link). Advanced only in real-time `step`; reset by a cold `solve`.
    this.accum_charge = {};
    this.accum_in = {};
    this.accum_grace = {};       // seconds of grace spent while the outcome flickers off-target
    this._accum_t = null;
    // Per empty accumulator, the colour it would radiate (additive sum of its
    // strongest feeders) and the set of feeder node-ids that produced it. Derived
    // every solve (cold or timed); the charge tracks the colour, and a finished
    // fill cuts exactly these feeder links.
    this._accum_color = {};
    this._accum_feeders = {};
  }

  // ---- blockers ----
  _leveled_blockers() {
    const w = this.world;
    const segs = [];
    for (const wl of w.walls) segs.push([wl.p1, wl.p2, null, null]);
    for (const ff of w.ffs) {
      if (!ff.is_passable()) segs.push([ff.p1, ff.p2, null, null]);
    }
    for (const bx of w.boxes) {
      for (const [s1,s2] of squareSegs(bx, BOX_R)) segs.push([s1,s2,0,null]);
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
        for (const [s1,s2] of squareSegs(n.pos, CONN_R)) segs.push([s1,s2,lvl,n.id]);
      } else {
        if (n.id === w.carrying) continue;
        const r = isAccumulatorKind(n.kind)
          ? this.accumFootprintRadius(n.id)
          : (objType(n.kind)?.radius ?? CONN_R);
        for (const [s1,s2] of squareSegs(n.pos, r)) segs.push([s1,s2,0,n.id]);
      }
    }
    // Forges are material fixtures: they occlude beams at every level and are
    // never a beam endpoint, so they always block.
    for (const f of w.forges()) {
      const r = objType(f.kind)?.radius ?? CONN_R;
      for (const [s1,s2] of squareSegs(f.pos, r)) segs.push([s1,s2,null,f.id]);
    }
    if (w.player_block && w.player) {
      for (const [s1,s2] of squareSegs(w.player, PLAYER_R))
        segs.push([s1,s2,0,PLAYER_OWNER]);
    }
    return segs;
  }

  light_blockers() {
    return this._leveled_blockers().map(([p1,p2]) => [p1,p2]);
  }

  // RANK makes light directional: it flows from lower rank to higher, never back
  // upstream along a complete connection. Sources (and charged accumulators) are
  // rank 0. A relay's rank is NOT a topological link-distance — it is computed from
  // what actually ARRIVES at it, so a tool always sits strictly downstream of every
  // colour it consumes and never pushes back on a feeder:
  //
  //   1. Find everything delivered to the relay. For each incoming COLOUR keep the
  //      strongest (lowest-rank) feeder of it — between blue@1 and blue@2 keep
  //      blue@1; between green@0 and green@2 keep green@0. Those are its feeders.
  //   2. Feed it those per-colour feeders by TIER, strongest first: take all rank-0
  //      feeders at once and ask whether it can emit yet; if not, add all rank-1
  //      feeders; and so on. STOP at the first tier that lets it emit a valid output
  //      — it consumes exactly that prefix and ranks at 1 + that tier, one step below
  //      the feed that satisfied it and above every feeder it actually used. Weaker
  //      feeders past that tier are left out (and, once it is settled, the directional
  //      / same-rank laws suppress them anyway) — so a mixer fed red@0, green@0
  //      and a distant blue@2 makes YELLOW from the near pair at rank 1 and never
  //      reaches for the blue, rather than climbing to also consume blue@2 and make
  //      white. (A mixer CAN emit white — it just stops at the first tier that lets
  //      it emit anything valid, and the near pair already does.)
  //      If NO tier ever lets it emit, it is genuinely confused: unranked and dark.
  //   3. As feeders appear or vanish across the solve, the intake is recomputed and
  //      the feeder set re-derived (the fixpoint lives in `propagate`).
  //
  // This generalises across every relay kind — a connector (one colour) and a mixer
  // (several) use the identical rule; a combiner is simply a relay with more than
  // one feeder. Because rank reads off DELIVERED beams, it co-evolves with `emit`
  // inside the propagate loop rather than being precomputed. Unranked relays (no
  // feed yet) are absent from the map (treated as +Infinity).

  // Rank-0 seeds: the real sources and any charged accumulators. Relays are added
  // by the propagate fixpoint as feed reaches them.
  _sourceRanks() {
    const rank = new Map();
    for (const n of Object.values(this.world.nodes))
      if (emitsAsSource(n)) rank.set(n.id, 0);
    return rank;
  }

  // Invoke cb(beam, targetNode) for every DELIVERED beam — the shared delivery
  // guard the incoming-colour collectors below all start from.
  _forEachDelivered(beams, delivery, cb) {
    const w = this.world;
    for (let k = 0; k < beams.length; k++) {
      if (!delivery[k]) continue;
      const b = beams[k];
      cb(b, w.nodes[b.t]);
    }
  }

  // From a solved beam list + its per-beam delivery flags, collect for every relay
  // (a) the set of distinct colours delivered to it, and (b) per colour the
  // strongest (minimum) feeder rank seen for that colour. `rank` supplies each
  // feeder's own rank (a beam's origin `.o`); an unranked origin counts as +Inf.
  _gatherIncoming(beams, delivery, rank) {
    const w = this.world;
    const incoming = {}, inRank = {};
    for (const n of Object.values(w.nodes))
      if (isRelayKind(n.kind)) { incoming[n.id] = new Set(); inRank[n.id] = new Map(); }
    this._forEachDelivered(beams, delivery, (b, nt) => {
      if (!nt || !isRelayKind(nt.kind)) return;
      incoming[b.t].add(b.color);
      const fr = rank.has(b.o) ? rank.get(b.o) : Infinity;
      const prev = inRank[b.t].get(b.color);
      if (prev === undefined || fr < prev) inRank[b.t].set(b.color, fr);
    });
    return [incoming, inRank];
  }

  // Decide a relay's intake by FEEDER TIER, strongest first (the "hungry relay"
  // rule). Walk the per-colour strongest feeders in ascending rank; at each tier
  // add ALL feeders of that rank at once, then ask whether the relay can now emit a
  // valid output (relayEmit !== null). Stop at the FIRST satisfying tier: the relay
  // consumes exactly that prefix and ranks at 1 + that tier. Weaker feeders past it
  // are left unconsumed — once the relay is settled the directional / same-rank laws
  // suppress them — so its output is fixed by the strongest feeders that suffice.
  // If it can never emit, even after every feeder, it is genuinely confused
  // (unranked, dark). A relay with no feed at all is merely idle — also unranked and
  // dark, but NOT confused (an idle node radiates nothing yet has no error).
  //   inRank: Map(colour -> strongest feeder rank)
  //   → { consumed:Set<colour>, rank:number (Infinity if none), confused, emit }
  _relayIntake(node, inRank) {
    const consumed = new Set();
    if (inRank.size === 0) return { consumed, rank: Infinity, confused: false, emit: null };
    const tiers = [...new Set(inRank.values())].sort((a, b) => a - b);  // ascending; Infinity last
    for (const T of tiers) {
      for (const [c, r] of inRank) if (r === T) consumed.add(c);
      const e = relayEmit(node, consumed);
      if (e !== null) return { consumed, rank: Number.isFinite(T) ? T + 1 : Infinity, confused: false, emit: e };
    }
    return { consumed, rank: Infinity, confused: true, emit: null };   // lit but cannot emit → confused
  }

  // For each EMPTY accumulator (a charging sink), collect per delivered colour the
  // strongest (lowest) feeder rank AND the set of feeder origins at that strongest
  // rank. Unlike the relay intake (which keeps one rank per colour), the accumulator
  // needs the actual feeders: if two or more strongest feeders share a colour, BOTH
  // are feeders — and a finished fill cuts every one of them. `rank` supplies each
  // origin's own rank (an unranked origin counts as +Inf).
  //   → { id -> Map(colour -> { minRank, origins:Set }) }
  _gatherAccumIncoming(beams, delivery, rank) {
    const w = this.world;
    const out = {};
    for (const n of Object.values(w.nodes))
      if (isChargingSink(n, w.carrying)) out[n.id] = new Map();
    this._forEachDelivered(beams, delivery, (b, nt) => {
      if (!nt || !isChargingSink(nt, w.carrying)) return;
      const fr = rank.has(b.o) ? rank.get(b.o) : Infinity;
      const m = out[b.t];
      const e = m.get(b.color);
      if (!e || fr < e.minRank) m.set(b.color, { minRank: fr, origins: new Set([b.o]) });
      else if (fr === e.minRank) e.origins.add(b.o);
    });
    return out;
  }

  // Decide one empty accumulator's intake by FEEDER TIER, strongest first — the same
  // "hungry relay" rule, but it stops at the first tier that radiates ANYTHING (the
  // accumulator has no forbidden colour, so any non-empty tier already emits). The
  // consumed tier fixes both the charge colour and the feeder set (all origins at
  // the consumed tiers, ties included).
  //   perColour: Map(colour -> { minRank, origins:Set })
  //   → { color: string|null, feeders: Set<id> }
  _accumIntake(perColour) {
    const consumed = new Set(), feeders = new Set();
    if (perColour.size === 0) return { color: null, feeders };
    const tiers = [...new Set([...perColour.values()].map(v => v.minRank))].sort((a, b) => a - b);
    for (const T of tiers) {
      for (const [c, e] of perColour)
        if (e.minRank === T) { consumed.add(c); for (const o of e.origins) feeders.add(o); }
      const col = accumulatorEmit(consumed);
      if (col !== null) return { color: col, feeders };
    }
    return { color: accumulatorEmit(consumed), feeders };
  }

  // Two rank maps equal? (same keys, same values) — used to detect the fixpoint.
  _sameRank(a, b) {    if (a.size !== b.size) return false;
    for (const [k, v] of a) if (b.get(k) !== v) return false;
    return true;
  }

  // Back-compat shim: the converged delivery-based ranks. Recomputes a full solve of
  // the light field and returns its rank map (used by tests/inspection).
  _linkRanks() {
    return this.propagate()[2];
  }

  beam_level(o, t) {
    const w = this.world;
    return (w._conn_elevated(o) || w._conn_elevated(t)) ? 1 : 0;
  }

  // ---- light: beams + crossings ----
  _beams_and_cross(emit, rank, confused) {
    const w = this.world;
    const blockers = this._leveled_blockers();
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
        //
        // A live RAY counts as wall-like for THIS decision: if another beam crosses
        // the path (the PREVIOUS frame's beams, `_ray_obstacles`, set only on the
        // timed step), the connection is likewise "incomplete", so the back-beam is
        // emitted — and then cut at the crossing by the ordinary crossing mechanic
        // below. This is a deliberately one-frame-lagged, self-referential rule, so
        // a configuration where the radiated beam cuts its own supply can oscillate
        // (intended); the cold solve leaves `_ray_obstacles` null and never does this.
        //
        // EXCEPTION — a CONFUSED target is still "looking for food": it took light
        // but cannot yet make a valid output, so the rank it currently holds is only
        // PROVISIONAL (computed from the colours that have reached it so far). It must
        // not use that provisional rank to suppress a feeder, or a colour that only
        // arrives via a longer (higher-rank) chain would be rejected and the tool
        // would starve forever — e.g. red reaches a mixer directly (so it provisionally
        // ranks at 1) while its green arrives through a 2-hop chain at rank 2; without
        // this exception the green@2 beam is suppressed and the mixer never completes.
        // So while t is confused we let EVERY incoming beam reach it, whatever the rank
        // direction. Once it has enough food to emit a valid colour it is no longer
        // confused, re-ranks to 1 + its weakest feeder (strictly above all feeders),
        // and from then on correctly suppresses the back-direction toward those feeders
        // — it never pushes back on what feeds it. A confused relay emits null, so it
        // pushes nothing back in the meantime; this only opens the inbound direction.
        const clear = hard_mat >= dl - 1e-6;
        if (clear && RANK(o) > RANK(t) && !confused.has(t)
            && !this._rayCrosses(O, T, level, o, t)) continue;
        // Same-rank head-on on a clear path is a TUG-OF-WAR: two equal-priority
        // emitters push at each other, so each beam is capped at the MIDPOINT —
        // it splits there and feeds NEITHER end (same-rank peers never feed). This
        // holds whatever the colours are, same or different — the `tug` tag we set
        // below only tells the renderer whether to draw a same-colour tug as one
        // smooth full-length ray (a visual link; nothing passes) or a different-
        // colour clash as a two-tone split. Capping per beam (not a mutual cut that
        // needs both ends lit) keeps it stable — a lit peer only reaches halfway
        // whether or not the other is lit — so no feedback loop can form.
        //
        // What counts as a clash peer: an opposing end that actually emits a RAY —
        // a source, a charged accumulator, or a lit relay, INCLUDING one emitting a
        // real BLACK ray (`'black'`, mask 0 but a real colour). A relay emitting
        // NULL is the special case: null is "no light" — a relay that took in light
        // but cannot yet make a valid output is CONFUSED, and a confused relay DOES
        // NOT PUSH BACK. It is "looking for food first": a same-rank feeder's beam is
        // let through in FULL so the relay can complete itself, after which its rank
        // lifts above that feeder (delivery-based rank) and the same-rank coincidence
        // resolves on the next pass — no oscillation, since a fed relay never drops
        // back below its feeder. The only same-rank end that still soft-caps is a
        // dark relay NOT seeking food (no delivered input); it shows the connection
        // full length yet feeds neither way. A pure SINK (a receiver, or an EMPTY
        // accumulator charging up) is not a relay and not a peer, so it falls through
        // with no cap to a real full-length delivery.
        let H = hard, HM = hard_mat;
        const sameColour = emit[o] != null && emit[o] === emit[t];
        const peer = emit[t] != null;            // a real ray (black included); null is not
        let tug = null;
        if (clear && RANK(o) === RANK(t)) {
          if (peer) {
            tug = sameColour ? 'same' : 'clash';
            H = Math.min(H, dl / 2); HM = Math.min(HM, dl / 2);
          } else if (isRelayKind(nt.kind) && !confused.has(t)) {
            // Same-rank dark relay that is NOT seeking food: soft cap (shown full
            // length, feeds neither way). A CONFUSED relay falls through instead —
            // its beam is delivered so it can find its food.
            tug = 'soft';
            H = Math.min(H, dl / 2); HM = Math.min(HM, dl / 2);
          }
        }
        const dx = (T[0]-O[0])/dl, dy = (T[1]-O[1])/dl;
        beams.push({ o, t, color: emit[o], O, T, dl, hard: H, hard_mat: HM, level, dx, dy, tug });
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

  // Does a live beam (from `_ray_obstacles`) cross the segment O→T strictly
  // between its ends, at the same level, without sharing a node with it? Used
  // only to defeat the directional suppression (a crossing ray = wall-like).
  // Returns false whenever there are no obstacles (the cold path), so the static
  // solve is untouched.
  _rayCrosses(O, T, level, o, t) {
    const obs = this._ray_obstacles;
    if (!obs) return false;
    for (const ob of obs) {
      if (ob.level !== level) continue;
      if (ob.o === o || ob.o === t || ob.t === o || ob.t === t) continue;  // meet at a shared node, not a crossing
      const r = seg_inter(O, T, ob.P1, ob.P2);
      if (!r) continue;
      const [, tA, tB] = r;
      if (EPS < tA && tA < 1 - EPS && EPS < tB && tB < 1 - EPS) return true;
    }
    return false;
  }

  // Snapshot the current (about-to-be-previous) frame's beams as wall-like
  // obstacle segments, each spanning its live EFFECTIVE length (where light is
  // actually present — a cut or tug-capped beam blocks only as far as it reaches).
  _buildRayObstacles() {
    const lengths = this._last_beams_t.map(b => this.beam_eff.get(beamKey(b.o, b.t))?.len ?? b.hard);
    return this._obstaclesFromBeams(this._last_beams_t, lengths);
  }

  // Build wall-like obstacle segments from a beam list and the length each beam
  // actually reaches. Shared by the timed snapshot (effective lengths) and the
  // static fixpoint (the previous pass's crossing-resolved lengths).
  _obstaclesFromBeams(beams, lengths) {
    const obs = [];
    for (let k = 0; k < beams.length; k++) {
      const b = beams[k];
      const len = lengths[k];
      if (len < 1e-6) continue;
      obs.push({ o: b.o, t: b.t, level: b.level, P1: b.O, P2: [b.O[0] + b.dx * len, b.O[1] + b.dy * len] });
    }
    return obs;
  }

  // A cheap signature of an obstacle set (which beams reach how far), so the
  // static fixpoint can tell when the rays-as-walls picture has stopped changing.
  _obstacleKey(beams, lengths) {
    return beams.map((b, k) => `${b.o}>${b.t}:${b.level}:${lengths[k].toFixed(2)}`).join('|');
  }
  resolve(emit, rank = null, confused = null) {
    if (rank === null) rank = this._sourceRanks();
    if (confused === null) confused = EMPTY_SET;
    const [beams, cross] = this._beams_and_cross(emit, rank, confused);
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

  // The shared light fixpoint, parameterised by the beam resolver. Each pass
  // solves the beam field for the current emit/rank, then re-derives from what was
  // DELIVERED: every relay's emitted colour, its new rank (1 + weakest of its
  // per-colour strongest feeders), and whether it is confused (took light but no
  // valid output → "looking for food", won't push back next pass). Rank and emit
  // co-evolve; the loop ends when BOTH are stable. Rank and confused are threaded
  // into the next pass so a tool can climb above a feeder it shares a rank with,
  // and so a confused tool stops capping its own food. `resolve` returns a tuple
  // whose first element is `beams` and whose LAST element is `delivery`, so the
  // cold and timed resolvers (different middle fields) both drive this unchanged.
  _propagateWith(resolve, selfObstacles = false) {
    const w = this.world;
    const conns = Object.values(w.nodes)
      .filter(n => isRelayKind(n.kind) && n.id !== w.carrying)
      .map(n => n.id);
    const emit = {};
    for (const [nid, nd] of Object.entries(w.nodes))
      emit[nid] = emitsAsSource(nd) ? nd.color : null;   // sources + charged accumulators
    let rank = this._sourceRanks();
    let confused = EMPTY_SET;
    let last = null;
    let obsKey = null;
    for (let iter = 0; iter < 2*conns.length+6; iter++) {
      // STATIC ray-occlusion: with no "previous frame" to lean on, feed the
      // previous PASS's beams back in as wall-like obstacles, so the suppression
      // decisions converge against the beam field they themselves produce. The
      // loop also re-runs while this picture keeps changing, so it settles to a
      // self-consistent state (or caps, exactly as the timed path may oscillate).
      // The timed path leaves _ray_obstacles fixed (set once per frame).
      if (selfObstacles)
        this._ray_obstacles = last ? this._obstaclesFromBeams(last[0], last[1]) : null;
      const result = resolve(emit, rank, confused);
      const beams = result[0], delivery = result[result.length - 1];
      const [, inRank] = this._gatherIncoming(beams, delivery, rank);
      const newRank = this._sourceRanks();
      const newConfused = new Set();
      let changed = false;
      for (const c of conns) {
        const intake = this._relayIntake(w.nodes[c], inRank[c]);
        if (Number.isFinite(intake.rank)) newRank.set(c, intake.rank);
        if (intake.confused) newConfused.add(c);
        if (intake.emit !== emit[c]) { emit[c] = intake.emit; changed = true; }
      }
      if (!this._sameRank(rank, newRank)) changed = true;
      rank = newRank;
      confused = newConfused;
      last = result;
      if (selfObstacles) {
        const nk = this._obstacleKey(result[0], result[1]);
        if (nk !== obsKey) { changed = true; obsKey = nk; }
      }
      if (!changed) break;
    }
    if (last === null) last = resolve(emit, rank, confused);
    // Empty accumulators are charging SINKS: they radiated nothing and stayed at
    // the weakest rank (absent from `rank`). Record the colour each WOULD radiate
    // (its strongest-feeder sum) and the feeder set that produced it — the charge
    // tracks the colour; a finished fill cuts exactly those feeders.
    this._accum_color = {};
    this._accum_feeders = {};
    {
      const fb = last[0], fd = last[last.length - 1];
      const accIn = this._gatherAccumIncoming(fb, fd, rank);
      for (const id in accIn) {
        const r = this._accumIntake(accIn[id]);
        this._accum_color[id] = r.color;
        this._accum_feeders[id] = r.feeders;
      }
    }
    this._rank = rank;
    this._confused = confused;
    return [emit, last, rank, confused];
  }

  // Cold (full-recompute) light fixpoint. `last` = [beams, length, delivery].
  propagate() {
    return this._propagateWith((e, r, c) => this.resolve(e, r, c), true);
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
    this._forEachDelivered(beams, delivery, (b, nt) => {
      if (isRelayKind(nt?.kind)) inc[b.t].add(b.color);
    });
    const dead = new Set();
    for (const id in inc) {
      if (relayConfused(w.nodes[id], inc[id])) dead.add(id);
    }
    return dead;
  }

  // Is a button at `bp` pressed by the given player position and box set? The
  // shared rule (player, any box, or any non-carried relay within BTN_R), used
  // both for the live world and for motion's hypothetical press sets.
  _buttonAt(bp, player, boxes) {
    return Boolean(
      (player && dist(player, bp) < BTN_R)
      || boxes.some(bx => dist(bx, bp) < BTN_R)
      || Object.values(this.world.nodes).some(
        n => isRelayKind(n.kind) && n.id !== this.world.carrying && dist(n.pos, bp) < BTN_R)
    );
  }

  button_pressed(bid) {
    const w = this.world;
    return this._buttonAt(w.nodes[bid].pos, w.player, w.boxes);
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

  // The boolean inputs feeding `dstId` (a gate or a force field): each logic
  // link into it, with its source's current value and the link's negate flag
  // applied. One definition for gate evaluation and field opening.
  _logicInputs(dstId, val) {
    return this.world.logic_links
      .filter(([,dst]) => dst === dstId)
      .map(([src,,neg]) => neg !== Boolean(val[src] ?? false));
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
        const ins = this._logicInputs(g.id, val);
        const nv = ins.length === 0 ? false
          : (g.kind === 'and' ? ins.every(Boolean) : ins.some(Boolean));
        if (nv !== val[g.id]) { val[g.id] = nv; changed = true; }
      }
      if (!changed) break;
    }
    return val;
  }

  field_open(ff, val) {
    const ins = this._logicInputs(ff.id, val);
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

  // ---- accumulator charging ----
  // The grown footprint radius of a charging accumulator (its external layer), or
  // CONN_R when idle / charged. Driven by the LAST step's charge so it is stable
  // frame-to-frame (a cold solve has no charge, so it reads the base footprint).
  accumFootprintRadius(id) {
    const n = this.world.nodes[id];
    if (n && isAccumulatorKind(n.kind) && !n.color && (this.accum_charge[id] ?? 0) > 0)
      return CONN_R + ACCUM_LAYER_GAP + ACCUM_LAYER_WIDTH;
    return CONN_R;
  }

  // Advance each empty accumulator's charge toward its current OUTCOME colour (the
  // additive sum of its strongest feeders, computed in the solve as _accum_color).
  // Charging needs the outcome to HOLD: a brief flicker to another colour — or to
  // nothing — is tolerated for up to ACCUM_FLICKER_GRACE before the charge is
  // dropped (lost feed) or restarted on the new colour. What matters is the
  // OUTCOME, so swapping one white-making mix for another keeps charging. A carried
  // accumulator is not a charging sink (no entry in _accum_color), so it never
  // charges. Real-time only (like the rewirer charge); a cold solve resets it.
  _update_accum_charge(now) {
    const dt = this._accum_t === null ? 0 : Math.max(0, now - this._accum_t);
    this._accum_t = now;
    let changed = false;
    const colours = this._accum_color || {};
    const live = new Set(Object.keys(colours));
    for (const id of live) {
      const cur = this.accum_charge[id] ?? 0;
      const grace = this.accum_grace[id] ?? 0;
      const target = this.accum_in[id] ?? null;     // the colour we are charging toward
      const out = colours[id] ?? null;              // the current outcome (may be null)
      let nCharge = cur, nTarget = target, nGrace = grace;
      if (out != null && out === target) {                 // steady: advance, clear grace
        nCharge = Math.min(ACCUM_FILL_SEC, cur + dt); nGrace = 0;
      } else if (target == null) {                          // not charging yet: begin on any colour
        if (out != null) { nTarget = out; nCharge = Math.min(ACCUM_FILL_SEC, dt); nGrace = 0; }
      } else {                                              // outcome differs (flicker or a real change)
        nGrace = grace + dt;
        if (nGrace > ACCUM_FLICKER_GRACE) {
          if (out != null) { nTarget = out; nCharge = Math.min(ACCUM_FILL_SEC, dt); nGrace = 0; } // restart on the new colour
          else { nTarget = null; nCharge = 0; nGrace = 0; }                                       // lost the feed: reset
        }
        // within grace: hold the current charge & target, waiting for the outcome to restore
      }
      if (nCharge !== cur || nTarget !== target || nGrace !== grace) changed = true;
      this.accum_charge[id] = nCharge; this.accum_in[id] = nTarget; this.accum_grace[id] = nGrace;
    }
    // Drop state for anything no longer a charging sink (filled / carried / removed).
    for (const id of Object.keys(this.accum_charge))
      if (!live.has(id)) {
        delete this.accum_charge[id]; delete this.accum_in[id]; delete this.accum_grace[id];
        changed = true;
      }
    return changed;
  }

  // Empty accumulators whose charge has completed — ready for the UI to fill: stamp
  // the colour, then cut ONLY its feeder links (the rest are kept). Returns
  // [{ id, color, feeders:[id…] }].
  ready_accumulators() {
    const out = [];
    for (const id in this.accum_charge) {
      const col = this.accum_in[id];
      if (col && (this.accum_charge[id] ?? 0) >= ACCUM_FILL_SEC - 1e-6)
        out.push({ id, color: col, feeders: [...(this._accum_feeders[id] ?? [])] });
    }
    return out;
  }

  // Settle jammers, the light field, and gate open/shut to a mutual fixpoint
  // using `propagateFn` (cold `propagate` or timed `propagate_timed`), then run
  // one final jam-apply + propagate and return its [emit, last]. `last[0]` is the
  // beam list and `last[last.length-1]` is the delivery flags, so both resolver
  // tuple shapes read out the same way. Recomputes `w.pressed` first.
  _settle(propagateFn) {
    const w = this.world;
    w.pressed = {};
    for (const n of Object.values(w.nodes))
      if (n.kind === 'button') w.pressed[n.id] = this.button_pressed(n.id);
    for (let iter = 0; iter < 30; iter++) {
      let changed = this._apply_jam_disabled(this._compute_jam_disabled());
      const [, last] = propagateFn();
      const beams = last[0], delivery = last[last.length - 1];
      const lit = this._lit_map(beams, delivery);
      const val = this.evaluate_logic(lit, w.pressed);
      for (const ff of w.ffs) {
        const nw = this.field_open(ff, val);
        if (nw !== ff.is_open) { ff.is_open = nw; changed = true; }
      }
      if (!changed) break;
    }
    this._apply_jam_disabled(this._compute_jam_disabled());
    return propagateFn();
  }

  solve(cold = false, fill_instant = true) {
    const w = this.world;
    this._fill_instant = fill_instant;
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
      this.accum_charge = {};
      this.accum_in = {};
      this.accum_grace = {};
      this._accum_t = null;
    }
    const [emit, last] = this._settle(() => this.propagate());
    const [beams, length, delivery] = last;
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
      const key = beamKey(b.o, b.t);
      this.beam_eff.set(key, { len: length[k], since: null });
      this._beam_targets.set(key, length[k]);
      this._beam_instant.set(key, length[k]);
    }
    this._last_beams_t = beams;
  }

  // A beam delivered INTO an empty (charging) accumulator: if its origin is NOT one
  // of that accumulator's feeders, it is absorbed by the EXTERNAL LAYER — visually it
  // must stop at the outer border, not reach the inner contour. Returns the capped
  // length (centre → outer edge) or null when no cap applies (a feeder, a charged
  // accumulator, or any other target). Purely visual: the beam is still delivered
  // (absorbed) for the simulation.
  _accumLayerCap(b) {
    const nt = this.world.nodes[b.t];
    if (!nt || !isAccumulatorKind(nt.kind) || nt.color) return null;   // only an EMPTY accumulator
    if (!this._accum_color[b.t]) return null;                          // only while it can radiate
    const feeders = this._accum_feeders[b.t];
    if (feeders && feeders.has(b.o)) return null;                      // a feeder reaches the inner contour
    return Math.max(0, b.dl - this.accumFootprintRadius(b.t));
  }

  // ---- cut animation ----
  _animate_beams(beams, length, delivery, now = null) {
    if (now === null) now = performance.now() / 1000;
    const out = [];
    const seen = new Set();
    for (let k = 0; k < beams.length; k++) {
      const b = beams[k];
      const key = beamKey(b.o, b.t);
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
      // A same-colour tug ('same') and a soft connect to a confused relay ('soft')
      // are both mechanically capped at the midpoint (they neither deliver nor
      // feed), but are SHOWN edge to edge with the delivered look (no stub). Every
      // other beam draws at its real animated length and delivered state.
      const full = b.tug === 'same' || b.tug === 'soft';
      let vlen = full ? b.dl : st.len;
      let vdeliv = full ? true : st.deliv;
      const cap = this._accumLayerCap(b);
      if (cap !== null && vlen > cap) { vlen = cap; vdeliv = false; }
      out.push([[...b.O], [b.O[0]+b.dx*vlen, b.O[1]+b.dy*vlen], b.color, vdeliv, b.tug]);
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
  resolve_timed(emit, rank = null, confused = null) {
    if (rank === null) rank = this._sourceRanks();
    if (confused === null) confused = EMPTY_SET;
    const [beams, cross] = this._beams_and_cross(emit, rank, confused);
    const n = beams.length;
    const is_new = beams.map(b => !this.beam_eff.has(beamKey(b.o, b.t)));
    const eff = beams.map((b,k) =>
      is_new[k] ? b.hard : (this.beam_eff.get(beamKey(b.o, b.t))?.len ?? b.hard)
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

  // Time-stepped light fixpoint. `last` = [beams, target, instant, eff, delivery].
  propagate_timed() {
    return this._propagateWith((e, r, c) => this.resolve_timed(e, r, c));
  }

  _advance_eff(beams, target, instant, now) {
    let changed = false;
    const seen = new Set();
    for (let k = 0; k < beams.length; k++) {
      const b = beams[k];
      const key = beamKey(b.o, b.t);
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
    this._beam_targets = new Map(beams.map((b,k) => [beamKey(b.o, b.t), target[k]]));
    this._beam_instant = new Map(beams.map((b,k) => [beamKey(b.o, b.t), instant[k]]));
    this._last_beams_t = beams;
    return changed;
  }

  _build_draw_timed(beams) {
    return beams.map(b => {
      const L = this.beam_eff.get(beamKey(b.o, b.t))?.len ?? b.hard;
      // A same-colour tug and a soft connect to a confused relay are both shown
      // full length with the delivered look (see _animate_beams); everything else
      // draws at its live effective length.
      const full = b.tug === 'same' || b.tug === 'soft';
      let vlen = full ? b.dl : L;
      let vdeliv = full ? true : (L >= b.dl - 1e-6);
      const cap = this._accumLayerCap(b);
      if (cap !== null && vlen > cap) { vlen = cap; vdeliv = false; }
      return [[...b.O], [b.O[0]+b.dx*vlen, b.O[1]+b.dy*vlen], b.color, vdeliv, b.tug];
    });
  }

  beams_live() {
    for (const st of this.beam_eff.values()) if (st.since !== null) return true;
    return false;
  }

  // Is the player standing on any beam's path? Judged against each beam's length
  // as it would be drawn IGNORING the player — `hard_mat` (the material reach,
  // which excludes the player) for an ordinary beam, and the full length for a
  // tug/soft beam (those are always drawn full and the player never visually cuts
  // them). This is deliberately independent of `player_block`: the dwell test that
  // engages the self-block must not read a beam that the block itself has already
  // retracted off her, or engaging the block would instantly drop "touching" to
  // false and the block would flicker (a long-standing, position-dependent bug).
  player_on_beam() {
    const w = this.world;
    if (!w.player) return false;
    for (const b of this._last_beams_t) {
      const full = b.tug === 'same' || b.tug === 'soft';
      const len = full ? b.dl : b.hard_mat;
      const end = [b.O[0] + b.dx * len, b.O[1] + b.dy * len];
      if (pt_seg_dist(w.player, b.O, end) < BEAM_TOUCH) return true;
    }
    return false;
  }

  step(now = null) {
    if (now === null) now = performance.now() / 1000;
    const w = this.world;
    this._fill_instant = false;
    // Treat the PREVIOUS frame's beams as wall-like obstacles for this frame's
    // directional-suppression decisions (the timed-only ray-occlusion rule).
    this._ray_obstacles = this._buildRayObstacles();
    const old_emit = { ...this.emit };
    const old_open = w.ffs.map(ff => ff.is_open);
    const old_disabled = w.ffs.map(ff => ff.disabled);
    const [emit, last] = this._settle(() => this.propagate_timed());
    const [beams, target, instant, eff, delivery] = last;
    this.emit = emit;
    this.lit = this._lit_map(beams, delivery);
    const charge_changed = this._update_charge(this.lit, now);
    const recolor_changed = this._update_recolor(now);
    const accum_changed = this._update_accum_charge(now);
    this.active = this._active_map(this.lit);
    this.logic_val = this.evaluate_logic(this.lit, w.pressed);
    for (const ff of w.ffs) ff.is_open = this.field_open(ff, this.logic_val);
    this._build_jam_rays();
    this._build_recolor_rays();
    this.dead_conns = this._conflict_map(beams, delivery);
    const eff_changed = this._advance_eff(beams, target, instant, now);
    this.beams_draw = this._build_draw_timed(beams);
    return eff_changed || charge_changed || recolor_changed || accum_changed
      || JSON.stringify(old_emit) !== JSON.stringify(this.emit)
      || w.ffs.some((ff,i) => ff.is_open !== old_open[i])
      || w.ffs.some((ff,i) => ff.disabled !== old_disabled[i]);
  }

  refresh_timed(now = null) {
    if (!this._last_beams_t.length) return false;
    if (now === null) now = performance.now() / 1000;
    const beams = this._last_beams_t;
    const target = beams.map(b => this._beam_targets.get(beamKey(b.o, b.t)) ?? b.hard);
    const instant = beams.map(b => this._beam_instant.get(beamKey(b.o, b.t)) ?? b.hard_mat);
    const changed = this._advance_eff(beams, target, instant, now);
    this.beams_draw = this._build_draw_timed(beams);
    return changed;
  }
}
