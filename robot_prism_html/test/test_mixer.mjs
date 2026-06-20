// Tests for the Mixer — a relay "sister" that COMBINES its inputs. A single
// colour always confuses it. Two programmable forms: 'blend' adds two distinct
// primaries into a secondary; 'whiten' makes white when the inputs cover all
// three primaries. Covers the additive colour model, both forms, confusion,
// compound (secondary) inputs, white retranslation, and corruption parity.
// Run: node test_mixer.mjs
import { World } from '../js/sim/world.js';
import { Node } from '../js/core/entities.js';
import { relayEmit, isRelayKind } from '../js/sim/relays.js';
import { isRelay } from '../js/sim/objects.js';
import { addColors, colorMask, maskColor, isBaseColor } from '../js/sim/colormix.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL:', m); } };

// ---------------------------------------------------------------------------
// 1. The additive colour model.
// ---------------------------------------------------------------------------
ok(addColors(['red', 'green']) === 'yellow', 'red + green = yellow');
ok(addColors(['red', 'blue']) === 'magenta', 'red + blue = magenta');
ok(addColors(['green', 'blue']) === 'cyan', 'green + blue = cyan');
ok(addColors(['red', 'green', 'blue']) === 'white', 'red + green + blue = white');
ok(addColors(['red', 'cyan']) === 'white', 'red + cyan = white');
ok(addColors(['yellow', 'blue']) === 'white', 'yellow + blue = white');
ok(addColors(['red']) === 'red' && addColors([]) === null, 'a single colour sums to itself; nothing → null');
ok(['red', 'green', 'blue'].every(isBaseColor), 'primaries are base colours');
ok(!isBaseColor('yellow') && !isBaseColor('white'), 'secondaries and white are not base');
ok(maskColor(colorMask('yellow')) === 'yellow', 'mask round-trips for a secondary');

// relayEmit unit checks for both forms (no solve).
{
  const blend = { kind: 'mixer', mode: 'blend', color: null };
  ok(relayEmit(blend, new Set(['red', 'green'])) === 'yellow', 'blend: two primaries → their secondary');
  ok(relayEmit(blend, new Set(['red', 'blue'])) === 'magenta', 'blend: red+blue → magenta');
  ok(relayEmit(blend, new Set(['green', 'blue'])) === 'cyan', 'blend: green+blue → cyan');
  ok(relayEmit(blend, new Set(['red'])) === null, 'blend: a single primary → confused');
  ok(relayEmit(blend, new Set(['yellow'])) === 'yellow', 'blend: a lone secondary → retranslated');
  ok(relayEmit(blend, new Set(['cyan'])) === 'cyan', 'blend: a lone secondary (cyan) → itself');
  ok(relayEmit(blend, new Set(['yellow', 'red'])) === 'yellow', 'blend: secondary + a primary already in it → that secondary');
  ok(relayEmit(blend, new Set(['yellow', 'green'])) === 'yellow', 'blend: yellow + green (in the mix) → yellow');
  ok(relayEmit(blend, new Set(['magenta', 'blue'])) === 'magenta', 'blend: magenta + blue (in the mix) → magenta');
  ok(relayEmit(blend, new Set(['white'])) === null, 'blend: white → confused');
  ok(relayEmit(blend, new Set(['red', 'green', 'blue'])) === null, 'blend: three primaries (→ white) → confused');
  ok(relayEmit(blend, new Set(['yellow', 'blue'])) === null, 'blend: secondary + the missing primary (→ white) → confused');
  ok(relayEmit(blend, new Set(['red', 'cyan'])) === null, 'blend: primary + its complementary secondary (→ white) → confused');
  ok(relayEmit(blend, new Set(['yellow', 'cyan'])) === null, 'blend: two secondaries (→ white) → confused');
  ok(relayEmit(blend, new Set()) === null, 'blend: no input → confused');

  const white = { kind: 'mixer', mode: 'whiten', color: null };
  ok(relayEmit(white, new Set(['red', 'green', 'blue'])) === 'white', 'whiten: all three primaries → white');
  ok(relayEmit(white, new Set(['red', 'cyan'])) === 'white', 'whiten: primary + complementary secondary → white');
  ok(relayEmit(white, new Set(['white'])) === 'white', 'whiten: retranslates incoming white');
  ok(relayEmit(white, new Set(['red', 'green'])) === null, 'whiten: only two primaries (yellow) → confused');
  ok(relayEmit(white, new Set(['red'])) === null, 'whiten: a single primary → confused');
}

