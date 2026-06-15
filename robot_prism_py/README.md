# robot_prism_py

A small original 2-D light-beam puzzle: route coloured beams through connectors,
relays and boolean logic to open force-fields and reach the goal. No assets or
copyrighted content; primitive graphics via `tkinter` (bundled with CPython).

## Project structure

```
robot_prism_py/
├── __init__.py          # public API re-exports (World, build_level, run_gui, ...)
├── __main__.py          # entry point: python -m robot_prism_py [--selftest]
├── src/
│   ├── selftest.py      # headless engine smoke test (backs --selftest)
│   ├── core/            # foundational data + math, no game logic
│   │   ├── constants.py # physics constants, colours, key/layout config
│   │   ├── geometry.py  # 2-D segment intersection / distance helpers
│   │   └── entities.py  # Node, Wall, Barrier, ForceField primitives
│   ├── sim/             # the simulation (depends on core)
│   │   ├── world.py     # scene state + facade over Engine/Motion
│   │   ├── engine.py    # light / logic / force-field solver (solve + step)
│   │   ├── motion.py    # player / box movement, reach and theft rules
│   │   └── level.py     # the hand-built sample level
│   └── ui/              # presentation + input (depends on core, sim)
│       ├── keymap.py    # layout-independent key mapping (WASD, etc.)
│       └── gui.py       # tkinter editor + sandbox
└── tests/
    └── test_engine.py   # pytest suite
```

Dependency flow is one-way: **core → sim → ui**.

## Run

```sh
python -m robot_prism_py          # launch the editor + sandbox (needs tkinter)
python robot_prism.py             # same, via the root launcher
```

If `tkinter` is missing (e.g. Debian/Ubuntu): `sudo apt install python3-tk`.

## Test

```sh
python -m pytest robot_prism_py/tests   # full pytest suite
python -m robot_prism_py --selftest      # headless smoke test, no window
```
