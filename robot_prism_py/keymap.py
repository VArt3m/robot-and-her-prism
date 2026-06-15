"""Layout-independent keyboard mapping and modifier decoding.

Every key event resolves to a layout-independent ACTION by PHYSICAL position
first (X11/Linux keycodes == evdev + 8), falling back to the lowercased keysym
for arrow keys and non-Linux platforms. Matching the physical key means
WASD/E/C/R/G work on any keyboard layout AND survive a stuck Shift or Caps
Lock -- which would otherwise uppercase the keysym, silently kill the
(case-sensitive) movement test, and persist across a relaunch since lock state
is global to the X server, not the process.
"""

import sys

_X11 = sys.platform.startswith("linux")
_KEYCODE_ACTION = {25: "up", 38: "left", 39: "down", 40: "right",   # W A S D
                   26: "carry", 54: "clear", 27: "reset",           # E C R
                   42: "gates", 65: "dump"}                         # G  space
_KEYSYM_ACTION = {"w": "up", "a": "left", "s": "down", "d": "right",
                  "up": "up", "left": "left", "down": "down", "right": "right",
                  "e": "carry", "c": "clear", "r": "reset", "g": "gates",
                  "space": "dump"}
MOVE_DIRS = {"up", "down", "left", "right"}


def key_action(e):
    # physical key (layout/modifier independent) on X11; keysym elsewhere. We only
    # trust keycodes on Linux: Windows/macOS virtual key codes differ (e.g. arrow
    # keys collide with these numbers there), so off-Linux we fall to the keysym.
    if _X11:
        a = _KEYCODE_ACTION.get(e.keycode)
        if a is not None:
            return a
    return _KEYSYM_ACTION.get(e.keysym.lower())


_MOD_BITS = [(0x0001, "Shift"), (0x0002, "Caps"), (0x0004, "Ctrl"),
             (0x0008, "Alt"), (0x0010, "NumLk"), (0x0040, "Super")]


def decode_mods(statebits):
    on = [name for bit, name in _MOD_BITS if statebits & bit]
    return "+".join(on) if on else "none"
