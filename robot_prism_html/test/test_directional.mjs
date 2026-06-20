// Tests for the DIRECTIONAL light law (engine `_linkRanks` + the suppression in
// `_beams_and_cross`). Links are undirected, but light is given a direction by
// each node's source-distance RANK: a source is 0, relays linked to it are 1,
// and so on. A ray never travels from a higher rank to a lower one WHEN that
// connection is complete (nothing material between them); with a wall between,
// the connection is incomplete and both ends radiate at it. This breaks the
// upstream feedback that previously confused inverters wired into other relays.
// Run: node test_directional.mjs
import { World } from '../js/sim/world.js';
import { Node, Wall } from '../js/core/entities.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL:', m); } };

// Which o→t beams exist between two ids, after a solve.
function beamsBetween(w, x, y) {
  const [, [beams]] = w.engine.propagate();
  return beams.filter(b => (b.o === x && b.t === y) || (b.o === y && b.t === x))
    .map(b => `${b.o}->${b.t}`).sort();
}

// ===========================================================================
// 1. Ranks are shortest link-path distance from a source (walls irrelevant).
// ===========================================================================
{
  const w = new World(); w.player = null; w._uid = 1;
  w.add(new Node('rs', 'source',    [0, 0],     { color: 'red' }));
  w.add(new Node('A',  'connector', [100, 0]));
  w.add(new Node('B',  'connector', [200, 0]));
  w.add(new Node('C',  'connector', [300, 0]));
  w.add(new Node('rcv', 'receiver', [400, 0],   { color: 'red' }));
  w.toggle_link('rs', 'A'); w.toggle_link('A', 'B'); w.toggle_link('B', 'C'); w.toggle_link('C', 'rcv');
  const r = w.engine._linkRanks();
  ok(r.get('rs') === 0, 'source is rank 0');
  ok(r.get('A') === 1, 'a relay linked to the source is rank 1');
  ok(r.get('B') === 2, 'the next relay is rank 2');
  ok(r.get('C') === 3, 'and the next is rank 3');
  ok(!r.has('rcv'), 'a receiver is a sink — it gets no rank (never forwards)');

  // A shortcut link to the source re-ranks via the shorter path.
  w.toggle_link('rs', 'C');
  const r2 = w.engine._linkRanks();
  ok(r2.get('C') === 1, 'a direct link to the source makes C rank 1 (shortest path wins)');
}

// ===========================================================================
// 2. The headline fix: source → inverter(1) → connector(2) → receiver now works
//    (the inverter no longer receives its own inverted output back from C).
// ===========================================================================
{
  const w = new World(); w.player = null; w._uid = 1;
  w.add(new Node('rs', 'source',   [0, 0],    { color: 'red' }));
  w.add(new Node('I',  'inverter', [150, 0],  { pair: ['red', 'blue'] }));
  w.add(new Node('C',  'connector',[300, 0]));
  w.add(new Node('br', 'receiver', [450, 0],  { color: 'blue' }));
  w.toggle_link('rs', 'I'); w.toggle_link('I', 'C'); w.toggle_link('C', 'br');
  w.solve(true);
  ok(w.engine.emit['I'] === 'blue', 'inverter emits blue (no confusing backflow from C)');
  ok(w.engine.emit['C'] === 'blue', 'connector relays the inverted blue onward');
  ok(!!w.engine.lit['br'], 'the blue receiver at the end of the chain lights');
  ok(!w.dead_conns.has('I'), 'the inverter is not confused');
  // Only the forward beam exists across the I–C link.
  ok(beamsBetween(w, 'I', 'C').join() === 'I->C', 'across I–C only the forward (I→C) beam exists');
}

// ===========================================================================
// 3. A clear chain carries light forward only — no upstream beam.
// ===========================================================================
{
  const w = new World(); w.player = null; w._uid = 1;
  w.add(new Node('rs', 'source',    [0, 0],   { color: 'red' }));
  w.add(new Node('A',  'connector', [120, 0]));
  w.add(new Node('B',  'connector', [240, 0]));
  w.toggle_link('rs', 'A'); w.toggle_link('A', 'B');
  w.solve(true);
  ok(beamsBetween(w, 'A', 'B').join() === 'A->B', 'clear A(1)→B(2): only the forward beam, B→A suppressed');
  ok(beamsBetween(w, 'rs', 'A').join() === 'rs->A', 'and A never beams back to the source');
}

