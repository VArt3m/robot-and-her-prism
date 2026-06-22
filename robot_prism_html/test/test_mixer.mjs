// Tests for the Mixer — a relay "sister" that COMBINES its inputs into their
// additive sum and emits that. It is a SINGLE, non-programmable, non-corruptible
// device (no 'blend'/'whiten' forms). Behaviour:
//   • two primaries → their secondary; all three primaries (or any sum reaching
//     white) → WHITE (the mixer CAN emit white);
//   • a lone DUAL input (one secondary) passes straight through — not confused;
//   • CONFUSED by a single base colour (sum is one primary — nothing to mix), and
//     by WHITE on the INPUT (white is emit-only, never received).
// Covers the additive model, the emit rule, confusion, white emit-vs-receive, the
// removal of programmability/corruption, and that a rewirer can't recolour it.
// Run: node test_mixer.mjs
import { World } from '../js/sim/world.js';
import { Node } from '../js/core/entities.js';
import { relayEmit, relayConfused, isRelayKind, isCorruptibleKind } from '../js/sim/relays.js';
import { isRelay, objType } from '../js/sim/objects.js';
import { programSpec } from '../js/sim/programming.js';
import { targetSpec } from '../js/sim/targeting.js';
import { addColors, colorMask, maskColor, isBaseColor } from '../js/sim/colormix.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL:', m); } };
const S = (...cs) => new Set(cs);

// ---------------------------------------------------------------------------
// 1. The additive colour model (unchanged).
// ---------------------------------------------------------------------------
ok(addColors(['red', 'green']) === 'yellow', 'red + green = yellow');
ok(addColors(['red', 'blue']) === 'magenta', 'red + blue = magenta');
ok(addColors(['green', 'blue']) === 'cyan', 'green + blue = cyan');
ok(addColors(['red', 'green', 'blue']) === 'white', 'red + green + blue = white');
ok(addColors(['red', 'cyan']) === 'white', 'red + cyan = white');
ok(addColors(['yellow', 'blue']) === 'white', 'yellow + blue = white');
ok(['red', 'green', 'blue'].every(isBaseColor), 'primaries are base colours');
ok(!isBaseColor('yellow') && !isBaseColor('white'), 'secondaries and white are not base');
ok(maskColor(colorMask('yellow')) === 'yellow', 'mask round-trips for a secondary');

// ---------------------------------------------------------------------------
// 2. The emit rule (relayEmit), no solve. A clean mixer (color null).
// ---------------------------------------------------------------------------
{
  const mx = { kind: 'mixer', color: null };
  // Two primaries → their secondary.
  ok(relayEmit(mx, S('red', 'green')) === 'yellow', 'red + green → yellow');
  ok(relayEmit(mx, S('red', 'blue')) === 'magenta', 'red + blue → magenta');
  ok(relayEmit(mx, S('green', 'blue')) === 'cyan', 'green + blue → cyan');
  // A lone DUAL (secondary) passes through — not confused.
  ok(relayEmit(mx, S('yellow')) === 'yellow', 'a lone secondary (yellow) passes through');
  ok(relayEmit(mx, S('cyan')) === 'cyan', 'a lone secondary (cyan) passes through');
  ok(relayEmit(mx, S('magenta')) === 'magenta', 'a lone secondary (magenta) passes through');
  // Secondary + an in-mix primary → that same secondary.
  ok(relayEmit(mx, S('yellow', 'red')) === 'yellow', 'yellow + red (already in it) → yellow');
  ok(relayEmit(mx, S('magenta', 'blue')) === 'magenta', 'magenta + blue (already in it) → magenta');
  // Sums that reach white → WHITE (emit).
  ok(relayEmit(mx, S('red', 'green', 'blue')) === 'white', 'three primaries → white');
  ok(relayEmit(mx, S('red', 'cyan')) === 'white', 'primary + complementary secondary → white');
  ok(relayEmit(mx, S('yellow', 'blue')) === 'white', 'secondary + the missing primary → white');
  ok(relayEmit(mx, S('yellow', 'cyan')) === 'white', 'two secondaries that cover all three → white');
  // A single base colour → confused (nothing to mix).
  ok(relayEmit(mx, S('red')) === null, 'a lone primary → confused');
  ok(relayEmit(mx, S('green')) === null, 'a lone primary (green) → confused');
  ok(relayEmit(mx, S('blue')) === null, 'a lone primary (blue) → confused');
  // White on the INPUT → confused (white is emit-only), even alongside others.
  ok(relayEmit(mx, S('white')) === null, 'a lone white input → confused');
  ok(relayEmit(mx, S('white', 'red')) === null, 'white among the inputs → confused (not received)');
  ok(relayEmit(mx, S('white', 'yellow')) === null, 'white + a secondary → still confused');
  // No input → dark (null).
  ok(relayEmit(mx, S()) === null, 'no input → dark');
}

