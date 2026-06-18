// Contract tests for the targeting FRAMEWORK (js/sim/targeting.js). These pin
// the invariant the framework exists to guarantee: every object that requires a
// target is driven entirely by a spec, with no per-kind code in the core. A new
// targetable object passes these by adding one registry entry.
// Run: node test_targeting.mjs
import { World } from '../js/sim/world.js';
import { Node, ForceField } from '../js/core/entities.js';
import { OBJECT_TYPES } from '../js/sim/objects.js';
import { TARGET_SPECS, targetSpec, allIntentRays } from '../js/sim/targeting.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL:', m); } };

// ---------------------------------------------------------------------------
// 1. The core invariant: requiresTarget  ⇔  has a spec. If someone adds a
//    targetable object without a spec (or a spec for a non-targeting kind),
//    this fails — which is exactly the "don't re-describe targeting" guard.
// ---------------------------------------------------------------------------
for (const [kind, t] of Object.entries(OBJECT_TYPES)) {
  ok(Boolean(t.requiresTarget) === Boolean(targetSpec(kind)),
     `${kind}: requiresTarget (${!!t.requiresTarget}) matches has-spec (${!!targetSpec(kind)})`);
}
for (const kind of Object.keys(TARGET_SPECS)) {
  ok(OBJECT_TYPES[kind]?.requiresTarget === true, `spec ${kind} is a requiresTarget kind`);
}

// ---------------------------------------------------------------------------
// 2. Every spec implements the full hook surface the core calls.
// ---------------------------------------------------------------------------
for (const [kind, spec] of Object.entries(TARGET_SPECS)) {
  for (const hook of ['targetAt', 'apply', 'intentRays', 'clear']) {
    ok(typeof spec[hook] === 'function', `${kind} spec implements ${hook}()`);
  }
  ok('maxIntents' in spec && 'persistent' in spec, `${kind} spec declares maxIntents + persistent`);
}

// ---------------------------------------------------------------------------
// 3. Connector spec: target → apply (link) → enumerate → clear.
// ---------------------------------------------------------------------------
{
  const w = new World(); w.player = null; w._uid = 1;
  w.add(new Node('c', 'connector', [100, 100]));
  w.add(new Node('s', 'source', [140, 100], { color: 'red' }));
  const spec = targetSpec('connector');
  const t = spec.targetAt(w, 'c', 140, 100);
  ok(t && t.id === 's', 'connector targetAt finds a source within reach');
  ok(spec.targetAt(w, 'c', 100, 100) === null, 'connector targetAt excludes itself');
  spec.apply(w, 'c', 's');
  ok(w.links.size === 1, 'connector apply creates a light link');
  const rays = allIntentRays(w);
  ok(rays.length === 1, 'allIntentRays enumerates the connector link once');
  rays[0].remove();
  ok(w.links.size === 0, 'the ray\u2019s remove() deletes the link');
  spec.apply(w, 'c', 's');
  spec.clear(w, 'c');
  ok(w.links.size === 0, 'connector clear() drops its links');
}

// ---------------------------------------------------------------------------
// 4. Jammer spec: single intent, set-overwrites, one ray, clear.
// ---------------------------------------------------------------------------
{
  const w = new World(); w.player = null; w._uid = 1;
  w.ffs.push(new ForceField('ff', [200, 50], [200, 150]));
  w.ffs.push(new ForceField('ff2', [260, 50], [260, 150]));
  w.add(new Node('j', 'jammer', [100, 100]));
  const spec = targetSpec('jammer');
  ok(spec.maxIntents === 1, 'jammer declares a single intent');
  const t = spec.targetAt(w, 'j', 200, 120);           // anywhere along the gate
  ok(t && t.id === 'ff', 'jammer targetAt hits a gate along its length');
  spec.apply(w, 'j', 'ff');
  spec.apply(w, 'j', 'ff2');                            // overwrites
  ok(w.jam_links.size === 1 && w.jam_links.get('j') === 'ff2', 'jammer apply overwrites (one intent)');
  const rays = allIntentRays(w);
  ok(rays.length === 1 && rays[0].key === 'jam\u0000j', 'jammer contributes one keyed ray');
  rays[0].remove();
  ok(!w.jam_links.has('j'), 'the jam ray\u2019s remove() clears the intent');
}

// ---------------------------------------------------------------------------
// 5. Rewirer spec: now a full persistent targeting device (recolour intent).
// ---------------------------------------------------------------------------
{
  const w = new World(); w.player = null; w._uid = 1;
  w.add(new Node('rw', 'rewirer', [100, 100], { color: 'red' }));
  w.add(new Node('s', 'source', [140, 100], { color: 'red' }));
  w.add(new Node('c', 'connector', [100, 140]));
  const spec = targetSpec('rewirer');
  ok(spec.persistent === true, 'rewirer stores a persistent recolour intent');
  ok(spec.targetAt(w, 'rw', 140, 100)?.id === 's', 'rewirer targetAt finds a source');
  ok(spec.targetAt(w, 'rw', 100, 140)?.id === 'c', 'rewirer can also target a connector');
  spec.apply(w, 'rw', 's');
  ok(allIntentRays(w).some(r => r.key === 'recolor\u0000rw'), 'rewirer apply stores a recolour ray');
  spec.apply(w, 'rw', 'c');                              // overwrites — one intent
  ok(w.recolor_links.size === 1 && w.recolor_links.get('rw') === 'c', 'rewirer keeps one intent (overwrites)');
  spec.clear(w, 'rw');
  ok(allIntentRays(w).length === 0, 'rewirer clear() drops its intent');
}

console.log(`\ntargeting framework tests: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
