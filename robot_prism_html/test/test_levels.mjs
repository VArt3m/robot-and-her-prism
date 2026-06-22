// Tests for the two-level system (sim/level.js): the LEVELS registry, the
// back-compat build_level() default (Test Grounds), and the derived
// "Lorem's Puzzle #1" — geographically identical to Test Grounds but with both
// Forges and the central scratch pickables removed, keeping exactly one central
// connector plus the two connectors in the lower-right room.
// Run: node test_levels.mjs
import { LEVELS, build_level } from '../js/sim/level.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL:', m); } };

const byId = w => new Set(Object.keys(w.nodes));
const kinds = (w, k) => Object.values(w.nodes).filter(n => n.kind === k).map(n => n.id).sort();
const env = w => JSON.stringify({
  walls: w.walls.length, ffs: w.ffs.length, barriers: w.barriers.length,
  logic: w.logic_links.length, goal: w.goal, start: w.player_start,
});

// ===========================================================================
// 1. The registry shape + the startup/menu order.
// ===========================================================================
const TG = LEVELS.find(l => l.id === 'test_grounds');   // the full sandbox
const LP = LEVELS.find(l => l.id === 'lorem_1');         // the puzzle (loads first)
{
  ok(Array.isArray(LEVELS) && LEVELS.length === 2, 'there are two registered levels');
  ok(LEVELS[0].id === 'lorem_1' && LEVELS[0].name === "Lorem's Puzzle #1",
     "the first level is Lorem's Puzzle #1 (loads first, first in the menu)");
  ok(LEVELS[1].id === 'test_grounds' && LEVELS[1].name === 'Test Grounds',
     'the second level is Test Grounds');
  const def = build_level(), tg = TG.build();
  ok(byId(def).size === byId(tg).size,
     'build_level() is still the back-compat Test Grounds (same node count)');
}

// ===========================================================================
// 2. Test Grounds is the full sandbox: both Forges and all the scratch parts.
// ===========================================================================
{
  const tg = TG.build();
  ok(kinds(tg, 'forge').length === 2, 'Test Grounds has both Forges');
  ok(tg.boxes.length === 1, 'Test Grounds has its test box');
  const ids = byId(tg);
  for (const id of ['con_c', 'con_1', 'con_2', 'inv_a', 'con_3', 'mix_a', 'acc_e', 'jam_a'])
    ok(ids.has(id), `Test Grounds keeps the scratch part ${id}`);
}

// ===========================================================================
// 3. Lorem's Puzzle #1: same geography/environment, minus Forges + minus the
//    central scratch pickables, keeping con_c (central) and con_1/con_2 (the
//    lower-right room behind the force field). Sources + receivers untouched.
// ===========================================================================
{
  const tg = TG.build();
  const lp = LP.build();

  ok(env(lp) === env(tg), 'geography + environment are identical (walls, ffs, barriers, logic, goal, start)');
  ok(lp.boxes.length === 0, 'the central test box (a pickable) is removed');
  ok(kinds(lp, 'forge').length === 0, 'both Forges are gone');

  const lpIds = byId(lp);
  // The three connectors that survive.
  for (const id of ['con_c', 'con_1', 'con_2'])
    ok(lpIds.has(id), `keeps connector ${id}`);
  ok(kinds(lp, 'connector').sort().join(',') === 'con_1,con_2,con_c',
     'exactly those three connectors remain — no other central scratch connectors');

  // Sources + receivers are environment, not pickables — all present, unchanged.
  ok(kinds(lp, 'source').join(',') === kinds(tg, 'source').join(','), 'all sources are kept');
  ok(kinds(lp, 'receiver').join(',') === kinds(tg, 'receiver').join(','), 'all receivers are kept');

  // Every removed id is a pickable or a Forge — nothing of geography vanished.
  const removed = [...byId(tg)].filter(id => !lpIds.has(id)).sort();
  const expectRemoved = ['acc_c','acc_e','con_3','con_4','con_5','forge_a','forge_b',
                         'inv_a','inv_b','jam_a','mine_a','mix_a','mix_b','rw_a'].sort();
  ok(JSON.stringify(removed) === JSON.stringify(expectRemoved),
     'removed set is exactly the central scratch pickables + both Forges');

  // No carriable scratch kinds linger in the central area.
  for (const k of ['inverter', 'mixer', 'accumulator', 'mine', 'rewirer', 'jammer'])
    ok(kinds(lp, k).length === 0, `no ${k} remains in Lorem's Puzzle #1`);
}

// ===========================================================================
// 4. Both levels solve cleanly (no throw) and are independent fresh worlds.
// ===========================================================================
{
  const a = LP.build();
  const b = LP.build();
  a.solve(true);
  b.solve(true);
  ok(a !== b && a.nodes !== b.nodes, 'each build() yields an independent world');
  ok(typeof a.engine.emit === 'object', "Lorem's Puzzle #1 solves without error");
}

console.log(`\nlevel tests: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
