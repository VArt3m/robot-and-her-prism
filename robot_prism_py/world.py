"""The World: the scene's state and a thin facade over its collaborators.

``World`` holds every entity (nodes, walls, barriers, boxes, force-fields), the
light / logic wiring, and the player, and exposes the editing API used to build
levels. The heavy lifting lives in two collaborators it owns and forwards to:

  * ``Engine`` (``engine.py``) -- the light / logic / force-field solver.
  * ``Motion`` (``motion.py``) -- the player / box movement, reach and theft rules.

Solver results (``emit``, ``lit``, ``pressed``, ``logic_val``, ``beams_draw``)
are written back onto the World by the Engine so callers can read them here.
"""

from .constants import BOX_R
from .geometry import dist
from .engine import Engine
from .motion import Motion


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
        # `pressed` stays here: it is both an output and scratch state the
        # movement dry-run temporarily overwrites. The other solver outputs
        # (emit / lit / logic_val / beams_draw) are OWNED by the Engine and read
        # back through the properties below.
        self.pressed = {}
        # collaborators: the solver, and the movement rules (which lean on the
        # solver for its latching dry-runs).
        self.engine = Engine(self)
        self.motion = Motion(self, self.engine)

    # ---- solver outputs (read-through to the Engine, read-only) ----
    @property
    def emit(self):
        return self.engine.emit

    @property
    def lit(self):
        return self.engine.lit

    @property
    def logic_val(self):
        return self.engine.logic_val

    @property
    def beams_draw(self):
        return self.engine.beams_draw

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

    def _conn_elevated(self, nid):
        # a connector "sits on a box" (is elevated) when it overlaps a box centre.
        # Pure scene query: read by both the Engine (blocker levels) and the GUI.
        nd = self.nodes.get(nid)
        if not nd or nd.kind != "connector" or nid == self.carrying:
            return False
        return any(dist(nd.pos, bx) < BOX_R for bx in self.boxes)

    # ---- light / logic solving (delegated to Engine) ----
    def solve(self, cold=False):
        return self.engine.solve(cold=cold)

    def step(self, now=None):
        return self.engine.step(now)

    def beams_live(self):
        return self.engine.beams_live()

    def light_blockers(self):
        return self.engine.light_blockers()

    # ---- player / boxes (delegated to Motion) ----
    def move_player(self, dx, dy):
        return self.motion.move_player(dx, dy)

    def reach_blocked(self, a, b):
        return self.motion.reach_blocked(a, b)

    def at_goal(self):
        return self.motion.at_goal()

    def player_touching_beam(self):
        return self.motion.player_touching_beam()
