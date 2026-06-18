// Headless checks for the carried-item placement shadow.
// Run: node test_placement.mjs
import { build_level } from '../js/sim/level.js';
import { PLAYER_R, CONN_R, BOX_R, CONNECT_REACH } from '../js/core/constants.js';
import { dist } from '../js/core/geometry.js';

let pass = 0, fail = 0;
const ok  = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };

// Replicates the UI-side ground-resolve: aim a unit vector at `aim`, ask the
// sim for a legal, reachable spot. (Box-snap classification lives in app.js;
// here we exercise the part that carries the legality/reach guarantee.)
function resolveGround(w, aim, r, ignoreConn) {
  const P = w.player;
  const gap = PLAYER_R + r + 2;
  const maxD = Math.max(gap, CONNECT_REACH - 1);
  let dx = aim[0]-P[0], dy = aim[1]-P[1];
  let d = Math.hypot(dx, dy) || 1;
  return w.placement_spot(P, dx/d, dy/d, r, gap, maxD, d, ignoreConn);
}

function spotIsLegalAndReachable(w, spot, r, ignoreConn) {
  return !w.object_pos_blocked(spot, r, { ignoreConn }) && !w.reach_blocked(w.player, spot);
}

// ---- 1. Connector placement in open space is always legal + reachable ----
{
  const w = build_level();
  w.carrying = 'con_c';
  w.nodes['con_c'].elevated = false;
  // Sweep aim around the player in the open area near the start.
  let resolved = 0;
  for (let a = 0; a < 360; a += 15) {
    const rad = a * Math.PI/180;
    const aim = [w.player[0] + Math.cos(rad)*60, w.player[1] + Math.sin(rad)*60];
    const spot = resolveGround(w, aim, CONN_R, 'con_c');
    if (spot) {
      resolved++;
      ok(spotIsLegalAndReachable(w, spot, CONN_R, 'con_c'),
         `connector spot at aim ${a}° not legal/reachable: ${spot}`);
      ok(dist(w.player, spot) <= CONNECT_REACH - 1 + 1e-6,
         `connector spot at aim ${a}° outside reach: d=${dist(w.player, spot).toFixed(1)}`);
    }
  }
  ok(resolved >= 20, `expected most aim angles to resolve in the open, got ${resolved}/24`);
}

// ---- 2. Aiming across the tan barrier clamps to the near side ----
{
  const w = build_level();
  w.carrying = 'con_c';
  // Stand just left of the tan barrier (x ~ 782) and aim far to its right.
  w.player = [760, 300];
  const aim = [900, 300];                 // straight through the barrier
  const spot = resolveGround(w, aim, CONN_R, 'con_c');
  ok(spot !== null, 'expected a near-side spot when aiming across the barrier');
  if (spot) {
    ok(spot[0] < 782, `spot should stay left of the barrier (x<782), got x=${spot[0].toFixed(1)}`);
    ok(!w.reach_blocked(w.player, spot), 'clamped spot must have a clear straight line');
    ok(spotIsLegalAndReachable(w, spot, CONN_R, 'con_c'), 'clamped spot must be fully legal');
  }
}

// ---- 3. Never returns a spot whose path crosses a wall (left wall x=237) ----
{
  const w = build_level();
  w.carrying = 'con_c';
  w.player = [250, 560];                  // just right of the lower-left wall
  const aim = [200, 560];                 // through the wall to its left
  const spot = resolveGround(w, aim, CONN_R, 'con_c');
  // Either no spot, or a spot on the reachable side with a clear line.
  if (spot) ok(!w.reach_blocked(w.player, spot),
               `spot across wall has blocked line: ${spot}`);
  ok(true, 'wall test executed');
}

// ---- 4. Box placement spot keeps clear of the existing box ----
{
  const w = build_level();
  w.carry_box = [0,0];                    // pretend we lifted a box
  w.player = [540, 500];                  // near the level's box at [580,500]
  const aim = [580, 500];                 // aim right at the existing box
  const spot = resolveGround(w, aim, BOX_R, null);
  ok(spot !== null, 'expected a legal box spot near the existing box');
  if (spot) {
    ok(dist(spot, [580,500]) >= 2*BOX_R - 2 - 1e-6,
       `placed box overlaps existing box: gap=${dist(spot,[580,500]).toFixed(1)}`);
    ok(spotIsLegalAndReachable(w, spot, BOX_R, null), 'box spot must be legal/reachable');
  }
}

// ---- 5. Resolved spot never overlaps the player ----
{
  const w = build_level();
  w.carrying = 'con_c';
  for (let a = 0; a < 360; a += 30) {
    const rad = a*Math.PI/180;
    const aim = [w.player[0]+Math.cos(rad)*5, w.player[1]+Math.sin(rad)*5]; // aim ON her
    const spot = resolveGround(w, aim, CONN_R, 'con_c');
    if (spot) ok(dist(w.player, spot) >= PLAYER_R + CONN_R + 2 - 1e-6,
                 `spot overlaps player at aim ${a}°: d=${dist(w.player,spot).toFixed(1)}`);
  }
}

console.log(`\nplacement tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
