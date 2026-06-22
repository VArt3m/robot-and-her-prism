// Tests for the FEEDER-BASED ranking rule (engine `_relayIntake` +
// `_gatherIncoming`, threaded through `propagate`). A relay's rank is no longer a
// topological link-distance; it is computed from what actually ARRIVES:
//
//   1. For each incoming colour, keep the strongest (lowest-rank) feeder of it.
//   2. Feed those per-colour feeders by TIER, strongest first: take all rank-0
//      feeders at once and ask if it can emit; if not, add all rank-1 feeders; and
//      so on. STOP at the first tier that lets it emit — the relay consumes exactly
//      that prefix and ranks at 1 + that tier, leaving weaker feeders out. If no
//      tier ever satisfies it, it is genuinely confused: unranked and dark.
//   3. A CONFUSED relay (took light, no valid output yet) does not push back: it
//      lets a same-rank feeder's beam deliver so it can complete itself, which then
//      lifts it above that feeder.
//
// This makes combining tools (mixers, complement inverters) auto-place downstream of
// their feeders — the old rule forced you to wire them at a manually-higher rank.
// The same rule governs connectors, so there is one code path for every relay kind.
// Run: node test_rank_feeders.mjs
import { World } from '../js/sim/world.js';
import { Node } from '../js/core/entities.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL:', m); } };

// Solve N times and return the list of a node's emitted colours — used to assert a
// result is stable (no oscillation across repeated solves).
function emitOverSolves(w, id, n = 4) {
  const out = [];
  for (let i = 0; i < n; i++) { w.solve(true); out.push(w.engine.emit[id]); }
  return out;
}
const allSame = (arr, v) => arr.every(x => x === v);

// ===========================================================================
// 1. The headline fix: a combiner wired DIRECTLY to a source (rank 0) alongside a
//    rank-1 feeder. The old topological BFS gave it min(0,1)+1 = 1 — the SAME rank
//    as the red connector, so the red split at the midpoint and the mixer starved.
//    The feeder rule gives it max(red@1, green@0)+1 = 2: auto-downstream, fed, yellow.
// ===========================================================================
{
  const w = new World(); w.player = null; w._uid = 1;
  w.add(new Node('Sr', 'source', [0, 0], { color: 'red' }));
  w.add(new Node('RC', 'connector', [150, 0]));                 // red, rank 1
  w.add(new Node('Sg', 'source', [300, -150], { color: 'green' })); // green, rank 0, clear to M
  w.add(new Node('M',  'mixer', [300, 0]));
  w.add(new Node('rcv', 'receiver', [300, 200], { color: 'yellow' }));
  for (const [a, b] of [['Sr','RC'], ['RC','M'], ['Sg','M'], ['M','rcv']]) w.toggle_link(a, b);

  const emits = emitOverSolves(w, 'M', 5);
  const r = w.engine._linkRanks();
  ok(r.get('RC') === 1, 'the red connector is rank 1');
  ok(r.get('M') === 2, 'the mixer auto-ranks to 2 — above BOTH feeders (max(red@1, green@0)+1)');
  ok(allSame(emits, 'yellow'), 'it is fed red+green and emits yellow, stable over 5 solves (no oscillation)');
  ok(!!w.engine.lit['rcv'], 'the yellow output lights the yellow receiver');
}

// ===========================================================================
// 2. Symmetric same-rank food. red source@0 → M (mixer); green source@0 → G
//    (connector); M and G are linked and would both be rank 1. M is confused (only
//    red) so it does NOT push back: G's green delivers, M climbs to rank 2 above G,
//    and completes to yellow. G stays a plain rank-1 green connector. Deterministic.
// ===========================================================================
{
  const w = new World(); w.player = null; w._uid = 1;
  w.add(new Node('Sr', 'source', [0, 0],   { color: 'red' }));
  w.add(new Node('Sg', 'source', [300, 0], { color: 'green' }));
  w.add(new Node('M',  'mixer', [100, 0]));
  w.add(new Node('G',  'connector', [200, 0]));
  for (const [a, b] of [['Sr','M'], ['Sg','G'], ['M','G']]) w.toggle_link(a, b);

  const emits = emitOverSolves(w, 'M', 5);
  const r = w.engine._linkRanks();
  ok(r.get('G') === 1, 'the green connector is rank 1');
  ok(r.get('M') === 2, 'the confused mixer takes G as food and climbs to rank 2 above it');
  ok(allSame(emits, 'yellow'), 'M completes to yellow and holds it across 5 solves (no oscillation)');
  ok(w.engine.emit['G'] === 'green', 'G is unaffected — still a plain green connector');
}

