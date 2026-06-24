// Tests for the player COLLISION + carry-physics fixes:
//   • radius-aware static collision (the body is a swept disc, so she can no
//     longer slip her centre through the off-by-a-pixel gaps where blocker
//     segments meet — force-field ends, the tan/purple jog, wall corners),
//   • the purple field auto-dropping a carried object on contact (near side
//     only; never crossing) unless she is carefully manipulating it (cursor
//     inside her activation ring),
//   • the upper-left wall extension that makes the src_red sightline from the
//     purple-field lip barely-but-surely impossible,
//   • MATERIALITY: every `material` object (objects.js) stops the player and
//     blocks placement — the carriable devices (jammer / accumulator idle OR
//     charging / …) and the source / receiver fixtures alike — while NONE of the
//     newly-solid fixtures occlude light (rays must still reach a source /
//     receiver to target them).
// Run: node test_collision.mjs
import { LEVELS } from '../js/sim/level.js';
import { World } from '../js/sim/world.js';
import { Node } from '../js/core/entities.js';
import { pt_seg_dist } from '../js/core/geometry.js';
import { PLAYER_R, CONN_R, CONNECT_REACH, FORGE_REACH } from '../js/core/constants.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL:', m); } };

const R = PLAYER_R - 2;   // the clearance the radius-aware check enforces

