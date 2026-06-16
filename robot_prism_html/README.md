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
| E | Pick up the nearest object in radius / set the carried one down at its live preview spot (the "shadow") |
| Boxes | Solid and not pushable — walk around them, or carry them to move them |
| Click an object in radius (empty-handed) | Pick up the top item, armed (ready) |
| Hold the mouse (or E) ~0.5 s on a stack | Open a chooser to pick which item (top connector or the box) |
| Take the box from under a connector | The connector de-elevates (drops to the ground) |
| Click carried connector | Toggle its "ready" state (ready = yellow = programmable) |
| Click a node while carrying + ready | Aim / link the carried connector at that node |
| Click while carrying | Set the item down at the shadow predicted from the click direction (stacks onto an empty box) |
| Disallowed stack (e.g. onto another connector) | Beep + "My hands are full", nothing happens |
| Drag player | Walk toward cursor |
| Drag carried connector over node (while ready) | Toggle link (auto-wires on pass-through) |
| C | Clear all links of selected connector |
| Z | Rewind — undo the last meaningful action (up to 3 steps) |
| Hold R (3s) | Full reset — rebuild the entire playfield from scratch |
| G | Reset gate latch states |

> While you carry something, a **shadow** shows exactly where it will land — always clamped to a spot that is in reach with a clear line to it, so a drop can never cross a wall, force field, or barrier. The shadow predicts whichever action fits where your cursor is:
> - **Cursor outside the operating radius** → it previews the **E-drop**: the item set down right next to her, in the direction she's looking. The roaming cursor neither moves it nor turns her eyes. Drawn **solid**.
> - **Cursor inside the operating radius** → it previews the **mouse-click drop**: the item right where the cursor is. Drawn **translucent**.
>
> Both **E** and a **click** commit to whatever the shadow currently shows.
