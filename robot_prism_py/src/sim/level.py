"""The hand-built sample level shipped with the editor / sandbox."""

from ..core.entities import Node, Wall, Barrier, ForceField
from .world import World


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