// Greedy local navigator over real world.move_player: from `start`, repeatedly
// step 3px toward `inside` (trying jittered headings, keeping the best) for up
// to `steps`. Returns whether she got within 3px of `inside`.
function reaches(buildCarry, start, inside, steps = 4000) {
  const w = LEVELS[1].build();           // Test Grounds (superset geography)
  if (buildCarry) w.carry_box = [...start];   // carrying ⇒ the purple field is solid
  w.player = [...start];
  let best = Infinity;
  for (let i = 0; i < steps; i++) {
    const p = [...w.player];
    const dx = inside[0] - p[0], dy = inside[1] - p[1], d = Math.hypot(dx, dy) || 1;
    let bp = p, bd = Infinity;
    for (const a of [0, 0.25, -0.25, 0.5, -0.5, 0.9, -0.9, 1.4, -1.4, 2, -2, 2.7, -2.7, 3.14]) {
      const ux = Math.cos(a) * dx / d - Math.sin(a) * dy / d;
      const uy = Math.sin(a) * dx / d + Math.cos(a) * dy / d;
      w.player = [...p];
      w.move_player(ux * 3, 0); w.move_player(0, uy * 3);
      const nd = Math.hypot(inside[0] - w.player[0], inside[1] - w.player[1]);
      if (nd < bd) { bd = nd; bp = [...w.player]; }
    }
    w.player = bp; best = Math.min(best, bd);
    if (best < 3) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 1. Radius-aware collision SEALS the reported clip junctions.
//    (Fields start closed, so the far side is reachable only through the gap.)
// ---------------------------------------------------------------------------
ok(!reaches(false, [1001, 235], [1001, 300]), 'cannot clip the far-right force-field/wall junction');
ok(!reaches(false, [795, 505], [820, 560]),  'cannot clip into the lower-right room corner (ff_bot/purple)');
ok(!reaches(false, [772, 20],  [800, 20]),   'cannot clip where the tan barrier meets the top border');
ok(!reaches(true,  [760, 560], [815, 560]),  'cannot carry an object across the purple field');

// ---------------------------------------------------------------------------
// 2. The level stays fully traversable (coarse flood-fill, fields open).
// ---------------------------------------------------------------------------
{
  const w = LEVELS[1].build();
  for (const ff of w.ffs) ff.is_open = true;
  // spawn must be clear of every blocker by at least the radius
  const segs0 = w.staticBlockerSegs({ barriers: 'carry', carry: false });
  const spawnClear = Math.min(...segs0.map(([s1, s2]) => pt_seg_dist(w.player_start, s1, s2)));
  ok(spawnClear >= R, `spawn is clear of walls (${spawnClear.toFixed(1)} >= ${R})`);

  const G = 6, key = (x, y) => `${Math.round(x / G)},${Math.round(y / G)}`;
  const seen = new Set([key(...w.player_start)]);
  const q = [[...w.player_start]]; const reached = [];
  let guard = 0;
  while (q.length && guard++ < 60000) {
    const p = q.shift(); reached.push(p);
    for (const [dx, dy] of [[G, 0], [-G, 0], [0, G], [0, -G]]) {
      w.player = [...p]; w.move_player(dx, 0); w.move_player(0, dy);
      if (Math.hypot(w.player[0] - p[0], w.player[1] - p[1]) < 0.5) continue;
      const np = [...w.player], k = key(...np);
      if (!seen.has(k) && np[0] > 5 && np[0] < 1013 && np[1] > 5 && np[1] < 635) { seen.add(k); q.push(np); }
    }
  }
  const within = (t, r) => reached.some(p => Math.hypot(p[0] - t[0], p[1] - t[1]) < r);
  for (const [id, r] of [['src_red', CONNECT_REACH], ['con_1', CONNECT_REACH], ['con_2', CONNECT_REACH],
                          ['src_blue', CONNECT_REACH], ['rcv_red', CONNECT_REACH], ['forge_a', FORGE_REACH]])
    ok(within(w.nodes[id].pos, r), `${id} is still reachable`);
  ok(within(w.goal, 18), 'the goal is still reachable');
}

// ---------------------------------------------------------------------------
// 3. Sliding parallel to a wall is allowed; driving into it is stopped.
// ---------------------------------------------------------------------------
{
  const w = LEVELS[1].build();
  // Stand a touch left of the right border wall (x=1006) in open space.
  w.player = [1006 - R - 4, 200];
  const x0 = w.player[0];
  w.move_player(0, 30);                         // parallel slide (down) along the wall
  ok(Math.abs(w.player[1] - 230) < 1 && Math.abs(w.player[0] - x0) < 1e-6, 'slides parallel to a wall');
  w.player = [1006 - R - 4, 200];
  w.move_player(20, 0);                         // straight into the wall
  ok(w.player[0] < 1006 - R + 1, 'driving into a wall is stopped near the radius, never through it');
}

// ---------------------------------------------------------------------------
// 4. blocked_by_purple is PURPLE-specific.
// ---------------------------------------------------------------------------
{
  const w = LEVELS[0].build();
  ok(w.blocked_by_purple([770, 560], [805, 560]) === true,  'crossing the purple field reads as a purple block');
  ok(w.blocked_by_purple([770, 300], [805, 300]) === false, 'crossing the tan barrier does NOT (it blocks empty-handed too)');
  ok(w.blocked_by_purple([400, 300], [420, 300]) === false, 'an open-space move is not a purple block');
  // purple is passable empty-handed, solid while carrying
  const a = [795, 560], b = [778, 560];
  const wEmpty = LEVELS[0].build(); wEmpty.player = [...a]; wEmpty.move_player(b[0] - a[0], 0);
  ok(wEmpty.player[0] < 786, 'empty-handed she walks through the purple field');
}

// ---------------------------------------------------------------------------
// 5. Fix #1 geometry: the upper-left wall reaches y=146 and the src_red
//    sightline from the room+lip is sealed, doorway still wide.
// ---------------------------------------------------------------------------
{
  const w = LEVELS[0].build();
  const upper = w.walls.find(wl => wl.p1[0] === 235);
  const lower = w.walls.find(wl => wl.p1[0] === 237);
  ok(upper.p2[1] === 146, 'upper-left wall extended to y=146');
  ok(lower.p1[1] - upper.p2[1] > 2 * PLAYER_R, 'player doorway between the two left walls stays ample');

  const src = w.nodes['src_red'].pos;
  const wallSegs = w.walls.map(wl => [wl.p1, wl.p2]);
  const cross = (p1, p2, p3, p4) => {
    const d = (p2[0]-p1[0])*(p4[1]-p3[1])-(p2[1]-p1[1])*(p4[0]-p3[0]);
    if (Math.abs(d) < 1e-9) return false;
    const t = ((p3[0]-p1[0])*(p4[1]-p3[1])-(p3[1]-p1[1])*(p4[0]-p3[0]))/d;
    const u = ((p3[0]-p1[0])*(p2[1]-p1[1])-(p3[1]-p1[1])*(p2[0]-p1[0]))/d;
    return t > 1e-6 && t < 1-1e-6 && u > 1e-6 && u < 1-1e-6;
  };
  const losClear = p => !wallSegs.some(([a, b]) => cross(p, src, a, b));
  let clear = false;
  for (let x = 740; x <= 1002 && !clear; x += 1)
    for (let y = 500; y <= 624; y += 1) {
      const p = [x, y];
      if (!w.object_pos_blocked(p, CONN_R, {}) && losClear(p)) { clear = true; break; }
    }
  ok(!clear, 'no placeable connector in the room+purple-lip has a clear beam to src_red');
}

// ---------------------------------------------------------------------------
// 6. App-level: the purple field auto-drops a carried object on contact,
//    on the near side, and the activation-ring exception suppresses it.
// ---------------------------------------------------------------------------
{
  const noop = () => {};
  const ctx2d = new Proxy({}, { get: (t, k) => (k in t ? t[k] : (k === 'measureText' ? () => ({ width: 0 }) : noop)), set: (t, k, v) => { t[k] = v; return true; } });
  const canvas = { width: 1018, height: 640, getContext: () => ctx2d, parentElement: { clientWidth: 1018, clientHeight: 640 }, addEventListener: noop, removeEventListener: noop, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1018, height: 640 }) };
  globalThis.window = { devicePixelRatio: 1, addEventListener: noop, removeEventListener: noop };
  globalThis.document = { addEventListener: noop };
  globalThis.performance = globalThis.performance || { now: () => Date.now() };
  globalThis.requestAnimationFrame = () => 0; globalThis.cancelAnimationFrame = noop;
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  const { App } = await import('../js/ui/app.js');

  const setup = () => {
    const statusEl = { textContent: '' };
    const app = new App(canvas, statusEl);   // starts on Lorem's Puzzle #1
    const w = app.world;
    w.player = [...w.nodes['con_1'].pos];      // sit on con_1 (in the lower-right room)
    app._pickItem({ kind: 'connector', id: 'con_1' });
    w.player = [795, 560];                     // just inside the room, ~9px right of purple
    app.input.hasFocus = true;
    app.input.held = new Set(['left']);        // push toward the purple field
    return app;
  };

  // (a) cursor OUTSIDE the activation ring → the object drops, on the near side.
  {
    const app = setup(); const w = app.world;
    app.uiState.mouse = [w.player[0] + 60, w.player[1]];   // 60px away (outside CONNECT_REACH)
    app._syncCarried();
    ok(app.uiState.placePreview, 'a near-side shadow exists before the drop');
    app._tick(performance.now() / 1000);
    ok(w.carrying === null, 'walking into the purple field drops the carried object');
    ok(w.nodes['con_1'].pos[0] > 786, 'the dropped object stays on the near side (never crosses the field)');
  }

  // (b) cursor INSIDE the activation ring → careful manipulation, no drop.
  {
    const app = setup(); const w = app.world;
    app.uiState.mouse = [w.player[0] + 10, w.player[1]];   // 10px away (inside CONNECT_REACH)
    app._syncCarried();
    app._tick(performance.now() / 1000);
    ok(w.carrying === 'con_1', 'with the cursor in her activation ring the object is NOT dropped');
  }
}

