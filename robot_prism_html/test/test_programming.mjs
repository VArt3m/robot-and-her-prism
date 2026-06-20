// Contract tests for the programming FRAMEWORK (js/sim/programming.js), sister to
// test_targeting.mjs. They pin the invariant: every programmable object is driven
// by a spec of FACETS, each facet resolves to real menu labels and flashes, and
// the chooser-building rules (no-op exclusion, corruption gating, multi-facet
// composition) behave — so a new programmable object is a small data addition
// with no core change. Run: node test_programming.mjs
import { OBJECT_TYPES } from '../js/sim/objects.js';
import {
  PROGRAM_SPECS, programSpec, programIsNoop, sameProgramValue, isCorruptionValue,
  programOptions, stampProgramDefaults,
} from '../js/sim/programming.js';
import { STR } from '../js/core/strings.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL:', m); } };

// 1. programmable  ⇔  has a program spec.
for (const [kind, t] of Object.entries(OBJECT_TYPES)) {
  ok(Boolean(t.programmable) === Boolean(programSpec(kind)),
     `${kind}: programmable (${!!t.programmable}) matches has-spec (${!!programSpec(kind)})`);
}
for (const kind of Object.keys(PROGRAM_SPECS)) {
  ok(OBJECT_TYPES[kind]?.programmable === true, `spec ${kind} is a programmable kind`);
}

// 2. Every spec is a non-empty list of facets, each complete, with label/flash
//    keys that resolve to real functions returning strings for every value.
for (const [kind, spec] of Object.entries(PROGRAM_SPECS)) {
  ok(Array.isArray(spec.facets) && spec.facets.length > 0, `${kind} spec has at least one facet`);
  for (const facet of spec.facets) {
    for (const f of ['field', 'default', 'values', 'labelKey', 'flashKey']) {
      ok(f in facet, `${kind}.${facet.field ?? '?'} facet declares ${f}`);
    }
    ok(Array.isArray(facet.values) && facet.values.length > 0, `${kind}.${facet.field} offers at least one value`);
    ok(facet.values.some(v => sameProgramValue(v, facet.default)), `${kind}.${facet.field} default is one of its values`);
    ok(typeof STR.menu[facet.labelKey] === 'function', `${kind}.${facet.field} labelKey → STR.menu.${facet.labelKey}() exists`);
    ok(typeof STR.flash[facet.flashKey] === 'function', `${kind}.${facet.field} flashKey → STR.flash.${facet.flashKey}() exists`);
    for (const v of facet.values) {
      ok(typeof STR.menu[facet.labelKey](v) === 'string', `${kind}.${facet.field}: a label renders for ${JSON.stringify(v)}`);
      ok(typeof STR.flash[facet.flashKey](v) === 'string', `${kind}.${facet.field}: a flash renders for ${JSON.stringify(v)}`);
    }
  }
}

// 3. sameProgramValue: null/undefined are equal; arrays compare as unordered sets;
//    everything else strict.
ok(sameProgramValue(null, undefined), 'null and undefined are the same (both "unset")');
ok(sameProgramValue('red', 'red'), 'identical values are the same');
ok(!sameProgramValue(null, 'red'), 'clean vs a colour differ');
ok(!sameProgramValue('red', 'green'), 'two colours differ');
ok(sameProgramValue(['red', 'blue'], ['blue', 'red']), 'a colour pair is order-independent');
ok(!sameProgramValue(['red', 'blue'], ['red', 'green']), 'different pairs differ');

// 4. The no-op rule, per facet: re-applying the current value is a no-op, and from
//    any current value exactly that value is excluded (so a facet never empties).
for (const [kind, spec] of Object.entries(PROGRAM_SPECS)) {
  for (const facet of spec.facets) {
    for (const cur of facet.values) {
      const node = { [facet.field]: cur };
      ok(programIsNoop(facet, node, cur),
         `${kind}.${facet.field}: re-applying ${JSON.stringify(cur)} is a no-op`);
      const live = facet.values.filter(v => !programIsNoop(facet, node, v));
      ok(live.length === facet.values.length - 1,
         `${kind}.${facet.field}: from ${JSON.stringify(cur)}, exactly the current value is excluded`);
    }
  }
}
ok(!programIsNoop(null, { color: 'red' }, 'red'), 'no facet → not flagged a no-op');
ok(!programIsNoop(programSpec('rewirer').facets[0], null, 'red'), 'no node → not flagged a no-op');

