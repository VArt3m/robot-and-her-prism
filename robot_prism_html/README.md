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
| E (brief tap) | Empty-handed: pick up the nearest object in radius. Carrying: set it down at its live preview spot (the "shadow"). In click-by-click: exit the mode |
| E (hold ~1/3 s) while carrying | Fires the same tree as the mouse, straight to the end state (no golden arrow): click-by-click for a targeting device, the programming chooser for a programmable one, the Setup/Target menu for both |
| Boxes | Solid and not pushable — walk around them, or carry them to move them |
| Click an object in radius (empty-handed) | Pick up the top item, armed (ready) |
| Hold the mouse (or E) ~1/3 s on a stack | Open a chooser to pick which item (top connector or the box) |
| Take the box from under a connector | The connector de-elevates (drops to the ground) |
| Targeting / programming a carried device | Press & hold in the operating ring — see "Targeting & programming" below |
| Click while carrying | Drops the item at the shadow — but only when the click is **inside** the activation radius; a click outside the ring is just an aim and never drops |
| Disallowed stack (e.g. onto another connector) | Beep + "My hands are full", nothing happens |
| Drag player | Walk toward cursor |
| Drag the character while carrying a ready connector | Auto-wires to nodes it passes over |
| Click on an intent ray (while carrying a targeting device, or in click-by-click) | Erases that intent; every ray in the small hit zone goes at once |
| Exit click-by-click | A brief click on empty space (not a target), or a tap of E |
| C | Clear all links of selected connector |
| Z | Rewind — undo the last meaningful action (up to 3 steps) |
| Hold R (3s) | Full reset — rebuild the entire playfield from scratch |
| G | Reset gate latch states |

> While you carry something, a **shadow** shows exactly where it will land — always clamped to a spot that is in reach with a clear line to it, so a drop can never cross a wall, force field, or barrier. The shadow predicts whichever action fits where your cursor is:
> - **Cursor outside the operating radius** → it previews the **E-drop**: the item set down right next to her, in the direction she's looking. The roaming cursor neither moves it nor turns her eyes. Drawn **solid**. Only **E** commits this — a click out here never drops.
> - **Cursor inside the operating radius** → it previews the **mouse-click drop**: the item right where the cursor is. Drawn **translucent**. A **click** or **E** commits it.

## Carriable devices

Beyond the connector and the box, three devices live on the field:

- **Mine** — *programmable.* Carries a fuse (3 s by default, reprogrammable) that begins counting down the moment it is first set down; on zero it destroys nearby walls.
- **Rewirer** — *programmable + targeting.* Holds a colour (red by default, or green/blue) and, with line of sight, recolours a source or receiver it targets.
- **Jammer** — *targeting only.* With line of sight it freezes a force field or a deployed mine; its effect is live only while the jammer itself is on the ground.

> The carry / placement / programming **interaction tree** is live. Still pending: the time-evolving simulation — the mine actually counting down and exploding, and the jammer's freeze and the recolour propagating through the light engine.

## Targeting & programming

A brief click while carrying just **drops** the item (inside the ring). To target or program a carried device, **press and hold in the operating ring** (off the character, inside the circle) for about a third of a second, **or hold E** for the same time. The mouse hold draws the golden arrow first; **E goes straight to the end state** (no arrow). What happens depends on the device:

- **Neither targeting nor programmable** (a box) → nothing; the hold is swallowed and the box is not dropped.
- **Targeting only** (connector, jammer) → the mouse hold launches a golden arrow, then a half-second window: **pull the cursor out of the ring** to keep drawing the arrow to a target, or **keep it inside** to drop into **click-by-click** (an E hold enters this directly). The device turns gold, you release the button and click targets one by one (a connector links nodes; a jammer marks a field or deployed mine).
- **Programmable only** (mine) → a small chooser opens to set the value (the fuse time).
- **Programmable + targeting** (rewirer) → if its colour is unset it asks you to set it first; otherwise a **Setup / Target** menu opens — *Setup* reprograms the colour, *Target* enters click-by-click which *marks* a source/receiver in line of sight. The recolour itself is applied when the rewirer is deployed (a later phase), so marking is all that happens now — like the jammer.

**Leaving click-by-click:** a brief click on empty space (anything that isn't a target) or a tap of E returns you to ordinary carrying.