// ---------------------------------------------------------------------------
// 3. Confusion (relayConfused) mirrors emit==null while lit.
// ---------------------------------------------------------------------------
{
  const mx = { kind: 'mixer', color: null };
  ok(relayConfused(mx, S('red')) === true, 'a lone primary is confused');
  ok(relayConfused(mx, S('white')) === true, 'a white input is confused');
  ok(relayConfused(mx, S('white', 'red')) === true, 'white among inputs is confused');
  ok(relayConfused(mx, S('yellow')) === false, 'a lone secondary is NOT confused');
  ok(relayConfused(mx, S('red', 'green')) === false, 'two primaries are NOT confused');
  ok(relayConfused(mx, S('red', 'green', 'blue')) === false, 'a sum-to-white is NOT confused (it emits white)');
  ok(relayConfused(mx, S()) === false, 'an unlit mixer is idle, not confused');
}

// ---------------------------------------------------------------------------
// 4. Through the engine.
// ---------------------------------------------------------------------------
function mixRig(feeds) {
  const w = new World(); w.player = null; w._uid = 1;
  w.add(new Node('rs', 'source', [0, 0],   { color: 'red' }));
  w.add(new Node('gs', 'source', [0, 200], { color: 'green' }));
  w.add(new Node('bs', 'source', [0, 400], { color: 'blue' }));
  w.add(new Node('X',  'mixer',  [300, 200]));
  for (const f of feeds) w.toggle_link(f, 'X');
  w.solve(true);
  return w;
}
ok(mixRig(['rs', 'gs']).engine.emit['X'] === 'yellow', 'red+green → yellow (engine)');
ok(mixRig(['rs', 'bs']).engine.emit['X'] === 'magenta', 'red+blue → magenta');
ok(mixRig(['gs', 'bs']).engine.emit['X'] === 'cyan', 'green+blue → cyan');
{
  const w = mixRig(['rs']);
  ok(w.engine.emit['X'] === null && w.dead_conns.has('X'), 'a single input → confused (dead)');
}
{
  // NEW: all three primaries → WHITE (no longer confused), and it radiates.
  const w = new World(); w.player = null; w._uid = 1;
  w.add(new Node('rs', 'source', [0, 0],   { color: 'red' }));
  w.add(new Node('gs', 'source', [0, 200], { color: 'green' }));
  w.add(new Node('bs', 'source', [0, 400], { color: 'blue' }));
  w.add(new Node('X',  'mixer',  [300, 200]));
  w.add(new Node('wr', 'receiver', [600, 200], { color: 'white' }));
  w.toggle_link('rs', 'X'); w.toggle_link('gs', 'X'); w.toggle_link('bs', 'X');
  w.toggle_link('X', 'wr');
  w.solve(true);
  ok(w.engine.emit['X'] === 'white' && !w.dead_conns.has('X'), 'three primaries → white (not confused)');
  ok(!!w.engine.lit['wr'], 'the white output lights a white receiver');
}

// A mixed secondary lights only the matching secondary receiver.
{
  const w = new World(); w.player = null; w._uid = 1;
  w.add(new Node('rs', 'source', [0, 0],   { color: 'red' }));
  w.add(new Node('gs', 'source', [0, 200], { color: 'green' }));
  w.add(new Node('X',  'mixer',  [200, 100]));
  w.add(new Node('yr', 'receiver', [400, 100], { color: 'yellow' }));
  w.add(new Node('rr', 'receiver', [400, 250], { color: 'red' }));
  w.toggle_link('rs', 'X'); w.toggle_link('gs', 'X');
  w.toggle_link('X', 'yr'); w.toggle_link('X', 'rr');
  w.solve(true);
  ok(!!w.engine.lit['yr'] && !w.engine.lit['rr'], 'yellow output lights a yellow receiver, not a red one');
}

