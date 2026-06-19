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
    │   ├── objects.js   # carriable-object attribute table (+ jammable)
    │   ├── targeting.js # per-kind targeting specs behind one generic core
    │   ├── programming.js # per-kind programming specs behind one generic core
    │   ├── occlusion.js # what each emitted ray passes through (one table)
    │   ├── world.js     # scene state + facade over Engine / Motion
    │   └── level.js     # hand-built sample level
    └── ui/              # presentation + input (depends on core, sim)
        ├── renderer2d.js  # Canvas 2D renderer (DPR-aware, letterboxed)
        ├── input.js       # keyboard / mouse input handler
        ├── panel.js       # corner tool panel (DOM overlay above the canvas)
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
| C | Clear every intent of the carried targeting device — a connector's links, a jammer's jam mark (works while carrying or in click-by-click) |
| Hold Shift | Highlight what the carried item can target (rings; dashed = no clear shot). Inverts the panel "Targets" toggle while held |
| Hold Space | Highlight where the carried item's ray can travel (a translucent area). Inverts the panel "Ray reach" toggle while held |
| Z | Rewind — undo the last meaningful action (up to 6 steps) |
| Hold R (2s) | Full reset — rebuild the entire playfield from scratch |
| G | Reset gate latch states |

> While you carry something, a **shadow** shows exactly where it will land — always clamped to a spot that is in reach with a clear line to it, so a drop can never cross a wall, force field, or barrier. The shadow predicts whichever action fits where your cursor is:
> - **Cursor outside the operating radius** → it previews the **E-drop**: the item set down right next to her, in the direction she's looking. The roaming cursor neither moves it nor turns her eyes. Drawn **solid**. Only **E** commits this — a click out here never drops.
> - **Cursor inside the operating radius** → it previews the **mouse-click drop**: the item right where the cursor is. Drawn **translucent**. A **click** or **E** commits it.

## Carriable devices

Beyond the connector and the box, three devices live on the field:

- **Mine** — *programmable.* Carries a fuse (3 s by default, reprogrammable) that begins counting down the moment it is first set down; on zero it destroys nearby walls.
- **Rewirer** — *programmable + targeting.* Holds a colour (red by default, or green/blue) and, once deployed with a clear shot to its single target, charges for three seconds and then recolours that target — a source, receiver, **or connector** — exactly once, destroying itself. Picking it up before the charge completes cancels it; the charge will not even begin if the shot is blocked. A recoloured connector accepts light of any colour without conflict but always re-emits its own colour.
- **Jammer** — *targeting only.* With line of sight it freezes a force field or a deployed mine; its effect is live only while the jammer itself is on the ground.

> The carry / placement / programming **interaction tree** is live, the **jammer** disables its target for real, and the **rewirer** now charges and recolours through the light engine (recoloured connectors emit their own colour). Still pending: the mine actually counting down and exploding, and the device that washes a connector's colour back to clear.

## Tool panel

A small translucent panel sits in the upper-left corner of the playfield. Its
header chevron collapses it vertically. The controls are:

- **Targets** — sticky toggle: highlight everything the carried item can target.
  A bright ring marks a target with a clear shot; a faint dashed ring marks one
  the ray cannot currently reach. Equivalent to holding **Shift** momentarily —
  and when the toggle is on, holding Shift *suppresses* it.
- **Ray reach** — sticky toggle: highlight the whole area the carried item's ray
  could travel to from where the robot stands (as if she were a light source
  whose rays stop on whatever that item cannot pass). Equivalent to holding
  **Space**, with the same invert-while-held behaviour.
- **Targeting** — enter or leave click-by-click targeting of the carried device.
- **Reset** — press and hold for 2 s to rebuild the whole playfield (same as
  holding **R**).
- **Undo** — rewind one step (up to 6; same as **Z**).

If the panel happens to cover an item you are trying to target — while sweeping
the golden link arrow or in click-by-click — and you move the cursor onto the
panel, it politely fades out after a second so you can reach what is behind it,
then fades back the moment the conflict is resolved.

## Targeting & programming

A brief click while carrying just **drops** the item (inside the ring). To target or program a carried device, **press and hold in the operating ring** (off the character, inside the circle) for about a third of a second, **or hold E** for the same time. The mouse hold draws the golden arrow first; **E goes straight to the end state** (no arrow).

**The targeting interaction is one shared framework**, identical for every object that can have targets — you never learn it twice. Any such object follows the same core:

- a long press (E or mouse) begins targeting;
- the **golden arrow** is available in the window from ~0.333 s to ~0.833 s into a mouse press — pull out of the ring to keep drawing it to a target, or stay inside to drop into **click-by-click** (an E hold enters click-by-click directly);
- a click on an **intent ray deletes** it (every ray in the small hit zone goes at once);
- **C clears** every intent of the carried device.

What differs per object is *only* its data, declared in one spec in `js/sim/targeting.js`: how many intents it may hold, what it is allowed to target, and how an intent is stored, drawn, and cleared. Today:

- **Connector** — many intents; targets sources / receivers / connectors; the arrow (and a character-drag) toggle light links.
- **Jammer** — one intent; targets a force field or a jammable node; the arrow sets the single target.
- **Rewirer** — one intent; targets a source / receiver / connector; the arrow sets the single target (a new mark overwrites the old). When its charge completes it recolours that target once and is spent. The single-intent-overwrite behaviour is the rewirer's own choice, not a framework assumption — the spec still declares its `maxIntents`, leaving room for a future object that must hold exactly two.

Programmable devices add a programming step on top, and it is **its own shared framework** (`js/sim/programming.js`): a long press on a carried programmable device always summons a chooser menu, and picking a value sets one of its fields. Only the menu *contents* differ per object, declared in one spec — the mine's spec offers fuse seconds, the rewirer's offers a colour; a future device could offer, say, a movement axis. A device that is both programmable and targeting (the rewirer) gets a **Setup / Target** menu that routes into whichever framework you pick. To add a new programmable object, give its type `programmable: true` and add one spec entry (plus its menu/flash strings) — the core does not change. (`test_programming.mjs` enforces that every `programmable` kind has a conforming spec, and `test_targeting.mjs` does the same for targeting.)
