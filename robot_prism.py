#!/usr/bin/env python3
"""
robot_prism.py  -- a small original 2-D light-beam puzzle engine + editor.
No assets, no copyrighted content; primitive graphics via tkinter (bundled).

Mechanics
  * Sources have a colour but emit nothing alone.
  * A connector pulls colour from its source side and re-radiates ONE colour.
    Two distinct colours arriving = conflict -> it radiates nothing.
  * Connectors relay and REMEMBER what they aim at (links stored by identity),
    so moving/placing a connector keeps it working.
  * You can only re-aim / clear a connector while standing next to it (or while
    carrying it) -- like reaching its little buttons.
  * Receivers fire on a matching colour. Buttons fire while a player, a box,
    OR a (set-down) connector sits on them.
  * Connectors and boxes are MATERIAL: they block rays, just like the player's
    body. Set a connector ON a box and its beams are elevated -- they clear
    ground-level material and cross over ground beams without cutting. A
    connector set on a box that sits on a button still presses the button.
  * A CARRIED connector is lifted out of play: it neither relays nor blocks and
    is invisible to other rays. Its aiming links are remembered and resume the
    moment it is set down.
  * Force-fields are driven by editable boolean LOGIC: AND / OR nodes, and links
    that can be negated (NOT). A field opens on the OR of its incoming links;
    route through an AND node to require several inputs; flag a link as NOT to
    invert it. Producers (receivers/buttons/logic nodes) may branch to many
    consumers.
  * Force-fields LATCH: the solver keeps each gate's state and re-settles from
    it, so a source placed beyond a gate and fed back into the connector that
    holds the gate open keeps it open even after the original trigger is removed
    (light outruns the gate). A cold reset (G, or re-entering play) clears it.
    Connectors may aim at things beyond a closed gate; the beam is drawn but
    stays blocked until the gate opens.
  * Walls + closed force-fields + boxes block light; tan/purple don't.
  * Crossing live beams cut each other -- resolved iteratively, so a beam cut
    short stops blocking beams further along its old path.
  * A player lingering in a beam (> dwell threshold) cuts it; stepping aside
    restores it. A brief pass does nothing.
  * Open field / purple: player passes (purple blocks the player only while
    carrying a tool); tan blocks the player always; light passes tan & purple.

Run
    python3 robot_prism.py             # editor + sandbox
    python3 robot_prism.py --selftest  # headless engine checks, no window
"""

import math
import sys

EPS = 1e-7
PLAYER_R = 8
BOX_R = 12
CONN_R = 12
BTN_R = 16
BEAM_TOUCH = PLAYER_R + 1
DWELL_THRESH = 0.5
SPEED = 150.0
TICK = 0.033
CONNECT_REACH = 42          # how close you must be to adjust a connector

COLORS = {
    "red": "#e23b3b", "green": "#27a838", "blue": "#2b5cd6",
    "yellow": "#e8c020", "cyan": "#1fb6c4", "magenta": "#c43fb0",
    "orange": "#e07b2a", "tan": "#d9c79a", "purple": "#8e44ad",
}
DIM = {
    "red": "#7a3030", "green": "#2f5a36", "blue": "#34406e",
    "yellow": "#776617", "cyan": "#175c63", "magenta": "#5f2356",
    "orange": "#724321",
}
PALETTE = ["red", "green", "blue", "yellow", "cyan", "magenta", "orange"]
LOGIC_KINDS = ("and", "or")


# --------------------------------------------------------------------------- #
# geometry
# --------------------------------------------------------------------------- #
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


# --------------------------------------------------------------------------- #
# entities
# --------------------------------------------------------------------------- #
class Node:
    # kinds: source / connector / receiver / button / and / or
    def __init__(self, nid, kind, pos, color=None, label=None):
        self.id, self.kind, self.pos = nid, kind, list(pos)
        self.color, self.label = color, label


class Wall:
    def __init__(self, p1, p2): self.p1, self.p2 = list(p1), list(p2)


class Barrier:
    def __init__(self, p1, p2, kind): self.p1, self.p2, self.kind = list(p1), list(p2), kind


class ForceField:
    def __init__(self, fid, p1, p2):
        self.id, self.p1, self.p2 = fid, list(p1), list(p2)
        self.is_open = False

    def mid(self):
        return ((self.p1[0] + self.p2[0]) / 2, (self.p1[1] + self.p2[1]) / 2)


