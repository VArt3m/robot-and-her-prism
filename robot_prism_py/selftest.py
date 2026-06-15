"""Headless engine smoke test (no window).

Kept so ``python -m robot_prism_py --selftest`` works without tkinter or pytest.
The same scenarios are also expressed as proper pytest cases under ``tests/``.
"""

from .entities import Node, ForceField
from .world import World
from .geometry import first_block_t
from .level import build_level


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
