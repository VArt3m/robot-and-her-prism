// Tests for the corner-panel highlight features:
//   • targeting-spec `candidates()` enumeration + reachability,
//   • carriedRayType / visibilityPolygon (the "passable ray area"),
//   • world.ray_clear line of sight,
//   • the Alt/Ctrl-vs-toggle XOR rule the panel relies on,
//   • the Panel's polite fade timer (driven headlessly, no DOM).
// Run: node test_highlight.mjs
import { World } from '../js/sim/world.js';
import { Node, Wall, ForceField } from '../js/core/entities.js';
import { build_level } from '../js/sim/level.js';
import { targetSpec } from '../js/sim/targeting.js';
import { carriedRayType, visibilityPolygon, rayProfile } from '../js/sim/occlusion.js';
import { WORLD_W, WORLD_H } from '../js/core/constants.js';
import { Panel } from '../js/ui/panel.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL:', m); } };

// ---------------------------------------------------------------------------
// 1. carriedRayType maps each aiming object to its occlusion profile; non-ray
//    objects (box, mine) map to null so they show no passable area.
// ---------------------------------------------------------------------------
ok(carriedRayType('connector') === 'laser',   'connector → laser ray');
ok(carriedRayType('rewirer')   === 'rewirer', 'rewirer → rewirer ray');
ok(carriedRayType('jammer')    === 'jammer',  'jammer → jammer ray');
ok(carriedRayType('box')       === null,      'box has no ray');
ok(carriedRayType('mine')      === null,      'mine has no ray (programmable only)');

// ---------------------------------------------------------------------------
// 2. world.ray_clear: a wall between two points blocks line of sight; remove it
//    (or step around) and the shot is clear. Unknown ray types are vacuously
//    clear.
// ---------------------------------------------------------------------------
{
  const w = new World();
  w.walls.push(new Wall([100, 0], [100, 200]));   // vertical wall at x=100
  ok(w.ray_clear([50, 100], [60, 100], 'laser', {}) === true,  'clear shot before the wall');
  ok(w.ray_clear([50, 100], [150, 100], 'laser', {}) === false, 'wall blocks the laser');
  ok(w.ray_clear([50, 100], [150, 100], 'nope', {}) === true,   'unknown ray type is vacuously clear');
}

// ---------------------------------------------------------------------------
// 3. candidates(): enumerate valid targets and report reachability from an
//    origin. Connector links ignore line of sight (always reachable); the
//    rewirer's recolour respects it.
// ---------------------------------------------------------------------------
{
  // Connector enumeration: every source/receiver/connector except itself, all
  // reachable (links ignore obstruction).
  const w = new World(); w.player = null; w._uid = 1;
  w.add(new Node('c',  'connector', [50, 100]));
  w.add(new Node('s',  'source',    [150, 100], { color: 'red' }));
  w.add(new Node('rcv','receiver',  [50, 180],  { color: 'red' }));
  w.walls.push(new Wall([100, 0], [100, 200]));    // between c and s

  const cc = targetSpec('connector').candidates(w, 'c', [50, 100]);
  ok(cc.length === 2, 'connector enumerates the source + receiver (not itself)');
  ok(cc.every(x => x.reachable), 'connector candidates are all reachable (links ignore walls)');
  ok(!cc.some(x => x.id === 'c'), 'connector excludes itself from candidates');
}
{
  // Rewirer reachability respects line of sight: the source behind the wall is a
  // candidate but not reachable; the receiver with a clear shot is reachable.
  const w = new World(); w.player = null; w._uid = 1;
  w.add(new Node('rw', 'rewirer',  [50, 100], { color: 'red' }));
  w.add(new Node('s',  'source',   [150, 100], { color: 'red' }));
  w.add(new Node('rcv','receiver', [50, 180],  { color: 'red' }));
  w.walls.push(new Wall([100, 0], [100, 200]));
  const rc = targetSpec('rewirer').candidates(w, 'rw', [50, 100]);
  const sHit = rc.find(x => x.id === 's');
  const rHit = rc.find(x => x.id === 'rcv');
  ok(sHit && sHit.reachable === false, 'rewirer: target behind a wall is unreachable');
  ok(rHit && rHit.reachable === true,  'rewirer: target with a clear shot is reachable');
}