# --------------------------------------------------------------------------- #
# world + solver
# --------------------------------------------------------------------------- #
class World:
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
        # a beam ignore the body it starts or ends inside.
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
                segs.append((s1, s2, 0, None))
        return segs

    def light_blockers(self):
        return [(p1, p2) for (p1, p2, _lvl, _own) in self._leveled_blockers()]

    def beam_level(self, o, t):
        return 1 if (self._conn_elevated(o) or self._conn_elevated(t)) else 0

    # ---- light: beams + crossings with partial lengths ----
    def resolve(self, emit):
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
                if emit.get(o) is None or no.kind == "receiver" or nt.kind == "source":
                    continue
                O, T = no.pos, nt.pos
                dl = dist(O, T)
                if dl < 1e-6:
                    continue
                level = self.beam_level(o, t)
                blk = [(s1, s2) for (s1, s2, lvl, own) in blockers
                       if (lvl is None or lvl == level) and own != o and own != t]
                bt = first_block_t(O, T, blk)
                hard = dl if bt is None else bt * dl
                beams.append({"o": o, "t": t, "color": emit[o], "O": O, "T": T,
                              "dl": dl, "hard": hard, "level": level,
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
        self.beams_draw = []
        for k, b in enumerate(beams):
            end = (b["O"][0] + b["dx"] * length[k], b["O"][1] + b["dy"] * length[k])
            self.beams_draw.append((tuple(b["O"]), end, b["color"], delivery[k]))

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
            bx = self.boxes[hit]
            nb = (bx[0] + dx, bx[1] + dy)
            if self._box_blocked(hit, bx, nb) or self._static_blocked(old, new, carry):
                return
            self.boxes[hit] = [nb[0], nb[1]]
            self.player = [new[0], new[1]]
            return
        if self._static_blocked(old, new, carry):
            return
        self.player = [new[0], new[1]]

    def reach_blocked(self, a, b):
        # line-of-sight for the player's hands: walls and ALL force-fields
        # (open or closed) get in the way, so you can't grab through them.
        segs = [(w.p1, w.p2) for w in self.walls]
        segs += [(ff.p1, ff.p2) for ff in self.ffs]
        return first_block_t(a, b, segs) is not None

    def at_goal(self):
        return self.player and self.goal and dist(self.player, self.goal) < 18

    def player_touching_beam(self):
        return any(pt_seg_dist(self.player, a, b) < BEAM_TOUCH
                   for (a, b, _, _) in self.beams_draw)


# --------------------------------------------------------------------------- #
# the level from our conversation
# --------------------------------------------------------------------------- #
def build_level():
    w = World()
    L, T, R, B = 12, 12, 1006, 628
    w.walls += [Wall((L, T), (R, T)), Wall((R, T), (R, B)),
                Wall((R, B), (L, B)), Wall((L, B), (L, T))]
    w.walls += [Wall((235, 13), (235, 138)), Wall((237, 490), (237, 628))]

    w.add(Node("src_red", "source", (140, 55), color="red"))
    w.add(Node("src_g1", "source", (40, 222), color="green"))
    w.add(Node("src_g2", "source", (40, 425), color="green"))
    w.add(Node("src_blue", "source", (130, 595), color="blue"))

    w.ffs.append(ForceField("ff_top", (786, 250), (1005, 250)))
    w.ffs.append(ForceField("ff_mid", (786, 380), (1005, 380)))
    w.ffs.append(ForceField("ff_bot", (786, 512), (1005, 512)))

    w.add(Node("rcv_green", "receiver", (988, 195), color="green"))
    w.add(Node("rcv_blue", "receiver", (988, 305), color="blue"))
    w.add(Node("rcv_red", "receiver", (988, 440), color="red"))
    w.add(Node("rcv_dead", "receiver", (24, 305), color="green"))

    w.logic_links += [["rcv_green", "ff_top", False],
                      ["rcv_blue", "ff_mid", False],
                      ["rcv_red", "ff_bot", False]]

    w.barriers.append(Barrier((782, 13), (782, 510), "tan"))
    w.barriers.append(Barrier((786, 510), (786, 628), "purple"))

    w.add(Node("con_c", "connector", (445, 293), label="C"))
    w.add(Node("con_1", "connector", (845, 590), label="1"))
    w.add(Node("con_2", "connector", (915, 590), label="2"))

    w.goal = [840, 70]
    w.player_start = [470, 500]
    w.player = list(w.player_start)
    w._uid = 100
    w.solve(cold=True)
    return w


# --------------------------------------------------------------------------- #
# headless self-test
# --------------------------------------------------------------------------- #
def selftest():
    ok = True

    def check(name, cond):
        nonlocal ok
        print(("  PASS " if cond else "  FAIL ") + name)
        ok = ok and cond

    print("Relay / walls:")
    w = build_level()
    w.toggle_link("con_c", "src_g1")
    w.toggle_link("con_c", "rcv_green")
    w.solve()
    check("green relay lights green receiver -> ff_top open",
          w.lit["rcv_green"] and w.field_by_id("ff_top").is_open)
    check("blue source walled off from centre connector",
          first_block_t(w.nodes["src_blue"].pos, w.nodes["con_c"].pos, w.light_blockers()) is not None)

    print("Colour conflict + partial-length (synthetic):")
    p = World()
    p.add(Node("sA", "source", (-10, 50), color="red"))
    p.add(Node("A", "connector", (0, 50)))
    p.add(Node("RA", "receiver", (300, 50), color="red"))
    p.add(Node("sB", "source", (50, -10), color="red"))
    p.add(Node("B", "connector", (50, 0)))
    p.add(Node("RB", "receiver", (50, 100), color="red"))
    p.add(Node("sC", "source", (200, -10), color="red"))
    p.add(Node("Cc", "connector", (200, 0)))
    p.add(Node("RC", "receiver", (200, 100), color="red"))
    for a, b in [("A", "sA"), ("A", "RA"), ("B", "sB"), ("B", "RB"),
                 ("Cc", "sC"), ("Cc", "RC")]:
        p.toggle_link(a, b)
    p.ffs += [ForceField("fa", (999, 0), (999, 1)), ForceField("fb", (998, 0), (998, 1)),
              ForceField("fc", (997, 0), (997, 1))]
    p.logic_links += [["RA", "fa", False], ["RB", "fb", False], ["RC", "fc", False]]
    p.solve()
    check("A cut early by B -> RA dark", not p.lit["RA"])
    check("C passes through where A no longer reaches -> RC lit", p.lit["RC"])

    print("Boolean logic -- AND, NOT, branching:")
    L = World()
    L.add(Node("R", "source", (0, 0), color="red"))
    L.add(Node("C", "connector", (40, 0)))
    L.add(Node("rA", "receiver", (80, -20), color="red"))
    L.add(Node("rB", "receiver", (80, 20), color="red"))
    L.add(Node("AND", "and", (140, 0)))
    L.ffs.append(ForceField("g", (200, -20), (200, 20)))
    L.toggle_link("C", "R")
    L.logic_links += [["rA", "AND", False], ["rB", "AND", False], ["AND", "g", False]]
    # only rA lit
    L.toggle_link("C", "rA")
    L.solve()
    check("AND of two receivers: one lit -> field shut", not L.field_by_id("g").is_open)
    L.toggle_link("C", "rB")
    L.solve()
    check("AND of two receivers: both lit -> field open", L.field_by_id("g").is_open)

    N = World()
    N.add(Node("R", "source", (0, 0), color="red"))
    N.add(Node("C", "connector", (40, 0)))
    N.add(Node("rc", "receiver", (80, 0), color="red"))
    N.ffs.append(ForceField("g", (200, -20), (200, 20)))
    N.toggle_link("C", "R")
    N.logic_links += [["rc", "g", True]]   # NOT
    N.solve()
    check("NOT link: receiver dark -> field open", N.field_by_id("g").is_open)
    N.toggle_link("C", "rc")
    N.solve()
    check("NOT link: receiver lit -> field shut", not N.field_by_id("g").is_open)

    # branching: one receiver drives two fields
    Br = World()
    Br.add(Node("R", "source", (0, 0), color="red"))
    Br.add(Node("C", "connector", (40, 0)))
    Br.add(Node("rc", "receiver", (80, 0), color="red"))
    Br.ffs += [ForceField("g1", (200, -20), (200, 20)), ForceField("g2", (260, -20), (260, 20))]
    Br.toggle_link("C", "R")
    Br.toggle_link("C", "rc")
    Br.logic_links += [["rc", "g1", False], ["rc", "g2", False]]
    Br.solve()
    check("branching: one receiver opens two fields",
          Br.field_by_id("g1").is_open and Br.field_by_id("g2").is_open)

    print("Buttons / boxes:")
    bw = World()
    bw.add(Node("btn", "button", (100, 100)))
    bw.ffs.append(ForceField("g", (200, 0), (200, 50)))
    bw.logic_links += [["btn", "g", False]]
    bw.player = [400, 400]
    bw.solve()
    check("button gate shut with nobody on it", not bw.field_by_id("g").is_open)
    bw.boxes = [[100, 100]]
    bw.solve()
    check("box on button opens gate", bw.field_by_id("g").is_open)

    print("Material connectors / boxes block rays:")
    Mb = World()
    Mb.add(Node("S", "source", (0, 0), color="red"))
    Mb.add(Node("C", "connector", (50, 0)))
    Mb.add(Node("blk", "connector", (150, 0)))   # idle connector squarely in the path
    Mb.add(Node("R", "receiver", (300, 0), color="red"))
    Mb.toggle_link("C", "S")
    Mb.toggle_link("C", "R")
    Mb.solve()
    check("idle connector body blocks the beam -> receiver dark", not Mb.lit["R"])
    Mb.boxes = [[50, 0]]                # box under C -> C and its beam ride up
    Mb.solve()
    check("connector raised on a box -> its elevated beam clears the ground blocker",
          Mb.lit["R"] and Mb._conn_elevated("C"))

    print("Connector presses a button (and box->button->connector stack):")
    Cb = World()
    Cb.add(Node("btn", "button", (100, 100)))
    Cb.ffs.append(ForceField("g", (200, 0), (200, 50)))
    Cb.logic_links += [["btn", "g", False]]
    Cb.player = [400, 400]
    Cb.add(Node("C", "connector", (100, 100)))   # connector resting on the button
    Cb.solve()
    check("connector on a button opens the gate", Cb.field_by_id("g").is_open)
    Cb.carrying = "C"
    Cb.solve()
    check("carried connector no longer presses the button", not Cb.field_by_id("g").is_open)
    Cb.carrying = None
    Cb.boxes = [[100, 100]]             # connector sits on box which sits on button
    Cb.solve()
    check("connector-on-box-on-button still presses the button",
          Cb.field_by_id("g").is_open and Cb._conn_elevated("C"))

    print("Carried connector drops out of relaying, then restores:")
    Cr = World()
    Cr.add(Node("S", "source", (0, 0), color="red"))
    Cr.add(Node("C", "connector", (50, 0)))
    Cr.add(Node("R", "receiver", (120, 0), color="red"))
    Cr.toggle_link("C", "S")
    Cr.toggle_link("C", "R")
    Cr.solve()
    check("connector relays while set down -> receiver lit", Cr.lit["R"])
    Cr.carrying = "C"
    Cr.solve()
    check("carried connector relays nothing -> receiver dark", not Cr.lit["R"])
    Cr.carrying = None                  # links were remembered the whole time
    Cr.solve()
    check("set back down -> relaying restored from remembered links", Cr.lit["R"])

    print("Self-latching loop (source beyond the gate holds it open):")
    Lt = World()
    Lt.add(Node("Sext", "source", (0, 0), color="blue"))
    Lt.add(Node("rcv", "receiver", (30, 0), color="blue"))
    Lt.add(Node("C", "connector", (50, 0)))
    Lt.add(Node("Sfar", "source", (200, 0), color="blue"))
    Lt.ffs.append(ForceField("g", (100, -30), (100, 30)))
    Lt.logic_links += [["rcv", "g", False]]
    Lt.toggle_link("C", "Sext")
    Lt.toggle_link("C", "rcv")
    Lt.toggle_link("C", "Sfar")    # aimed beyond the closed gate; tries but blocked
    Lt.solve(cold=True)
    check("bootstrap: external source opens the gate", Lt.field_by_id("g").is_open)
    Lt.toggle_link("C", "Sext")    # remove the external trigger
    Lt.solve(cold=False)
    check("latched: gate holds open on the far source via the open gate",
          Lt.field_by_id("g").is_open)
    Lt.solve(cold=True)
    check("cold restart, no external trigger -> gate falls shut",
          not Lt.field_by_id("g").is_open)

    print("\nRESULT:", "ALL GOOD" if ok else "SOMETHING FAILED")
    return ok


# --------------------------------------------------------------------------- #
# GUI (editor + sandbox)
# --------------------------------------------------------------------------- #
def run_gui():
    import tkinter as tk

    w = build_level()
    state = {"mode": "play", "tool": "select", "color": "red",
             "pending": None, "link_src": None, "sel": None,
             "dwell": 0.0, "dirty": False, "msg": ""}
    held = set()
    mouse = {"x": 0, "y": 0}

    root = tk.Tk()
    root.title("Robot and her prism -- beam puzzle (edit + play)")
    bar = tk.Frame(root); bar.pack(fill="x")
    cv = tk.Canvas(root, width=1018, height=640, bg="#fafafa", highlightthickness=0); cv.pack()
    info = tk.Label(root, anchor="w", justify="left", font=("TkDefaultFont", 9)); info.pack(fill="x")

    def in_reach(nid):
        if w.carrying == nid:
            return True
        return bool(w.player) and dist(w.player, w.nodes[nid].pos) < CONNECT_REACH

    def set_mode(m):
        state.update(mode=m, pending=None, link_src=None)
        if m == "play" and w.player_start:
            w.player = list(w.player_start)
        w.player_block = False
        state["dwell"] = 0.0
        w.solve(cold=True); refresh_bar(); redraw()

    def set_tool(t):
        state.update(tool=t, pending=None, link_src=None)
        refresh_bar()

    def refresh_bar():
        for c in bar.winfo_children():
            c.destroy()
        tk.Button(bar, text="EDIT", relief=("sunken" if state["mode"] == "edit" else "raised"),
                  command=lambda: set_mode("edit")).pack(side="left")
        tk.Button(bar, text="PLAY", relief=("sunken" if state["mode"] == "play" else "raised"),
                  command=lambda: set_mode("play")).pack(side="left")
        tk.Label(bar, text=" ").pack(side="left")
        if state["mode"] == "edit":
            for t in ["select", "source", "receiver", "connector", "button", "box",
                      "and", "or", "wall", "field", "tan", "purple",
                      "goal", "start", "link", "delete"]:
                tk.Button(bar, text=t, relief=("sunken" if state["tool"] == t else "raised"),
                          command=lambda t=t: set_tool(t)).pack(side="left")
            cm = tk.StringVar(value=state["color"])
            tk.OptionMenu(bar, cm, *PALETTE,
                          command=lambda v: state.__setitem__("color", v)).pack(side="left")
        else:
            tk.Label(bar, text="WASD move | E pick/drop | stand by a connector, click it, "
                              "then click a node to aim | C clear | R reset | G reset gates").pack(side="left")

    # ----- drawing -----
    def star_pts(cx, cy, r=16, ri=7, n=5):
        pts = []
        for i in range(2 * n):
            rad = r if i % 2 == 0 else ri
            ang = -math.pi / 2 + i * math.pi / n
            pts += [cx + rad * math.cos(ang), cy + rad * math.sin(ang)]
        return pts

    def diamond(cx, cy, r=13):
        return [cx, cy - r, cx + r, cy, cx, cy + r, cx - r, cy]

    def redraw():
        cv.delete("all")
        for b in w.barriers:
            cv.create_line(*b.p1, *b.p2, fill=COLORS[b.kind], width=6, capstyle="round")
        for wl in w.walls:
            cv.create_line(*wl.p1, *wl.p2, fill="#111", width=5, capstyle="round")
        for ff in w.ffs:
            if ff.is_open:
                cv.create_line(*ff.p1, *ff.p2, fill="#bfe3ec", width=3, dash=(3, 7))
            else:
                cv.create_line(*ff.p1, *ff.p2, fill="#8fd3e8", width=6)
        for (a, b) in w.links:
            cv.create_line(*w.nodes[a].pos, *w.nodes[b].pos, fill="#dddddd", width=1, dash=(2, 5))
        for (a, b, col, delivered) in w.beams_draw:
            shade = COLORS[col] if delivered else DIM.get(col, "#999")
            cv.create_line(*a, *b, fill=shade, width=4 if delivered else 3, capstyle="round")
            if not delivered:
                cv.create_oval(b[0] - 3, b[1] - 3, b[0] + 3, b[1] + 3, outline=shade, width=2)
        # logic wiring
        for (src, dst, neg) in w.logic_links:
            sp = w.nodes[src].pos if src in w.nodes else None
            dp = w.consumer_pos(dst)
            if not sp or not dp:
                continue
            active = (neg != bool(w.logic_val.get(src, False)))
            cv.create_line(*sp, *dp, fill=("#5aa0e0" if active else "#cbd3da"),
                           width=2, dash=(4, 3), arrow="last")
            if neg:
                mx, my = (sp[0] + dp[0]) / 2, (sp[1] + dp[1]) / 2
                cv.create_oval(mx - 5, my - 5, mx + 5, my + 5, fill="#fff",
                               outline="#c0392b", width=2)
                cv.create_text(mx, my, text="!", font=("TkDefaultFont", 7, "bold"), fill="#c0392b")
        # boxes
        for bx in w.boxes:
            x, y = bx
            on = any(dist(bx, n.pos) < BTN_R for n in w.nodes.values() if n.kind == "button")
            cv.create_rectangle(x - BOX_R, y - BOX_R, x + BOX_R, y + BOX_R,
                                fill=("#caa46a" if on else "#b08d57"), outline="#5b4523", width=2)
        # nodes
        for n in w.nodes.values():
            x, y = n.pos
            if n.kind == "source":
                cv.create_polygon(diamond(x, y), fill=COLORS.get(n.color, "#999"), outline="#222")
            elif n.kind == "receiver":
                lit = w.lit.get(n.id, False)
                cv.create_rectangle(x - 11, y - 13, x + 11, y + 13,
                                    outline=COLORS.get(n.color, "#999"), width=3,
                                    fill=COLORS[n.color] if lit else "#fff")
            elif n.kind == "button":
                pr = w.pressed.get(n.id, False)
                cv.create_oval(x - BTN_R, y - BTN_R, x + BTN_R, y + BTN_R,
                               fill=("#88d18b" if pr else "#e7e7e7"), outline="#555", width=2)
                cv.create_text(x, y, text="B", font=("TkDefaultFont", 8))
            elif n.kind in LOGIC_KINDS:
                on = w.logic_val.get(n.id, False)
                cv.create_rectangle(x - 17, y - 13, x + 17, y + 13,
                                    fill=("#bfe6c2" if on else "#eceff1"),
                                    outline="#516", width=2)
                cv.create_text(x, y, text=("AND" if n.kind == "and" else "OR"),
                               font=("TkDefaultFont", 8, "bold"))
            elif n.kind == "connector":
                near = state["mode"] == "play" and in_reach(n.id)
                ring = "#f5c518" if state["sel"] == n.id else ("#2e8b57" if near else "#222")
                col = w.emit.get(n.id)
                carried = w.carrying == n.id
                if w._conn_elevated(n.id):
                    cv.create_oval(x - 16, y - 16, x + 16, y + 16,
                                   outline="#8e44ad", width=2, dash=(2, 2))
                cv.create_oval(x - 12, y - 12, x + 12, y + 12,
                               fill=COLORS[col] if col else "#fff", outline=ring, width=3)
                cv.create_text(x, y, text=n.label or "C", font=("TkDefaultFont", 9, "bold"))
                if carried:
                    cv.create_text(x, y - 20, text="(carried)", font=("TkDefaultFont", 7), fill="#666")
                elif w._conn_elevated(n.id):
                    cv.create_text(x, y + 22, text="(raised)", font=("TkDefaultFont", 7), fill="#8e44ad")
        if w.goal:
            cv.create_polygon(star_pts(*w.goal), fill="#f5c518", outline="#b8860b")
        if w.player:
            px, py = w.player
            cv.create_oval(px - PLAYER_R, py - PLAYER_R, px + PLAYER_R, py + PLAYER_R,
                           fill=("#c0392b" if w.player_block else "#222"), outline="#fff", width=2)
            if state["mode"] == "play":
                cv.create_oval(px - CONNECT_REACH, py - CONNECT_REACH,
                               px + CONNECT_REACH, py + CONNECT_REACH,
                               outline="#e7e7e7", dash=(2, 4))
        if state["pending"]:
            p = state["pending"]
            cv.create_line(p[0], p[1], mouse["x"], mouse["y"], fill="#888", dash=(2, 2))
        gates = "  ".join(f"{ff.id}:{'open' if ff.is_open else 'shut'}" for ff in w.ffs)
        goal = "   *** GOAL REACHED ***" if w.at_goal() else ""
        tl = state["tool"] if state["mode"] == "edit" else "-"
        info.config(text=f"[{state['mode']}/{tl}]  gates: {gates}{goal}\n{state['msg']}")

    # ----- hit testing -----
    def node_at(x, y, kinds=None):
        best, bd = None, 18
        for n in w.nodes.values():
            if kinds and n.kind not in kinds:
                continue
            d = dist((x, y), n.pos)
            if d < bd:
                best, bd = n, d
        return best

    def box_at(x, y):
        for i, bx in enumerate(w.boxes):
            if dist((x, y), bx) < BOX_R + 4:
                return i
        return None

    def field_at(x, y):
        for ff in w.ffs:
            if pt_seg_dist((x, y), ff.p1, ff.p2) < 8:
                return ff
        return None

    # ----- editing -----
    def edit_click(x, y):
        t = state["tool"]
        if t == "select":
            n = node_at(x, y)
            state["sel"] = n.id if (n and n.kind == "connector") else None
        elif t in ("source", "receiver"):
            w.add(Node(w.new_id(t[:3] + "_"), t, (x, y), color=state["color"]))
        elif t == "connector":
            w.add(Node(w.new_id("con_"), "connector", (x, y), label="+"))
        elif t == "button":
            w.add(Node(w.new_id("btn_"), "button", (x, y)))
        elif t in LOGIC_KINDS:
            w.add(Node(w.new_id(t + "_"), t, (x, y)))
        elif t == "box":
            w.boxes.append([x, y])
        elif t == "goal":
            w.goal = [x, y]
        elif t == "start":
            w.player_start = [x, y]; w.player = [x, y]
        elif t in ("wall", "field", "tan", "purple"):
            if state["pending"] is None:
                state["pending"] = (x, y); return
            p1, p2 = state["pending"], (x, y); state["pending"] = None
            if t == "wall":
                w.walls.append(Wall(p1, p2))
            elif t == "field":
                w.ffs.append(ForceField(w.new_id("ff_"), p1, p2))
            else:
                w.barriers.append(Barrier(p1, p2, t))
        elif t == "link":
            if state["link_src"] is None:
                n = node_at(x, y, kinds=("receiver", "button") + LOGIC_KINDS)
                if n:
                    state["link_src"] = n.id
                    state["msg"] = f"link from {n.id}: now click an AND/OR node or a field"
                return
            n = node_at(x, y, kinds=LOGIC_KINDS)
            dst = n.id if (n and n.id != state["link_src"]) else None
            if dst is None:
                ff = field_at(x, y)
                dst = ff.id if ff else None
            if dst:
                state["msg"] = w.toggle_logic_link(state["link_src"], dst)
                state["link_src"] = None
            else:
                state["msg"] = "click an AND/OR node or a field as the target"
        elif t == "delete":
            n = node_at(x, y)
            if n:
                w.remove_node(n.id); return
            bi = box_at(x, y)
            if bi is not None:
                w.boxes.pop(bi); return
            ff = field_at(x, y)
            if ff:
                w.remove_field(ff); return
            for (src, dst, neg) in list(w.logic_links):
                sp = w.nodes[src].pos if src in w.nodes else None
                dp = w.consumer_pos(dst)
                if sp and dp and pt_seg_dist((x, y), sp, dp) < 7:
                    w.logic_links.remove([src, dst, neg]); return
            for lst in (w.walls, w.barriers):
                for o in list(lst):
                    if pt_seg_dist((x, y), o.p1, o.p2) < 8:
                        lst.remove(o); return

    # ----- play interactions (proximity-gated) -----
    def play_click(x, y):
        if state["sel"] and not in_reach(state["sel"]):
            state["sel"] = None
        n = node_at(x, y)
        if n is None:
            state["sel"] = None
            return
        if n.kind == "connector":
            if state["sel"] and state["sel"] != n.id:
                w.toggle_link(state["sel"], n.id)          # aim selected at this connector
            elif state["sel"] == n.id:
                state["sel"] = None
            elif in_reach(n.id):
                state["sel"] = n.id
            else:
                state["msg"] = "move closer to that connector to adjust it"
        elif state["sel"]:
            w.toggle_link(state["sel"], n.id)              # aim selected connector at node

    # ----- events -----
    drag = {"id": None, "moved": False, "link_hit": None}

    def drag_player_to(tx, ty):
        # walk the player toward the cursor in small valid steps; move_player
        # honours walls, fields, barriers and pushes boxes just like WASD does.
        moved = False
        for _ in range(60):
            px, py = w.player
            dx, dy = tx - px, ty - py
            d = math.hypot(dx, dy)
            if d < 0.5:
                break
            step = min(6.0, d)
            before = tuple(w.player)
            w.move_player(dx / d * step, 0); w.move_player(0, dy / d * step)
            if tuple(w.player) == before:
                break          # fully blocked, stop nudging
            moved = True
        return moved

    def on_press(e):
        mouse.update(x=e.x, y=e.y)
        drag["moved"] = False
        drag["link_hit"] = None
        if state["mode"] == "edit" and state["tool"] == "select":
            n = node_at(e.x, e.y); bi = box_at(e.x, e.y)
            drag["id"] = ("node", n.id) if n else (("box", bi) if bi is not None else None)
        elif state["mode"] == "play" and w.player and dist((e.x, e.y), w.player) < PLAYER_R + 6:
            drag["id"] = ("player", None)
        else:
            drag["id"] = None

    def on_motion(e):
        mouse.update(x=e.x, y=e.y)
        if drag["id"] and state["mode"] == "edit" and state["tool"] == "select":
            drag["moved"] = True
            kind, ref = drag["id"]
            (w.nodes[ref].pos.__setitem__(slice(0, 2), [e.x, e.y]) if kind == "node"
             else w.boxes.__setitem__(ref, [e.x, e.y]))
            w.solve(cold=True)
        elif drag["id"] and drag["id"][0] == "player" and state["mode"] == "play":
            if drag_player_to(e.x, e.y):
                drag["moved"] = True
                if w.carrying:
                    cid = w.carrying
                    w.nodes[cid].pos[:] = [w.player[0], w.player[1]]
                    # dragging the carried connector over a connectable node
                    # toggles its link (debounced so each pass fires once).
                    tgt, best = None, 18
                    for nd in w.nodes.values():
                        if nd.id == cid or nd.kind not in ("source", "receiver", "connector"):
                            continue
                        dd = dist(w.player, nd.pos)
                        if dd < best:
                            tgt, best = nd, dd
                    if tgt is None:
                        drag["link_hit"] = None
                    elif tgt.id != drag["link_hit"]:
                        w.toggle_link(cid, tgt.id)
                        drag["link_hit"] = tgt.id
                        linked = tuple(sorted((cid, tgt.id))) in w.links
                        state["msg"] = f"{'linked' if linked else 'unlinked'} {cid} <-> {tgt.id}"
                w.solve(cold=False)
        redraw()

    def on_release(e):
        if drag["moved"]:
            cold = state["mode"] == "edit"
            drag["id"] = None; w.solve(cold=cold); redraw(); return
        drag["id"] = None
        (edit_click if state["mode"] == "edit" else play_click)(e.x, e.y)
        w.solve(cold=(state["mode"] == "edit")); redraw()

    def on_key(e):
        k = e.keysym
        held.add(k)
        if state["mode"] == "play":
            kl = k.lower()
            if kl == "e":
                if w.carrying:
                    cid = w.carrying
                    # set-down: snap onto an adjacent box so the connector rests
                    # on it (elevated). Otherwise it stays where the player is.
                    best, bd = None, BOX_R + PLAYER_R + 8
                    for bx in w.boxes:
                        d = dist(w.player, bx)
                        if d < bd:
                            best, bd = bx, d
                    if best is not None:
                        w.nodes[cid].pos[:] = [best[0], best[1]]
                    w.carrying = None
                else:
                    best, bd = None, 30
                    for n in w.connectors():
                        d = dist(w.player, n.pos)
                        if d < bd and not w.reach_blocked(w.player, n.pos):
                            best, bd = n, d
                    if best:
                        w.carrying = best.id
                w.solve(cold=False); redraw()
            elif kl == "c":
                if state["sel"] and in_reach(state["sel"]):
                    w.clear_links_of(state["sel"]); w.solve(cold=False); redraw()
                elif state["sel"]:
                    state["msg"] = "move closer to clear that connector"
            elif kl == "r":
                w.player = list(w.player_start); w.carrying = None; w.solve(cold=True); redraw()
            elif kl == "g":
                w.solve(cold=True); state["msg"] = "gates reset (latches cleared)"; redraw()
        if k == "space":
            print_state()

    def on_key_release(e):
        held.discard(e.keysym)

    def print_state():
        print("--- state ---")
        for n in w.connectors():
            print(f"  connector {n.id:10} emits {w.emit.get(n.id)}")
        for ff in w.ffs:
            ins = [(s, d, ng) for (s, d, ng) in w.logic_links if d == ff.id]
            print(f"  gate {ff.id:10} {'OPEN' if ff.is_open else 'shut'} inputs={ins}")

    def tick():
        if state["mode"] == "play" and w.player:
            vx = (("d" in held or "Right" in held) - ("a" in held or "Left" in held))
            vy = (("s" in held or "Down" in held) - ("w" in held or "Up" in held))
            moved = False
            if vx or vy:
                step = SPEED * TICK
                before = tuple(w.player)
                w.move_player(vx * step, 0); w.move_player(0, vy * step)
                moved = tuple(w.player) != before
            if w.carrying:
                w.nodes[w.carrying].pos[:] = [w.player[0], w.player[1]]
                state["dirty"] = True
            if state["sel"] and not in_reach(state["sel"]):
                state["sel"] = None
            if moved or state["dirty"]:
                w.solve(cold=False); state["dirty"] = False
            state["dwell"] = state["dwell"] + TICK if w.player_touching_beam() else 0.0
            want = state["dwell"] >= DWELL_THRESH
            if want != w.player_block:
                w.player_block = want; w.solve(cold=False)
            redraw()
        root.after(int(TICK * 1000), tick)

    cv.bind("<ButtonPress-1>", on_press)
    cv.bind("<B1-Motion>", on_motion)
    cv.bind("<ButtonRelease-1>", on_release)
    cv.bind("<Motion>", lambda e: (mouse.update(x=e.x, y=e.y),
                                    redraw() if state["pending"] else None))
    root.bind("<KeyPress>", on_key)
    root.bind("<KeyRelease>", on_key_release)

    refresh_bar(); w.solve(cold=True); redraw(); tick()
    root.mainloop()


def main():
    if "--selftest" in sys.argv:
        sys.exit(0 if selftest() else 1)
    try:
        run_gui()
    except Exception as exc:
        print("Could not start the GUI:", exc)
        print("If tkinter is missing: Debian/Ubuntu -> sudo apt install python3-tk")
        print("Engine check still works: python3 robot_prism.py --selftest")


if __name__ == "__main__":
    main()