// ---------------------------------------------------------------------------
// 7. MATERIALITY: every `material` object stops the player — not just relays /
//    forges. A jammer, an IDLE accumulator (the "half-way" charging-only case is
//    now whole), a source and a receiver are all solid: the robot can no longer
//    walk her centre through their bodies. Yet the source / receiver fixtures
//    occlude NO light, so a ray can still reach (target) them.
// ---------------------------------------------------------------------------
{
  const mk = () => { const w = new World(); w._uid = 1; return w; };
  // Walk straight from `from` toward `to` (through the object centred between
  // them). Returns true only if she gets all the way (i.e. nothing stopped her).
  const walksThrough = (w, from, to) => {
    w.player = [...from];
    for (let i = 0; i < 400; i++) {
      const dx = to[0]-w.player[0], dy = to[1]-w.player[1], d = Math.hypot(dx, dy) || 1;
      if (d < 1) return true;
      const before = [...w.player];
      w.move_player(dx/d*3, 0); w.move_player(0, dy/d*3);
      if (w.player[0] === before[0] && w.player[1] === before[1]) return false;   // stopped at the body
    }
    return Math.hypot(w.player[0]-to[0], w.player[1]-to[1]) < 1;
  };

  for (const [kind, extra] of [
    ['jammer',      {}],
    ['accumulator', { color: null }],                       // IDLE — not charging
    ['rewirer',     {}],
    ['mine',        { fuse: 3 }],
    ['source',      { color: 'red' }],
    ['receiver',    { color: 'red', fill_time: 1 }],
  ]) {
    const w = mk();
    w.add(new Node('M', kind, [300, 300], extra));
    ok(!walksThrough(w, [300, 270], [300, 330]),
       `a ${kind} is material — the robot cannot walk through its body`);
    // She is stopped, but never trapped INSIDE the skin: her centre stays at
    // least (radius - 2) clear of the body she pressed against.
    ok(Math.hypot(w.player[0]-300, w.player[1]-300) > PLAYER_R + CONN_R - 4,
       `the robot stops at the ${kind}'s surface, not inside it`);
  }

  // A charging accumulator blocks at its GROWN footprint (already true; now via
  // the unified material path) — strictly larger than the idle body.
  {
    const w = mk();
    w.add(new Node('gs', 'source', [0, 300], { color: 'green' }));
    w.add(new Node('bs', 'source', [600, 300], { color: 'blue' }));
    w.add(new Node('A', 'accumulator', [300, 300], { color: null }));
    w.toggle_link('gs', 'A'); w.toggle_link('bs', 'A');
    w.solve(true); w.step(0); w.step(0.3);                  // begin charging → grows
    ok(w.engine.accumFootprintRadius('A') > CONN_R, 'the accumulator is charging (grown)');
    ok(w.nodeFootprintRadius('A') === w.engine.accumFootprintRadius('A'),
       'movement reads the grown footprint while charging');
  }

  // Sources & receivers are SOLID — material to the robot AND (now) standard
  // light obstacles. The pass-through-vs-deliver nuance + outer-contour reach are
  // pinned in test_occlusion; here we just confirm both facets are present.
  {
    const w = mk();
    w.add(new Node('src', 'source',   [100, 100], { color: 'red' }));
    w.add(new Node('rcv', 'receiver', [500, 100], { color: 'red', fill_time: 1 }));
    ok(w.material_nodes().length === 2, 'both fixtures are material (block the robot & placement)');
    ok(w.light_blockers().length > 0, 'sources & receivers now occlude light too (obstacle rules)');
  }

  // Placement honours the new fixtures: a connector may not be dropped overlapping
  // a source, but a spot a hair past their combined radii is fine.
  {
    const w = mk();
    w.add(new Node('src', 'source', [300, 300], { color: 'red' }));
    ok(w.object_pos_blocked([300, 300], CONN_R, {}) === true,  'cannot place a connector on a source');
    ok(w.object_pos_blocked([300, 300 + CONN_R + 13 + 1], CONN_R, {}) === false,
       'a placement just clear of the source is legal');
  }
}

console.log(`\ncollision / carry-physics tests: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
