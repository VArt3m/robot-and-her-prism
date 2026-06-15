"""robot_prism -- a small original 2-D light-beam puzzle engine + editor.

No assets, no copyrighted content; primitive graphics via tkinter (bundled).

Public surface:
  * ``World``       -- scene state + light / logic / force-field solver.
  * ``Node``, ``Wall``, ``Barrier``, ``ForceField`` -- world primitives.
  * ``build_level`` -- the hand-built sample puzzle.
  * ``run_gui``     -- the tkinter editor + sandbox.

Run the package directly for the editor + sandbox::

    python -m robot_prism_py             # editor + sandbox
    python -m robot_prism_py --selftest  # headless engine checks, no window
"""

from .entities import Node, Wall, Barrier, ForceField
from .world import World
from .level import build_level

__all__ = ["Node", "Wall", "Barrier", "ForceField", "World", "build_level",
           "run_gui"]


def run_gui():
    # Imported lazily so the engine / tests work without tkinter present.
    from .gui import run_gui as _run_gui
    return _run_gui()
