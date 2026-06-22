import { Node, Wall, Barrier, ForceField } from '../core/entities.js';
import { World } from './world.js';
import { FORGE_USES_DEFAULT } from '../core/constants.js';

// The playfield is built from one shared geography + environment. The two levels
// differ ONLY in their loose contents:
//
//   Test Grounds      — the full sandbox: every scratch relay/gadget and both
//                       Forges, for trying things out.
//   Lorem's Puzzle #1 — the same room, MINUS both Forges and MINUS the central
//                       scratch pickables, keeping just one central connector
//                       (con_c) plus the two connectors already standing in the
//                       lower-right room behind the force field (con_1, con_2).
//                       Nothing else is removed — geography, sources, receivers,
//                       force fields, barriers and goal are identical.
//
// `scratch` gates exactly the loose pickables + Forges, so Test Grounds is the
// builder with scratch ON and Lorem's is the same builder with scratch OFF; the
// shared, always-present part is the single source of truth for the geography.
function build_world(scratch) {
  const w = new World();
  const [L, T, R, B] = [12, 12, 1006, 628];
  w.walls.push(
    new Wall([L,T],[R,T]), new Wall([R,T],[R,B]),
    new Wall([R,B],[L,B]), new Wall([L,B],[L,T]),
    new Wall([235,13],[235,138]), new Wall([237,490],[237,628]),
  );

  w.add(new Node('src_red',  'source', [140,55],  { color:'red' }));
  w.add(new Node('src_g1',   'source', [40,222],  { color:'green' }));
  w.add(new Node('src_g2',   'source', [40,425],  { color:'green' }));
  w.add(new Node('src_blue', 'source', [130,595], { color:'blue' }));

  w.ffs.push(new ForceField('ff_top', [786,250],[1005,250]));
  w.ffs.push(new ForceField('ff_mid', [786,380],[1005,380]));
  w.ffs.push(new ForceField('ff_bot', [786,512],[1005,512]));

  w.add(new Node('rcv_green', 'receiver', [988,195], { color:'green', fill_time:1.0 }));
  w.add(new Node('rcv_blue',  'receiver', [988,305], { color:'blue',  fill_time:1.0 }));
  w.add(new Node('rcv_red',   'receiver', [988,440], { color:'red',   fill_time:1.0 }));
  w.add(new Node('rcv_dead',  'receiver', [24,305],  { color:'green', fill_time:1.0 }));

  w.logic_links.push(
    ['rcv_green', 'ff_top', false],
    ['rcv_blue',  'ff_mid', false],
    ['rcv_red',   'ff_bot', false],
  );

  w.barriers.push(new Barrier([782,13],[782,510],  'tan'));
  w.barriers.push(new Barrier([786,510],[786,628], 'purple'));

  // Kept in BOTH levels: one central connector (con_c) and the two connectors
  // standing in the lower-right room behind the force field (con_1, con_2).
  w.add(new Node('con_c', 'connector', [445,293], { label:'C' }));
  w.add(new Node('con_1', 'connector', [845,590], { label:'1' }));
  if (scratch) {
    // An inverter (sister of the connector): clean, swapping red↔blue by default.
    w.add(new Node('inv_a', 'inverter', [660,293], { label:'I' }));
  }
  w.add(new Node('con_2', 'connector', [915,590], { label:'2' }));

  if (scratch) {
    // Three more plain connectors scattered in open space — scratch parts for testing.
    w.add(new Node('con_3', 'connector', [350,165], { label:'3' }));
    w.add(new Node('con_4', 'connector', [560,175], { label:'4' }));
    w.add(new Node('con_5', 'connector', [300,360], { label:'5' }));

    // One more inverter and one more mixer, also for testing — same clean defaults
    // as their originals (inverter swaps red<->blue; mixer in 'blend' mode).
    w.add(new Node('inv_b', 'inverter', [700,180], { label:'J' }));
    w.add(new Node('mix_b', 'mixer',    [680,440], { label:'Y', mode:'blend' }));

    // Two accumulators (portable sources) for testing: one empty (wire a single
    // colour to it for ~2s to charge it), one pre-charged blue.
    w.add(new Node('acc_e', 'accumulator', [640,255], { color:null }));
    w.add(new Node('acc_c', 'accumulator', [770,255], { color:'blue' }));

    w.boxes.push([580, 500]);   // test box in the open area near the player start

    // Programmable / targeting devices (phase 1: real, carriable, placeable) — a
    // cluster near the player start to pick up and try.
    w.add(new Node('mine_a', 'mine',    [430, 440], { fuse: 3 }));
    w.add(new Node('rw_a',   'rewirer', [520, 440], { color: 'red' }));
    w.add(new Node('jam_a',  'jammer',  [470, 380]));
    // A mixer (another relay sister): clean, in its default 'blend' form (sums its
    // inputs to a secondary). Sits with the other gadgets so it's easy to grab,
    // wire to two colours, and test — reprogram it to 'whiten' at a Forge.
    w.add(new Node('mix_a',  'mixer',   [590, 380], { label:'X', mode:'blend' }));

    // Two Forges, bottom-centre, clear of the existing beams. forge_a is a normal
    // (corrupting) station; forge_b is clean-only (corrupts:false) — it can strip a
    // connector's corruption but never impose one, and wears a cooler rim to say so.
    // They sit 129 px apart: more than one FORGE_REACH (111) so each centre is a
    // sole-Forge zone you can program at, but less than two (222) so their control
    // areas overlap in the middle — and in that overlap programming is unavailable.
    w.add(new Node('forge_a', 'forge', [509, 600], { uses: FORGE_USES_DEFAULT }));
    w.add(new Node('forge_b', 'forge', [380, 600], { uses: FORGE_USES_DEFAULT, corrupts: false }));
  }

  w.goal = [840, 70];
  w.player_start = [470, 500];
  w.player = [...w.player_start];
  w._uid = 100;
  w.solve(true);
  return w;
}

// The level registry. Registry ORDER is what the player sees: the first entry
// loads at startup and sits first in the level-select menu — that is Lorem's
// Puzzle #1. `build_level()` is kept as a back-compat helper that still returns
// Test Grounds (the full sandbox), because the headless placement/highlight
// suites build from it to get the scratch gadgets; it is NOT the startup level.
export const LEVELS = [
  { id: 'lorem_1',      name: "Lorem's Puzzle #1", build: () => build_world(false) },
  { id: 'test_grounds', name: 'Test Grounds',      build: () => build_world(true)  },
];

export function build_level() {
  return build_world(true);
}