// ===========================================================================
// 4. A WALL between two DIFFERENT-rank relays (each lit by its own path): the
//    connection is incomplete, so BOTH ends radiate at the wall. Removing the
//    wall completes it and the higher→lower beam vanishes.
// ===========================================================================
{
  const mk = (withWall) => {
    const w = new World(); w.player = null; w._uid = 1;
    w.add(new Node('rs', 'source',    [0, 0],   { color: 'red' }));
    w.add(new Node('A',  'connector', [200, 0]));            // rs→A  ⇒ rank 1
    w.add(new Node('X',  'connector', [0, 200]));            // rs→X  ⇒ rank 1
    w.add(new Node('B',  'connector', [200, 200]));          // X→B   ⇒ rank 2, lit independently
    w.toggle_link('rs', 'A'); w.toggle_link('rs', 'X'); w.toggle_link('X', 'B');
    w.toggle_link('A', 'B');                                 // the cross-link under test (A rank1, B rank2)
    if (withWall) w.walls.push(new Wall([180, 100], [220, 100]));  // crosses the vertical A–B beam
    w.solve(true);
    return w;
  };
  const walled = mk(true);
  ok(walled.engine.emit['A'] === 'red' && walled.engine.emit['B'] === 'red', 'both A and B are independently lit');
  ok(beamsBetween(walled, 'A', 'B').join() === 'A->B,B->A',
     'wall between different ranks → BOTH radiate at it (A→B and B→A)');

  const clear = mk(false);
  ok(beamsBetween(clear, 'A', 'B').join() === 'A->B',
     'no wall → connection complete → only A→B (lower→higher); B→A suppressed');
}

// ===========================================================================
// 5. SAME-rank relays always radiate both ways (no preferred direction), even
//    on a clear connection.
// ===========================================================================
{
  const w = new World(); w.player = null; w._uid = 1;
  w.add(new Node('r1', 'source',    [0, 0],   { color: 'red' }));
  w.add(new Node('r2', 'source',    [0, 200], { color: 'red' }));
  w.add(new Node('A',  'connector', [200, 0]));            // r1→A ⇒ rank 1
  w.add(new Node('B',  'connector', [200, 200]));          // r2→B ⇒ rank 1
  w.toggle_link('r1', 'A'); w.toggle_link('r2', 'B'); w.toggle_link('A', 'B');
  w.solve(true);
  const r = w.engine._linkRanks();
  ok(r.get('A') === 1 && r.get('B') === 1, 'A and B are the same rank');
  ok(beamsBetween(w, 'A', 'B').join() === 'A->B,B->A', 'same-rank clear link → both directions radiate');

  // Same rank but the SAME colour on both sides: nothing to clash over, so the
  // ray simply connects (full length, delivers across) rather than splitting.
  const w3 = new World(); w3.player = null; w3._uid = 1;
  w3.add(new Node('r1', 'source',    [0, 0],   { color: 'red' }));
  w3.add(new Node('r2', 'source',    [400, 0], { color: 'red' }));
  w3.add(new Node('A',  'connector', [100, 0]));
  w3.add(new Node('B',  'connector', [300, 0]));
  w3.toggle_link('r1', 'A'); w3.toggle_link('r2', 'B'); w3.toggle_link('A', 'B');
  w3.solve(true);
  const [, [b3, l3, d3]] = w3.engine.propagate();
  const ab3 = b3.map((b, k) => ({ b, len: l3[k], del: d3[k] }))
    .filter(({ b }) => (b.o === 'A' && b.t === 'B') || (b.o === 'B' && b.t === 'A'));
  ok(ab3.length === 2 && ab3.every(({ b, len }) => Math.abs(len - b.dl) < 1e-6),
     'same-rank, SAME colour → beams run the FULL length (no midpoint split)');
  ok(ab3.every(({ del }) => del === true), 'same-rank same colour → the ray connects (delivers across)');
}

// ===========================================================================
// 6. Two sources into one connector confuse it (Case 1).
// ===========================================================================
{
  const w = new World(); w.player = null; w._uid = 1;
  w.add(new Node('bs', 'source',    [0, 0],     { color: 'blue' }));
  w.add(new Node('rs', 'source',    [0, 200],   { color: 'red' }));
  w.add(new Node('C',  'connector', [200, 100]));
  w.toggle_link('bs', 'C'); w.toggle_link('rs', 'C');
  w.solve(true);
  ok(w.engine.emit['C'] === null && w.dead_conns.has('C'),
     'a connector fed a blue AND a red source is confused (dark, dead)');
}

