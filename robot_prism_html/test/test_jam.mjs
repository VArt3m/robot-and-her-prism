// Headless checks for the jammer: intent storage, live reach, the "dark matter"
// ray (walls + active force fields stop it; barriers do not), logic override,
// the disabled-field transparency chain, and the carried-not-live rule.
// Run: node test_jam.mjs
import { World } from '../js/sim/world.js';
import { Node, Wall, Barrier, ForceField } from '../js/core/entities.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };

// A vertical force-field segment centred on (cx, cy), half-height h.
function vfield(id, cx, cy, h = 50) {
  return new ForceField(id, [cx, cy - h], [cx, cy + h]);
}

// Fresh minimal world: a jammer plus whatever fields/segments a test pushes.
function freshWorld() {
  const w = new World();
  w.player = null;
  w._uid = 100;
  return w;
}

// ---------------------------------------------------------------------------
// 1. Basic reach: a deployed jammer with clear line of sight to a field holds
//    it disabled (and therefore passable), even though no logic opens it.
// ---------------------------------------------------------------------------
{
  const w = freshWorld();
  const ff = vfield('ff_t', 500, 300);
  w.ffs.push(ff);
  w.add(new Node('jam', 'jammer', [100, 300]));
  w.set_jam('jam', 'ff_t');
  w.solve(true);
  ok(ff.disabled === true, 'clear LOS → target field is disabled');
  ok(ff.is_passable() === true, 'disabled field is passable (down)');
}

// ---------------------------------------------------------------------------
// 2. Logic override: a receiver-driven field that logic WOULD open stays under
//    jam control; and one logic would keep shut is forced down anyway. Either
//    way, while jammed the field is disabled and passable.
// ---------------------------------------------------------------------------
{
  const w = freshWorld();
  const ff = vfield('ff_t', 500, 300);
  w.ffs.push(ff);
  w.add(new Node('jam', 'jammer', [100, 300]));
  // No logic link at all → logic alone would keep ff shut (is_open=false).
  w.set_jam('jam', 'ff_t');
  w.solve(true);
  ok(ff.disabled === true && ff.is_passable() === true,
     'logic says shut, jam forces it down → disabled & passable');
}

// ---------------------------------------------------------------------------
// 3. An ACTIVE (solid) force field in front of the target stops the ray. Then
//    a second jammer takes that blocker down, the ray passes, and the original
//    target is jammed — the disabled-field transparency chain.
// ---------------------------------------------------------------------------
{
  const w = freshWorld();
  const ffTarget = vfield('ff_t', 500, 300);   // final target, far right
  const ffBlock  = vfield('ff_b', 300, 300);   // active field in the way
  w.ffs.push(ffTarget, ffBlock);
  w.add(new Node('j1', 'jammer', [100, 300])); // aims right, through ff_b, at ff_t
  w.set_jam('j1', 'ff_t');
  w.solve(true);
  ok(ffTarget.disabled === false, 'active field in front blocks the ray → target not jammed');
  ok(ffBlock.disabled === false,  'the intervening field is NOT itself jammed');

  // Add a second jammer that can see ff_b from above (clear vertical shot).
  w.add(new Node('j2', 'jammer', [300, 120]));
  w.set_jam('j2', 'ff_b');
  w.solve(true);
  ok(ffBlock.disabled === true,  'second jammer takes the blocker down');
  ok(ffTarget.disabled === true, 'with the blocker down, the ray passes → target jammed');
}

// ---------------------------------------------------------------------------
// 4. Barriers (tan/purple) do NOT stop the ray — only walls and active fields.
// ---------------------------------------------------------------------------
{
  const w = freshWorld();
  const ff = vfield('ff_t', 500, 300);
  w.ffs.push(ff);
  w.barriers.push(new Barrier([300, 250], [300, 350], 'tan'));   // squarely in the way
  w.add(new Node('jam', 'jammer', [100, 300]));
  w.set_jam('jam', 'ff_t');
  w.solve(true);
  ok(ff.disabled === true, 'a barrier in the path does not stop the jam ray');
}

// ---------------------------------------------------------------------------
// 5. Black walls DO stop the ray.
// ---------------------------------------------------------------------------
{
  const w = freshWorld();
  const ff = vfield('ff_t', 500, 300);
  w.ffs.push(ff);
  w.walls.push(new Wall([300, 250], [300, 350]));   // wall across the path
  w.add(new Node('jam', 'jammer', [100, 300]));
  w.set_jam('jam', 'ff_t');
  w.solve(true);
  ok(ff.disabled === false, 'a wall in the path stops the jam ray → not jammed');
}

