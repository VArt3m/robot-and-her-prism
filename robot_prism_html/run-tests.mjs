// Test runner: discovers and runs the headless test_*.mjs suites.
//
//   node run-tests.mjs              run every suite
//   node run-tests.mjs jam tree     run only suites whose name contains a filter
//                                   (matches "test_jam.mjs", "test_tree.mjs", …)
//
// Each suite is a standalone script that prints its own tally and exits non-zero
// on failure. We run them in child processes, stream their output, and aggregate
// into a final pass/fail summary; the runner's own exit code is non-zero if any
// suite failed, so it works as a CI gate.

import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const testDir = join(here, 'test');
const filters = process.argv.slice(2);

const all = readdirSync(testDir)
  .filter(f => /^test_.*\.mjs$/.test(f))
  .sort();

const suites = filters.length
  ? all.filter(f => filters.some(s => f.includes(s)))
  : all;

if (suites.length === 0) {
  console.error(filters.length
    ? `No test suites match: ${filters.join(', ')}\nAvailable: ${all.join(', ')}`
    : 'No test_*.mjs suites found.');
  process.exit(1);
}

const failed = [];
for (const suite of suites) {
  console.log(`\n=== ${suite} ===`);
  const res = spawnSync(process.execPath, [join(testDir, suite)], { stdio: 'inherit' });
  if (res.status !== 0) failed.push(suite);
}

console.log(`\n${'='.repeat(40)}`);
console.log(`suites: ${suites.length} run, ${suites.length - failed.length} passed, ${failed.length} failed`);
if (failed.length) {
  console.log(`failed: ${failed.join(', ')}`);
  process.exit(1);
}
console.log('all suites passed');