// A downstream mixer retranslates a lone secondary and absorbs an in-mix primary.
{
  // red+green → yellow (rank 1), then that yellow feeds a second mixer (rank 2)
  // together with green (already in yellow) → still yellow.
  const w = new World(); w.player = null; w._uid = 1;
  w.add(new Node('rs', 'source', [0, 0],   { color: 'red' }));
  w.add(new Node('gs', 'source', [0, 200], { color: 'green' }));
  w.add(new Node('gs2','source', [0, 400], { color: 'green' }));
  w.add(new Node('Y',  'mixer', [200, 100]));      // → yellow (rank 1)
  w.add(new Node('GC', 'connector', [200, 400]));  // relays green (rank 1)
  w.add(new Node('X',  'mixer', [400, 250]));      // yellow + green → yellow (rank 2)
  w.toggle_link('rs', 'Y'); w.toggle_link('gs', 'Y'); w.toggle_link('gs2', 'GC');
  w.toggle_link('Y', 'X'); w.toggle_link('GC', 'X');
  w.solve(true);
  ok(w.engine.emit['Y'] === 'yellow', 'first mixer makes yellow');
  ok(w.engine.emit['X'] === 'yellow' && !w.dead_conns.has('X'),
     'a downstream mixer retranslates yellow and absorbs the in-mix green → yellow');
}

// A lone secondary fed to a downstream mixer passes straight through.
{
  const w = new World(); w.player = null; w._uid = 1;
  w.add(new Node('rs', 'source', [0, 0],   { color: 'red' }));
  w.add(new Node('gs', 'source', [0, 200], { color: 'green' }));
  w.add(new Node('Y',  'mixer', [200, 100]));      // → yellow (rank 1)
  w.add(new Node('X',  'mixer', [400, 100]));      // lone yellow → yellow (rank 2)
  w.toggle_link('rs', 'Y'); w.toggle_link('gs', 'Y'); w.toggle_link('Y', 'X');
  w.solve(true);
  ok(w.engine.emit['X'] === 'yellow' && !w.dead_conns.has('X'),
     'a mixer fed a lone secondary passes it straight through (not confused)');
}

// WHITE may be EMITTED but not RECEIVED: a mixer fed white (plus a primary) is confused.
{
  const w = new World(); w.player = null; w._uid = 1;
  w.add(new Node('rs', 'source', [0, 0],   { color: 'red' }));
  w.add(new Node('gs', 'source', [0, 200], { color: 'green' }));
  w.add(new Node('bs', 'source', [0, 400], { color: 'blue' }));
  w.add(new Node('rs2','source', [0, 600], { color: 'red' }));
  w.add(new Node('W',  'mixer', [200, 200]));      // r+g+b → white (rank 1)
  w.add(new Node('RC', 'connector', [200, 600]));  // relays a second red (rank 1)
  w.add(new Node('X',  'mixer', [400, 400]));      // receives white + red → confused
  w.toggle_link('rs', 'W'); w.toggle_link('gs', 'W'); w.toggle_link('bs', 'W');
  w.toggle_link('rs2', 'RC');
  w.toggle_link('W', 'X'); w.toggle_link('RC', 'X');
  w.solve(true);
  ok(w.engine.emit['W'] === 'white', 'the upstream mixer emits white');
  ok(w.engine.emit['X'] === null && w.dead_conns.has('X'),
     'a mixer that receives white is confused (white is emit-only)');
}

