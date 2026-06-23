// Tests for the ACCUMULATOR — a portable source with a charge (REDESIGNED).
//   CHARGED (color set): a rank-0 source that emits ONLY its own colour. It never
//     relays incoming light, is never confused, and is dead weight to beams that
//     pass through it. Against a same-rank emitter it is a tug that delivers to
//     neither end (clash or match alike).
//   EMPTY (color null): a charging SINK. For INTAKE it behaves like a relay — it
//     gathers its feeders by tier and would radiate their additive SUM — but it
//     RADIATES NOTHING OUTWARD and holds the weakest rank, so every beam reaching
//     it is absorbed (no push-back on feeders). Having no forbidden colour it is
//     never confused: ANY non-empty intake gives a charge colour. It charges over
//     ACCUM_FILL_SEC of a steady OUTCOME colour (a brief flicker is tolerated for
//     ACCUM_FLICKER_GRACE; the outcome — not the exact feeders — is what must
//     hold), stops if carried, then becomes charged, cuts EXACTLY its feeder links
//     (keeping every other intent), and emits as a rank-0 source.
// Run: node test_accumulator.mjs
import { World } from '../js/sim/world.js';
import { Node } from '../js/core/entities.js';
import { ACCUM_FILL_SEC, ACCUM_FLICKER_GRACE } from '../js/core/constants.js';
import { targetSpec } from '../js/sim/targeting.js';
import { accumulatorEmit } from '../js/sim/relays.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL:', m); } };
const mk = () => { const w = new World(); w.player = null; w._uid = 1; return w; };
const S = (...cs) => new Set(cs);
const beamsBetween = (w, x, y) => {
  const [, [beams, , delivery]] = w.engine.propagate();
  return beams.map((b, k) => ({ b, del: delivery[k] }))
    .filter(({ b }) => (b.o === x && b.t === y) || (b.o === y && b.t === x));
};
// Emulate the UI fill commit: stamp colour, cut ONLY feeder links, keep the rest.
const commit = (w) => {
  for (const { id, color, feeders } of w.engine.ready_accumulators()) {
    w.nodes[id].color = color;
    for (const f of feeders) w.links.delete(w._link_key(id, f));
  }
  w.solve(true);
};

// ---------------------------------------------------------------------------
// 1. The empty accumulator's emit rule: additive sum, NEVER confused.
// ---------------------------------------------------------------------------
ok(accumulatorEmit(S('red')) === 'red', 'a lone primary radiates that primary (not confused)');
ok(accumulatorEmit(S('red', 'green')) === 'yellow', 'two primaries → the secondary');
ok(accumulatorEmit(S('red', 'green', 'blue')) === 'white', 'three primaries → white');
ok(accumulatorEmit(S('yellow')) === 'yellow', 'a lone secondary passes through');
ok(accumulatorEmit(S('white')) === 'white', 'white is accepted (no forbidden colour) → white');
ok(accumulatorEmit(S('yellow', 'red')) === 'yellow', 'secondary + in-mix primary → that secondary');
ok(accumulatorEmit(S()) === null, 'no input → null (idle)');

// ---------------------------------------------------------------------------
// 2. Charged: a rank-0 source emitting its own colour, lighting a receiver.
// ---------------------------------------------------------------------------
{
  const w = mk();
  w.add(new Node('A', 'accumulator', [100, 0], { color: 'red' }));
  w.add(new Node('rr', 'receiver', [300, 0], { color: 'red' }));
  w.toggle_link('A', 'rr'); w.solve(true);
  ok(w.engine.emit['A'] === 'red', 'charged accumulator emits its own colour');
  ok(w.engine._linkRanks().get('A') === 0, 'charged accumulator is rank 0 (a source)');
  ok(!!w.engine.lit['rr'], 'it lights a matching receiver downstream');
}

