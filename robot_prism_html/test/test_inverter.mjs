// Tests for the Inverter — the connector's "sister" relay. Covers the clean
// emit rule (swap within a colour pair), confusion (no input / conflict /
// off-pair), corruption parity with connectors, pair reprogramming, and that the
// shared relay machinery (links, buttons, dead map, elevation) treats it alike.
// Run: node test_inverter.mjs
import { World } from '../js/sim/world.js';
import { Node } from '../js/core/entities.js';
import { relayEmit, isRelayKind } from '../js/sim/relays.js';
import { isRelay } from '../js/sim/objects.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL:', m); } };

// A clean inverter with sources of each colour wired in, and three receivers
// (one per colour) wired out, so we can read exactly what it emits.
function rig({ pair = ['red', 'blue'], color = null, feed = [] } = {}) {
  const w = new World(); w.player = null; w._uid = 1;
  w.add(new Node('rs', 'source', [0, 100], { color: 'red' }));
  w.add(new Node('gs', 'source', [0, 200], { color: 'green' }));
  w.add(new Node('bs', 'source', [0, 300], { color: 'blue' }));
  w.add(new Node('I',  'inverter', [200, 200], { pair, color }));
  w.add(new Node('rr', 'receiver', [400, 100], { color: 'red' }));
  w.add(new Node('gr', 'receiver', [400, 200], { color: 'green' }));
  w.add(new Node('br', 'receiver', [400, 300], { color: 'blue' }));
  for (const s of feed) w.toggle_link(s, 'I');
  w.toggle_link('I', 'rr'); w.toggle_link('I', 'gr'); w.toggle_link('I', 'br');
  w.solve(true);
  return w;
}

// ---------------------------------------------------------------------------
// 1. Clean emit rule: in-pair light comes out as the OTHER half of the pair.
// ---------------------------------------------------------------------------
{
  const w = rig({ pair: ['red', 'blue'], feed: ['rs'] });   // red in
  ok(w.engine.emit['I'] === 'blue', 'red in → blue out (pair red/blue)');
  ok(!!w.engine.lit['br'], 'the blue receiver downstream lights');
  ok(!w.engine.lit['rr'], 'the red receiver is not lit by the blue output');

  const w2 = rig({ pair: ['red', 'blue'], feed: ['bs'] });  // blue in
  ok(w2.engine.emit['I'] === 'red', 'blue in → red out (symmetry)');

  const w3 = rig({ pair: ['blue', 'green'], feed: ['gs'] }); // green in, blue/green pair
  ok(w3.engine.emit['I'] === 'blue', 'green in → blue out (pair blue/green)');
}

// Pure emit-function unit checks (no solve), pinning the rule directly.
{
  const inv = { kind: 'inverter', pair: ['red', 'green'], color: null };
  ok(relayEmit(inv, new Set(['red'])) === 'green', 'relayEmit: red→green for pair red/green');
  ok(relayEmit(inv, new Set(['green'])) === 'red', 'relayEmit: green→red for pair red/green');
  ok(relayEmit(inv, new Set(['blue'])) === null, 'relayEmit: off-pair (blue) → null');
  ok(relayEmit(inv, new Set()) === null, 'relayEmit: no input → null');
  ok(relayEmit(inv, new Set(['red', 'green'])) === null, 'relayEmit: conflict → null');
  // pair order is irrelevant.
  ok(relayEmit({ kind: 'inverter', pair: ['green', 'red'], color: null }, new Set(['red'])) === 'green',
     'relayEmit: pair order does not matter');
  // a fresh inverter with no pair set falls back to red/blue.
  ok(relayEmit({ kind: 'inverter', pair: null, color: null }, new Set(['red'])) === 'blue',
     'relayEmit: missing pair falls back to red/blue');
}

// ---------------------------------------------------------------------------
// 2. Confusion → dark, and counted "dead" only when it actually receives light.
// ---------------------------------------------------------------------------
{
  // Off-pair single colour: green into a red/blue inverter → confused.
  const w = rig({ pair: ['red', 'blue'], feed: ['gs'] });
  ok(w.engine.emit['I'] === null, 'off-pair colour → no output');
  ok(w.dead_conns.has('I'), 'off-pair input marks the inverter confused (dead)');

  // Conflict: red AND blue in → confused.
  const w2 = rig({ pair: ['red', 'blue'], feed: ['rs', 'bs'] });
  ok(w2.engine.emit['I'] === null, 'two in-pair colours at once → no output');
  ok(w2.dead_conns.has('I'), 'a conflict marks the inverter confused (dead)');

  // No input: dark but NOT "dead" (nothing to be confused about).
  const w3 = rig({ pair: ['red', 'blue'], feed: [] });
  ok(w3.engine.emit['I'] === null, 'no input → no output');
  ok(!w3.dead_conns.has('I'), 'an unlit inverter is dark, not confused');
}