// ===========================================================================
// 3. The per-colour rule: strongest WITHIN a colour, weakest ACROSS colours.
//    M receives red from two depths (a source@0 and a 2-hop connector chain) and
//    green from a 1-hop connector. Red picks its strongest (0); green is 1; the
//    rank is max(0, 1)+1 = 2 — the redundant weak red does not inflate it.
// ===========================================================================
{
  const w = new World(); w.player = null; w._uid = 1;
  w.add(new Node('Sr', 'source', [-250, -150], { color: 'red' }));  // red@0, clear direct to M
  w.add(new Node('R1', 'connector', [-250, 150]));                  // red, rank 1
  w.add(new Node('R2', 'connector', [-120, 250]));                  // red, rank 2 (weak red feed)
  w.add(new Node('Sg', 'source', [250, -150], { color: 'green' })); // green@0
  w.add(new Node('GC', 'connector', [140, -90]));                   // green, rank 1
  w.add(new Node('M',  'mixer', [0, 0]));
  for (const [a, b] of [['Sr','R1'], ['R1','R2'], ['R2','M'], ['Sr','M'], ['Sg','GC'], ['GC','M']])
    w.toggle_link(a, b);

  const emits = emitOverSolves(w, 'M', 5);
  const r = w.engine._linkRanks();
  ok(r.get('GC') === 1 && r.get('R2') === 2, 'feeders span ranks: green@1, a weak red@2, a strong red@0');
  ok(r.get('M') === 2,
     'rank = max(strongest-red@0, green@1)+1 = 2 — the redundant red@2 is ignored');
  ok(allSame(emits, 'yellow'), 'M emits yellow, stable (no oscillation)');
}

// ===========================================================================
// 4. The rule generalises to connectors. A connector that gets its colour both
//    direct from a source (clear) and via a longer chain ranks off the STRONGEST
//    feeder, exactly like a combiner with one colour.
// ===========================================================================
{
  const w = new World(); w.player = null; w._uid = 1;
  w.add(new Node('Sr', 'source', [0, 0], { color: 'red' }));
  w.add(new Node('A', 'connector', [100, 120]));   // red, rank 1 (chain hop)
  w.add(new Node('B', 'connector', [250, 120]));   // red, rank 2 (chain hop)
  w.add(new Node('C', 'connector', [300, 0]));     // red from B@2 AND direct Sr@0 (clear)
  for (const [a, b] of [['Sr','A'], ['A','B'], ['B','C'], ['Sr','C']]) w.toggle_link(a, b);

  w.solve(true);
  const r = w.engine._linkRanks();
  ok(r.get('B') === 2, 'the chain connector B is rank 2');
  ok(r.get('C') === 1, 'C ranks off its strongest red feeder (the direct source@0), not the chain — rank 1');
}

// ===========================================================================
// 5. Same-colour, same-rank peers are NOT feeders. Two connectors each fed by their
//    OWN source are both rank 1; the rule must keep them peers (a tug), never letting
//    one climb above the other (each already has valid food, neither is confused).
// ===========================================================================
{
  const w = new World(); w.player = null; w._uid = 1;
  w.add(new Node('S1', 'source', [0, -100], { color: 'red' }));
  w.add(new Node('S2', 'source', [0, 100],  { color: 'red' }));
  w.add(new Node('A', 'connector', [200, -50]));
  w.add(new Node('B', 'connector', [200, 50]));
  for (const [a, b] of [['S1','A'], ['S2','B'], ['A','B']]) w.toggle_link(a, b);

  w.solve(true);
  const r = w.engine._linkRanks();
  ok(r.get('A') === 1 && r.get('B') === 1, 'each is fed by its own source → both stay rank 1 (peers, not feeders)');
  const [, [beams, length, delivery]] = w.engine.propagate();
  const ab = beams.findIndex(b => b.o === 'A' && b.t === 'B');
  ok(ab >= 0 && beams[ab].tug === 'same' && delivery[ab] === false,
     'the A–B edge is a same-colour tug — capped, feeds neither (no spurious rank climb)');
}