// ---------------------------------------------------------------------------
// 6. One intent per jammer: re-marking overwrites the previous target.
// ---------------------------------------------------------------------------
{
  const w = freshWorld();
  const ffA = vfield('ff_a', 500, 200);
  const ffB = vfield('ff_b', 500, 400);
  w.ffs.push(ffA, ffB);
  w.add(new Node('jam', 'jammer', [100, 300]));
  w.set_jam('jam', 'ff_a');
  w.set_jam('jam', 'ff_b');          // overwrites
  ok(w.jam_links.size === 1, 'a jammer holds exactly one intent');
  ok(w.jam_links.get('jam') === 'ff_b', 'the last-marked target is the one that sticks');
  w.solve(true);
  ok(ffB.disabled === true,  'the surviving intent is the one that takes effect');
  ok(ffA.disabled === false, 'the overwritten intent has no effect');
}

// ---------------------------------------------------------------------------
// 7. A carried jammer is not live: its ray does not jam until it is deployed.
// ---------------------------------------------------------------------------
{
  const w = freshWorld();
  const ff = vfield('ff_t', 500, 300);
  w.ffs.push(ff);
  w.add(new Node('jam', 'jammer', [100, 300]));
  w.set_jam('jam', 'ff_t');
  w.carrying = 'jam';                // picked up
  w.solve(true);
  ok(ff.disabled === false, 'a carried jammer does not jam');
  w.carrying = null;                 // set back down
  w.solve(true);
  ok(ff.disabled === true, 'once deployed, the jammer jams again');
}

// ---------------------------------------------------------------------------
// 8. Mines are jammable; a non-jammable target (a connector) is rejected.
// ---------------------------------------------------------------------------
{
  const w = freshWorld();
  w.add(new Node('mine', 'mine', [500, 300], { fuse: 3 }));
  w.add(new Node('con',  'connector', [500, 100]));
  w.add(new Node('jam',  'jammer', [100, 300]));
  w.set_jam('jam', 'mine');
  ok(w.jam_links.get('jam') === 'mine', 'a mine is a valid jam target');
  w.set_jam('jam', 'con');
  ok(w.jam_links.get('jam') === 'mine', 'a connector is rejected as a jam target (intent unchanged)');
  w.solve(true);
  ok(w.nodes['mine'].disabled === true, 'a reached mine is frozen (disabled)');
}

// ---------------------------------------------------------------------------
// 9. Ray draw data: a deployed reaching ray is marked live + reaches.
// ---------------------------------------------------------------------------
{
  const w = freshWorld();
  const ff = vfield('ff_t', 500, 300);
  w.ffs.push(ff);
  w.add(new Node('jam', 'jammer', [100, 300]));
  w.set_jam('jam', 'ff_t');
  w.solve(true);
  const ray = w.jam_rays_draw.find(r => Math.abs(r.from[0] - 100) < 1e-6);
  ok(ray && ray.live === true && ray.reaches === true, 'draw list reports the live, reaching ray');
}

// ---------------------------------------------------------------------------
// 10. Object placement (reach) treats a force field as solid in EVERY state:
//     a drop can never cross the field line whether it is closed, logic-open,
//     or jammer-disabled. (Open/disabled are equal here — both block — matching
//     closed; this is the placement counterpart to "open == disabled" passage.)
// ---------------------------------------------------------------------------
{
  const w = freshWorld(); w.player = [100, 300];
  const ff = vfield('ff_r', 300, 300);          // vertical wall on the drop line
  w.ffs.push(ff);
  const A = [100, 300], B = [500, 300];
  ff.is_open = false; ff.disabled = false;
  ok(w.reach_blocked(A, B) === true, 'reach: a closed field blocks a drop across it');
  ff.is_open = true;  ff.disabled = false;
  ok(w.reach_blocked(A, B) === true, 'reach: a logic-open field still blocks a drop');
  ff.is_open = false; ff.disabled = true;
  ok(w.reach_blocked(A, B) === true, 'reach: a jammed (disabled) field blocks a drop too');
}

// ---------------------------------------------------------------------------
// 11. A jammer-disabled gate is never "box-critical": the jammer, not the box,
//     holds it passable, so stealing the box cannot close it — even if logic
//     would also have it open. So it must not block a box theft.
// ---------------------------------------------------------------------------
{
  const w = freshWorld(); w.player = [100, 300];
  const ff = vfield('ff_c', 300, 300);
  w.ffs.push(ff); w.boxes.push([300, 300]);     // a box sitting by the gate
  ff.is_open = true; ff.disabled = false;       // logically open, box-propped, no jam
  ok(w.motion._box_critical_fields(0, w.boxes).length === 1,
     'a box-propped open gate IS critical (stealing the box would close it)');
  ff.disabled = true;                           // now also jammed
  ok(w.motion._box_critical_fields(0, w.boxes).length === 0,
     'a jammed + logically-open gate is NOT critical → it does not block a box theft');
}

console.log(`\njam tests: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