// ===========================================================================
// 7. Same-rank opposing beams CLASH at the midpoint (Case 2): A stays blue, B
//    stays red, both still serve their other links, and the shared ray splits —
//    blue half near A, red half near B, neither delivering to the other.
// ===========================================================================
{
  const w = new World(); w.player = null; w._uid = 1;
  w.add(new Node('bs',   'source',   [0, 0],     { color: 'blue' }));
  w.add(new Node('rs',   'source',   [400, 0],   { color: 'red' }));
  w.add(new Node('A',    'connector',[100, 0]));
  w.add(new Node('B',    'connector',[300, 0]));
  w.add(new Node('brcv', 'receiver', [100, 150], { color: 'blue' }));
  w.add(new Node('rrcv', 'receiver', [300, 150], { color: 'red' }));
  w.toggle_link('bs', 'A'); w.toggle_link('rs', 'B'); w.toggle_link('A', 'B');
  w.toggle_link('A', 'brcv'); w.toggle_link('B', 'rrcv');
  w.solve(true);
  const r = w.engine._linkRanks();
  ok(r.get('A') === 1 && r.get('B') === 1, 'A and B are the same rank (each source-adjacent)');
  ok(w.engine.emit['A'] === 'blue' && w.engine.emit['B'] === 'red',
     'A stays blue and B stays red — they do not confuse each other');
  ok(!w.dead_conns.has('A') && !w.dead_conns.has('B'), 'neither is dead — both remain legal sources');
  ok(!!w.engine.lit['brcv'] && !!w.engine.lit['rrcv'], 'each still feeds its own receiver');
  // The A–B beams each reach only the midpoint and deliver to neither end.
  const [, [beams, length, delivery]] = w.engine.propagate();
  const ab = beams.map((b, k) => ({ b, len: length[k], del: delivery[k] }))
    .filter(({ b }) => (b.o === 'A' && b.t === 'B') || (b.o === 'B' && b.t === 'A'));
  ok(ab.length === 2, 'both opposing beams exist on the A–B link');
  ok(ab.every(({ b, len }) => Math.abs(len - b.dl / 2) < 1e-6), 'each is cut at the midpoint (the clash point)');
  ok(ab.every(({ del }) => del === false), 'neither delivers across — they meet head-on');

  // A wall between same-rank relays: each is already cut by the wall, so they
  // still do not pass through (and the clash midpoint is irrelevant).
  const w2 = new World(); w2.player = null; w2._uid = 1;
  w2.add(new Node('bs', 'source',    [0, 0],   { color: 'blue' }));
  w2.add(new Node('rs', 'source',    [400, 0], { color: 'red' }));
  w2.add(new Node('A',  'connector', [100, 0]));
  w2.add(new Node('B',  'connector', [300, 0]));
  w2.walls.push(new Wall([200, -30], [200, 30]));   // collinear? no — perpendicular below
  w2.walls.length = 0;
  w2.walls.push(new Wall([180, -20], [220, 20]));   // crosses the horizontal A–B beam near x=200
  w2.toggle_link('bs', 'A'); w2.toggle_link('rs', 'B'); w2.toggle_link('A', 'B');
  w2.solve(true);
  ok(w2.engine.emit['A'] === 'blue' && w2.engine.emit['B'] === 'red',
     'with a wall between, A and B still keep their own colours (no pass-through)');
}

// ===========================================================================
// 8. Different ranks ⇒ NO clash; the lower rank is "stronger" and overruns. A is
//    rank 1 (direct from a blue source); B is rank 2 (chained via M from a red
//    source). A pushes all the way through to B (no midpoint break) and, arriving
//    alongside B's own red feed, confuses B.
// ===========================================================================
{
  const w = new World(); w.player = null; w._uid = 1;
  w.add(new Node('bs', 'source',    [0, 0],     { color: 'blue' }));
  w.add(new Node('A',  'connector', [200, 0]));               // bs→A        ⇒ rank 1
  w.add(new Node('rs', 'source',    [400, 400], { color: 'red' }));
  w.add(new Node('M',  'connector', [400, 200]));             // rs→M        ⇒ rank 1
  w.add(new Node('B',  'connector', [400, 0]));               // M→B (and A→B) ⇒ rank 2
  w.toggle_link('bs', 'A'); w.toggle_link('rs', 'M'); w.toggle_link('M', 'B'); w.toggle_link('A', 'B');
  w.solve(true);
  const r = w.engine._linkRanks();
  ok(r.get('A') === 1 && r.get('B') === 2, 'A is rank 1, B is rank 2 (B is chained through M)');
  ok(w.engine.emit['A'] === 'blue', 'A keeps its blue (it is upstream / stronger)');
  ok(w.engine.emit['B'] === null && w.dead_conns.has('B'),
     'B is confused: A pushed blue through AND M feeds red');
  const ab = beamsBetween(w, 'A', 'B');
  ok(ab.join() === 'A->B', 'only A→B exists across the link (B→A suppressed — no mid-conflict)');
  // …and that A→B reaches B in full (no midpoint clash).
  const [, [beams, length]] = w.engine.propagate();
  const fwd = beams.find(b => b.o === 'A' && b.t === 'B');
  const li = beams.indexOf(fwd);
  ok(Math.abs(length[li] - fwd.dl) < 1e-6, 'A→B is NOT cut at the midpoint — it pushes all the way to B');
}

