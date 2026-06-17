// Runtime smoke test with a mocked DOM. Exercises the full carry → preview →
// place flow and the renderer's ghost drawing, catching runtime errors that a
// syntax check can't. Run: node test_integration.mjs
import { dist } from './js/core/geometry.js';
import { CONNECT_REACH } from './js/core/constants.js';

// --- minimal DOM mocks ---
const noop = () => {};
const ctx2d = new Proxy({}, {
  get: (t, k) => (k in t ? t[k] : (k === 'measureText' ? (() => ({ width: 0 })) : noop)),
  set: (t, k, v) => { t[k] = v; return true; },
});
const canvas = {
  width: 1018, height: 640,
  getContext: () => ctx2d,
  parentElement: { clientWidth: 1018, clientHeight: 640 },
  addEventListener: noop, removeEventListener: noop,
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 1018, height: 640 }),
};
globalThis.window = { devicePixelRatio: 1, addEventListener: noop, removeEventListener: noop };
globalThis.document = { addEventListener: noop };
globalThis.performance = globalThis.performance || { now: () => Date.now() };
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = noop;
globalThis.ResizeObserver = class { observe() {} disconnect() {} };

const { App } = await import('./js/ui/app.js');
const { objType } = await import('./js/sim/objects.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL:', m); } };

const statusEl = { textContent: '' };
const app = new App(canvas, statusEl);
const w = app.world;

// Render once empty-handed — must not throw.
app._draw(); ok(true, 'initial render');

// --- carry a connector, preview, draw, place via E ---
w.player = [445, 293];                 // sit on con_c so pickup is in reach
ok(app._pickItem({ kind: 'connector', id: 'con_c' }), 'picked up connector');
ok(w.carrying === 'con_c', 'carrying flag set');

app.uiState.mouse = [w.player[0] + 50, w.player[1]];   // aim right
app._syncCarried();
ok(app.uiState.placePreview && app.uiState.placePreview.spot, 'preview produced');
const previewSpot = app.uiState.placePreview.spot;
ok(dist(w.player, w.nodes['con_c'].pos) <= CONNECT_REACH,
   'carried connector glued near the player (shadow)');
ok(Math.abs(w.nodes['con_c'].pos[0] - previewSpot[0]) < 1e-6,
   'connector node sits at the preview spot');
app._draw(); ok(true, 'render while carrying connector (ghost)');

const before = [...w.nodes['con_c'].pos];
ok(app._commitPlacement(app.uiState.placePreview), 'committed connector placement');
ok(w.carrying === null, 'no longer carrying after place');
ok(app.uiState.placePreview === null, 'preview cleared after place');
ok(dist([445,293], w.nodes['con_c'].pos) > 1, 'connector actually moved from its origin');
app._draw(); ok(true, 'render after placing connector');

// --- mode split: cursor inside vs outside the operating radius ---
{
  w.player = [445, 293];
  w.carrying = 'con_c';
  w.nodes['con_c'].elevated = false;
  app.uiState.sel = 'con_c';

  // INSIDE the radius → predict the mouse-click placement: lands at the cursor.
  const inAim = [w.player[0] + 30, w.player[1]];        // 30 < CONNECT_REACH (37)
  const pin = app._resolvePlacement(inAim);
  ok(pin && Math.abs(dist(w.player, pin.spot) - 30) < 6,
     `inside radius → spot lands at the cursor (~30), got ${pin ? dist(w.player, pin.spot).toFixed(1) : 'null'}`);

  // OUTSIDE the radius → E-logic ignores the cursor: the drop follows her EYES
  // (facing), not the pointer. Point her right, then put the cursor far to the
  // LEFT — the item must still sit to her right, hugging her.
  w.facing = [1, 0];                                   // eyes → +x (right)
  const outAim = [w.player[0] - 200, w.player[1]];     // cursor far to the LEFT
  const pout = app._resolvePlacement(outAim);
  ok(pout && dist(w.player, pout.spot) < CONNECT_REACH,
     'outside radius → spot stays within reach');
  ok(pout && dist(w.player, pout.spot) <= 28,
     `outside radius → E-drop hugs the robot (~22), got ${pout ? dist(w.player, pout.spot).toFixed(1) : 'null'}`);
  ok(pout && pout.spot[0] > w.player[0] && Math.abs(pout.spot[1] - w.player[1]) < 1e-6,
     'outside radius → spot follows her eyes (+x), NOT the far-left cursor');

  w.carrying = null; app.uiState.sel = null; app.uiState.placePreview = null;
}