// ---------------------------------------------------------------------------
// 3. Charged: never relays; dead weight to a passing beam; tug vs same-rank.
// ---------------------------------------------------------------------------
{
  const w = mk();
  w.add(new Node('S', 'source', [0, 0], { color: 'green' }));
  w.add(new Node('A', 'accumulator', [150, 0], { color: 'red' }));
  w.add(new Node('gr', 'receiver', [300, 0], { color: 'green' }));
  w.add(new Node('rr', 'receiver', [300, 140], { color: 'red' }));
  w.toggle_link('S', 'A'); w.toggle_link('A', 'gr'); w.toggle_link('A', 'rr'); w.solve(true);
  ok(w.engine.emit['A'] === 'red', 'a fed charged accumulator still emits only its own colour');
  ok(!w.engine.lit['gr'], 'the incoming green is NOT relayed onward');
  ok(!!w.engine.lit['rr'], 'its own red is emitted onward');
  ok(!w.dead_conns.has('A'), 'a charged accumulator is never confused by incoming light');
}
{
  const w = mk();
  w.add(new Node('A', 'accumulator', [0, 0], { color: 'red' }));
  w.add(new Node('Sd', 'source', [200, 0], { color: 'blue' }));
  w.toggle_link('A', 'Sd'); w.solve(true);
  const clash = beamsBetween(w, 'A', 'Sd');
  ok(clash.length === 2 && clash.every(({ del }) => del === false),
     'charged accumulator vs source → tug (neither delivers)');
}

// ---------------------------------------------------------------------------
// 4. Empty = charging SINK: radiates NOTHING outward; absorbs its feed.
// ---------------------------------------------------------------------------
{
  const w = mk();
  w.add(new Node('S', 'source', [0, 0], { color: 'green' }));
  w.add(new Node('A', 'accumulator', [200, 0], { color: null }));
  w.add(new Node('gr', 'receiver', [400, 0], { color: 'green' }));
  w.toggle_link('S', 'A'); w.toggle_link('A', 'gr'); w.solve(true);
  ok(w.engine.emit['A'] == null, 'an empty accumulator emits nothing outward');
  ok(w.engine._accum_color['A'] === 'green', 'but it computes its charge colour (green)');
  ok(!w.engine.lit['gr'], 'a downstream receiver is NOT lit while it only charges');
  const sa = beamsBetween(w, 'S', 'A');
  ok(sa.length === 1 && sa[0].del === true, 'a source delivers full length into it (absorbed)');
  ok(w.engine._linkRanks().get('A') === undefined, 'a charging sink holds the weakest rank (absent)');
}

// ---------------------------------------------------------------------------
// 5. Empty charges on the MIX (single OR multi colour) — the old "one intent
//    only" rule is GONE: two primaries now charge toward their secondary.
// ---------------------------------------------------------------------------
{
  const w = mk();
  w.add(new Node('rs', 'source', [0, 0], { color: 'red' }));
  w.add(new Node('gs', 'source', [0, 200], { color: 'green' }));
  w.add(new Node('A', 'accumulator', [300, 100], { color: null }));
  w.toggle_link('rs', 'A'); w.toggle_link('gs', 'A'); w.solve(true);
  w.step(0); w.step(ACCUM_FILL_SEC * 0.5);
  ok((w.engine.accum_charge['A'] ?? 0) > 0 && w.engine.ready_accumulators().length === 0,
     'two colours now CHARGE (partway, not ready yet)');
  w.step(ACCUM_FILL_SEC + 0.1);
  const ready = w.engine.ready_accumulators();
  ok(ready.length === 1 && ready[0].color === 'yellow', 'it fills to the MIX colour (yellow)');
  ok([...ready[0].feeders].sort().join() === 'gs,rs', 'both primaries are recorded as feeders');
}

