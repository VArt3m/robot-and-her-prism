# CLAUDE.md — robot_prism_html

Browser port of a 2-D light-beam puzzle. Pure ES modules, **no build step, no framework, no deps**. See `README.md` for gameplay/controls/features; this file is for navigating the code.

> The active, canonical implementation lives here. The sibling `../robot_prism_py/` is legacy — do not use it (see the parent `../CLAUDE.md`).

## Layout (dependency flow is one-way: core → sim → ui)

```
js/core/   constants.js (physics consts, COLORS)  entities.js (Node/Wall/Barrier/ForceField)
           geometry.js (seg_inter, pt_seg_dist, dist…)  strings.js (STR, i18n)
js/sim/    engine.js   light/logic/forcefield solver  (solve + step, ~700 ln)
           motion.js   player/box movement, reach, placement_spot
           world.js    scene state + FACADE over Engine/Motion (read-through getters)
           objects.js  OBJECT_TYPES table (material/carriable/requiresTarget/programmable/jammable/radius)
           targeting.js   TARGET_SPECS — per-kind targeting data behind a shared core
           programming.js PROGRAM_SPECS — per-kind programming data behind a shared core
           occlusion.js   RAY_OCCLUSION — what each ray type passes through
           level.js    the single hand-built level (build_level())
js/ui/     renderer2d.js  Canvas2D (DPR-aware, letterboxed); render(world, uiState)
           input.js       keyboard/mouse → events + held/drainActions
           app.js         game loop, all play interactions (~1400 ln, the big one)
```

## Key patterns — learn these before adding features

- **Spec-driven frameworks.** Targeting and programming are each ONE generic interaction core (in `app.js`) driven by per-kind data in `targeting.js` / `programming.js`. To add a targetable/programmable device: set the flag in `OBJECT_TYPES` (`objects.js`) and add one spec entry — **do not add per-kind branches in `app.js`**. The frameworks' own doc-comments explain every spec field. `test_targeting.mjs` / `test_programming.mjs` enforce that every flagged kind has a conforming spec.
- **World is a facade.** `world.js` owns raw state (nodes, boxes, links, jam_links, recolor_links) and exposes solver outputs as read-through getters (`w.emit`, `w.lit`, `w.beams_draw`…) that delegate to `engine`. Movement delegates to `motion`. Add new derived state to the engine, not the world.
- **Solve vs step.** `world.solve(cold, fillInstant)` = full recompute (call after any structural/state change or restore). `world.step(now)` = per-frame advance of animated charge/beams; returns "still live". `app._tick` only steps when something is dirty/live.
- **Undo = snapshot inputs only.** `app._captureState` / `_restoreState` snapshot *input* state (positions, links, per-node color/fuse/spent); derived state is recomputed by `solve()` on restore. `_sig()` is the cheap signature used to decide if a drag actually changed anything worth an undo point. Max 3 steps (`UNDO_MAX`).
- **Carry "shadow".** While carrying, `_syncCarried` + `_resolvePlacement` + `motion.placement_spot` continuously compute a guaranteed-legal, in-reach drop spot, so `_commitPlacement` needs no further reach test. Stacking legality lives in `STACK_RULES` (`app.js`).
- **Strings.** All user-facing text goes through `STR.*` (`core/strings.js`), never inline literals.
- **IDs/links.** Light links are a `Set` of sorted `"a\x00b"` keys; jam/recolor intents are `Map`s (one target per device, re-mark overwrites).

## Run & test

- **Run:** `python server.py` → http://127.0.0.1:8080 (server forces correct JS MIME). Or `npm run serve` / `npx serve .`.
- **Tests:** headless suites at project root (`test_integration`, `_jam`, `_occlusion`, `_placement`, `_programming`, `_rewirer`, `_targeting`, `_tree`). Each is a standalone script that prints its tally and exits non-zero on failure.
  - **All:** `npm test` (or `node run-tests.mjs`).
  - **Selected:** `node run-tests.mjs jam tree` — runs suites whose filename contains any given substring.
  - **One, directly:** `node test_targeting.mjs`.
- **Note:** `package.json` declares `"type":"module"` so the `.js` source imports as ESM under Node. Without it, Node treats `.js` as CommonJS and every suite fails with *"is a CommonJS module"*. The browser is independent (`index.html` loads everything as `type="module"`). The project still has no third-party deps; `package.json` exists only for the module type and the test/serve scripts.

## Status / not-yet-done (per README)

Level editor is stubbed (`uiState.mode 'play'|'edit'`, switch wired but unimplemented). Mine countdown/explosion not implemented (fuse is programmable but inert). No "uncolour" device. A `renderer3d.js` is anticipated — keep the `render(world, uiState)` contract renderer-agnostic.
