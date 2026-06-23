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

// ---------------------------------------------------------------------------
// 4. INTERCEPTION SPOTS. Where two beams meet, the crossing POINT gets a small
//    occlusion presence — so a beam reaching the spot at its OWN endpoint (which
//    the beam-SEGMENT obstacles miss) still defeats the directional suppression.
// ---------------------------------------------------------------------------
{
  const w = new World(); w._uid = 1;
  w.add(new Node('s1', 'source', [100, 300], { color: 'red' }));
  w.add(new Node('c1', 'connector', [300, 300]));
  w.toggle_link('s1', 'c1');
  const eng = w.engine;
  const emit = { s1: 'red', c1: 'red' };
  const rank = new Map([['s1', 0], ['c1', 1]]);   // s1 stronger; c1→s1 is the suppressed back-beam
  const backBeam = () => eng._beams_and_cross(emit, rank, new Set())[0]
    .some(b => b.o === 'c1' && b.t === 's1');

  // A SEGMENT obstacle that only touches the path at its endpoint (s1) is missed
  // by the strict segment test — the back-beam stays suppressed (the old bug).
  eng._ray_obstacles = [{ o: 'ox', t: 'oy', level: 0, P1: [100, 200], P2: [100, 400] }];
  ok(!backBeam(), 'a crossing only at the target ENDPOINT is missed by the segment test');

  // A crossing-POINT blob at that same spot (the target endpoint) DOES register,
  // so the back-beam is emitted — the fix.
  eng._ray_obstacles = [{ cross: true, P: [100, 300], r: 4, level: 0, owners: new Set() }];
  ok(backBeam(), 'an interception blob at the target endpoint defeats suppression');

  // A blob off to the side (beyond its small radius) does nothing.
  eng._ray_obstacles = [{ cross: true, P: [200, 360], r: 4, level: 0, owners: new Set() }];
  ok(!backBeam(), 'a blob off the path (outside its radius) leaves it suppressed');

  // Thickness bias: a junction just past the blob radius (4) but within the ray's
  // half-thickness (+2 → 6) still intercepts — a body that barely grazes is caught.
  eng._ray_obstacles = [{ cross: true, P: [200, 305], r: 4, level: 0, owners: new Set() }];
  ok(backBeam(), 'a spot grazed by the ray body (within blob + half-thickness) intercepts');
  // Clearly beyond blob + half-thickness: no contact, no interception.
  eng._ray_obstacles = [{ cross: true, P: [200, 308], r: 4, level: 0, owners: new Set() }];
  ok(!backBeam(), 'a spot beyond the ray body does not intercept');

  // A blob whose owners include an endpoint of the pair is that beam's OWN
  // interception — skipped, so it never self-un-suppresses.
  eng._ray_obstacles = [{ cross: true, P: [100, 300], r: 4, level: 0, owners: new Set(['c1']) }];
  ok(!backBeam(), 'a blob owned by the beam itself is skipped');

  // A blob at the emitter end (behind the start) does not obstruct.
  eng._ray_obstacles = [{ cross: true, P: [300, 300], r: 4, level: 0, owners: new Set() }];
  ok(!backBeam(), 'a blob at the emitter end does not count');
}

// ---------------------------------------------------------------------------
// 5. BLOB GENERATION. A T-junction (one beam ending on another) yields one blob
//    at the interception, tagged with the forming beams as owners.
// ---------------------------------------------------------------------------
{
  const eng = new World().engine;
  const beams = [
    { o: 'a', t: 'b', O: [300, 100], dx: 0, dy: 1, level: 0 },   // vertical, len 400 → [300,500]
    { o: 'c', t: 'd', O: [100, 300], dx: 1, dy: 0, level: 0 },   // horizontal, len 200 → ends at [300,300]
  ];
  const blobs = eng._beamCrossBlobs(beams, [400, 200]);
  ok(blobs.length === 1 && Math.abs(blobs[0].P[0] - 300) < 1e-6 && Math.abs(blobs[0].P[1] - 300) < 1e-6,
     'a T-junction yields a blob at the interception point');
  ok(blobs[0].owners.has('a') && blobs[0].owners.has('d'), 'the blob records the forming beams as owners');

  // Two beams that share a node (a fan) are not an interception → no blob.
  const fan = [
    { o: 'x', t: 'b', O: [300, 300], dx: 1, dy: 0, level: 0 },
    { o: 'x', t: 'd', O: [300, 300], dx: 0, dy: 1, level: 0 },
  ];
  ok(eng._beamCrossBlobs(fan, [100, 100]).length === 0, 'beams sharing a node make no interception blob');

  // The built obstacle set carries blobs alongside the beam segments.
  const obs = eng._obstaclesFromBeams(beams, [400, 200]);
  ok(obs.some(o => o.cross) && obs.some(o => o.P1), 'obstacles include both segments and interception blobs');
}

console.log(`\nray-occlusion tests: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
