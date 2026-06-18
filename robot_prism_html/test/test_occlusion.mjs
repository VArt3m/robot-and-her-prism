// Tests for the ray OCCLUSION model (js/sim/occlusion.js) and the laser fix:
// a beam is now stopped by every material object, while a deliberate link
// endpoint still re-emits. Run: node test_occlusion.mjs
import { World } from '../js/sim/world.js';
import { Node, Wall, Barrier, ForceField } from '../js/core/entities.js';
import { RAY_OCCLUSION, rayProfile, rayBlockerSegments } from '../js/sim/occlusion.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL:', m); } };

// ---------------------------------------------------------------------------
// 1. The table itself — the spec the user set, frozen.
// ---------------------------------------------------------------------------
const expect = {
  laser:   { wall: true, barrierTan: false, barrierPurple: false, ffActive: true, object: true,  player: true },
  jammer:  { wall: true, barrierTan: false, barrierPurple: false, ffActive: true, object: false, player: false },
  rewirer: { wall: true, barrierTan: true,  barrierPurple: false, ffActive: true, object: true,  player: true },
};
for (const [type, prof] of Object.entries(expect)) {
  for (const [cat, val] of Object.entries(prof)) {
    ok(RAY_OCCLUSION[type][cat] === val, `${type}.${cat} === ${val}`);
  }
}

// ---------------------------------------------------------------------------
// 2. rayBlockerSegments honours each profile. One of every occluder; count the
//    segments each ray would see (a box / player is a 4-side square).
// ---------------------------------------------------------------------------
function scene() {
  const w = new World(); w._uid = 1;
  w.walls.push(new Wall([0, 0], [0, 100]));
  w.barriers.push(new Barrier([10, 0], [10, 100], 'tan'));
  w.barriers.push(new Barrier([20, 0], [20, 100], 'purple'));
  const active = new ForceField('ff_a', [30, 0], [30, 100]);          // solid
  const open = new ForceField('ff_o', [40, 0], [40, 100]); open.is_open = true;
  w.ffs.push(active, open);
  w.boxes.push([200, 200]);
  w.player = [300, 300]; w.player_block = true;
  return w;
}
{
  const w = scene();
  const jam = rayBlockerSegments(w, rayProfile('jammer'));
  ok(jam.length === 2, `jammer sees wall + active FF only (got ${jam.length})`);   // 1 + 1

  const rew = rayBlockerSegments(w, rayProfile('rewirer'));
  ok(rew.length === 11, `rewirer sees wall+tan+activeFF+box+player (got ${rew.length})`); // 1+1+1+4+4

  const las = rayBlockerSegments(w, rayProfile('laser'));
  ok(las.length === 10, `laser sees wall+activeFF+box+player, both barriers pass (got ${las.length})`); // 1+1+4+4

  // The passable (open) force field never blocks anyone.
  ok(!jam.some(([p]) => p[0] === 40) && !rew.some(([p]) => p[0] === 40),
     'an open/disabled force field is transparent to every ray');

  // excludeFieldId drops the ray's own target field.
  const jamEx = rayBlockerSegments(w, rayProfile('jammer'), { excludeFieldId: 'ff_a' });
  ok(jamEx.length === 1, 'a jammer ray does not block on its own target field');
}

// ---------------------------------------------------------------------------
// 3. The laser fix, functionally: a non-chain object between a source and a
//    linked connector stops the beam, so the connector stops re-emitting; a
//    deliberate endpoint is unaffected; clearing the object restores delivery.
// ---------------------------------------------------------------------------
{
  const w = new World(); w.player = null; w._uid = 1;
  w.add(new Node('s', 'source', [0, 100], { color: 'red' }));
  w.add(new Node('c', 'connector', [200, 100]));
  w.toggle_link('s', 'c');
  w.solve(true);
  ok(w.engine.emit['c'] === 'red', 'baseline: the connector receives and re-emits red');

  // Drop a jammer squarely on the beam path.
  w.add(new Node('jm', 'jammer', [100, 100]));
  w.solve(true);
  ok(w.engine.emit['c'] === null, 'a jammer on the path blocks the beam → connector goes dark');

  // A mine does the same (any material object, not just connectors).
  w.remove_node('jm');
  w.add(new Node('mn', 'mine', [100, 100], { fuse: 3 }));
  w.solve(true);
  ok(w.engine.emit['c'] === null, 'a mine on the path blocks the beam too');

  // Move it off the line — delivery resumes.
  w.nodes['mn'].pos = [100, 400];
  w.solve(true);
  ok(w.engine.emit['c'] === 'red', 'with the object clear of the path, the beam delivers again');

  // The carried object is in hand, not on the field — it must not block.
  w.nodes['mn'].pos = [100, 100];
  w.carrying = 'mn';
  w.solve(true);
  ok(w.engine.emit['c'] === 'red', 'a carried object does not block beams');
}

// ---------------------------------------------------------------------------
// 4. The cross-of-the-logic corner case: a LIVE, translating connector is an
//    obstacle to a different connector's beam that merely passes through its
//    icon (not through its rays, so nothing is cut). Passing through a working
//    connector unaimed is forbidden — it occludes like any other object.
//
//    Green chain horizontal on y=300:  GS → A → GR  (A translates green).
//    Red chain vertical on x=300:      RS → B → RR  (B → RR passes through A).
// ---------------------------------------------------------------------------
{
  const w = new World(); w.player = null; w._uid = 1;
  w.add(new Node('GS', 'source',    [100, 300], { color: 'green' }));
  w.add(new Node('A',  'connector', [300, 300]));
  w.add(new Node('GR', 'receiver',  [500, 300], { color: 'green' }));
  w.toggle_link('GS', 'A'); w.toggle_link('A', 'GR');

  w.add(new Node('RS', 'source',    [300, 100], { color: 'red' }));
  w.add(new Node('B',  'connector', [300, 200]));
  w.add(new Node('RR', 'receiver',  [300, 500], { color: 'red' }));   // B→RR crosses A at (300,300)
  w.toggle_link('RS', 'B'); w.toggle_link('B', 'RR');
  w.solve(true);

  const e = w.engine;
  ok(e.emit['A'] === 'green', 'A is a live, working connector (re-emits green)');
  ok(!!e.lit['GR'], 'the green chain still delivers (A unaffected as an endpoint of its own beam)');
  ok(e.emit['B'] === 'red', 'B still receives red from its source');
  ok(!e.lit['RR'], 'A occludes B\u2019s crossing beam — RR stays dark (unaimed pass-through forbidden)');

  // No beam-vs-beam cut is responsible: the crossing is at the green beams'
  // endpoints (A itself), so it is excluded — the block is A's body alone.
  // Proof: slide A off the red line and RR lights, with the chains unchanged.
  w.nodes['A'].pos = [300, 800];
  w.solve(true);
  ok(!!e.lit['RR'], 'with A off the path, B\u2019s beam reaches RR');
  ok(!!e.lit['GR'], 'and the green chain is unaffected by A\u2019s move');
}

console.log(`\nocclusion tests: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
