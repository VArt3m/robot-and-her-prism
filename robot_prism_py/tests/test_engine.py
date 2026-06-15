"""Headless engine checks for the beam-puzzle solver.

These mirror the scenarios in ``robot_prism_py.selftest`` but as proper pytest
cases, so each behaviour fails independently and reports its own assertion.
"""

from robot_prism_py import Node, ForceField, World, build_level
from robot_prism_py.src.core.geometry import first_block_t


# --------------------------------------------------------------------------- #
# relay / walls
# --------------------------------------------------------------------------- #
def test_green_relay_lights_receiver_and_opens_field():
    w = build_level()
    w.toggle_link("con_c", "src_g1")
    w.toggle_link("con_c", "rcv_green")
    w.solve()
    assert w.lit["rcv_green"]
    assert w.field_by_id("ff_top").is_open


def test_blue_source_walled_off_from_centre_connector():
    w = build_level()
    blocked = first_block_t(w.nodes["src_blue"].pos, w.nodes["con_c"].pos,
                            w.light_blockers())
    assert blocked is not None


# --------------------------------------------------------------------------- #
# colour conflict + partial beam length
# --------------------------------------------------------------------------- #
def _partial_world():
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
    p.ffs += [ForceField("fa", (999, 0), (999, 1)),
              ForceField("fb", (998, 0), (998, 1)),
              ForceField("fc", (997, 0), (997, 1))]
    p.logic_links += [["RA", "fa", False], ["RB", "fb", False], ["RC", "fc", False]]
    p.solve()
    return p


def test_crossing_beam_cuts_receiver_dark():
    assert not _partial_world().lit["RA"]


def test_beam_passes_where_cut_beam_no_longer_reaches():
    assert _partial_world().lit["RC"]


# --------------------------------------------------------------------------- #
# boolean logic: AND, NOT, branching
# --------------------------------------------------------------------------- #
def test_and_gate_requires_both_inputs():
    w = World()
    w.add(Node("R", "source", (0, 0), color="red"))
    w.add(Node("C", "connector", (40, 0)))
    w.add(Node("rA", "receiver", (80, -20), color="red"))
    w.add(Node("rB", "receiver", (80, 20), color="red"))
    w.add(Node("AND", "and", (140, 0)))
    w.ffs.append(ForceField("g", (200, -20), (200, 20)))
    w.toggle_link("C", "R")
    w.logic_links += [["rA", "AND", False], ["rB", "AND", False], ["AND", "g", False]]
    w.toggle_link("C", "rA")
    w.solve()
    assert not w.field_by_id("g").is_open
    w.toggle_link("C", "rB")
    w.solve()
    assert w.field_by_id("g").is_open


def test_not_link_inverts_receiver():
    w = World()
    w.add(Node("R", "source", (0, 0), color="red"))
    w.add(Node("C", "connector", (40, 0)))
    w.add(Node("rc", "receiver", (80, 0), color="red"))
    w.ffs.append(ForceField("g", (200, -20), (200, 20)))
    w.toggle_link("C", "R")
    w.logic_links += [["rc", "g", True]]   # NOT
    w.solve()
    assert w.field_by_id("g").is_open
    w.toggle_link("C", "rc")
    w.solve()
    assert not w.field_by_id("g").is_open


def test_branching_one_receiver_opens_two_fields():
    w = World()
    w.add(Node("R", "source", (0, 0), color="red"))
    w.add(Node("C", "connector", (40, 0)))
    w.add(Node("rc", "receiver", (80, 0), color="red"))
    w.ffs += [ForceField("g1", (200, -20), (200, 20)),
              ForceField("g2", (260, -20), (260, 20))]
    w.toggle_link("C", "R")
    w.toggle_link("C", "rc")
    w.logic_links += [["rc", "g1", False], ["rc", "g2", False]]
    w.solve()
    assert w.field_by_id("g1").is_open
    assert w.field_by_id("g2").is_open