// ===========================================================================
// 9. Extra same-colour sources do NOT raise a connector's priority. A is fed by
//    TWO blue sources, B by ONE red source; both are still rank 1, so the tug
//    stays in the middle (midpoint clash), not pushed toward B.
// ===========================================================================
{
  const w = new World(); w.player = null; w._uid = 1;
  w.add(new Node('bs1', 'source',    [0, 0],      { color: 'blue' }));
  w.add(new Node('bs2', 'source',    [200, -200], { color: 'blue' }));
  w.add(new Node('A',   'connector', [200, 0]));
  w.add(new Node('rs',  'source',    [600, 0],    { color: 'red' }));
  w.add(new Node('B',   'connector', [400, 0]));
  w.toggle_link('bs1', 'A'); w.toggle_link('bs2', 'A'); w.toggle_link('rs', 'B'); w.toggle_link('A', 'B');
  w.solve(true);
  const r = w.engine._linkRanks();
  ok(r.get('A') === 1 && r.get('B') === 1, 'two sources do not change rank — A and B are both rank 1');
  ok(w.engine.emit['A'] === 'blue' && w.engine.emit['B'] === 'red', 'A stays blue (two blue sources agree), B stays red');
  ok(!w.dead_conns.has('A') && !w.dead_conns.has('B'), 'neither is confused');
  const [, [beams, length, delivery]] = w.engine.propagate();
  const ab = beams.map((b, k) => ({ b, len: length[k], del: delivery[k] }))
    .filter(({ b }) => (b.o === 'A' && b.t === 'B') || (b.o === 'B' && b.t === 'A'));
  ok(ab.length === 2 && ab.every(({ b, len }) => Math.abs(len - b.dl / 2) < 1e-6),
     'the tug is still in the middle — both beams cut at the midpoint');
  ok(ab.every(({ del }) => del === false), 'neither delivers across (A is not made stronger by two sources)');
}

// ---------------------------------------------------------------------------
// Source-less emitter → receiver: the same-rank midpoint cap is relay↔relay only.
// No gameplay piece emits without a source yet (the planned black / environment
// source will), so we feed `resolve` a crafted emit map. An unranked (rank ∞)
// emitter must still light an unranked receiver — the receiver is no clash peer —
// while the same emitter aimed at another unranked RELAY of a different colour is
// still capped at the midpoint (the peer-clash behaviour is unchanged).
// ---------------------------------------------------------------------------
{
  const w = new World(); w.player = null; w._uid = 1;
  w.add(new Node('I',  'connector', [100, 0]));
  w.add(new Node('wr', 'receiver',  [300, 0], { color: 'white' }));
  w.toggle_link('I', 'wr');
  const [beams, , delivery] = w.engine.resolve({ I: 'white', wr: null });
  const k = beams.findIndex(b => b.o === 'I' && b.t === 'wr');
  ok(k >= 0 && delivery[k] === true,
     'a source-less (rank ∞) emitter delivers full length to a receiver (no peer cap)');

  const w2 = new World(); w2.player = null; w2._uid = 1;
  w2.add(new Node('I', 'connector', [100, 0]));
  w2.add(new Node('J', 'connector', [300, 0]));
  w2.toggle_link('I', 'J');
  const [b2, len2, del2] = w2.engine.resolve({ I: 'white', J: 'red' });
  const k2 = b2.findIndex(b => b.o === 'I' && b.t === 'J');
  ok(k2 >= 0 && del2[k2] === false && Math.abs(len2[k2] - b2[k2].dl / 2) < 1e-6,
     'but the same emitter aimed at a same-rank RELAY of a different colour is still capped at the midpoint');
}

console.log(`\ndirectional light tests: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
