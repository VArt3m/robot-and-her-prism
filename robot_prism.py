#!/usr/bin/env python3
"""Thin launcher for the robot_prism_py package (kept for backwards compat).

The engine, editor and tests now live in the ``robot_prism_py`` package; this
file only forwards to it so the old invocation keeps working::

    python robot_prism.py             # editor + sandbox
    python robot_prism.py --selftest  # headless engine checks, no window

Prefer ``python -m robot_prism_py`` going forward.
"""

from robot_prism_py.__main__ import main

if __name__ == "__main__":
    main()