// ---------------------------------------------------------------------------
// 5. Singular device: relay membership, no programmability, no corruption.
// ---------------------------------------------------------------------------
ok(isRelay('mixer') && isRelayKind('mixer'), 'mixer is a relay kind');
ok(objType('mixer').programmable === false, 'mixer is NOT programmable');
ok(programSpec('mixer') === null, 'mixer has NO program spec (the orphaned menu is gone)');
ok(isCorruptibleKind('mixer') === false, 'mixer is NOT corruptible');
ok(isCorruptibleKind('connector') === true && isCorruptibleKind('inverter') === true,
   'connector and inverter remain corruptible');
{
  // A stray locked colour is ignored — a mixer always mixes (never acts corrupted).
  const w = mixRig(['rs', 'gs']);     // red+green → yellow
  w.nodes['X'].color = 'blue';        // try to "corrupt" it
  w.solve(true);
  ok(w.engine.emit['X'] === 'yellow' && !w.dead_conns.has('X'),
     'a mixer ignores a locked colour and still mixes (red+green → yellow)');
  // And a single input stays confused even with a stray colour (no corruption rescue).
  const w2 = mixRig(['rs']);
  w2.nodes['X'].color = 'blue';
  w2.solve(true);
  ok(w2.engine.emit['X'] === null && w2.dead_conns.has('X'),
     'a stray colour does not rescue a single-input mixer from confusion');
}
{
  // A rewirer cannot target/recolour a mixer (it is not corruptible).
  const w = new World(); w.player = null; w._uid = 1;
  w.add(new Node('rw', 'rewirer', [100, 100], { color: 'red' }));
  w.add(new Node('mx', 'mixer',   [140, 100]));
  w.add(new Node('cn', 'connector', [100, 140]));
  const spec = targetSpec('rewirer');
  ok(spec.targetAt(w, 'rw', 140, 100) === null, 'rewirer targetAt skips a mixer');
  ok(spec.targetAt(w, 'rw', 100, 140)?.id === 'cn', 'rewirer still targets a connector');
  const cand = spec.candidates(w, 'rw').map(c => c.id);
  ok(!cand.includes('mx'), 'a mixer is not among rewirer candidates');
  ok(cand.includes('cn'), 'a connector is among rewirer candidates');
}

// ---------------------------------------------------------------------------
// 6. The "hungry relay" feeder-tier rule, for the mixer (generic to all relays):
//    a same-tier sweep is taken whole; a stronger prefix that already emits wins
//    and weaker feeders are left out (pushed back).
// ---------------------------------------------------------------------------
{
  // R@0 + G@0 + B@0 all arrive directly (one rank-0 sweep) → WHITE @ rank 1.
  const w = new World(); w.player = null; w._uid = 1;
  w.add(new Node('rs', 'source', [0, 0],   { color: 'red' }));
  w.add(new Node('gs', 'source', [0, 200], { color: 'green' }));
  w.add(new Node('bs', 'source', [0, 400], { color: 'blue' }));
  w.add(new Node('M',  'mixer',  [300, 200]));
  w.toggle_link('rs', 'M'); w.toggle_link('gs', 'M'); w.toggle_link('bs', 'M');
  w.solve(true);
  const r = w.engine._linkRanks();
  ok(w.engine.emit['M'] === 'white' && r.get('M') === 1 && !w.dead_conns.has('M'),
     'R@0 + G@0 + B@0 (one sweep) → white @ rank 1');
}
{
  // R@0 + G@0 direct, B via a 2-hop chain (feeder rank 2). The near pair satisfies
  // at tier 0 → YELLOW @ rank 1; the weak blue is never consumed (no white anywhere).
  const w = new World(); w.player = null; w._uid = 1;
  w.add(new Node('rs', 'source', [0, 0],   { color: 'red' }));
  w.add(new Node('gs', 'source', [0, 200], { color: 'green' }));
  w.add(new Node('bs', 'source', [0, 400], { color: 'blue' }));
  w.add(new Node('c1', 'connector', [150, 500]));   // blue @ rank 1
  w.add(new Node('c2', 'connector', [250, 500]));   // blue @ rank 2
  w.add(new Node('M',  'mixer',  [400, 250]));
  w.toggle_link('rs', 'M'); w.toggle_link('gs', 'M');
  w.toggle_link('bs', 'c1'); w.toggle_link('c1', 'c2'); w.toggle_link('c2', 'M');
  w.solve(true);
  const r = w.engine._linkRanks();
  ok(w.engine.emit['M'] === 'yellow' && r.get('M') === 1 && !w.dead_conns.has('M'),
     'R@0 + G@0 + B@2 → yellow @ rank 1 (the near pair wins)');
  ok(Object.values(w.engine.emit).every(c => c !== 'white'),
     'the weak rank-2 blue is pushed back — no white is ever generated');
}

console.log(`\nmixer tests: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
