// Tests for the rewirer recolour feature: the coloured-connector emit rule, the
// timed charge gated on a clear shot, cancel-on-pickup, reach-loss reset, and
// the spent state. The firing+undo commit (UI) is exercised in test_tree.mjs.
// Run: node test_rewirer.mjs
import { World } from './js/sim/world.js';
import { Node, Wall, ForceField } from './js/core/entities.js';
import { RECOLOR_DELAY } from './js/core/constants.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL:', m); } };

// ===========================================================================
// 1. Coloured connector emit rule: "blue in, red out" — always its own colour,
//    never dead on conflict, dark with no input.
// ===========================================================================
{
  const w = new World(); w.player = null; w._uid = 1;
  w.add(new Node('bs', 'source',    [0, 100],   { color: 'blue' }));
  w.add(new Node('C',  'connector', [200, 100], { color: 'red' }));   // recoloured red
  w.add(new Node('rr', 'receiver',  [400, 100], { color: 'red' }));
  w.add(new Node('br', 'receiver',  [200, 300], { color: 'blue' }));
  w.toggle_link('bs', 'C'); w.toggle_link('C', 'rr'); w.toggle_link('C', 'br');
  w.solve(true);
  const e = w.engine;
  ok(e.emit['C'] === 'red', 'blue in → red out: a red connector emits red');
  ok(!!e.lit['rr'], 'the red receiver downstream lights');
  ok(!e.lit['br'], 'a blue receiver is NOT lit by the red output');

  // No input → no output, even with a colour assigned.
  w.toggle_link('bs', 'C');              // unlink the source
  w.solve(true);
  ok(e.emit['C'] === null, 'a coloured connector with no incoming light emits nothing');
}

// Conflict immunity: two different colours into a coloured connector → still its
// own colour, and it is NOT counted dead.
{
  const w = new World(); w.player = null; w._uid = 1;
  w.add(new Node('rs', 'source',    [0, 100],   { color: 'red' }));
  w.add(new Node('gs', 'source',    [0, 300],   { color: 'green' }));
  w.add(new Node('C',  'connector', [200, 200], { color: 'blue' }));
  w.add(new Node('bn', 'receiver',  [400, 200], { color: 'blue' }));
  w.toggle_link('rs', 'C'); w.toggle_link('gs', 'C'); w.toggle_link('C', 'bn');
  w.solve(true);
  const e = w.engine;
  ok(e.emit['C'] === 'blue', 'two conflicting colours in → a coloured connector still emits its own');
  ok(!e.dead_conns.has('C'), 'a coloured connector is never dead by conflict');
  ok(!!e.lit['bn'], 'its blue output lights the blue receiver');

  // A PLAIN connector in the same spot would die on the conflict.
  w.nodes['C'].color = null;
  w.solve(true);
  ok(e.emit['C'] === null && e.dead_conns.has('C'), 'a plain connector dies on the same conflict (control)');
}

// ===========================================================================
// 2. The timed charge, gated on a clear shot. Vertical shot RW → C, no blockers.
// ===========================================================================
function chargeScene() {
  const w = new World(); w.player = null; w._uid = 1;
  w.add(new Node('C',  'connector', [200, 100]));
  w.add(new Node('RW', 'rewirer',   [200, 300], { color: 'red' }));
  w.set_recolor('RW', 'C');
  return w;
}
{
  const w = chargeScene();
  w.step(0);                                   // initialise the charge clock
  ok((w.nodes['RW'].recolor_charge ?? 0) === 0, 'charge starts at zero');
  w.step(1.0);
  ok(Math.abs(w.nodes['RW'].recolor_charge - 1.0) < 0.05, 'charge accrues with a clear shot (~1s)');
  ok(w.ready_rewirers().length === 0, 'not ready before the delay');
  w.step(2.0); w.step(RECOLOR_DELAY + 0.3);
  ok(w.nodes['RW'].recolor_charge >= RECOLOR_DELAY - 1e-6, 'charge caps at the full delay');
  ok(w.ready_rewirers().includes('RW'), 'ready once fully charged');
}

// A wall across the shot → no charge, never ready.
{
  const w = chargeScene();
  w.walls.push(new Wall([150, 200], [250, 200]));   // blocks the vertical shot
  w.step(0); w.step(1.0); w.step(2.0);
  ok((w.nodes['RW'].recolor_charge ?? 0) === 0, 'a blocked shot never starts charging');
  ok(w.ready_rewirers().length === 0, 'and never becomes ready');
}

// Carried → charge resets (picking up cancels).
{
  const w = chargeScene();
  w.step(0); w.step(1.5);
  ok(w.nodes['RW'].recolor_charge > 1.0, 'charged partway');
  w.carrying = 'RW';
  w.step(2.5);
  ok(w.nodes['RW'].recolor_charge === 0, 'carrying the rewirer cancels the charge');
}

// Reach lost mid-charge (an active force field drops in) → reset.
{
  const w = chargeScene();
  w.step(0); w.step(1.5);
  ok(w.nodes['RW'].recolor_charge > 1.0, 'charged partway before the block');
  w.ffs.push(new ForceField('ff', [150, 200], [250, 200]));   // active (closed) across the shot
  w.step(2.5);
  ok(w.nodes['RW'].recolor_charge === 0, 'losing the clear shot resets the charge');
  // ...and a *passable* field does NOT block it. A bare is_open is recomputed
  // away by the solver (an undriven field is solid), so disable it for real with
  // a jammer placed off the shot line — a disabled field is passable and sticks.
  w.add(new Node('J', 'jammer', [500, 200]));
  w.set_jam('J', 'ff');
  w.step(3.0); w.step(4.0);
  ok(w.ffs[0].is_passable(), 'the jammed field is passable (disabled)');
  ok(w.nodes['RW'].recolor_charge > 0, 'a passable (disabled) field does not block the shot — charge resumes');
}

// ===========================================================================
// 3. The spent state: a fired rewirer is gone (not carriable, not an occluder).
// ===========================================================================
{
  const w = chargeScene();
  // Mimic the UI commit: apply the recolour and spend the rewirer.
  w.nodes['C'].color = w.nodes['RW'].color;     // red
  w.nodes['RW'].spent = true;
  w.clear_recolor('RW');
  w.solve(true);
  ok(!w.carriable_nodes().some(n => n.id === 'RW'), 'a spent rewirer cannot be picked up');
  ok(w.recolor_links.size === 0, 'its intent is gone');
  ok(w.engine.emit['C'] === null, 'the recoloured connector is red but idle (no input yet)');
  ok(w.nodes['C'].color === 'red', 'the recolour stuck on the connector');
}

console.log(`\nrewirer tests: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