// 5. Corruption classification (isCorruptionValue) operates on a facet: only a
//    `corrupts` facet gates values, and its clean value is never a corruption.
const connColor = programSpec('connector').facets[0];
ok(connColor.corrupts === true && 'cleanValue' in connColor, 'connector colour facet is corruption-based');
ok(!isCorruptionValue(connColor, connColor.cleanValue), 'cleaning (→ clean value) is NOT a corruption');
ok(['red', 'green', 'blue'].every(c => isCorruptionValue(connColor, c)), 'locking any colour IS a corruption');
for (const v of programSpec('rewirer').facets[0].values) {
  ok(!isCorruptionValue(programSpec('rewirer').facets[0], v), `rewirer ${JSON.stringify(v)} is never a "corruption"`);
}
// The inverter's PAIR facet is not a corruption facet, so a clean-only Forge keeps it.
const invPair = programSpec('inverter').facets.find(f => f.field === 'pair');
ok(invPair && invPair.corrupts !== true, 'the inverter pair facet is not a corruption facet');
for (const v of invPair.values) ok(!isCorruptionValue(invPair, v), `inverter pair ${JSON.stringify(v)} is never a corruption`);

// 6. programOptions composes facets, drops no-ops, and (when asked) gates
//    corruptions — exactly what the Forge chooser shows.
{
  // A clean connector at a corrupting Forge → the three corruption colours only.
  const opts = programOptions(programSpec('connector'), { color: null }, { canCorrupt: true });
  ok(opts.length === 3 && opts.every(o => o.field === 'color' && o.value), 'clean connector → 3 corruption options');
  // …at a clean-only Forge → nothing (clean is a no-op, corruptions are gated).
  ok(programOptions(programSpec('connector'), { color: null }, { canCorrupt: false }).length === 0,
     'clean connector at a clean-only Forge → no options');
  // A corrupted connector at a clean-only Forge → only "clean".
  const cleanOnly = programOptions(programSpec('connector'), { color: 'red' }, { canCorrupt: false });
  ok(cleanOnly.length === 1 && cleanOnly[0].value === null, 'corrupted connector at a clean-only Forge → only Clean');

  // A clean inverter (pair red/blue) at a corrupting Forge → 3 corruptions + 2
  // other pairs = 5 options spanning BOTH facets.
  const inv = programOptions(programSpec('inverter'), { color: null, pair: ['red', 'blue'] }, { canCorrupt: true });
  ok(inv.length === 5, 'clean inverter → 5 options (3 corruptions + 2 pair swaps)');
  ok(inv.filter(o => o.field === 'color').length === 3, '…three on the colour facet');
  ok(inv.filter(o => o.field === 'pair').length === 2, '…two on the pair facet (current pair excluded)');
  // …at a clean-only Forge → only the 2 pair swaps (corruptions gated).
  const invClean = programOptions(programSpec('inverter'), { color: null, pair: ['red', 'blue'] }, { canCorrupt: false });
  ok(invClean.length === 2 && invClean.every(o => o.field === 'pair'),
     'clean inverter at a clean-only Forge → only pair swaps');
}

// 7. stampProgramDefaults fills every facet's field (copying array defaults), and
//    is idempotent / never clobbers a set field.
{
  const node = { kind: 'inverter' };
  stampProgramDefaults(node, programSpec('inverter'));
  ok(node.color === null && Array.isArray(node.pair) && sameProgramValue(node.pair, ['red', 'blue']),
     'inverter stamps color=null and pair=[red,blue]');
  node.pair[0] = 'green';                          // mutating the node must not touch the spec default
  const node2 = { kind: 'inverter' };
  stampProgramDefaults(node2, programSpec('inverter'));
  ok(sameProgramValue(node2.pair, ['red', 'blue']), 'array default is copied, not shared');
  const set = { color: 'red', fuse: 7 };
  stampProgramDefaults(set, programSpec('connector'));
  ok(set.color === 'red', 'stamping never clobbers an already-set field');
}

console.log(`\nprogramming framework tests: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
