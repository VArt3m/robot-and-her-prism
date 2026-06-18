// Contract tests for the programming FRAMEWORK (js/sim/programming.js), sister
// to test_targeting.mjs. They pin the invariant: every programmable object is
// driven by a spec, and the spec resolves to real menu labels and flashes, so a
// new programmable object is a one-entry addition with no core change.
// Run: node test_programming.mjs
import { OBJECT_TYPES } from './js/sim/objects.js';
import { PROGRAM_SPECS, programSpec } from './js/sim/programming.js';
import { STR } from './js/core/strings.js';

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

console.log(`\nprogramming framework tests: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
