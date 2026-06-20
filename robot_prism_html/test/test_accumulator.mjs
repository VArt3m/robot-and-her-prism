// Tests for the ACCUMULATOR — a portable source with a charge.
//   CHARGED (color set): a rank-0 source that emits ONLY its own colour. It never
//     relays incoming light, is never confused, and is dead weight to beams that
//     pass through it. Against a same-rank emitter (a source / another charged
//     accumulator) a colour clash tugs at the midpoint; same colour delivers.
//   EMPTY  (color null): a sink that fills over ACCUM_FILL_SEC of an uninterrupted
//     SINGLE incoming colour (more than one colour, or none, resets the charge),
//     then becomes charged and the link that filled it drops.
// Run: node test_accumulator.mjs
import { World } from '../js/sim/world.js';
import { Node } from '../js/core/entities.js';
import { ACCUM_FILL_SEC } from '../js/core/constants.js';
import { targetSpec } from '../js/sim/targeting.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL:', m); } };
const mk = () => { const w = new World(); w.player = null; w._uid = 1; return w; };
const beamsBetween = (w, x, y) => {
  const [, [beams, , delivery]] = w.engine.propagate();
  return beams.map((b, k) => ({ b, del: delivery[k] }))
    .filter(({ b }) => (b.o === x && b.t === y) || (b.o === y && b.t === x));
};

// ---------------------------------------------------------------------------
// 1. Charged: a rank-0 source emitting its own colour, lighting a receiver.
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
// 2. Charged: never relays. Fed another colour, it still emits only its own.
// ---------------------------------------------------------------------------
{
  const w = mk();
  w.add(new Node('S', 'source', [0, 0], { color: 'green' }));
  w.add(new Node('A', 'accumulator', [150, 0], { color: 'red' }));
  w.add(new Node('gr', 'receiver', [300, 0], { color: 'green' }));
  w.add(new Node('rr', 'receiver', [300, 140], { color: 'red' }));
  w.toggle_link('S', 'A'); w.toggle_link('A', 'gr'); w.toggle_link('A', 'rr'); w.solve(true);
  ok(w.engine.emit['A'] === 'red', 'a fed accumulator still emits only its own colour');
  ok(!w.engine.lit['gr'], 'the incoming green is NOT relayed onward');
  ok(!!w.engine.lit['rr'], 'its own red is emitted onward');
  ok(!w.dead_conns.has('A'), 'a charged accumulator is never confused by incoming light');
}

// ---------------------------------------------------------------------------
// 3. Charged: dead weight — blocks a beam that merely passes through it.
// ---------------------------------------------------------------------------
{
  const w = mk();
  w.add(new Node('S', 'source', [0, 0], { color: 'red' }));
  w.add(new Node('C', 'connector', [100, 0]));
  w.add(new Node('rr', 'receiver', [300, 0], { color: 'red' }));
  w.add(new Node('A', 'accumulator', [200, 0], { color: 'blue' }));   // squats on C→rr
  w.toggle_link('S', 'C'); w.toggle_link('C', 'rr'); w.solve(true);
  ok(!w.engine.lit['rr'], 'an accumulator in the beam path is dead weight (blocks it)');
}

// ---------------------------------------------------------------------------
// 4. Charged vs a same-rank source: colour clash tugs; same colour delivers.
// ---------------------------------------------------------------------------
{
  const w = mk();
  w.add(new Node('A', 'accumulator', [0, 0], { color: 'red' }));
  w.add(new Node('S', 'source', [200, 0], { color: 'blue' }));
  w.toggle_link('A', 'S'); w.solve(true);
  const clash = beamsBetween(w, 'A', 'S');
  ok(clash.length === 2 && clash.every(({ del }) => del === false),
     'charged accumulator vs source, different colours → tug (neither delivers)');

  const w2 = mk();
  w2.add(new Node('A', 'accumulator', [0, 0], { color: 'red' }));
  w2.add(new Node('S', 'source', [200, 0], { color: 'red' }));
  w2.toggle_link('A', 'S'); w2.solve(true);
  const same = beamsBetween(w2, 'A', 'S');
  ok(same.length === 2 && same.every(({ del }) => del === true),
     'charged accumulator vs source, same colour → full delivery');
}

// ---------------------------------------------------------------------------
// 5. Empty: emits nothing, and a source's beam delivers to it (to fill it).
// ---------------------------------------------------------------------------
{
  const w = mk();
  w.add(new Node('S', 'source', [0, 0], { color: 'green' }));
  w.add(new Node('A', 'accumulator', [200, 0], { color: null }));
  w.toggle_link('S', 'A'); w.solve(true);
  ok(w.engine.emit['A'] == null, 'an empty accumulator emits nothing');
  const sa = beamsBetween(w, 'S', 'A');
  ok(sa.length === 1 && sa[0].del === true, 'a source delivers full length to an empty accumulator');
}

