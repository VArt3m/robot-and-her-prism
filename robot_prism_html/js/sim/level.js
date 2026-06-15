import { Node, Wall, Barrier, ForceField } from '../core/entities.js';
import { World } from './world.js';

export function build_level() {
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

  w.add(new Node('con_c', 'connector', [445,293], { label:'C' }));
  w.add(new Node('con_1', 'connector', [845,590], { label:'1' }));
  w.add(new Node('con_2', 'connector', [915,590], { label:'2' }));

  w.goal = [840, 70];
  w.player_start = [470, 500];
  w.player = [...w.player_start];
  w._uid = 100;
  w.solve(true);
  return w;
}
