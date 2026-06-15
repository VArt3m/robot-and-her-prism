"""Static world primitives: nodes, walls, barriers and force-fields."""


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