// ---------------------------------------------------------------------------
// 6. Empty: charges over ACCUM_FILL_SEC of a single colour, then is ready.
// ---------------------------------------------------------------------------
{
  const w = mk();
  w.add(new Node('S', 'source', [0, 0], { color: 'green' }));
  w.add(new Node('A', 'accumulator', [200, 0], { color: null }));
  w.toggle_link('S', 'A'); w.solve(true);
  w.step(0);
  w.step(ACCUM_FILL_SEC * 0.5);
  ok((w.engine.accum_charge['A'] ?? 0) > 0 && w.engine.ready_accumulators().length === 0,
     'partway through it is charging but not yet ready');
  w.step(ACCUM_FILL_SEC + 0.1);
  const ready = w.engine.ready_accumulators();
  ok(ready.length === 1 && ready[0].id === 'A' && ready[0].color === 'green',
     'after the full delay it is ready to fill with the incoming colour');
}

// ---------------------------------------------------------------------------
// 7. Empty: a colour CONFLICT (more than one colour) never charges; and an
//    interruption resets a partial charge.
// ---------------------------------------------------------------------------
{
  const w = mk();
  w.add(new Node('S1', 'source', [0, 0], { color: 'green' }));
  w.add(new Node('S2', 'source', [0, 120], { color: 'red' }));
  w.add(new Node('A', 'accumulator', [200, 60], { color: null }));
  w.toggle_link('S1', 'A'); w.toggle_link('S2', 'A'); w.solve(true);
  w.step(0); w.step(1); w.step(ACCUM_FILL_SEC + 0.5);
  ok((w.engine.accum_charge['A'] ?? 0) === 0 && w.engine.ready_accumulators().length === 0,
     'two colours reaching it → it never charges (confused)');

  const w2 = mk();
  w2.add(new Node('S', 'source', [0, 0], { color: 'green' }));
  w2.add(new Node('A', 'accumulator', [200, 0], { color: null }));
  w2.toggle_link('S', 'A'); w2.solve(true);
  w2.step(0); w2.step(ACCUM_FILL_SEC * 0.6);
  const partial = w2.engine.accum_charge['A'];
  ok(partial > 0, 'charge builds with a clear single colour');
  w2.toggle_link('S', 'A');             // cut the feed
  w2.step(ACCUM_FILL_SEC * 0.6 + 0.1);
  ok((w2.engine.accum_charge['A'] ?? 0) === 0, 'cutting the feed resets the charge to zero');
}

// ---------------------------------------------------------------------------
// 8. Fill commit (what the UI does): stamp the colour, drop the filling link.
//    After it, the accumulator is a source and the charging link is gone.
// ---------------------------------------------------------------------------
{
  const w = mk();
  w.add(new Node('S', 'source', [0, 0], { color: 'green' }));
  w.add(new Node('A', 'accumulator', [200, 0], { color: null }));
  w.toggle_link('S', 'A'); w.solve(true);
  w.step(0); w.step(ACCUM_FILL_SEC + 0.1);
  const ready = w.ready_accumulators();
  ok(ready.length === 1, 'ready_accumulators surfaces the finished accumulator');
  // Emulate _commitFills:
  for (const { id, color } of ready) { w.nodes[id].color = color; w.clear_links_of(id); }
  w.solve(true);
  ok(w.nodes['A'].color === 'green', 'fill stamps the colour (now a charged source)');
  ok(w.links_pairs.every(([a, b]) => a !== 'A' && b !== 'A'), 'the link that filled it has dropped');
  ok(w.engine.emit['A'] === 'green', 'and it now emits as a source');
}

// ---------------------------------------------------------------------------
// 9. Discharge: emptying a charged accumulator makes it a chargeable sink again.
// ---------------------------------------------------------------------------
{
  const w = mk();
  w.add(new Node('A', 'accumulator', [100, 0], { color: 'blue' }));
  w.solve(true);
  ok(w.engine.emit['A'] === 'blue', 'charged before discharge');
  w.nodes['A'].color = null;            // what Q does
  w.solve(true);
  ok(w.engine.emit['A'] == null && w.engine._linkRanks().get('A') === undefined,
     'after discharge it emits nothing and is no longer a rank-0 source');
}

// ---------------------------------------------------------------------------
// 10. It is a wireable, targetable device, and an empty one excludes receivers.
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
  const chargedCands = spec.candidates(w, 'A').map(c => c.id).sort();
  ok(chargedCands.includes('R'), 'a charged accumulator may also target receivers');
}

console.log(`\naccumulator tests: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
