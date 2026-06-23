// Regression test for the long-standing self-occlusion FLICKER.
//
// When the robot dwells in a beam she becomes a blocker and the beam is cut at
// her body. The auto-block is engaged by `player_touching_beam()`. The bug: that
// test used to measure the player against the player-CUT beam, whose end sits at
// her near edge — for an off-centre / diagonal hit that endpoint is farther than
// BEAM_TOUCH from her centre, so "touching" flipped to false once the block had
// retracted the beam, dropping the block and restoring the beam → a position-
// dependent blink. The fix judges "on the beam" against the beam's player-
// INDEPENDENT length (hard_mat), so engaging the block can't disengage it.
//
// Run: node test_player_block.mjs
import { World } from '../js/sim/world.js';
import { Node } from '../js/core/entities.js';
import { BEAM_TOUCH, PLAYER_R } from '../js/core/constants.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL:', m); } };

// Distance from p to segment a->b (local copy, so the test is self-contained).
function ptSeg(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L2 = dx * dx + dy * dy;
  const t = L2 < 1e-9 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

// A charged accumulator (a portable rank-0 source) wired straight to a matching
// receiver gives one clean beam with no other obstacles.
function scene(srcPos, rcvPos, playerPos) {
  const w = new World(); w._uid = 1;
  w.add(new Node('src', 'accumulator', srcPos, { color: 'red' }));
  w.add(new Node('rcv', 'receiver',    rcvPos, { color: 'red' }));
  w.toggle_link('src', 'rcv');
  w.player = [...playerPos];
  w.solve(true, false);
  return w;
}

const srcBeam = (w) => w.engine._last_beams_t.find(b => b.o === 'src');

// ---------------------------------------------------------------------------
// 1. The reproducer: player a few px OFF the beam centreline (still within the
//    touch band). Disengaged -> on the beam. Engage the block -> STILL on the
//    beam (stable), even though the beam is now genuinely cut short at her edge.
// ---------------------------------------------------------------------------
{
  const w = scene([100, 300], [400, 300], [250, 305]);   // 5px below the y=300 beam
  ok(w.player_touching_beam(), 'reproducer: on the beam before the block engages');

  w.player_block = true;
  w.solve(false, false);
  const b = srcBeam(w);
  ok(b && b.hard < b.dl - 1e-6, `block is real - beam cut to hard=${b ? Math.round(b.hard) : '?'} (< dl=${b ? Math.round(b.dl) : '?'})`);
  ok(w.player_touching_beam(), 'reproducer: STILL on the beam after the block engages (no flicker)');
  const cutEnd = [b.O[0] + b.dx * b.hard, b.O[1] + b.dy * b.hard];
  ok(ptSeg(w.player, b.O, cutEnd) > BEAM_TOUCH,
     'witness: the old player-cut test would have dropped it here');
  const matEnd = [b.O[0] + b.dx * b.hard_mat, b.O[1] + b.dy * b.hard_mat];
  ok(ptSeg(w.player, b.O, matEnd) < BEAM_TOUCH, 'fix: material-length test keeps her on the beam');
}

// ---------------------------------------------------------------------------
// 2. Centred hit was always stable - confirm the fix keeps it stable.
// ---------------------------------------------------------------------------
{
  const w = scene([100, 300], [400, 300], [250, 300]);
  ok(w.player_touching_beam(), 'centred: on the beam before block');
  w.player_block = true;
  w.solve(false, false);
  ok(w.player_touching_beam(), 'centred: still on the beam after block');
}

// ---------------------------------------------------------------------------
// 3. Stepping clear must still release: a player well outside the touch band is
//    NOT on the beam, whether or not the block flag is set.
// ---------------------------------------------------------------------------
{
  const off = 300 + PLAYER_R + BEAM_TOUCH + 6;
  const w = scene([100, 300], [400, 300], [250, off]);
  ok(!w.player_touching_beam(), 'off-beam: not touching (block would release)');
  w.player_block = true;
  w.solve(false, false);
  ok(!w.player_touching_beam(), 'off-beam: still not touching after a stale block flag');
}

// ---------------------------------------------------------------------------
// 4. A diagonal beam (the geometry most prone to the corner-distance blink):
//    45 deg from a charged accumulator to a receiver, player just off the line.
// ---------------------------------------------------------------------------
{
  const w = scene([100, 100], [400, 400], [253, 247]);   // ~4px off the y=x line
  ok(w.player_touching_beam(), 'diagonal: on the beam before block');
  w.player_block = true;
  w.solve(false, false);
  const b = srcBeam(w);
  ok(b && b.hard < b.dl - 1e-6, 'diagonal: block is real (beam cut)');
  ok(w.player_touching_beam(), 'diagonal: still on the beam after block (no flicker)');
}

console.log(`\nplayer-block (self-occlusion) tests: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
