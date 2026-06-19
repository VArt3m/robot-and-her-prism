# CLAUDE.md — robot_prism_html

Browser port of a 2-D light-beam puzzle. Pure ES modules, **no build step, no framework, no deps**. See `README.md` for gameplay/controls/features; this file is for navigating the code.

> The active, canonical implementation lives here. The sibling `../robot_prism_py/` is legacy — do not use it (see the parent `../CLAUDE.md`).

## Layout (dependency flow is one-way: core → sim → ui)

```
js/core/   constants.js (physics consts, COLORS, WORLD_W/H)  entities.js (Node/Wall/Barrier/ForceField)
           geometry.js (seg_inter, pt_seg_dist, dist…)  strings.js (STR, i18n; incl. STR.panel)
js/sim/    engine.js   light/logic/forcefield solver  (solve + step, ~700 ln); ray_clear (shared LOS)
           motion.js   player/box movement, reach, placement_spot
           world.js    scene state + FACADE over Engine/Motion (read-through getters)
           objects.js  OBJECT_TYPES table (material/carriable/requiresTarget/programmable/jammable/radius)
           targeting.js   TARGET_SPECS — per-kind targeting data (incl. candidates()) behind a shared core
           programming.js PROGRAM_SPECS — per-kind programming data behind a shared core
           occlusion.js   RAY_OCCLUSION + carriedRayType + visibilityPolygon (the "passable ray area")
           level.js    the single hand-built level (build_level())
js/ui/     renderer2d.js  Canvas2D (DPR-aware, letterboxed); render(world, uiState); world↔screen transforms
           input.js       keyboard/mouse → events + held/drainActions (Q/F highlight holds live in `held`)
           panel.js       DOM overlay tool panel (top-left): highlight toggles, targeting, reset-hold, undo
           app.js         game loop, all play interactions (~1500 ln, the big one)
```

## Key patterns — learn these before adding features

- **Spec-driven frameworks.** Targeting and programming are each ONE generic interaction core (in `app.js`) driven by per-kind data in `targeting.js` / `programming.js`. To add a targetable/programmable device: set the flag in `OBJECT_TYPES` (`objects.js`) and add one spec entry — **do not add per-kind branches in `app.js`**. The frameworks' own doc-comments explain every spec field. `test_targeting.mjs` / `test_programming.mjs` enforce that every flagged kind has a conforming spec.
- **Programming is gated behind Forges.** Targeting is summoned by the annulus press-and-hold gesture / E-hold (`_updateGestures`, `_fireECarryTree` — TARGETING only now). Programming is summoned ONLY at a **Forge**: `app._invokeForge()` (the `F` key / the panel's hidden "Program" button) opens the programming chooser when a programmable item is carried within a Forge's `FORGE_REACH` and the Forge has `uses` left; each *applied* value spends one use (Escape closes for free). A Forge is a stationary, non-carriable `forge` node that is **material** — it occludes light (`engine._leveled_blockers`) and blocks movement/placement (`motion.move_player`, `world.object_pos_blocked`) like other objects, via `world.forges()`. Connectors are `programmable` too (field `color`, `null` = clean): a Forge cleans or corrupts them, the same locked-colour state a fired rewirer leaves.
- **World is a facade.** `world.js` owns raw state (nodes, boxes, links, jam_links, recolor_links) and exposes solver outputs as read-through getters (`w.emit`, `w.lit`, `w.beams_draw`…) that delegate to `engine`. Movement delegates to `motion`. Add new derived state to the engine, not the world.
- **Solve vs step.** `world.solve(cold, fillInstant)` = full recompute (call after any structural/state change or restore). `world.step(now)` = per-frame advance of animated charge/beams; returns "still live". `app._tick` only steps when something is dirty/live.
- **Undo = snapshot inputs only.** `app._captureState` / `_restoreState` snapshot *input* state (positions, links, per-node color/fuse/spent); derived state is recomputed by `solve()` on restore. `_sig()` is the cheap signature used to decide if a drag actually changed anything worth an undo point. Max 3 steps (`UNDO_MAX`).
- **Carry "shadow".** While carrying, `_syncCarried` + `_resolvePlacement` + `motion.placement_spot` continuously compute a guaranteed-legal, in-reach drop spot, so `_commitPlacement` needs no further reach test. Stacking legality lives in `STACK_RULES` (`app.js`).
- **Strings.** All user-facing text goes through `STR.*` (`core/strings.js`), never inline literals.
- **IDs/links.** Light links are a `Set` of sorted `"a\x00b"` keys; jam/recolor intents are `Map`s (one target per device, re-mark overwrites).
- **Tool panel + highlights.** `panel.js` is a DOM overlay (not canvas-drawn) built by `app.js`; it reports presses through callbacks and is refreshed each frame via `panel.refresh()`. Two highlights — "possible targets" and "passable ray area" — are each the XOR of a sticky panel toggle and a momentary held key (`Shift` → `held.has('hl_targets')`, `Space` → `held.has('hl_passable')`), so holding the key *suppresses* a toggled-on highlight. (Shift + Space sit under one palm and dodge the browser-owned Alt/Ctrl chords; `input.js` preventDefaults Space so it neither scrolls nor activates a focused button.) `app._updateHighlights()` computes `uiState.{showTargets,showPassable,targetHints,passableRegion}`; the renderer just draws them. "Possible targets" is spec-driven: each `TARGET_SPEC` exposes `candidates(world, deviceId, origin)` (reachability via `world.ray_clear`); add the hook, never per-kind UI branches. "Passable ray area" is `occlusion.visibilityPolygon` over the carried item's `carriedRayType`. The panel politely fades (`setConflict`, ~1 s) when it covers a live target the player is reaching for during a targeting gesture — `app._panelConflict()` decides this from the panel footprint vs. candidate screen positions.
- **Reset/undo tuning.** `UNDO_MAX = 6`, `RESET_HOLD_SEC = 2` (in `app.js`), honoured identically for the keyboard (Z / hold R) and the panel buttons; the panel's reset hold is merged with the key in `_updateResetHold`.

## Run & test

- **Run:** `python server.py` → http://127.0.0.1:8080 (server forces correct JS MIME). Or `npm run serve` / `npx serve .`.
- **Tests:** headless suites in `test/` (`test_integration`, `_jam`, `_occlusion`, `_placement`, `_programming`, `_rewirer`, `_targeting`, `_tree`, `_highlight`). Each is a standalone script that prints its tally and exits non-zero on failure.
  - **All:** `npm test` (or `node run-tests.mjs`).
  - **Selected:** `node run-tests.mjs jam tree` — runs suites whose filename contains any given substring.
  - **One, directly:** `node test/test_targeting.mjs`.
- **Note:** `package.json` declares `"type":"module"` so the `.js` source imports as ESM under Node. Without it, Node treats `.js` as CommonJS and every suite fails with *"is a CommonJS module"*. The browser is independent (`index.html` loads everything as `type="module"`). The project still has no third-party deps; `package.json` exists only for the module type and the test/serve scripts.

## Status / not-yet-done (per README)

Level editor is stubbed (`uiState.mode 'play'|'edit'`, switch wired but unimplemented). Mine countdown/explosion not implemented (fuse is programmable but inert). Connector cleaning/corruption now exists via the Forge (no standalone "uncolour" device). A `renderer3d.js` is anticipated — keep the `render(world, uiState)` contract renderer-agnostic.