// ---------------------------------------------------------------------------
// 3. Corruption parity with connectors: a corrupted inverter emits its locked
//    colour on ANY input and never dies on a conflict — its pair is ignored.
// ---------------------------------------------------------------------------
{
  const w = rig({ pair: ['red', 'blue'], color: 'green', feed: ['rs', 'bs'] }); // conflict in
  ok(w.engine.emit['I'] === 'green', 'a corrupted inverter emits its locked colour on any input');
  ok(!w.dead_conns.has('I'), 'a corrupted inverter is never confused');
  ok(!!w.engine.lit['gr'], 'its locked-green output lights the green receiver');

  // Corrupted with NO input → dark (the lock needs some light to relay).
  const w2 = rig({ pair: ['red', 'blue'], color: 'red', feed: [] });
  ok(w2.engine.emit['I'] === null, 'a corrupted inverter with no input still emits nothing');

  // Off-pair input that would confuse a clean inverter is fine once corrupted.
  const w3 = rig({ pair: ['red', 'blue'], color: 'red', feed: ['gs'] });
  ok(w3.engine.emit['I'] === 'red', 'off-pair input + corruption → the locked colour, no confusion');
}

// ---------------------------------------------------------------------------
// 4. Reprogramming the pair re-runs the sim and changes the swap.
// ---------------------------------------------------------------------------
{
  const w = rig({ pair: ['red', 'blue'], feed: ['gs'] });   // green in → confused under red/blue
  ok(w.engine.emit['I'] === null, 'green in under red/blue pair → confused');
  w.nodes['I'].pair = ['blue', 'green'];                     // reprogram to blue/green
  w.solve(true);
  ok(w.engine.emit['I'] === 'blue', 'after reprogramming to blue/green, green in → blue out');
}

// ---------------------------------------------------------------------------
// 5. Shared relay machinery recognises the inverter like a connector.
// ---------------------------------------------------------------------------
{
  ok(isRelay('inverter') && isRelayKind('inverter'), 'inverter is a relay kind');
  ok(isRelay('connector'), 'connector is still a relay kind');
  ok(!isRelay('mine') && !isRelay('rewirer') && !isRelay('jammer'), 'devices are not relays');

  // A link may attach to an inverter exactly like a connector, and — now that
  // light is directional (see test_directional.mjs) — an inverter can feed
  // another relay: its inverted output flows downstream and does NOT loop back to
  // confuse it. Chain: source → inverter(1) → connector(2) → receiver.
  const w = new World(); w.player = null; w._uid = 1;
  w.add(new Node('rs', 'source',    [0, 0],   { color: 'red' }));
  w.add(new Node('I',  'inverter',  [150, 0], { pair: ['red', 'blue'] }));
  w.add(new Node('C',  'connector', [300, 0]));
  w.add(new Node('br', 'receiver',  [450, 0], { color: 'blue' }));
  w.toggle_link('rs', 'I'); w.toggle_link('I', 'C'); w.toggle_link('C', 'br');
  ok(w.links.size === 3, 'links wire onto an inverter just like a connector');
  w.solve(true);
  ok(w.engine.emit['I'] === 'blue' && w.engine.emit['C'] === 'blue',
     'inverted blue flows downstream through a connector (no upstream feedback)');
  ok(!!w.engine.lit['br'], 'the blue receiver at the end of the chain lights');
  ok(!w.dead_conns.has('I'), 'the inverter is not confused by its own downstream output');
}