// ---------------------------------------------------------------------------
// 6. Feeder ties: two strongest feeders of the SAME colour are BOTH feeders.
// ---------------------------------------------------------------------------
{
  const w = mk();
  w.add(new Node('g1', 'source', [0, 0],   { color: 'green' }));
  w.add(new Node('g2', 'source', [0, 100], { color: 'green' }));
  w.add(new Node('rs', 'source', [0, 200], { color: 'red' }));
  w.add(new Node('A', 'accumulator', [300, 100], { color: null }));
  w.toggle_link('g1', 'A'); w.toggle_link('g2', 'A'); w.toggle_link('rs', 'A'); w.solve(true);
  ok([...w.engine._accum_feeders['A']].sort().join() === 'g1,g2,rs',
     'two same-colour, same-rank feeders are BOTH feeders (ties kept)');
  ok(w.engine._accum_color['A'] === 'yellow', 'their sum is yellow');
}

// ---------------------------------------------------------------------------
// 7. Outcome-tracking: a feeder change that PRESERVES the colour keeps charging.
// ---------------------------------------------------------------------------
{
  const w = mk();
  w.add(new Node('rs', 'source', [0, 0],   { color: 'red' }));
  w.add(new Node('gs', 'source', [0, 200], { color: 'green' }));
  w.add(new Node('rs2','source', [0, 400], { color: 'red' }));
  w.add(new Node('A', 'accumulator', [300, 200], { color: null }));
  w.toggle_link('rs', 'A'); w.toggle_link('gs', 'A'); w.solve(true);
  w.step(0); w.step(ACCUM_FILL_SEC * 0.5);
  const half = w.engine.accum_charge['A'];
  w.toggle_link('rs2', 'A');                 // add another red — outcome stays yellow
  w.step(ACCUM_FILL_SEC * 0.5 + 0.2);
  ok(w.engine.accum_charge['A'] > half && w.engine.accum_in['A'] === 'yellow',
     'changing feeders while the OUTCOME holds (yellow) keeps charging');
}

// ---------------------------------------------------------------------------
// 8. Flicker grace: a sub-grace blip HOLDS the charge; a longer change resets.
// ---------------------------------------------------------------------------
{
  const w = mk();
  w.add(new Node('gs', 'source', [0, 0], { color: 'green' }));
  w.add(new Node('A', 'accumulator', [200, 0], { color: null }));
  w.toggle_link('gs', 'A'); w.solve(true);
  let t = 0;
  w.step(t); t += ACCUM_FILL_SEC * 0.5; w.step(t);
  const held = w.engine.accum_charge['A'];
  w.toggle_link('gs', 'A');                   // cut feed — outcome → null
  t += ACCUM_FLICKER_GRACE * 0.5; w.step(t);  // within grace
  ok(Math.abs((w.engine.accum_charge['A'] ?? 0) - held) < 1e-6, 'a sub-grace flicker HOLDS the charge');
  w.toggle_link('gs', 'A');                   // restore feed
  t += 0.1; w.step(t);
  ok(w.engine.accum_charge['A'] > held, 'restoring within grace continues from the held charge');
}
{
  const w = mk();
  w.add(new Node('gs', 'source', [0, 0], { color: 'green' }));
  w.add(new Node('A', 'accumulator', [200, 0], { color: null }));
  w.toggle_link('gs', 'A'); w.solve(true);
  let t = 0;
  w.step(t); t += ACCUM_FILL_SEC * 0.5; w.step(t);
  w.toggle_link('gs', 'A');                    // cut feed
  t += ACCUM_FLICKER_GRACE + 0.05; w.step(t);  // past grace → reset
  ok((w.engine.accum_charge['A'] ?? 0) === 0, 'losing the feed past the grace window resets the charge');
}

// ---------------------------------------------------------------------------
// 9. Charging stops if the accumulator is PICKED (carried).
// ---------------------------------------------------------------------------
{
  const w = mk();
  w.add(new Node('gs', 'source', [0, 0], { color: 'green' }));
  w.add(new Node('A', 'accumulator', [200, 0], { color: null }));
  w.toggle_link('gs', 'A'); w.solve(true);
  w.step(0); w.step(ACCUM_FILL_SEC * 0.5);
  ok((w.engine.accum_charge['A'] ?? 0) > 0, 'charging before pickup');
  w.carrying = 'A'; w.step(ACCUM_FILL_SEC * 0.5 + 0.1);
  ok((w.engine.accum_charge['A'] ?? 0) === 0, 'picking the accumulator stops (and clears) its charge');
}

