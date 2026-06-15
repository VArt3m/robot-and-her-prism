"""The World: scene state plus the light/logic/force-field solver.

Holds every entity (nodes, walls, barriers, boxes, force-fields) and the two
solvers that drive them:

  * ``solve()``  -- the instantaneous settle used in the editor / on reset.
  * ``step()``   -- one real-time tick whose cuts apply with a CUT_LINGER delay,
                    so dependency chains are dynamic and paradox loops oscillate.

It also owns the movement / reach / theft rules for the player and boxes.
"""

import time

from .constants import (
    EPS, PLAYER_R, BOX_R, CONN_R, BTN_R, BEAM_TOUCH, CUT_LINGER,
    CROSSING_CUT_INSTANT, LOGIC_KINDS,
)
from .geometry import seg_inter, first_block_t, dist, pt_seg_dist


class World:
    PLAYER_OWNER = "__player__"     # owner tag for the player's body as a blocker;
                                    # never a node id, so beams still respect it, but
                                    # the timed solver can single it out for lingering.

    def __init__(self):
        self.nodes = {}
        self.walls, self.ffs, self.barriers, self.boxes = [], [], [], []
        self.links = set()              # light links: connector aiming
        self.logic_links = []           # [src_id, dst_id, negate]; dst = logic node or field id
        self.goal = None
        self.player = None
        self.player_start = None
        self.carrying = None
        self.player_block = False
        self._uid = 0
        self.emit, self.lit, self.pressed, self.logic_val = {}, {}, {}, {}
        self.beams_draw = []
        # cut animation: per-beam drawn length lags a fresh cut by CUT_LINGER.
        self.beam_anim = {}             # (o,t) -> {"len","deliv","since"}
        self._last_solve = None         # cached (beams, length, delivery) for re-animating between solves
        # time-stepped play: a beam's EFFECTIVE (logical) length lags a fresh cut
        # by CUT_LINGER too, so the delay is real -- it feeds back into who-cuts-
        # whom and what each beam delivers, which lets dependency chains be dynamic
        # and paradoxical loops oscillate instead of freezing. Driven by step().
        self.beam_eff = {}              # (o,t) -> {"len","since"}  (logical truth in play)
        self._beam_targets = {}         # (o,t) -> geometric target length to relax toward
        self._beam_instant = {}         # (o,t) -> length justified by INSTANT cuts only
                                        # (material / fields / -- optionally -- crossings);
                                        # the player's body may cut below this, and only
                                        # that extra cut lingers.
        self._last_beams_t = []         # last beam geometry list seen by the timed solver

    def new_id(self, prefix):
        self._uid += 1
        return f"{prefix}{self._uid}"

    def add(self, node):
        self.nodes[node.id] = node
        return node

    def connectors(self):
        return [n for n in self.nodes.values() if n.kind == "connector"]

    def field_by_id(self, fid):
        for ff in self.ffs:
            if ff.id == fid:
                return ff
        return None

    # ---- light links ----
    def toggle_link(self, a, b):
        if a == b or a not in self.nodes or b not in self.nodes:
            return
        if self.nodes[a].kind != "connector" and self.nodes[b].kind != "connector":
            return
        key = tuple(sorted((a, b)))
        self.links.discard(key) if key in self.links else self.links.add(key)

    def clear_links_of(self, nid):
        self.links = {k for k in self.links if nid not in k}

    # ---- logic links ----
    def toggle_logic_link(self, src, dst):
        for l in self.logic_links:
            if l[0] == src and l[1] == dst:
                if l[2] is False:
                    l[2] = True
                    return "set NOT on " + src + " -> " + dst
                self.logic_links.remove(l)
                return "removed " + src + " -> " + dst
        self.logic_links.append([src, dst, False])
        return "linked " + src + " -> " + dst

    def remove_node(self, nid):
        self.nodes.pop(nid, None)
        self.clear_links_of(nid)
        self.logic_links = [l for l in self.logic_links if l[0] != nid and l[1] != nid]

    def remove_field(self, ff):
        if ff in self.ffs:
            self.ffs.remove(ff)
        self.logic_links = [l for l in self.logic_links if l[1] != ff.id]

    def consumer_pos(self, dst):
        if dst in self.nodes:
            return self.nodes[dst].pos
        ff = self.field_by_id(dst)
        return ff.mid() if ff else None

    # ---- blockers ----
    def _square(self, c, r):
        x, y = c
        p = [(x - r, y - r), (x + r, y - r), (x + r, y + r), (x - r, y + r)]
        return [(p[i], p[(i + 1) % 4]) for i in range(4)]

    def _conn_elevated(self, nid):
        # a connector "sits on a box" (is elevated) when it overlaps a box centre.
        nd = self.nodes.get(nid)
        if not nd or nd.kind != "connector" or nid == self.carrying:
            return False
        return any(dist(nd.pos, bx) < BOX_R for bx in self.boxes)

    def _leveled_blockers(self):
        # (p1, p2, level, owner): level None blocks every beam (tall: walls /
        # closed fields); 0 = ground material; 1 = elevated material. owner lets
        # a beam ignore the body it starts or ends inside, and lets the timed
        # solver tell the player's (forgiving) body apart from material blockers.
        segs = [(w.p1, w.p2, None, None) for w in self.walls]
        for ff in self.ffs:
            if not ff.is_open:
                segs.append((ff.p1, ff.p2, None, None))
        for bx in self.boxes:
            for (s1, s2) in self._square(bx, BOX_R):
                segs.append((s1, s2, 0, None))
        for n in self.nodes.values():
            if n.kind != "connector" or n.id == self.carrying:
                continue
            lvl = 1 if self._conn_elevated(n.id) else 0
            for (s1, s2) in self._square(n.pos, CONN_R):
                segs.append((s1, s2, lvl, n.id))
        if self.player_block and self.player:
            for (s1, s2) in self._square(self.player, PLAYER_R):
                segs.append((s1, s2, 0, self.PLAYER_OWNER))
        return segs

    def light_blockers(self):
        return [(p1, p2) for (p1, p2, _lvl, _own) in self._leveled_blockers()]

    def beam_level(self, o, t):
        return 1 if (self._conn_elevated(o) or self._conn_elevated(t)) else 0

    # ---- light: beams + crossings with partial lengths ----
    def _beams_and_cross(self, emit):
        # Build every live beam (geometry, hard-blocker length, level, direction)
        # and the list of crossings between same-level beams. Shared by both the
        # instantaneous solver (resolve) and the time-stepped one (resolve_timed);
        # only the cut RESOLUTION differs between them.
        blockers = self._leveled_blockers()
        beams = []
        for (a, b) in self.links:
            for (o, t) in ((a, b), (b, a)):
                no, nt = self.nodes.get(o), self.nodes.get(t)
                if not no or not nt:
                    continue
                # a carried connector is lifted out of play: it neither emits
                # nor is tracked as a target by any other ray.
                if o == self.carrying or t == self.carrying:
                    continue
                # An emitter still radiates ALONG a link aimed at a source: the
                # beam travels toward that source (and can be cut on the way) --
                # it just delivers nothing there, since sources don't receive.
                # Suppressing it would stop a connector that has (re)acquired a
                # colour from lighting up the segment back toward the source.
                if emit.get(o) is None or no.kind == "receiver":
                    continue
                O, T = no.pos, nt.pos
                dl = dist(O, T)
                if dl < 1e-6:
                    continue
                level = self.beam_level(o, t)
                blk = [(s1, s2) for (s1, s2, lvl, own) in blockers
                       if (lvl is None or lvl == level) and own != o and own != t]
                # ...and the same set with the player's (forgiving) body removed, so
                # the timed solver knows how far the beam reaches on MATERIAL/FIELD
                # blockers alone -- everything down to that point cuts instantly; only
                # the player can cut nearer than that, and that nearer cut lingers.
                blk_mat = [(s1, s2) for (s1, s2, lvl, own) in blockers
                           if (lvl is None or lvl == level) and own != o and own != t
                           and own != self.PLAYER_OWNER]
                bt = first_block_t(O, T, blk)
                bt_mat = first_block_t(O, T, blk_mat)
                hard = dl if bt is None else bt * dl
                hard_mat = dl if bt_mat is None else bt_mat * dl
                beams.append({"o": o, "t": t, "color": emit[o], "O": O, "T": T,
                              "dl": dl, "hard": hard, "hard_mat": hard_mat, "level": level,
                              "dx": (T[0] - O[0]) / dl, "dy": (T[1] - O[1]) / dl})
        n = len(beams)
        cross = []
        for i in range(n):
            bi = beams[i]
            Ei = (bi["O"][0] + bi["dx"] * bi["hard"], bi["O"][1] + bi["dy"] * bi["hard"])
            for j in range(i + 1, n):
                bj = beams[j]
                if {bi["o"], bi["t"]} & {bj["o"], bj["t"]}:
                    continue
                if bi["level"] != bj["level"]:   # elevated beams clear ground ones
                    continue
                Ej = (bj["O"][0] + bj["dx"] * bj["hard"], bj["O"][1] + bj["dy"] * bj["hard"])
                r = seg_inter(bi["O"], Ei, bj["O"], Ej)
                if not r:
                    continue
                _, tA, tB = r
                if EPS < tA < 1 - EPS and EPS < tB < 1 - EPS:
                    cross.append((i, j, tA * bi["hard"], tB * bj["hard"]))
        return beams, cross

    def resolve(self, emit):
        beams, cross = self._beams_and_cross(emit)
        n = len(beams)
        length = [b["hard"] for b in beams]
        for _ in range(4 * n + 10):
            newl = [b["hard"] for b in beams]
            for (i, j, di, dj) in cross:
                if length[j] >= dj - EPS and di < newl[i]:
                    newl[i] = di
                if length[i] >= di - EPS and dj < newl[j]:
                    newl[j] = dj
            if all(abs(newl[k] - length[k]) < 1e-6 for k in range(n)):
                length = newl
                break
            length = newl
        delivery = [length[k] >= beams[k]["dl"] - 1e-6 for k in range(n)]
        return beams, length, delivery

    def propagate(self):
        conns = [n.id for n in self.connectors() if n.id != self.carrying]
        emit = {nid: (nd.color if nd.kind == "source" else None)
                for nid, nd in self.nodes.items()}
        last = None
        for _ in range(2 * len(conns) + 6):
            beams, length, delivery = self.resolve(emit)
            incoming = {c: set() for c in conns}
            for k, b in enumerate(beams):
                if delivery[k] and self.nodes[b["t"]].kind == "connector":
                    incoming[b["t"]].add(b["color"])
            changed = False
            for c in conns:
                s = incoming[c]
                nc = next(iter(s)) if len(s) == 1 else None
                if nc != emit[c]:
                    emit[c] = nc
                    changed = True
            last = (beams, length, delivery)
            if not changed:
                break
        if last is None:
            last = self.resolve(emit)
        return emit, last

    def _lit_map(self, beams, delivery):
        lit = {n.id: False for n in self.nodes.values() if n.kind == "receiver"}
        for k, b in enumerate(beams):
            if delivery[k]:
                nt = self.nodes[b["t"]]
                if nt.kind == "receiver" and b["color"] == nt.color:
                    lit[nt.id] = True
        return lit

    def button_pressed(self, bid):
        bp = self.nodes[bid].pos
        if self.player and dist(self.player, bp) < BTN_R:
            return True
        if any(dist(bx, bp) < BTN_R for bx in self.boxes):
            return True
        return any(n.kind == "connector" and n.id != self.carrying
                   and dist(n.pos, bp) < BTN_R for n in self.nodes.values())

    # ---- boolean control logic ----
    def evaluate_logic(self, lit, pressed):
        val = {}
        for nid, nd in self.nodes.items():
            if nd.kind == "receiver":
                val[nid] = lit.get(nid, False)
            elif nd.kind == "button":
                val[nid] = pressed.get(nid, False)
            elif nd.kind in LOGIC_KINDS:
                val[nid] = False
        gates = [n for n in self.nodes.values() if n.kind in LOGIC_KINDS]
        for _ in range(len(gates) + 2):
            changed = False
            for g in gates:
                ins = [(neg != bool(val.get(src, False)))
                       for (src, dst, neg) in self.logic_links if dst == g.id]
                nv = (all(ins) if g.kind == "and" else any(ins)) if ins else False
                if nv != val[g.id]:
                    val[g.id] = nv
                    changed = True
            if not changed:
                break
        return val

    def field_open(self, ff, val):
        ins = [(neg != bool(val.get(src, False)))
               for (src, dst, neg) in self.logic_links if dst == ff.id]
        return any(ins) if ins else False

    def solve(self, cold=False):
        # Hysteresis / latching: by default we seed the iteration from the
        # CURRENT gate states, so a self-sustaining open loop (a source beyond a
        # gate feeding the connector that holds the gate open) stays open even
        # when the original trigger is removed -- light outruns the gate. cold=True
        # forces a fresh start (all shut), used on load / entering play / reset.
        self.pressed = {n.id: self.button_pressed(n.id)
                        for n in self.nodes.values() if n.kind == "button"}
        if cold:
            for ff in self.ffs:
                ff.is_open = False
            self.beam_anim.clear()
        for _ in range(30):
            emit, (beams, length, delivery) = self.propagate()
            lit = self._lit_map(beams, delivery)
            val = self.evaluate_logic(lit, self.pressed)
            changed = False
            for ff in self.ffs:
                new = self.field_open(ff, val)
                if new != ff.is_open:
                    ff.is_open = new
                    changed = True
            if not changed:
                break
        emit, (beams, length, delivery) = self.propagate()
        self.emit = emit
        self.lit = self._lit_map(beams, delivery)
        self.logic_val = self.evaluate_logic(self.lit, self.pressed)
        for ff in self.ffs:
            ff.is_open = self.field_open(ff, self.logic_val)
        self._last_solve = (beams, length, delivery)
        self.beams_draw = self._animate_beams(beams, length, delivery)
        # Keep the time-stepped store in sync with this settled snapshot, so a
        # later step() in play continues smoothly and only lags genuinely-new cuts
        # rather than re-lingering everything that was already settled.
        self.beam_eff = {(b["o"], b["t"]): {"len": length[k], "since": None}
                         for k, b in enumerate(beams)}
        self._beam_targets = {(b["o"], b["t"]): length[k] for k, b in enumerate(beams)}
        # a settled scene is, by definition, sitting on its floor: no cut is pending,
        # so the instant floor equals the resolved length for every beam.
        self._beam_instant = {(b["o"], b["t"]): length[k] for k, b in enumerate(beams)}
        self._last_beams_t = beams

    # ---- cut animation ----
    def _animate_beams(self, beams, length, delivery, now=None):
        # Build the drawn beam list, lagging any FRESH shortening (a new cut)
        # by CUT_LINGER seconds: an existing ray keeps its old length for a
        # third of a second, then the cut-off part disappears. Growth (a cut
        # being removed) is applied at once.
        if now is None:
            now = time.monotonic()
        out, seen = [], set()
        for k, b in enumerate(beams):
            key = (b["o"], b["t"])
            seen.add(key)
            Lnew, dnew = length[k], delivery[k]
            st = self.beam_anim.get(key)
            if st is None:
                st = {"len": Lnew, "deliv": dnew, "since": None}
                self.beam_anim[key] = st
            if Lnew >= st["len"] - 1e-6:
                st["len"], st["deliv"], st["since"] = Lnew, dnew, None
            else:
                # a shorter result than what we're drawing == a fresh cut
                if st["since"] is None:
                    st["since"] = now
                if now - st["since"] >= CUT_LINGER:
                    st["len"], st["deliv"], st["since"] = Lnew, dnew, None
                # else: keep the old (longer) len & delivery for now
            end = (b["O"][0] + b["dx"] * st["len"], b["O"][1] + b["dy"] * st["len"])
            out.append((tuple(b["O"]), end, b["color"], st["deliv"]))
        for key in list(self.beam_anim):
            if key not in seen:
                del self.beam_anim[key]
        return out

    def refresh_beams(self):
        # Re-run the cut animation against the last solve so a pending linger
        # still resolves on frames where nothing else triggers a solve(). Returns
        # True if the drawn beams changed.
        if self._last_solve is None:
            return False
        new_draw = self._animate_beams(*self._last_solve)
        if new_draw != self.beams_draw:
            self.beams_draw = new_draw
            return True
        return False

    # ---- time-stepped solve (logical cut delay -> dynamic / oscillating chains) ----
    def resolve_timed(self, emit):
        # Like resolve(), but with a logical distinction between an EXISTING ray and
        # a NEWCOMER. An existing beam keeps its lagged effective length (so a fresh
        # cut on it lingers ~CUT_LINGER before applying). A newcomer is born ALREADY
        # cut by whatever it crosses -- it never pokes out the far side of a beam
        # that was already there, not even for one frame -- so we solve the new
        # beams' extents against the (fixed) extents of the existing ones. `target`
        # is the geometry each beam relaxes toward; `eff` is the length in play now.
        beams, cross = self._beams_and_cross(emit)
        n = len(beams)
        is_new = [(b["o"], b["t"]) not in self.beam_eff for b in beams]
        eff = [b["hard"] if is_new[k] else self.beam_eff[(b["o"], b["t"])]["len"]
               for k, b in enumerate(beams)]
        # Cut only the NEW beams down to where an already-present beam blocks them
        # (existing beams stay pinned at their lagged length here).
        for _ in range(4 * n + 10):
            changed = False
            for (i, j, di, dj) in cross:
                if is_new[i] and eff[j] >= dj - EPS and eff[i] > di + EPS:
                    eff[i] = di
                    changed = True
                if is_new[j] and eff[i] >= di - EPS and eff[j] > dj + EPS:
                    eff[j] = dj
                    changed = True
            if not changed:
                break
        # Geometric target: nearest crossing whose other beam currently reaches it.
        # Existing beams linger toward this; new beams are already sitting at it.
        # `target` is the full geometry (incl. the player's body). `instant` is the
        # floor justified by MATERIAL + FORCE-FIELD blockers only (b["hard_mat"]) --
        # the timed advance applies any cut down to `instant` immediately, and lets
        # only the deeper, player-made cut (target < instant) linger.
        target = [b["hard"] for b in beams]
        instant = [b["hard_mat"] for b in beams]
        for (i, j, di, dj) in cross:
            if eff[j] >= dj - EPS and di < target[i]:   # j reaches -> cuts i
                target[i] = di
            if eff[i] >= di - EPS and dj < target[j]:
                target[j] = dj
            if CROSSING_CUT_INSTANT:                    # opt-in: ray-on-ray is instant too
                if eff[j] >= dj - EPS and di < instant[i]:
                    instant[i] = di
                if eff[i] >= di - EPS and dj < instant[j]:
                    instant[j] = dj
        # the player can only cut a beam SHORTER than material does; keep the floor
        # at or above the final target so the lingering region is exactly that gap.
        instant = [max(instant[k], target[k]) for k in range(n)]
        delivery = [eff[k] >= beams[k]["dl"] - 1e-6 for k in range(n)]
        return beams, target, instant, eff, delivery

    def propagate_timed(self):
        conns = [n.id for n in self.connectors() if n.id != self.carrying]
        emit = {nid: (nd.color if nd.kind == "source" else None)
                for nid, nd in self.nodes.items()}
        last = None
        for _ in range(2 * len(conns) + 6):
            beams, target, instant, eff, delivery = self.resolve_timed(emit)
            incoming = {c: set() for c in conns}
            for k, b in enumerate(beams):
                if delivery[k] and self.nodes[b["t"]].kind == "connector":
                    incoming[b["t"]].add(b["color"])
            changed = False
            for c in conns:
                s = incoming[c]
                nc = next(iter(s)) if len(s) == 1 else None
                if nc != emit[c]:
                    emit[c] = nc
                    changed = True
            last = (beams, target, instant, eff, delivery)
            if not changed:
                break
        if last is None:
            last = self.resolve_timed(emit)
        return emit, last

    def _advance_eff(self, beams, target, instant, now):
        # Relax each beam's effective length toward its geometry. The motion splits
        # into two parts:
        #   * down to `instant` (the material/field floor): applied AT ONCE -- a box,
        #     a set-down connector, a wall, or a closing force-field cuts the beam the
        #     instant it intrudes. Growth (any cut removed) is likewise immediate.
        #   * below `instant` down to `target`: this only happens when the PLAYER'S
        #     body is the nearer blocker, and THAT cut is held for CUT_LINGER before
        #     it bites -- so a brief pass (which never even sets player_block) is free,
        #     and a committed block fades smoothly. Stepping aside restores instantly.
        # `instant >= target` always (the player can only cut nearer than material).
        changed = False
        seen = set()
        for k, b in enumerate(beams):
            key = (b["o"], b["t"])
            seen.add(key)
            tgt, inst = target[k], instant[k]
            st = self.beam_eff.get(key)
            if st is None:                       # newcomer: born already cut to its
                st = {"len": tgt, "since": None}     # final target, with no linger
                self.beam_eff[key] = st
                changed = True
                continue
            cur = st["len"]
            if tgt >= cur - 1e-6:                # growing / steady -> immediate
                if abs(cur - tgt) > 1e-6 or st["since"] is not None:
                    changed = True
                st["len"], st["since"] = tgt, None
            elif cur > inst + 1e-6:              # an INSTANT (material/field) cut is
                # pending -- snap straight down to the floor now. If the player wants
                # to cut deeper still, start its linger clock from here.
                st["len"] = inst
                st["since"] = now if tgt < inst - 1e-6 else None
                changed = True
            else:                                # only the player's deeper cut remains
                if tgt >= inst - 1e-6:           # no player cut wanted -> sit on floor
                    if st["since"] is not None:
                        changed = True
                    st["since"] = None
                else:                            # player cut: linger, then apply
                    if st["since"] is None:
                        st["since"] = now
                        changed = True
                    elif now - st["since"] >= CUT_LINGER:
                        if abs(st["len"] - tgt) > 1e-6:
                            changed = True
                        st["len"], st["since"] = tgt, None
        for key in list(self.beam_eff):
            if key not in seen:
                del self.beam_eff[key]
                changed = True
        self._beam_targets = {(beams[k]["o"], beams[k]["t"]): target[k]
                              for k in range(len(beams))}
        self._beam_instant = {(beams[k]["o"], beams[k]["t"]): instant[k]
                              for k in range(len(beams))}
        self._last_beams_t = beams
        return changed

    def _build_draw_timed(self, beams):
        out = []
        for b in beams:
            L = self.beam_eff.get((b["o"], b["t"]), {}).get("len", b["hard"])
            end = (b["O"][0] + b["dx"] * L, b["O"][1] + b["dy"] * L)
            out.append((tuple(b["O"]), end, b["color"], L >= b["dl"] - 1e-6))
        return out

    def beams_live(self):
        # True while any cut is mid-linger -- i.e. the world is still evolving and
        # should keep being stepped even if the player isn't doing anything.
        return any(st["since"] is not None for st in self.beam_eff.values())

    def step(self, now=None):
        # One real-time tick of the solver. Identical control logic to solve(), but
        # the CUT is applied to the logic with a CUT_LINGER delay (growth instant).
        # Because that lagged effective length feeds back into both who-cuts-whom
        # and what each beam delivers, dependency chains are dynamic and a loop with
        # no stable assignment (A cuts B ... D cuts A, which un-cuts B) oscillates in
        # real time. Returns True if anything changed (used to keep stepping). Call
        # once per frame during play; solve(cold=True) for instant settles/resets.
        if now is None:
            now = time.monotonic()
        old_emit = dict(self.emit)
        old_open = [ff.is_open for ff in self.ffs]
        self.pressed = {n.id: self.button_pressed(n.id)
                        for n in self.nodes.values() if n.kind == "button"}
        for _ in range(30):                      # field-latching loop (eff frozen here)
            emit, (beams, target, instant, eff, delivery) = self.propagate_timed()
            lit = self._lit_map(beams, delivery)
            val = self.evaluate_logic(lit, self.pressed)
            changed = False
            for ff in self.ffs:
                nw = self.field_open(ff, val)
                if nw != ff.is_open:
                    ff.is_open = nw
                    changed = True
            if not changed:
                break
        emit, (beams, target, instant, eff, delivery) = self.propagate_timed()
        self.emit = emit
        self.lit = self._lit_map(beams, delivery)
        self.logic_val = self.evaluate_logic(self.lit, self.pressed)
        for ff in self.ffs:
            ff.is_open = self.field_open(ff, self.logic_val)
        eff_changed = self._advance_eff(beams, target, instant, now)   # advance the lag
        self.beams_draw = self._build_draw_timed(beams)
        return (eff_changed or old_emit != self.emit
                or old_open != [ff.is_open for ff in self.ffs])

    def refresh_timed(self, now=None):
        # Advance only the lag toward the last targets (no re-solve) and rebuild the
        # drawn beams -- lets an in-flight cut finish on a frame we choose not to
        # fully re-step. Returns True if a beam snapped (logic should be re-stepped).
        if not self._last_beams_t:
            return False
        if now is None:
            now = time.monotonic()
        target = [self._beam_targets.get((b["o"], b["t"]), b["hard"])
                  for b in self._last_beams_t]
        instant = [self._beam_instant.get((b["o"], b["t"]), b["hard_mat"])
                   for b in self._last_beams_t]
        changed = self._advance_eff(self._last_beams_t, target, instant, now)
        self.beams_draw = self._build_draw_timed(self._last_beams_t)
        return changed

    # ---- player / boxes ----
    def _static_blocked(self, old, new, carry):
        segs = [(w.p1, w.p2) for w in self.walls]
        for ff in self.ffs:
            if not ff.is_open:
                segs.append((ff.p1, ff.p2))
        for bar in self.barriers:
            if bar.kind == "tan" or (bar.kind == "purple" and carry):
                segs.append((bar.p1, bar.p2))
        for (s1, s2) in segs:
            r = seg_inter(old, new, s1, s2)
            if r:
                _, t, u = r
                if -EPS <= t <= 1 + EPS and -EPS <= u <= 1 + EPS:
                    return True
        return False

    def _box_blocked(self, idx, old, new):
        segs = [(w.p1, w.p2) for w in self.walls]
        for ff in self.ffs:
            if not ff.is_open:
                segs.append((ff.p1, ff.p2))
        for bar in self.barriers:
            segs.append((bar.p1, bar.p2))
        for (s1, s2) in segs:
            r = seg_inter(old, new, s1, s2)
            if r:
                _, t, u = r
                if -EPS <= t <= 1 + EPS and -EPS <= u <= 1 + EPS:
                    return True
        for j, bx in enumerate(self.boxes):
            if j != idx and dist(new, bx) < 2 * BOX_R - 2:
                return True
        return False

    def _press_set(self, player_pos, boxes):
        # which buttons would be held down for this player/box configuration.
        out = {}
        for n in self.nodes.values():
            if n.kind != "button":
                continue
            bp = n.pos
            out[n.id] = bool(
                (player_pos and dist(player_pos, bp) < BTN_R)
                or any(dist(b, bp) < BTN_R for b in boxes)
                or any(c.kind == "connector" and c.id != self.carrying
                       and dist(c.pos, bp) < BTN_R for c in self.nodes.values()))
        return out

    def _hypothetical_open(self, player_pos, boxes):
        # Dry-run: which force-fields end up OPEN if the player and boxes were
        # in this configuration, settling with the SAME latching the live solver
        # uses (seeded from current gate states). All touched state is restored.
        if not self.ffs:
            return {}
        saved = (self.player, self.boxes, self.pressed,
                 [ff.is_open for ff in self.ffs])
        self.player = list(player_pos) if player_pos else None
        self.boxes = [list(b) for b in boxes]
        try:
            for _ in range(30):
                self.pressed = {n.id: self.button_pressed(n.id)
                                for n in self.nodes.values() if n.kind == "button"}
                emit, (beams, length, delivery) = self.propagate()
                lit = self._lit_map(beams, delivery)
                val = self.evaluate_logic(lit, self.pressed)
                changed = False
                for ff in self.ffs:
                    nw = self.field_open(ff, val)
                    if nw != ff.is_open:
                        ff.is_open = nw
                        changed = True
                if not changed:
                    break
            return {ff.id: ff.is_open for ff in self.ffs}
        finally:
            self.player, self.boxes, self.pressed = saved[0], saved[1], saved[2]
            for ff, s in zip(self.ffs, saved[3]):
                ff.is_open = s

    def _box_critical_fields(self, box_index, boxes):
        # Force-fields that are OPEN right now but would CLOSE if this particular
        # box stopped holding its button(s) -- i.e. gates this box itself props
        # open. The player may not reach across, step across, or shove the box
        # through such a gate, because doing so depends on the very lock the move
        # is about to flip. This is independent of the per-step push distance, so
        # it also stops the box from being walked off the button one nudge at a
        # time.
        if not self.ffs or box_index is None:
            return []
        open_now = {ff.id for ff in self.ffs if ff.is_open}
        if not open_now:
            return []
        far = [list(b) for b in boxes]
        far[box_index] = [1e7, 1e7]            # lift this box out of the world
        after = self._hypothetical_open(self.player, far)
        return [(ff.p1, ff.p2) for ff in self.ffs
                if ff.id in open_now and not after.get(ff.id, True)]

    def _theft_blocked(self, old, new, reach_to, boxes_after,
                       push_idx=None, box_new=None):
        # Delimiting surfaces (walls, tan, purple, force-fields) must not be used
        # to reach across and "steal" a box, nor may a single move slip the player
        # across a field that the very same move causes to shut. A currently-open
        # immediate path is fine; a path that depends on a lock the move itself
        # flips is not.
        def crosses(a, b, segs):
            for (s1, s2) in segs:
                r = seg_inter(a, b, s1, s2)
                if r:
                    _, t, u = r
                    if -EPS <= t <= 1 + EPS and -EPS <= u <= 1 + EPS:
                        return True
            return False

        closed_now = [(ff.p1, ff.p2) for ff in self.ffs if not ff.is_open]
        # Only pay for a latching dry-run when the move can actually move a gate:
        # a shoved box (light may shift), the player's body blocking light, or a
        # change in which buttons are held.
        need_dry = bool(self.ffs) and (
            reach_to is not None
            or self.player_block
            or self._press_set(old, self.boxes) != self._press_set(new, boxes_after))
        if need_dry:
            after_open = self._hypothetical_open(new, boxes_after)
            closed_after = [(ff.p1, ff.p2) for ff in self.ffs
                            if not after_open.get(ff.id, True)]
        else:
            closed_after = closed_now

        # The player's own step may not ride a closing gate across.
        if crosses(old, new, closed_after):
            return True
        # Reaching out to shove a box may not cross any delimiting surface, nor a
        # field that is shut now or becomes shut once the box has been moved.
        barrier_segs = [(b.p1, b.p2) for b in self.barriers]   # tan + purple
        wall_segs = [(wl.p1, wl.p2) for wl in self.walls]
        if reach_to is not None and crosses(
                old, reach_to, wall_segs + barrier_segs + closed_now + closed_after):
            return True

        # A box may not be reached across, walked across, or pushed through a gate
        # that the box itself is currently holding open: taking it that way relies
        # on a lock the move flips. Robust against nudging the box off one step at
        # a time, since "held open by this box" doesn't depend on the step size.
        if push_idx is not None:
            crit = self._box_critical_fields(push_idx, self.boxes)
            if crit and (crosses(old, reach_to, crit)        # reach across the gate
                         or crosses(old, new, crit)          # player body across it
                         or (box_new is not None
                             and crosses(reach_to, box_new, crit))):  # box through it
                return True
        return False

    def move_player(self, dx, dy):
        if not self.player:
            return
        old = tuple(self.player)
        new = (old[0] + dx, old[1] + dy)
        carry = self.carrying is not None
        hit = None
        for i, bx in enumerate(self.boxes):
            if dist(new, bx) < PLAYER_R + BOX_R - 2:
                hit = i
                break
        if hit is not None:
            bx = tuple(self.boxes[hit])
            nb = (bx[0] + dx, bx[1] + dy)
            if self._box_blocked(hit, bx, nb) or self._static_blocked(old, new, carry):
                return
            boxes_after = [list(b) for b in self.boxes]
            boxes_after[hit] = [nb[0], nb[1]]
            if self._theft_blocked(old, new, bx, boxes_after,
                                   push_idx=hit, box_new=nb):
                return
            self.boxes[hit] = [nb[0], nb[1]]
            self.player = [new[0], new[1]]
            return
        if self._static_blocked(old, new, carry):
            return
        if self._theft_blocked(old, new, None, self.boxes):
            return
        self.player = [new[0], new[1]]

    def reach_blocked(self, a, b):
        # Line-of-sight for the player's hands: you cannot grab (and thus pull /
        # "teleport") an object through a delimiting surface. Walls and ALL
        # force-fields -- open or closed -- block, and so do tan and purple
        # barriers: a barrier you cannot carry an object *through* is equally a
        # barrier you cannot reach across to snatch one from the far side.
        segs = [(w.p1, w.p2) for w in self.walls]
        segs += [(ff.p1, ff.p2) for ff in self.ffs]
        segs += [(bar.p1, bar.p2) for bar in self.barriers]
        return first_block_t(a, b, segs) is not None

    def at_goal(self):
        return self.player and self.goal and dist(self.player, self.goal) < 18

    def player_touching_beam(self):
        return any(pt_seg_dist(self.player, a, b) < BEAM_TOUCH
                   for (a, b, _, _) in self.beams_draw)
