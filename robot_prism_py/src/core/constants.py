"""Tunable physics constants and colour palettes for the beam-puzzle engine."""

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
CUT_LINGER = 0.33           # a freshly-cut ray keeps its old length this long (s)
# CUT_LINGER applies ONLY to a cut made by the player's own body, so a brief pass
# is forgiven and a committed block fades in/out smoothly. Cuts made by MATERIAL
# (boxes, set-down connectors, walls) and by FORCE-FIELDS closing are instant --
# they snap the moment the obstacle enters the beam. A carried connector is lifted
# out of play and blocks nothing, so carrying a tool through a beam never cuts it.
CROSSING_CUT_INSTANT = False  # beam-vs-beam crossings: keep them lingering (this is
                              # what makes paradox loops oscillate instead of
                              # freezing). Set True to make ray-on-ray cuts instant
                              # too -- simpler, but oscillators settle/flicker.
DEBUG_KEYS = False          # print every key event (sym/code/mods); toggle live w/ F12

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
