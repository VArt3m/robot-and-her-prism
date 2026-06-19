// Contract tests for the programming FRAMEWORK (js/sim/programming.js), sister
// to test_targeting.mjs. They pin the invariant: every programmable object is
// driven by a spec, and the spec resolves to real menu labels and flashes, so a
// new programmable object is a one-entry addition with no core change.
// Run: node test_programming.mjs
import { OBJECT_TYPES } from '../js/sim/objects.js';
import { PROGRAM_SPECS, programSpec, programIsNoop, sameProgramValue } from '../js/sim/programming.js';
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

// 2. Every spec is complete and its label/flash keys resolve to real functions.
for (const [kind, spec] of Object.entries(PROGRAM_SPECS)) {
  for (const f of ['field', 'default', 'values', 'labelKey', 'flashKey']) {
    ok(f in spec, `${kind} spec declares ${f}`);
  }
  ok(Array.isArray(spec.values) && spec.values.length > 0, `${kind} spec offers at least one value`);
  ok(spec.values.includes(spec.default), `${kind} default is one of its values`);
  ok(typeof STR.menu[spec.labelKey] === 'function', `${kind} labelKey → STR.menu.${spec.labelKey}() exists`);
  ok(typeof STR.flash[spec.flashKey] === 'function', `${kind} flashKey → STR.flash.${spec.flashKey}() exists`);
  for (const v of spec.values) {
    ok(typeof STR.menu[spec.labelKey](v) === 'string', `${kind}: a label renders for ${JSON.stringify(v)}`);
    ok(typeof STR.flash[spec.flashKey](v) === 'string', `${kind}: a flash renders for ${JSON.stringify(v)}`);
  }
}

// 3. The "exclude no-op options" rule (programIsNoop / sameProgramValue): an
//    option is a no-op exactly when applying it would not change the field.
//    null/undefined ("unset / clean") compare equal; everything else is strict.
ok(sameProgramValue(null, undefined), 'null and undefined are the same (both "unset")');
ok(sameProgramValue('red', 'red'), 'identical values are the same');
ok(!sameProgramValue(null, 'red'), 'clean vs a colour differ');
ok(!sameProgramValue('red', 'green'), 'two colours differ');
ok(!sameProgramValue(2, 3), 'two fuses differ');

// Generic over every spec: the value the device already holds is a no-op, and at
// least one offered value is NOT a no-op (so the menu is never fully disabled).
for (const [kind, spec] of Object.entries(PROGRAM_SPECS)) {
  for (const cur of spec.values) {
    const node = { [spec.field]: cur };
    ok(programIsNoop(spec, node, cur),
       `${kind}: re-applying the current ${spec.field}=${JSON.stringify(cur)} is a no-op`);
    const live = spec.values.filter(v => !programIsNoop(spec, node, v));
    ok(live.length === spec.values.length - 1,
       `${kind}: from ${JSON.stringify(cur)}, exactly the current value is excluded`);
    ok(live.length >= 1, `${kind}: at least one real option remains from ${JSON.stringify(cur)}`);
  }
}
// A freshly-stamped connector is "clean" (null): the "Clean" option is excluded.
ok(programIsNoop(programSpec('connector'), { color: null }, null),
   'connector: a clean connector is not offered "clean" again');
ok(!programIsNoop(programSpec('connector'), { color: null }, 'red'),
   'connector: a clean connector CAN be corrupted to red');
// Guard: no spec/node → not a no-op (caller treats it as a normal option).
ok(!programIsNoop(null, { color: 'red' }, 'red'), 'no spec → not flagged a no-op');
ok(!programIsNoop(programSpec('rewirer'), null, 'red'), 'no node → not flagged a no-op');

console.log(`\nprogramming framework tests: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
