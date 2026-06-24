# Test Suite Guide — *Robot and Her Prism*

A plain-language tour of the automated tests: what exists, how they're built, and
what each one is actually checking. Written so someone who has *not* read the
engine can still follow along. If you only remember one thing: the tests are tiny
standalone scripts that build a toy world, ask the simulation a question, and
assert the answer — no test framework, no browser, no magic.

- **20 suites, ~1062 assertions, run in a few seconds.**
- Everything is headless Node (`.mjs` ES modules); the few UI tests fake just
  enough of a browser to construct the app object.
- Source of truth for behaviour lives in `CLAUDE.md` (architecture) and the per-file
  header comments; this guide ties them together.

---

## 1. How to run them

From the project root:

```bash
node run-tests.mjs            # run every suite
node run-tests.mjs jam tree   # run only suites whose filename contains "jam" or "tree"
```

`run-tests.mjs` finds every `test/test_*.mjs` file, runs each one in its own child
process, streams its output, and prints a final tally. Its own exit code is
non-zero if any suite failed, so it doubles as a CI gate. To run one suite on its
own (handy while debugging) just run the file: `node test/test_mixer.mjs`.

## 2. How a single suite is built

Every suite follows the same little pattern, so once you've read one you can read
all of them. There is no `expect(...)` library — just a four-line scoreboard:

