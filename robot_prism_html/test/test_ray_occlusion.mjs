// Tests for the RAY-OCCLUSION rule on directional suppression.
//
// Normally a higher-rank→lower-rank beam is dropped when the path is materially
// clear (light never flows back toward a stronger source). The new rule: a live
// beam crossing that path counts as wall-like and DEFEATS the suppression, so the
// back-beam is emitted and then cut at the crossing by the ordinary mechanic.
//
// It applies on BOTH paths. The timed step uses engine._ray_obstacles = the
// previous frame's beams. The cold solve has no previous frame, so propagate()
// threads the previous PASS's beams back in as obstacles and iterates until the
// beam field is self-consistent (or caps). A configuration where the radiated
// beam cuts its own obstacle therefore oscillates live and lands on one phase
// statically; that is intended, so these tests pin the MECHANISM, the wiring, and
// static termination/determinism — not a steady end-state of an oscillating scene.
//
// Run: node test_ray_occlusion.mjs
import { World } from '../js/sim/world.js';
import { Node } from '../js/core/entities.js';
import { CUT_LINGER } from '../js/core/constants.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL:', m); } };

const keys = (eng) => eng._last_beams_t.map(b => `${b.o}>${b.t}`);
const hasBeam = (eng, o, t) => eng._last_beams_t.some(b => b.o === o && b.t === t);

// ---------------------------------------------------------------------------
// 0. The cut delay was raised to 0.75s.
// ---------------------------------------------------------------------------
ok(CUT_LINGER === 0.75, `CUT_LINGER === 0.75 (got ${CUT_LINGER})`);

// ---------------------------------------------------------------------------
// 1. MECHANISM (isolated). A source S feeds a connector C (so C→S is the
//    suppressed higher→lower beam). Drive _beams_and_cross directly with a hand
//    -built emit/rank and a hand-set obstacle, so there is no feedback.
// ---------------------------------------------------------------------------
{
  const w = new World(); w._uid = 1;
  w.add(new Node('s1', 'source', [100, 300], { color: 'red' }));
  w.add(new Node('c1', 'connector', [300, 300]));
  w.toggle_link('s1', 'c1');
  const eng = w.engine;
  const emit = { s1: 'red', c1: 'red' };          // c1 lit (emits red)
  const rank = new Map([['s1', 0], ['c1', 1]]);   // s1 stronger than c1

  // No obstacle → C→S is suppressed (light won't flow back to the stronger source).
  eng._ray_obstacles = null;
  let [beams] = eng._beams_and_cross(emit, rank, new Set());
  ok(beams.some(b => b.o === 's1' && b.t === 'c1'), 'forward beam s1→c1 present');
  ok(!beams.some(b => b.o === 'c1' && b.t === 's1'), 'no obstacle: back-beam c1→s1 is suppressed');

  // A ray crossing the c1—s1 segment (vertical through x=200) defeats the
  // suppression: the back-beam c1→s1 is now emitted.
  eng._ray_obstacles = [{ o: 'ox', t: 'oy', level: 0, P1: [200, 200], P2: [200, 400] }];
  [beams] = eng._beams_and_cross(emit, rank, new Set());
  ok(beams.some(b => b.o === 'c1' && b.t === 's1'), 'crossing ray: back-beam c1→s1 is emitted (un-suppressed)');

  // A ray that does NOT cross the segment (off to the side) leaves it suppressed.
  eng._ray_obstacles = [{ o: 'ox', t: 'oy', level: 0, P1: [400, 200], P2: [400, 400] }];
  [beams] = eng._beams_and_cross(emit, rank, new Set());
  ok(!beams.some(b => b.o === 'c1' && b.t === 's1'), 'non-crossing ray: back-beam stays suppressed');

  // A ray sharing a node with the pair is a legitimate meeting, not a crossing.
  eng._ray_obstacles = [{ o: 's1', t: 'oy', level: 0, P1: [200, 200], P2: [200, 400] }];
  [beams] = eng._beams_and_cross(emit, rank, new Set());
  ok(!beams.some(b => b.o === 'c1' && b.t === 's1'), 'obstacle sharing an endpoint node does not count');
}