// ---------------------------------------------------------------------------
// 2. Blend form through the engine.
// ---------------------------------------------------------------------------
function mixRig(mode, feeds) {
  const w = new World(); w.player = null; w._uid = 1;
  w.add(new Node('rs', 'source', [0, 0],   { color: 'red' }));
  w.add(new Node('gs', 'source', [0, 200], { color: 'green' }));
  w.add(new Node('bs', 'source', [0, 400], { color: 'blue' }));
  w.add(new Node('X',  'mixer',  [300, 200], { mode }));
  for (const f of feeds) w.toggle_link(f, 'X');
  w.solve(true);
  return w;
}
ok(mixRig('blend', ['rs', 'gs']).engine.emit['X'] === 'yellow', 'blend red+green → yellow (engine)');
ok(mixRig('blend', ['rs', 'bs']).engine.emit['X'] === 'magenta', 'blend red+blue → magenta');
ok(mixRig('blend', ['gs', 'bs']).engine.emit['X'] === 'cyan', 'blend green+blue → cyan');
{
  const w = mixRig('blend', ['rs']);
  ok(w.engine.emit['X'] === null && w.dead_conns.has('X'), 'blend single input → confused (dead)');
}
{
  const w = mixRig('blend', ['rs', 'gs', 'bs']);
  ok(w.engine.emit['X'] === null && w.dead_conns.has('X'), 'blend three primaries (sum is white) → confused');
}

// A blended secondary lights only the matching secondary receiver.
{
  const w = new World(); w.player = null; w._uid = 1;
  w.add(new Node('rs', 'source', [0, 0],   { color: 'red' }));
  w.add(new Node('gs', 'source', [0, 200], { color: 'green' }));
  w.add(new Node('X',  'mixer',  [200, 100], { mode: 'blend' }));
  w.add(new Node('yr', 'receiver', [400, 100], { color: 'yellow' }));
  w.add(new Node('rr', 'receiver', [400, 250], { color: 'red' }));
  w.toggle_link('rs', 'X'); w.toggle_link('gs', 'X');
  w.toggle_link('X', 'yr'); w.toggle_link('X', 'rr');
  w.solve(true);
  ok(!!w.engine.lit['yr'] && !w.engine.lit['rr'], 'yellow output lights a yellow receiver, not a red one');
}

// A blend mixer downstream of a secondary retranslates it, and absorbs an
// in-mix primary delivered alongside it.
{
  // red+green → yellow (rank 1), then that yellow feeds a second blend mixer
  // (rank 2) together with green (already in yellow) → still yellow.
  const w = new World(); w.player = null; w._uid = 1;
  w.add(new Node('rs', 'source', [0, 0],   { color: 'red' }));
  w.add(new Node('gs', 'source', [0, 200], { color: 'green' }));
  w.add(new Node('gs2','source', [0, 400], { color: 'green' }));
  w.add(new Node('Y',  'mixer', [200, 100], { mode: 'blend' }));     // → yellow (rank 1)
  w.add(new Node('GC', 'connector', [200, 400]));                    // relays green (rank 1)
  w.add(new Node('X',  'mixer', [400, 250], { mode: 'blend' }));     // yellow + green → yellow (rank 2)
  w.toggle_link('rs', 'Y'); w.toggle_link('gs', 'Y'); w.toggle_link('gs2', 'GC');
  w.toggle_link('Y', 'X'); w.toggle_link('GC', 'X');
  w.solve(true);
  ok(w.engine.emit['Y'] === 'yellow', 'first blend makes yellow');
  ok(w.engine.emit['X'] === 'yellow' && !w.dead_conns.has('X'),
     'a downstream blend retranslates yellow and absorbs the in-mix green → yellow');
}