```js
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log('  FAIL:', msg); } };
// ... build a world, do a thing, then a bunch of ok(...) checks ...
console.log(`\nmixer tests: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
```

`ok(condition, message)` is the whole assertion vocabulary. A passing run prints
only the final `N passed, 0 failed` line; a failure prints the `FAIL: <message>`
for the exact check that broke, then exits non-zero so the runner notices.

**What a test actually does**, in three beats:

1. **Build a world.** `import { World } from '../js/sim/world.js'` and
   `import { Node } from '../js/core/entities.js'`, then place nodes
   (`new Node('s1', 'source', [x, y], { color: 'red' })`), add them to the world,
   and wire links with `world.toggle_link('s1', 'c1')`. Walls, force fields and
   the robot's position are set the same direct way.
2. **Solve the light.** Two ways, and the choice matters (see §3):
   - `world.solve(true, false)` — the **cold** solve: settle the light *instantly*
     for a static snapshot. Most physics/device tests use this.
   - `world.step(t)` — one **timed** frame at virtual time `t` (seconds): advances
     animations, charges, and time-based mechanics. Tests that care about charging,
     cut delays, or the timed-only behaviours step a few frames.
3. **Assert.** Read back the result — which beams exist and how far they reach,
   which receivers are *lit*, what each relay *emits*, each node's *rank*, whether a
   relay is *confused* — and `ok(...)` the expected values.

The UI suites (`integration`, `tree`, `placement`, `highlight`, `input`,
`levelselect`) additionally stub a minimal fake `document`/`window` so an `App`
can be constructed with no real DOM; then they call app methods directly and
assert on the resulting UI state.

## 3. The two solve paths (why a test picks one)

The engine can settle the light field two ways, and several tests exist
specifically to pin the difference:

- **Cold solve** (`solve`) is *timeless*. It relaxes the beam field to a
  self-consistent snapshot at a single instant — no clock advances. Use it to ask
  "what is the steady picture of this layout?"
- **Timed step** (`step(t)`) advances one frame of real simulated time. It's where
  animation, the cut-in delay, accumulator charging, rewirer charging, and mine
  fuses live. Use it to ask "what happens *over time*?"

A handful of behaviours only appear on the timed path (e.g. an accumulator filling
up, or the ray-occlusion oscillation), so those suites `step()` in a loop; the rest
prefer the cheaper, deterministic cold solve.

---

## 4. The map — all 20 suites at a glance

| Suite | Checks | Area |
|---|--:|---|
| `test_occlusion` | 46 | Beam physics |
| `test_directional` | 51 | Beam physics |
| `test_rank_feeders` | 23 | Beam physics |
| `test_ray_occlusion` | 29 | Beam physics |
| `test_player_block` | 12 | Beam physics |
| `test_collision` | 43 | Collision & carry |
| `test_inverter` | 62 | Devices |
| `test_mixer` | 61 | Devices |
| `test_accumulator` | 55 | Devices |
| `test_rewirer` | 25 | Devices |
| `test_jam` | 24 | Devices |
| `test_targeting` | 75 | Frameworks |
| `test_programming` | 189 | Frameworks |
| `test_integration` | 108 | UI / app |
| `test_tree` | 96 | UI / app |
| `test_placement` | 70 | UI / app |
| `test_highlight` | 31 | UI / app |
| `test_levelselect` | 18 | UI / app |
| `test_input` | 12 | UI / app |
| `test_levels` | 32 | Levels |

The rest of this document walks each group.

---

## 5. Beam physics — the light simulation core

These are the heart of the game: how rays travel, stop, and decide which way to
flow. They lean on a few recurring ideas, defined once here:

- **Rank** — light is given a direction so it can't loop back upstream. A source is
  rank 0; a relay lit by it is one rank higher; and so on. Light flows *low → high*.
- **Suppression** — a beam from a higher rank back toward a lower rank (i.e. *toward*
  a stronger source) is dropped *when the path between them is complete* (nothing in
  the way). Put a wall between them and the connection is "incomplete", so both ends
  radiate at the wall instead.
- **`hard` vs `hard_mat`** — a beam's length after it's cut by *everything* (`hard`,
  which includes the robot's body when she's blocking) versus by *material only*
  (`hard_mat`, which ignores the robot). The distinction is what keeps the robot
  able to walk through rays.
- **Confused** — a relay that took in light but can't form a valid output yet
  ("hungry"). It emits nothing and is drawn with a dotted "dead" mark.

### `test_occlusion` — what stops a ray
The occlusion model: a beam is stopped by every *material* object (boxes, relays,
forges, closed force fields, the robot when blocking), while a deliberate link
*endpoint* still re-emits rather than being treated as a wall. Confirms walls vs.
barriers vs. force fields behave as intended, and basic line-of-sight
(`world.ray_clear`). §5 adds **sources & receivers as obstacles**: a fixture standing
between a connector and a farther target blocks the beam (the far one stays dark, the
unwired blocker takes nothing), yet a beam that actually *targets* a fixture still
delivers ("what they take, they take"), and that delivering beam stops at the
fixture's **outer contour** (centre − r) rather than plunging into the body.

### `test_directional` — which way light flows
The directional rank law, organised into numbered cases that read like a spec:
rank is feeder-based (a relay sits one step below the weakest feeder it needs); the
headline fix that *source → inverter → connector → receiver* now works without the
inverter getting confused by feedback; a clear chain carries light *forward only*
(no upstream beam); a **wall between two different-rank relays** makes both radiate
at it; **same-rank** relays radiate both ways and meet in the middle; and two
sources into one connector confuse it. This is the suite that defines "light has a
direction."

### `test_rank_feeders` — how a relay earns its rank
The feeder-based ranking rule in detail. A relay's rank isn't a topological
distance; it's computed from what actually *arrives*: for each incoming colour keep
the strongest feeder, then feed the relay those feeders tier by tier (strongest
first) and stop at the first tier that lets it emit — it ranks at *1 + that tier*.
If no tier ever satisfies it, it's confused (unranked, dark). This is what lets
combining tools (mixers, complement inverters) auto-place *downstream* of their
feeders instead of needing a manual rank.

### `test_ray_occlusion` — a ray is also a wall
The newest physics rule: a live beam crossing a path counts as wall-like for the
suppression decision, so a normally-suppressed back-beam gets emitted (and is then
cut at the crossing). It applies on **both** solve paths — the timed step uses the
previous frame's beams as obstacles; the cold solve threads the previous *pass's*
beams back through its own fixpoint until the picture is self-consistent. Because a
radiated beam can cut its own obstacle, a crossed layout oscillates on purpose; the
suite therefore pins the **mechanism** (drive `_beams_and_cross` with a hand-placed
obstacle and watch a suppressed beam reappear), the **wiring** (cold solve populates
the obstacle set, a step seeds it), **static termination + determinism** (a crossing
layout solves the same way 2000× and never hangs), and that an ordinary straight
chain never triggers it.

### `test_player_block` — the robot can stand in a beam without flicker
A regression test for a long-standing, position-dependent *blink*. When the robot
lingers in a beam she becomes a blocker and cuts it at her body. The fix: the test
that engages this block measures her against the beam's *player-independent* length
(`hard_mat`), never the already-cut beam — otherwise engaging the block retracts the
beam off her and instantly disengages it. Covers the off-centre reproducer, the
centred case, stepping clear (the block releases), and a diagonal beam.

---

## 5b. Player collision & carry physics

### `test_collision` — radius-aware movement, the purple field, and one wall
This suite guards the player-physics fixes. **Collision is radius-aware:** the robot
is treated as a disc swept from her old position to the new one, and a move is
blocked when that sweep comes within `PLAYER_R − 2` of any wall, barrier, or closed
force field — not merely when her centre line crosses one. That difference is what
seals the off-by-a-pixel gaps where blocker segments almost meet (a force-field end
beside the border, the tan/purple barrier jog, the tan top beside the ceiling, wall
corners), which a centre-only test let her slip her body through. The suite drives a
small greedy navigator over the *real* `world.move_player` to prove she can no longer
clip those junctions, then flood-fills the level to prove every key spot is still
reachable (sealing the leaks didn't wall anything off), and checks the two everyday
motions directly: sliding parallel to a wall is allowed, driving straight into one
stops at the radius. **The purple field** is the carry-only barrier; the suite checks
that `blocked_by_purple` isolates it (true crossing purple, false crossing the tan
barrier or open space; passable empty-handed). Finally it pins the **app-level
auto-drop** with a mocked DOM: walking a carried object into the field sets it down on
the near side (it never crosses) and she continues empty-handed — unless the cursor is
inside her activation ring, the "careful manipulation" exception, in which case it is
not dropped. The same suite also asserts the **upper-left wall** now reaches `y=146`,
that this closes the `src_red` sightline from the purple-field lip, and that the player
doorway below stays wide. **Materiality** rounds it out: every `material` kind — the
carriable devices (jammer, idle *and* charging accumulator, rewirer, mine) and the
source / receiver fixtures — now stops the robot's body (she can't walk her centre
through one) without trapping her inside the skin, placement refuses to drop an object
overlapping a source, and the fixtures are confirmed to occlude light too (the
pass-through-blocks-vs-endpoint-delivers nuance and the outer-contour reach live in
`test_occlusion`).

---

## 6. Devices — the gadgets

Each device suite builds little worlds that feed the gadget light and check what it
does, plus confirms it inherits the shared relay machinery (links, buttons,
dead/confused map, elevation) where applicable.

### `test_inverter` — the connector's "sister"
The inverter's clean emit rule (swap within a colour pair, or the *complement* form
that emits what's missing to make white), its confusion conditions (no input /
conflict / off-pair colour), corruption parity with connectors, pair
reprogramming, and that the generic relay plumbing treats it exactly like a
connector.

### `test_mixer` — additive combiner
The mixer sums its inputs additively: two primaries → their secondary; anything
reaching white → white (it's the one relay that can *emit* white); a lone secondary
passes through; it's confused by a single primary (nothing to mix) and by white on
its *input* (white is emit-only). Organised as: the colour model, the pure emit rule
(no solve), confusion, behaviour through the full engine, its single
non-programmable / non-corruptible nature, and the "hungry relay" feeder-tier rule
applied to a mixer.

### `test_accumulator` — a portable source with a charge
Two states. **Charged**: a rank-0 source that emits only its own colour, never
relays, and is dead weight that blocks beams passing through it; against a same-rank
source it's a tug-of-war that delivers to neither end. **Empty**: a sink that fills
over a fixed time of one uninterrupted colour, then becomes charged and drops the
link that filled it. The empty→charged transition is a *timed* test (it `step()`s
through the charge window).

### `test_rewirer` — recolour at range
The rewirer's coloured-connector emit rule, its timed charge that only advances on a
clear shot, cancel-on-pickup, reset when the shot is lost, and the spent state. (The
actual *firing + undo* commit, which is UI, is exercised in `test_tree`.)

### `test_jam` — the dark-matter ray
The jammer: how its disabling intent is stored, its live reach, the "dark matter"
ray that walls and *active* force fields stop but barriers do not, logic override,
the chain where disabling a field makes it transparent, and the rule that a jammer
carried in hand is not live.

---

## 7. Frameworks — the data-driven architecture

Two suites guard an *architectural invariant* rather than a single behaviour: adding
a new targetable or programmable gadget should be a small **data** addition (one
spec entry), with no new per-kind code in the core. They're contract tests.

### `test_targeting` — every "needs a target" device is spec-driven
Pins that targeting is entirely spec-driven: the candidate enumeration,
reachability, and wiring all come from a registry entry, so a new targetable object
passes simply by registering. No per-kind branches allowed in the core path. It also
pins `sweepKissTarget` — the character-drag's body-contact (kiss) target finder:
a target is marked when the carried device's body touches it (within the sum of
footprint radii), and crucially a target *beyond* the old `HIT` centre-proximity (the
shot the now-blocked pass-through used to need) is still kissed.

### `test_programming` — every programmable device is spec-driven
The largest suite (189 checks). The programming system models each device as a set
of **facets**; the suite pins that every facet resolves to real menu labels and
flashes, that the chooser-building rules behave (no-op options are hidden,
corruption options are gated to the right kind of Forge, multi-facet devices
compose correctly), so a new programmable object is again just data.

---

## 8. UI / app — interaction, with a faked browser

These construct the real `App` against a minimal stubbed DOM (so the panel stays
inert and input listeners are no-ops) and drive its methods directly. They catch
runtime wiring errors a syntax check can't.

### `test_integration` — the full carry → preview → place flow
A broad runtime smoke test (108 checks). Walks picking up a connector, previewing
the drop shadow, the renderer drawing the ghost, and placing via the **E** key;
the cursor-inside-vs-outside operating-radius split; carrying and placing a box by
direction; the newer carriables (mine / rewirer / jammer); that a few ticks don't
throw; the highlight wiring; the panel-conflict logic and a screen-coordinate
round-trip; and the Forge chooser end-to-end (no-op hiding, clean-vs-corrupting
Forges, the two-Forge overlap dead-zone, and the inverter's multi-facet menu).

### `test_tree` — the gesture state machine + Forge gateway
Drives the press-and-hold annulus gesture (now the golden-arrow wiring only — a
hold launches the arrow, which draws until release; there is no click-by-click
mode and no E-hold targeting) plus the **click-to-intent** path (a plain click on
a target while carrying makes / toggles / erases an intent) and the Forge
programming gateway, by **back-dating timestamps** so the timers fire
deterministically, then asserts each branch of the state machine. It also pins the
**character-drag kiss auto-wire** end-to-end: parked at the materiality-stop distance
from a source (her centre beyond the old `HIT` proximity), a player-drag into it still
wires the link — body contact, not centre-overlap, is what marks now that targets are
solid.

### `test_placement` — the carried-item drop shadow
Headless checks that the continuously-computed, guaranteed-legal, in-reach drop
spot behaves under all the stacking rules (ground / box / connector / elevated).

### `test_highlight` — the corner-panel highlights
The "possible targets" and "passable ray area" overlays: candidate enumeration and
reachability, the visibility polygon, line-of-sight, the toggle-vs-held-key XOR
rule the panel uses, and the panel's polite fade timer — all driven without a DOM.

### `test_input` — keyboard bindings
Pins the momentary-hold bindings (Shift = show targets, Space = show ray reach,
Space's browser scroll/activation suppressed) and spot-checks movement keys so a
future rebind can't silently break them.

### `test_levelselect` — the level-select state machine
Drives the level-picker overlay: opening it via the panel action, Escape and
click-outside cancelling without changing the level, a click loading the chosen
level, the "current" mark following the load, a full reset rebuilding the *current*
level, and the deliberate absence of any keyboard shortcut for it.

---

## 9. Levels — the content

### `test_levels` — the two-level registry
The `LEVELS` registry and its two entries: the full **Test Grounds** sandbox and the
derived **Lorem's Puzzle #1** — the same room with both Forges and the central
pickables removed, keeping exactly one central connector plus the two in the
lower-right room. Also pins the back-compat `build_level()` default.

---

## 10. Adding a test (the conventions)

If you extend the game, mirror the existing style and the runner will pick it up
automatically:

1. Create `test/test_<area>.mjs`.
2. Start with the `pass`/`fail`/`ok` scoreboard from §2.
3. Build a `World`, wire it, `solve()` or `step()`, and `ok(...)` the readbacks.
4. End with the tally line and a non-zero exit on failure:

   ```js
   console.log(`\n<area> tests: ${pass} passed, ${fail} failed`);
   if (fail) process.exit(1);
   ```

5. Group related checks under a short `// --- heading ---` so a reader (and a future
   you) can navigate failures quickly.

`node run-tests.mjs` discovers it by filename — no registration needed.