// ---------------------------------------------------------------------------
// 2. WIRING. The static rule is now ACTIVE on the cold solve too — propagate
//    threads the previous pass's beams back in as obstacles, so a cold solve
//    populates _ray_obstacles. The timed step seeds it from the previous frame.
// ---------------------------------------------------------------------------
{
  const w = new World(); w._uid = 1;
  w.add(new Node('s1', 'source', [100, 300], { color: 'red' }));
  w.add(new Node('c1', 'connector', [400, 300]));
  w.toggle_link('s1', 'c1');

  w.solve(true, false);
  // Cold solve now leaves a populated obstacle set behind (rays-as-walls also
  // applies statically); here the single forward beam s1→c1.
  ok(Array.isArray(w.engine._ray_obstacles), 'cold solve populates _ray_obstacles (static rule active)');
  ok(w.engine._ray_obstacles.some(o => o.o === 's1' && o.t === 'c1'),
     'cold-solve obstacles include the forward beam');

  // The obstacle list a step builds equals the previous frame's beams (here just
  // the one forward beam s1→c1, spanning its full effective length).
  const obs = w.engine._buildRayObstacles();
  ok(obs.length === 1 && obs[0].o === 's1' && obs[0].t === 'c1', 'obstacles snapshot the previous frame\'s beams');
  ok(Math.abs(obs[0].P2[0] - 400) < 1e-6 && Math.abs(obs[0].P2[1] - 300) < 1e-6,
     'obstacle spans the beam\'s effective length (reaches c1)');

  w.step(0.1);
  ok(Array.isArray(w.engine._ray_obstacles), 'a step populates _ray_obstacles');
}

// ---------------------------------------------------------------------------
// 2b. STATIC TERMINATION + DETERMINISM. A crossing configuration (whose live
//    behaviour self-oscillates) must still make the cold solve TERMINATE and be
//    REPRODUCIBLE — the static fixpoint caps and lands on one consistent phase,
//    the same one every time. (Two perpendicular source→connector beams cross.)
// ---------------------------------------------------------------------------
function crossScene() {
  const w = new World(); w._uid = 1;
  w.add(new Node('s1', 'source', [100, 300], { color: 'red' }));
  w.add(new Node('c1', 'connector', [500, 300]));
  w.add(new Node('s2', 'source', [300, 100], { color: 'green' }));
  w.add(new Node('c2', 'connector', [300, 500]));
  w.toggle_link('s1', 'c1');
  w.toggle_link('s2', 'c2');
  return w;
}
{
  const a = crossScene(); a.solve(true, false);
  const ka = keys(a.engine).sort().join(',');
  const b = crossScene(); b.solve(true, false);
  const kb = keys(b.engine).sort().join(',');
  ok(ka === kb, 'crossing config: cold solve is deterministic (same beams every run)');
  ok(a.engine._last_beams_t.length > 0, 'crossing config: cold solve terminates with a beam field');
}

// ---------------------------------------------------------------------------
// 3. GUARD. A straight chain has no crossing rays, so the rule never fires: the
//    timed step produces the same beams as the cold solve, stably, with no
//    spurious back-beams (no regression for ordinary configurations).
// ---------------------------------------------------------------------------
{
  const w = new World(); w._uid = 1;
  w.add(new Node('s1', 'source', [100, 300], { color: 'red' }));
  w.add(new Node('c1', 'connector', [300, 300]));
  w.add(new Node('c2', 'connector', [500, 300]));
  w.toggle_link('s1', 'c1');
  w.toggle_link('c1', 'c2');

  w.solve(true, false);
  const coldKeys = keys(w.engine).sort().join(',');

  let stableKeys = coldKeys;
  for (let i = 0; i < 6; i++) {
    w.step(0.1 * (i + 1));
    const k = keys(w.engine).sort().join(',');
    if (k !== stableKeys) stableKeys = `CHANGED@${i}:${k}`;
  }
  ok(stableKeys === coldKeys, 'straight chain: timed beams match cold and stay stable');
  ok(!hasBeam(w.engine, 'c1', 's1') && !hasBeam(w.engine, 'c2', 'c1'),
     'straight chain: no spurious back-beams toward the source');
}

console.log(`\nray-occlusion tests: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