// ---------------------------------------------------------------------------
// 6. The alternate 'complement' form: emits what is MISSING to make white from
//    its combined base-colour inputs. No pair swapping. Inputs must contain more
//    than one base colour; a full white collected → black (dark). NO input is not
//    "received black" (black needs a real source) → dark, never white from nothing.
// ---------------------------------------------------------------------------
{
  const comp = (incoming) => relayEmit({ kind: 'inverter', mode: 'complement', color: null }, incoming);
  // Duos (two primaries, however delivered) → the third, missing primary.
  ok(comp(new Set(['red', 'blue']))  === 'green', 'complement: red+blue → green');
  ok(comp(new Set(['red', 'green'])) === 'blue',  'complement: red+green → blue');
  ok(comp(new Set(['green', 'blue']))=== 'red',   'complement: green+blue → red');
  // A single secondary ray is itself a duo of base colours → same result.
  ok(comp(new Set(['magenta'])) === 'green', 'complement: magenta (red+blue) → green');
  ok(comp(new Set(['yellow']))  === 'blue',  'complement: yellow (red+green) → blue');
  ok(comp(new Set(['cyan']))    === 'red',   'complement: cyan (green+blue) → red');
  // The two boundary cases.
  ok(comp(new Set())          === null,  'complement: no input → dark (NOT white; black needs a real source)');
  ok(comp(new Set(['white'])) === null,  'complement: white collected → black (dark, null)');
  ok(comp(new Set(['red', 'cyan'])) === null, 'complement: inputs summing to white → black (dark)');
  // A lone single base colour is too little (needs MORE than one) → confused/dark.
  ok(comp(new Set(['red']))   === null, 'complement: a single primary → null (needs more than one)');
  ok(comp(new Set(['green'])) === null, 'complement: a single primary (green) → null');
  // The pair is irrelevant in complement form.
  ok(relayEmit({ kind: 'inverter', mode: 'complement', color: null, pair: ['red', 'green'] }, new Set(['red', 'blue'])) === 'green',
     'complement: ignores the colour pair entirely');
  // Corruption still wins over the form: a locked colour emits on any input.
  ok(relayEmit({ kind: 'inverter', mode: 'complement', color: 'red' }, new Set(['white'])) === 'red',
     'complement + corruption → the locked colour, regardless of form');
}

// ---------------------------------------------------------------------------
// 7. The complement form through the full solver: a duo delivers, the lone-primary
//    case is marked confused, and an UNFED complement inverter stays dark (it does
//    not invent white from nothing — black needs a real source).
// ---------------------------------------------------------------------------
{
  // red + blue sources → complement inverter → green receiver lights.
  const w = new World(); w.player = null; w._uid = 1;
  w.add(new Node('rs', 'source',   [0, 0],   { color: 'red' }));
  w.add(new Node('bs', 'source',   [0, 100], { color: 'blue' }));
  w.add(new Node('I',  'inverter', [200, 50],{ mode: 'complement' }));
  w.add(new Node('gr', 'receiver', [400, 50],{ color: 'green' }));
  w.toggle_link('rs', 'I'); w.toggle_link('bs', 'I'); w.toggle_link('I', 'gr');
  w.solve(true);
  ok(w.engine.emit['I'] === 'green', 'complement (solved): red+blue in → green out');
  ok(!!w.engine.lit['gr'], 'the green receiver downstream lights');
  ok(!w.dead_conns.has('I'), 'a working complement inverter is not confused');

  // A lone primary into a complement inverter → confused (dead), emits nothing.
  const w2 = new World(); w2.player = null; w2._uid = 1;
  w2.add(new Node('rs', 'source',   [0, 0],   { color: 'red' }));
  w2.add(new Node('I',  'inverter', [200, 0], { mode: 'complement' }));
  w2.add(new Node('rr', 'receiver', [400, 0], { color: 'red' }));
  w2.toggle_link('rs', 'I'); w2.toggle_link('I', 'rr');
  w2.solve(true);
  ok(w2.engine.emit['I'] === null, 'complement (solved): a lone primary → no output');
  ok(w2.dead_conns.has('I'), 'a lone primary marks the complement inverter confused');

  // No input at all: the complement inverter stays DARK. It must NOT radiate white
  // (or anything) out of itself — black is a colour that needs a real source.
  const w3 = new World(); w3.player = null; w3._uid = 1;
  w3.add(new Node('I',  'inverter', [100, 0], { mode: 'complement' }));
  w3.add(new Node('wr', 'receiver', [300, 0], { color: 'white' }));
  w3.toggle_link('I', 'wr');
  w3.solve(true);
  ok(w3.engine.emit['I'] === null, 'complement (solved): no input → no output (no white from nothing)');
  ok(!w3.engine.lit['wr'], 'an unfed complement inverter lights nothing');
  ok(!w3.dead_conns.has('I'), 'an unfed complement inverter is dark, not confused');
}

console.log(`\ninverter tests: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
