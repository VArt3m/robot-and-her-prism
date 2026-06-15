# robot_prism_html

Browser port of the 2-D light-beam puzzle: route coloured beams through
connectors, relays and boolean logic to open force-fields and reach the goal.
Pure HTML + ES modules — no build step, no framework.

Ported from the Python/tkinter reference implementation in `../robot_prism_py/`.

## Project structure

```
robot_prism_html/
├── index.html           # entry point
├── server.py            # local dev server (correct JS MIME type)
├── css/
│   └── style.css        # layout + dark chrome
└── js/
    ├── core/            # foundational data + math, no game logic
    │   ├── constants.js # physics constants, colours
    │   ├── entities.js  # Node, Wall, Barrier, ForceField classes
    │   └── geometry.js  # 2-D segment intersection / distance helpers
    ├── sim/             # the simulation (depends on core)
    │   ├── engine.js    # light / logic / force-field solver (solve + step)
    │   ├── motion.js    # player / box movement, reach and theft rules
    │   ├── world.js     # scene state + facade over Engine / Motion
    │   └── level.js     # hand-built sample level
    └── ui/              # presentation + input (depends on core, sim)
        ├── renderer2d.js  # Canvas 2D renderer (DPR-aware, letterboxed)
        ├── input.js       # keyboard / mouse input handler
        └── app.js         # game loop, mode switching, play interactions
```

Dependency flow is one-way: **core → sim → ui**.

The renderer interface (`render(world, uiState)`) is designed so a future
`renderer3d.js` can be driven alongside the 2D view from the same game loop
in `app.js`.

A level editor is not yet implemented; the placeholder mode switch and
`uiState.mode` are already wired in `app.js` for when it is added.

## Run locally

```sh
cd robot_prism_html
python server.py          # serves at http://127.0.0.1:8080
```

`server.py` is a one-file wrapper around Python's built-in HTTP server that
forces the correct `application/javascript` MIME type for `.js` files (some
platforms default to `text/plain`, which browsers block for ES modules).

If you have Node.js available, `npx serve .` also works.

## Controls

| Key / action | Effect |
|---|---|
| WASD / arrow keys | Move player |
| E | Pick up / put down nearest connector |
| Click connector (in reach) | Select it |
| Click node while connector selected | Aim selected connector at that node |
| Drag player | Walk toward cursor |
| Drag carried connector over node | Toggle link (auto-wires on pass-through) |
| C | Clear all links of selected connector |
| R | Reset player position and carried item |
| G | Reset gate latch states |