# --------------------------------------------------------------------------- #
# buttons / boxes
# --------------------------------------------------------------------------- #
def test_box_on_button_opens_gate():
    w = World()
    w.add(Node("btn", "button", (100, 100)))
    w.ffs.append(ForceField("g", (200, 0), (200, 50)))
    w.logic_links += [["btn", "g", False]]
    w.player = [400, 400]
    w.solve()
    assert not w.field_by_id("g").is_open
    w.boxes = [[100, 100]]
    w.solve()
    assert w.field_by_id("g").is_open


# --------------------------------------------------------------------------- #
# material connectors / boxes block rays; elevation clears ground blockers
# --------------------------------------------------------------------------- #
def test_idle_connector_blocks_beam_until_raised_on_box():
    w = World()
    w.add(Node("S", "source", (0, 0), color="red"))
    w.add(Node("C", "connector", (50, 0)))
    w.add(Node("blk", "connector", (150, 0)))   # idle connector in the path
    w.add(Node("R", "receiver", (300, 0), color="red"))
    w.toggle_link("C", "S")
    w.toggle_link("C", "R")
    w.solve()
    assert not w.lit["R"]
    w.boxes = [[50, 0]]                # box under C -> C and its beam ride up
    w.solve()
    assert w.lit["R"]
    assert w._conn_elevated("C")


# --------------------------------------------------------------------------- #
# connector presses a button; box -> button -> connector stack
# --------------------------------------------------------------------------- #
def test_connector_presses_button_and_stacks():
    w = World()
    w.add(Node("btn", "button", (100, 100)))
    w.ffs.append(ForceField("g", (200, 0), (200, 50)))
    w.logic_links += [["btn", "g", False]]
    w.player = [400, 400]
    w.add(Node("C", "connector", (100, 100)))   # connector resting on the button
    w.solve()
    assert w.field_by_id("g").is_open
    w.carrying = "C"
    w.solve()
    assert not w.field_by_id("g").is_open
    w.carrying = None
    w.boxes = [[100, 100]]             # connector on box on button
    w.solve()
    assert w.field_by_id("g").is_open
    assert w._conn_elevated("C")


# --------------------------------------------------------------------------- #
# carried connector drops out of relaying, then restores
# --------------------------------------------------------------------------- #
def test_carried_connector_stops_relaying_then_restores():
    w = World()
    w.add(Node("S", "source", (0, 0), color="red"))
    w.add(Node("C", "connector", (50, 0)))
    w.add(Node("R", "receiver", (120, 0), color="red"))
    w.toggle_link("C", "S")
    w.toggle_link("C", "R")
    w.solve()
    assert w.lit["R"]
    w.carrying = "C"
    w.solve()
    assert not w.lit["R"]
    w.carrying = None                  # links were remembered the whole time
    w.solve()
    assert w.lit["R"]


# --------------------------------------------------------------------------- #
# self-latching loop (source beyond the gate holds it open)
# --------------------------------------------------------------------------- #
def test_self_latching_loop():
    w = World()
    w.add(Node("Sext", "source", (0, 0), color="blue"))
    w.add(Node("rcv", "receiver", (30, 0), color="blue"))
    w.add(Node("C", "connector", (50, 0)))
    w.add(Node("Sfar", "source", (200, 0), color="blue"))
    w.ffs.append(ForceField("g", (100, -30), (100, 30)))
    w.logic_links += [["rcv", "g", False]]
    w.toggle_link("C", "Sext")
    w.toggle_link("C", "rcv")
    w.toggle_link("C", "Sfar")    # aimed beyond the closed gate; tries but blocked
    w.solve(cold=True)
    assert w.field_by_id("g").is_open       # bootstrap
    w.toggle_link("C", "Sext")    # remove the external trigger
    w.solve(cold=False)
    assert w.field_by_id("g").is_open       # latched via far source
    w.solve(cold=True)
    assert not w.field_by_id("g").is_open   # cold restart falls shut