// ---------------------------------------------------------------------------
// 10. Fill commit: stamp the colour, cut ONLY feeders, KEEP other intents,
//     then emit as a rank-0 source onto the kept links.
// ---------------------------------------------------------------------------
{
  const w = mk();
  w.add(new Node('rs', 'source', [0, 0],   { color: 'red' }));
  w.add(new Node('gs', 'source', [0, 200], { color: 'green' }));
  w.add(new Node('yr', 'receiver', [500, 100], { color: 'yellow' }));  // a NON-feeder intent
  w.add(new Node('A', 'accumulator', [250, 100], { color: null }));
  w.toggle_link('rs', 'A'); w.toggle_link('gs', 'A'); w.toggle_link('A', 'yr');
  w.solve(true); w.step(0); w.step(ACCUM_FILL_SEC + 0.1);
  commit(w);
  ok(w.nodes['A'].color === 'yellow', 'commit stamps the mix colour');
  ok(!w.links.has(w._link_key('A', 'rs')) && !w.links.has(w._link_key('A', 'gs')),
     'the feeder links are cut');
  ok(w.links.has(w._link_key('A', 'yr')), 'a non-feeder link is KEPT');
  ok(w.engine.emit['A'] === 'yellow' && w.engine._linkRanks().get('A') === 0,
     'it now emits yellow as a rank-0 source');
  ok(!!w.engine.lit['yr'], 'and lights the kept yellow receiver');
}

// ---------------------------------------------------------------------------
// 11. Discharge: emptying a charged accumulator makes it a chargeable sink again.
// ---------------------------------------------------------------------------
{
  const w = mk();
  w.add(new Node('A', 'accumulator', [100, 0], { color: 'blue' }));
  w.solve(true);
  ok(w.engine.emit['A'] === 'blue', 'charged before discharge');
  w.nodes['A'].color = null;
  w.solve(true);
  ok(w.engine.emit['A'] == null && w.engine._linkRanks().get('A') === undefined,
     'after discharge it emits nothing and is no longer a rank-0 source');
}

// ---------------------------------------------------------------------------
// 12. Targetable device: empty wires to sources/relays (not receivers); a
//     charged one may also target receivers.
// ---------------------------------------------------------------------------
{
  const w = mk();
  w.add(new Node('S', 'source', [0, 0], { color: 'red' }));
  w.add(new Node('R', 'receiver', [400, 0], { color: 'red' }));
  w.add(new Node('C', 'connector', [200, 0]));
  w.add(new Node('A', 'accumulator', [200, 100], { color: null }));
  const spec = targetSpec('accumulator');
  ok(!!spec, 'the accumulator has a targeting spec');
  const emptyCands = spec.candidates(w, 'A').map(c => c.id).sort();
  ok(emptyCands.includes('S') && emptyCands.includes('C') && !emptyCands.includes('R'),
     'empty accumulator targets sources/relays but NOT receivers');
  w.nodes['A'].color = 'red';
  ok(spec.candidates(w, 'A').map(c => c.id).includes('R'),
     'a charged accumulator may also target receivers');
}

// ---------------------------------------------------------------------------
// 13. Grown footprint: a charging accumulator occludes light at a larger radius.
// ---------------------------------------------------------------------------
{
  const w = mk();
  w.add(new Node('gs', 'source', [0, 0], { color: 'green' }));
  w.add(new Node('A', 'accumulator', [200, 0], { color: null }));
  w.toggle_link('gs', 'A'); w.solve(true);
  ok(w.engine.accumFootprintRadius('A') === 12, 'an idle accumulator has the base footprint');
  w.step(0); w.step(0.2);                       // begin charging
  ok(w.engine.accumFootprintRadius('A') > 12, 'a charging accumulator grows its footprint');
}

console.log(`\naccumulator tests: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