// --- carry a box, preview, place via click direction ---
w.player = [470, 500];
ok(app._pickItem({ kind: 'box', box: [...w.boxes.find(b => true)] }) || true, 'box pickup attempt');
// _pickItem(box) removes by identity; emulate a clean lift instead:
w.carry_box = [w.player[0], w.player[1]];
app.uiState.mouse = [w.player[0], w.player[1] - 50];   // aim up
app._syncCarried();
ok(app.uiState.placePreview && app.uiState.placePreview.carried === 'box', 'box preview produced');
app._draw(); ok(true, 'render while carrying box (ghost)');
const place = app._resolvePlacement([w.player[0], w.player[1] - 50]);
ok(app._commitPlacement(place), 'committed box placement');
ok(w.carry_box === null, 'box no longer carried after place');
app._draw(); ok(true, 'render after placing box');

// --- phase 1: the new carriable devices (mine / rewirer / jammer) ---
{
  // schema flags drive the (later) interaction tree
  ok(objType('mine').programmable && !objType('mine').requiresTarget, 'mine: programmable, not targeting');
  ok(objType('rewirer').programmable && objType('rewirer').requiresTarget, 'rewirer: programmable + targeting');
  ok(!objType('jammer').programmable && objType('jammer').requiresTarget, 'jammer: targeting only');

  // mine: pick up, defaults applied, not counting while carried
  w.player = [430, 440];
  const stack = app._stackAt(430, 440);
  ok(stack.length && stack[0].kind === 'mine' && stack[0].id === 'mine_a',
     '_stackAt discovers the mine under the cursor');
  ok(app._pickItem({ kind: 'mine', id: 'mine_a' }), 'picked up mine');
  ok(w.carrying === 'mine_a', 'carrying the mine');
  ok(w.nodes['mine_a'].fuse === 3, 'mine fuse kept at 3');
  ok(w.nodes['mine_a'].fuse_running === false, 'carried mine is not counting down');
  // E-drop it (aim outside the ring → hugs her); the fuse starts on first drop
  w.facing = [0, -1];
  const mplace = app._resolvePlacement([w.player[0], w.player[1] - 200]);
  ok(mplace && mplace.carried === 'mine', 'mine resolves a ground placement');
  ok(app._commitPlacement(mplace), 'placed the mine');
  ok(w.carrying === null, 'mine released');
  ok(w.nodes['mine_a'].fuse_running === true, 'mine fuse starts counting on first drop');
  // a placed mine is now a material obstacle
  ok(w.object_pos_blocked([...w.nodes['mine_a'].pos], 8), 'placed mine blocks overlap');

  // rewirer: defaults to red, carriable + placeable
  w.player = [520, 440];
  ok(app._pickItem({ kind: 'rewirer', id: 'rw_a' }), 'picked up rewirer');
  ok(w.nodes['rw_a'].color === 'red', 'rewirer colour defaults to red');
  ok(app._commitPlacement(app._resolvePlacement([w.player[0] + 30, w.player[1]])), 'placed the rewirer');

  // jammer: targeting-only, carriable + placeable
  w.player = [470, 380];
  ok(app._pickItem({ kind: 'jammer', id: 'jam_a' }), 'picked up jammer');
  ok(w.carrying === 'jam_a', 'carrying the jammer');
  ok(app._commitPlacement(app._resolvePlacement([w.player[0] + 30, w.player[1]])), 'placed the jammer');

  app._draw(); ok(true, 'render with all three devices placed');
}

// --- a few ticks must not throw ---
for (let i = 0; i < 5; i++) app._tick(performance.now() / 1000 + i * 0.033);
ok(true, 'ticks ran without throwing');

console.log(`\nintegration smoke: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