// ---------------------------------------------------------------------------
// 3. Whiten form, including a compound (secondary) input and retranslation.
// ---------------------------------------------------------------------------
ok(mixRig('whiten', ['rs', 'gs', 'bs']).engine.emit['X'] === 'white', 'whiten all three primaries → white');
{
  const w = mixRig('whiten', ['rs', 'gs']);
  ok(w.engine.emit['X'] === null && w.dead_conns.has('X'), 'whiten only two primaries → confused');
}
{
  // green+blue blended to cyan, red relayed through a connector; both feed a
  // downstream whiten mixer (rank 2) which makes white from red + cyan.
  const w = new World(); w.player = null; w._uid = 1;
  w.add(new Node('gs', 'source', [0, 0],   { color: 'green' }));
  w.add(new Node('bs', 'source', [0, 200], { color: 'blue' }));
  w.add(new Node('rs', 'source', [0, 400], { color: 'red' }));
  w.add(new Node('CY', 'mixer', [200, 100], { mode: 'blend' }));     // g+b → cyan   (rank 1)
  w.add(new Node('RC', 'connector', [200, 400]));                    // relays red    (rank 1)
  w.add(new Node('W',  'mixer', [400, 250], { mode: 'whiten' }));    // red+cyan → white (rank 2)
  w.add(new Node('wr', 'receiver', [600, 250], { color: 'white' }));
  w.toggle_link('gs', 'CY'); w.toggle_link('bs', 'CY'); w.toggle_link('rs', 'RC');
  w.toggle_link('CY', 'W'); w.toggle_link('RC', 'W'); w.toggle_link('W', 'wr');
  w.solve(true);
  const r = w.engine._linkRanks();
  ok(r.get('CY') === 1 && r.get('RC') === 1 && r.get('W') === 2,
     'the consuming whiten mixer is rank 2 (downstream of its rank-1 feeders)');
  ok(w.engine.emit['CY'] === 'cyan', 'blend green+blue → cyan (feeds the whiten mixer)');
  ok(w.engine.emit['W'] === 'white', 'whiten red + cyan → white');
  ok(!!w.engine.lit['wr'], 'the white output lights a white receiver (white radiates downstream)');
}
{
  // Retranslate: a whiten mixer fed only white re-emits white.
  const w = new World(); w.player = null; w._uid = 1;
  w.add(new Node('rs', 'source', [0, 0],   { color: 'red' }));
  w.add(new Node('gs', 'source', [0, 200], { color: 'green' }));
  w.add(new Node('bs', 'source', [0, 400], { color: 'blue' }));
  w.add(new Node('W1', 'mixer', [200, 200], { mode: 'whiten' }));
  w.add(new Node('W2', 'mixer', [400, 200], { mode: 'whiten' }));
  w.toggle_link('rs', 'W1'); w.toggle_link('gs', 'W1'); w.toggle_link('bs', 'W1');
  w.toggle_link('W1', 'W2');
  w.solve(true);
  ok(w.engine.emit['W1'] === 'white' && w.engine.emit['W2'] === 'white',
     'a whiten mixer fed only white retranslates white');
}

// ---------------------------------------------------------------------------
// 4. Corruption parity & relay membership.
// ---------------------------------------------------------------------------
{
  ok(isRelay('mixer') && isRelayKind('mixer'), 'mixer is a relay kind');
  // A corrupted mixer emits its locked colour on any input and never confuses.
  const w = mixRig('blend', ['rs']);          // single input would normally confuse
  w.nodes['X'].color = 'green';               // corrupt it
  w.solve(true);
  ok(w.engine.emit['X'] === 'green' && !w.dead_conns.has('X'),
     'a corrupted mixer emits its locked colour on any input, never confused');
}

console.log(`\nmixer tests: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