// ---------------------------------------------------------------------------
// 4. Jammer candidates include force fields (at their midpoint) and jammable
//    nodes (a mine), with reachability via the jammer profile.
// ---------------------------------------------------------------------------
{
  const w = new World(); w.player = null; w._uid = 1;
  w.ffs.push(new ForceField('ff', [200, 50], [200, 150]));
  w.add(new Node('j',    'jammer', [100, 100]));
  w.add(new Node('mine', 'mine',   [120, 100], { fuse: 3 }));
  const jc = targetSpec('jammer').candidates(w, 'j', [100, 100]);
  ok(jc.some(x => x.id === 'ff'),   'jammer lists the force field');
  ok(jc.some(x => x.id === 'mine'), 'jammer lists the jammable mine');
  ok(jc.every(x => x.reachable),    'jammer candidates reachable with clear sight');
}

// ---------------------------------------------------------------------------
// 5. visibilityPolygon: bounded, non-degenerate, every point inside the world,
//    and a wall demonstrably shrinks the reachable area.
// ---------------------------------------------------------------------------
{
  const w = build_level();
  const bounds = [0, 0, WORLD_W, WORLD_H];
  const poly = visibilityPolygon(w, { ...rayProfile('laser'), player: false }, w.player, bounds);
  ok(poly.length > 2, 'polygon has enough points to fill');
  ok(poly.every(([x, y]) => x >= -1 && x <= WORLD_W + 1 && y >= -1 && y <= WORLD_H + 1),
     'every polygon point lies within the world bounds');
  const area = (pts) => {
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      a += p[0] * q[1] - q[0] * p[1];
    }
    return Math.abs(a) / 2;
  };
  ok(area(poly) > 1000, 'polygon encloses a real area');

  // An empty room of the same size sees its whole self; a wall through it sees
  // strictly less.
  const open = new World(); open.player = [200, 200];
  const full = area(visibilityPolygon(open, { ...rayProfile('laser'), player: false }, open.player, bounds));
  const walled = new World(); walled.player = [200, 200];
  walled.walls.push(new Wall([300, 0], [300, WORLD_H]));
  const cut = area(visibilityPolygon(walled, { ...rayProfile('laser'), player: false }, walled.player, bounds));
  ok(cut < full - 1, 'a wall shrinks the reachable area');
}

// ---------------------------------------------------------------------------
// 6. The XOR rule the panel uses: effective = toggle XOR keyHeld. A held key
//    turns a highlight ON when the toggle is off, and SUPPRESSES it when on.
// ---------------------------------------------------------------------------
{
  const eff = (toggle, key) => toggle !== key;
  ok(eff(false, false) === false, 'off + no key → hidden');
  ok(eff(false, true)  === true,  'off + key held → shown (momentary)');
  ok(eff(true,  false) === true,  'on + no key → shown');
  ok(eff(true,  true)  === false, 'on + key held → suppressed');
}

// ---------------------------------------------------------------------------
// 7. Panel fade timer (headless): a Panel built with no real DOM is inert and
//    safe, but its setConflict timer logic still runs — fades only after a
//    sustained second, and reanimates the instant the conflict clears.
// ---------------------------------------------------------------------------
{
  const p = new Panel(null, {});            // inert (no DOM) — must not throw
  ok(p.el === null, 'panel without a DOM parent is inert');
  ok(p.isPointerOver() === false, 'inert panel: pointer never over');
  ok(typeof p.footprintRect().left === 'number', 'inert panel returns a usable rect');

  // Drive the timer on a fake element so we can observe the faded class.
  const classes = new Set();
  const fake = {
    el: { classList: { toggle: (c, on) => { on ? classes.add(c) : classes.delete(c); } } },
    _conflictSince: null, _faded: false,
  };
  fake._setFaded = Panel.prototype._setFaded.bind(fake);
  const setConflict = Panel.prototype.setConflict.bind(fake);
  setConflict(true, 1000);
  ok(!classes.has('faded'), 'no fade immediately on conflict');
  setConflict(true, 1500);
  ok(!classes.has('faded'), 'still no fade before a full second');
  setConflict(true, 2000);
  ok(classes.has('faded'), 'fades after ~1s of sustained conflict');
  setConflict(false, 2050);
  ok(!classes.has('faded'), 'reanimates the moment the conflict clears');
}

console.log(`\nhighlight / panel tests: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