// ===========================================================================
// 6. A CONFUSED tool must accept food arriving from a WEAKER (higher-rank)
//    direction, not just a same-rank one. Red reaches the mixer DIRECTLY (so it
//    provisionally ranks at 1 and marks itself confused on red alone), while its
//    green only arrives through a two-hop chain at rank 2 — i.e. from "above" its
//    provisional rank. The directional law would suppress a higher→lower beam, so
//    without the confused exemption the green@2 is rejected and the mixer starves
//    at null forever. With it, the mixer takes the green, climbs to 1+max(0,2)=3,
//    and completes to yellow. This is the case the same-rank-only handling missed.
// ===========================================================================
{
  const w = new World(); w.player = null; w._uid = 1;
  w.add(new Node('Sr', 'source', [0, 0], { color: 'red' }));        // red@0, direct to M
  w.add(new Node('Sg', 'source', [300, -200], { color: 'green' })); // green@0
  w.add(new Node('G1', 'connector', [200, -120]));                  // green@1
  w.add(new Node('G2', 'connector', [150, -40]));                   // green@2 — feeds M from "above"
  w.add(new Node('M',  'mixer', [120, 0]));
  for (const [a, b] of [['Sr','M'], ['Sg','G1'], ['G1','G2'], ['G2','M']]) w.toggle_link(a, b);

  const emits = emitOverSolves(w, 'M', 6);
  const r = w.engine._linkRanks();
  ok(r.get('G2') === 2, 'the green feed arrives via a 2-hop chain at rank 2');
  ok(r.get('M') === 3,
     'the confused mixer accepts the higher-rank green and climbs to 1+max(red@0, green@2)=3');
  ok(allSame(emits, 'yellow'),
     'it completes to yellow and holds it across 6 solves (no starve, no oscillation)');
}

// ===========================================================================
// 7. Greedy strongest-first intake: a relay STOPS consuming the moment it can
//    emit, leaving weaker feeders out. A blend mixer fed red@0 and green@0 makes
//    yellow from that near pair at rank 1 and never consumes a third primary that
//    only arrives further away (blue via a 2-hop chain) — so it does NOT sum all
//    three into a confusing white. Rank 1 (not 3) proves the blue was left out.
// ===========================================================================
{
  const w = new World(); w.player = null; w._uid = 1;
  w.add(new Node('Sr', 'source', [-200, -80], { color: 'red' }));
  w.add(new Node('Sg', 'source', [-200,  80], { color: 'green' }));
  w.add(new Node('Sb', 'source', [ 300,-260], { color: 'blue' }));   // a distant blue,
  w.add(new Node('B1', 'connector', [220, -180]));                   // relayed in via
  w.add(new Node('B2', 'connector', [160,  -90]));                   // a 2-hop chain (rank 2)
  w.add(new Node('M',  'mixer', [120, 0]));
  for (const [a, b] of [['Sr','M'], ['Sg','M'], ['Sb','B1'], ['B1','B2'], ['B2','M']]) w.toggle_link(a, b);

  const emits = emitOverSolves(w, 'M', 6);
  const r = w.engine._linkRanks();
  ok(r.get('M') === 1,
     'the mixer ranks at 1 — it stopped at the near rank-0 pair and never climbed to consume the distant blue');
  ok(allSame(emits, 'yellow'),
     'it makes yellow from red+green and holds it (it does not sum the third primary into a confusing white)');
}

// ===========================================================================
// 8. The same greedy rule generalises to a CONNECTOR: fed one colour directly
//    (red@0) and another only via a longer hop (so it arrives at a weaker, equal-
//    to-it rank), it takes the stronger and stays lit rather than dying on a
//    "conflict" between feeders of different strength.
// ===========================================================================
{
  const w = new World(); w.player = null; w._uid = 1;
  w.add(new Node('Sr', 'source', [0, 0],       { color: 'red' }));
  w.add(new Node('Sb', 'source', [300, -200],  { color: 'blue' }));
  w.add(new Node('BH', 'connector', [200, -120]));   // blue arrives via this hop (rank 1)
  w.add(new Node('K',  'connector', [120, 0]));
  for (const [a, b] of [['Sr','K'], ['Sb','BH'], ['BH','K']]) w.toggle_link(a, b);

  const emits = emitOverSolves(w, 'K', 6);
  ok(allSame(emits, 'red'),
     'the connector passes the stronger red@0 and stays lit (the weaker blue, arriving same-rank via the hop, is tugged off)');
}

// ===========================================================================
// 9. Exhausted-and-still-confused ⇒ NO rank. A connector fed two DIFFERENT colours
//    at the same (strongest) tier can never relay them: it consumes that whole tier,
//    stays confused, and so takes no rank at all (dark, radiating nothing) rather
//    than a 1 + max placeholder.
// ===========================================================================
{
  const w = new World(); w.player = null; w._uid = 1;
  w.add(new Node('Sr', 'source', [-150, 0], { color: 'red' }));
  w.add(new Node('Sb', 'source', [ 150, 0], { color: 'blue' }));
  w.add(new Node('K',  'connector', [0, 0]));
  for (const [a, b] of [['Sr','K'], ['Sb','K']]) w.toggle_link(a, b);
  w.solve(true);
  const r = w.engine._linkRanks();
  ok(w.engine.emit['K'] === null, 'the connector is dark on a same-rank red/blue conflict');
  ok(r.get('K') === undefined, 'and, confused with no feeders left to try, it takes no rank (unranked)');
}

console.log(`\nrank/feeder tests: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
