// Contract tests for the targeting FRAMEWORK (js/sim/targeting.js). These pin
// the invariant the framework exists to guarantee: every object that requires a
// target is driven entirely by a spec, with no per-kind code in the core. A new
// targetable object passes these by adding one registry entry.
// Run: node test_targeting.mjs
import { World } from '../js/sim/world.js';
import { Node, ForceField } from '../js/core/entities.js';
import { OBJECT_TYPES } from '../js/sim/objects.js';
import { TARGET_SPECS, targetSpec, allIntentRays, sweepKissTarget } from '../js/sim/targeting.js';

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
  for (const hook of ['targetAt', 'apply', 'intentRays', 'clear', 'candidates']) {
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
// 3b. sweepKissTarget — the character-drag sweep marks on body CONTACT (a kiss),
//     not centre proximity. Now that wire targets are MATERIAL the robot's centre
//     stops ~a radius short, so a target whose body the carried device touches
//     must mark even though her centre never reaches the old HIT (18) proximity.
// ---------------------------------------------------------------------------
{
  const w = new World(); w.player = null; w._uid = 1;
  w.add(new Node('c', 'connector', [100, 100]));      // the carried device
  const spec = targetSpec('connector');
  const devR = OBJECT_TYPES.connector.radius;          // 12
  const srcR = OBJECT_TYPES.source.radius;             // 13 → bodies meet within 25

  w.add(new Node('near', 'source', [100, 100 + devR + srcR - 1], { color: 'red' }));   // 24 apart: kissing
  ok(sweepKissTarget(w, spec, 'c', [100, 100], devR) === 'near',
     'a target whose body the device touches is kissed');
  w.remove_node('near');

  w.add(new Node('far', 'source', [100, 100 + devR + srcR + 2], { color: 'red' }));    // 27 apart: clear
  ok(sweepKissTarget(w, spec, 'c', [100, 100], devR) === null,
     'a target a hair beyond the summed radii is NOT kissed');
  w.remove_node('far');

  // The crux: a target beyond HIT-style centre proximity (so targetAt misses it)
  // is still kissed — exactly the shot the old "pass-through" sweep needed.
  w.add(new Node('s', 'source', [100, 122], { color: 'red' }));                        // 22 apart: > HIT(18), still kissing
  ok(spec.targetAt(w, 'c', 100, 100) === null, 'the source is beyond HIT centre proximity (targetAt misses)');
  ok(sweepKissTarget(w, spec, 'c', [100, 100], devR) === 's',
     'kissing marks it where passing-through used to be required');

  // A device that does not auto-wire on drag (the jammer) carries no kiss risk:
  // it has candidates, but the drag branch never calls kiss for it (dragAutoWire
  // is off). The helper itself is generic, so spec choice is the only gate.
  ok(typeof sweepKissTarget === 'function', 'sweepKissTarget is exported');
}


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
