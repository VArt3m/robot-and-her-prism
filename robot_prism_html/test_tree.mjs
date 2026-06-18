// Phase-2 state-machine test: the annulus press-and-hold targeting/programming
// tree. Drives the gesture timers directly (back-dating press/aim timestamps)
// and asserts each branch of the tree. Run: node test_tree.mjs
import { dist } from './js/core/geometry.js';
import { CONNECT_REACH } from './js/core/constants.js';
import { targetSpec } from './js/sim/targeting.js';

// --- minimal DOM mocks (same as the integration harness) ---
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

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL:', m); } };

const app = new App(canvas, statusEl());
function statusEl() { return { textContent: '' }; }
const w = app.world;

// --- helpers to drive the gesture machine deterministically ---
function clearHands() { w.carrying = null; w.carry_box = null; app.uiState.targeting = null; app._aim = null; app._press = null; app.uiState.menu = null; }
function holdInAnnulus(player, pressPt, mouse) {
  // place the player, start a press in the annulus, and aim the cursor
  w.player = [...player];
  app.uiState.mouse = [...(mouse || pressPt)];
  app._onMouseDown([...pressPt], {});
}
function elapse(ms) {                     // back-date the press + aim so `ms` has "passed"
  const past = performance.now() - ms;
  if (app._press) app._press.t = past;
  if (app._aim) app._aim.since = past;
}
function forceDecide() {                  // make the golden-arrow decision window expire now
  if (app._aim) app._aim.decideAt = performance.now() - 1;
}
const menuItem = (label) => (app.uiState.menu?.items || []).find(it => it.label === label);
function clickMenu(label) { const it = menuItem(label); ok(!!it, `menu has "${label}"`); if (it) { const [rx, ry, rw, rh] = it.rect; app._playClick(rx + rw / 2, ry + rh / 2); } }
function eHold() {            // simulate E held past the 1/3 s threshold
  app.input.carryHeldSince = performance.now() - 400;
  app._prevCarrySince = null;        // force "fresh press" bookkeeping
  app._carryConsumed = false;
  app._updateHoldMenu();
}
function eTap(mouse) {        // simulate a brief E press+release
  if (mouse) app.uiState.mouse = [...mouse];
  app.input.carryHeldSince = null;
  app._carryConsumed = false;
  app._handleAction('carry_release', performance.now());
}

// =========================================================================
// A — neither targeting nor programmable (box): the hold is swallowed.
// =========================================================================
clearHands();
w.carry_box = [300, 300];                 // carry a box (kind 'box')
holdInAnnulus([300, 300], [320, 300]);    // press 20px off her → annulus
ok(app._aim && app._aim.kind === 'box', 'A: aim-hold armed for the box');
elapse(400); app._updateGestures();
ok(app._aim === null, 'A: aim resolved');
ok(app._press && app._press.consumed === true, 'A: press consumed (release will not drop)');
ok(app.uiState.targeting === null && app.uiState.menu === null && !app._drag.active,
   'A: nothing happens — no targeting, no menu, no arrow');

// =========================================================================
// C — programmable only (mine): opens the programming chooser.
// =========================================================================
clearHands();
w.player = [430, 440];
ok(app._pickItem({ kind: 'mine', id: 'mine_a' }), 'C: picked up the mine');
holdInAnnulus([430, 440], [450, 440]);
elapse(400); app._updateGestures();
ok(app.uiState.menu && app.uiState.menu.items.some(it => it.act === 'program' && it.value === 5),
   'C: programming chooser (fuse) opened');
ok(app._aim === null && app._press.consumed, 'C: aim resolved + press consumed');
clickMenu('5s fuse');
ok(w.nodes['mine_a'].fuse === 5, 'C: selecting a value reprograms the fuse');
clearHands();

// =========================================================================
// B — targeting only (connector): golden arrow, then the ring decision.
// =========================================================================
// B-out: cursor leaves the ring during the window → keep drawing the arrow.
clearHands();
w.player = [445, 293];
ok(app._pickItem({ kind: 'connector', id: 'con_c' }), 'B: picked up the connector');
holdInAnnulus([445, 293], [465, 293]);
elapse(400); app._updateGestures();       // branch → launch arrow
ok(app._drag.active && app._drag.kind === 'wire', 'B: golden arrow launched at 1/3 s');
ok(app._aim && app._aim.decideAt, 'B: decision window armed');
app.uiState.mouse = [445 + 200, 293];     // pull the cursor OUT of the ring
forceDecide(); app._updateGestures();
ok(app._drag.active && app._drag.kind === 'wire', 'B-out: arrow keeps drawing when cursor left the ring');
ok(app.uiState.targeting === null, 'B-out: did not fall into click-by-click');
ok(app._aim === null, 'B-out: aim cleared');

// B-in: cursor stays in the ring → fall into click-by-click targeting.
clearHands();
w.player = [445, 293];
app._pickItem({ kind: 'connector', id: 'con_c' });
holdInAnnulus([445, 293], [465, 293]);
elapse(400); app._updateGestures();        // branch → arrow
app.uiState.mouse = [455, 293];            // cursor stays INSIDE the ring (dist 10)
forceDecide(); app._updateGestures();
ok(app.uiState.targeting && app.uiState.targeting.kind === 'connector', 'B-in: entered click-by-click targeting');
ok(!app._drag.active && app.uiState.wireDrag === null, 'B-in: arrow ended');
ok(Math.abs(w.nodes['con_c'].pos[0] - w.player[0]) < 1e-6, 'B-in: connector centred on the player');
// click a node → toggles a link (the intent)
const linksBefore = w.links.size;
app._playClick(w.nodes['con_1'].pos[0], w.nodes['con_1'].pos[1]);
ok(w.links.size === linksBefore + 1, 'B-in: clicking a node creates a link intent');
// a brief click on empty space (not a target) leaves the mode
app._playClick(700, 300);
ok(app.uiState.targeting === null, 'B-in: a click on empty space exits click-by-click');
ok(w.carrying === 'con_c', 'B-in: still carrying after the exit click');
clearHands();

// =========================================================================
// D — programmable + targeting (rewirer): Setup·Target menu, both branches.
// =========================================================================
// D with fields filled (colour=red) → decision opens the Setup/Target menu.
clearHands();
w.player = [520, 440];
ok(app._pickItem({ kind: 'rewirer', id: 'rw_a' }), 'D: picked up the rewirer');
ok(w.nodes['rw_a'].color === 'red', 'D: rewirer colour is set (not N/A)');
holdInAnnulus([520, 440], [540, 440]);
elapse(400); app._updateGestures();        // branch → arrow (fields filled)
ok(app._drag.active && app._drag.kind === 'wire', 'D: arrow launched (fields filled)');
app.uiState.mouse = [528, 440];            // stay inside the ring
forceDecide(); app._updateGestures();
ok(app.uiState.menu && menuItem('Setup') && menuItem('Target'), 'D: Setup·Target menu opened');
ok(!app._drag.active, 'D: arrow ended for the menu');
// choose Target → click-by-click
clickMenu('Target');
ok(app.uiState.targeting && app.uiState.targeting.kind === 'rewirer', 'D: Target → click-by-click targeting');
// the rewirer MARKS a target it has line of sight to, but does NOT recolour
// instantly — the recolour is deferred to deployment (phase 3/4).
w.player = [140, 90];
w.nodes['rw_a'].pos[0] = 140; w.nodes['rw_a'].pos[1] = 90;   // (centred on her while targeting)
w.nodes['rw_a'].color = 'blue';
const srcColorBefore = w.nodes['src_red'].color;
app._playClick(w.nodes['src_red'].pos[0], w.nodes['src_red'].pos[1]);
ok(w.nodes['src_red'].color === srcColorBefore, 'D: rewirer does NOT recolour instantly (effect deferred)');
ok(app.uiState.targeting && app.uiState.targeting.kind === 'rewirer', 'D: still targeting after marking');
app.uiState.targeting = null;
clearHands();

// D with a blank field (colour N/A) → programming fires first, no arrow.
clearHands();
w.player = [520, 440];
app._pickItem({ kind: 'rewirer', id: 'rw_a' });
w.nodes['rw_a'].color = null;              // force N/A
holdInAnnulus([520, 440], [540, 440]);
elapse(400); app._updateGestures();
ok(app.uiState.menu && app.uiState.menu.items.some(it => it.act === 'program' && it.value === 'red'),
   'D/NA: blank field fires the programming chooser first');
ok(!app._drag.active, 'D/NA: no arrow when a field is blank');
clickMenu('Green');
ok(w.nodes['rw_a'].color === 'green', 'D/NA: colour chooser sets the colour');
clearHands();

// =========================================================================
// Jammer — targeting only (B path), with a jam-target finder.
// =========================================================================
clearHands();
w.player = [470, 380];
ok(app._pickItem({ kind: 'jammer', id: 'jam_a' }), 'J: picked up the jammer');
holdInAnnulus([470, 380], [490, 380]);
elapse(400); app._updateGestures();
app.uiState.mouse = [478, 380];
forceDecide(); app._updateGestures();
ok(app.uiState.targeting && app.uiState.targeting.kind === 'jammer', 'J: jammer enters click-by-click');
const ffMid = w.ffs[0].mid();
ok(!!targetSpec('jammer').targetAt(w, 'jam_a', ffMid[0], ffMid[1]),
   'J: a force field is a valid jam target');
clearHands();

// brief click in the annulus is still a drop (no hold) ------------------------
clearHands();
w.player = [445, 293];
app._pickItem({ kind: 'connector', id: 'con_c' });
app._onMouseDown([465, 293], {});          // press in annulus
ok(app._aim, 'brief: aim-hold armed');
app._onMouseUp([465, 293], {});            // released quickly (no hold)
ok(app._aim === null, 'brief: aim cleared on release');
ok(w.carrying === null, 'brief: a quick click dropped the connector');

app._draw(); ok(true, 'render after the whole tree');

// =========================================================================
// Intent-ray deletion: a click on a ray erases it — while carrying a
// targeting device, or in click-by-click. Boxes (no intents) never erase.
// =========================================================================
const RAY_MID = [(w.nodes.con_1.pos[0] + w.nodes.con_2.pos[0]) / 2,
                 (w.nodes.con_1.pos[1] + w.nodes.con_2.pos[1]) / 2];

// carrying a connector → click on a ray erases it, and does NOT drop
clearHands();
w.links.clear(); w.toggle_link('con_1', 'con_2');
ok(w.links.size === 1, 'ray-delete: setup link con_1–con_2');
w.player = [470, 500]; w.carrying = 'con_c';
app._playClick(RAY_MID[0], RAY_MID[1]);
ok(w.links.size === 0, 'ray-delete: carrying a connector, a ray click erases the intent');
ok(w.carrying === 'con_c', 'ray-delete: erasing a ray does not drop the carried device');

// carrying a box → a ray click is not an eraser (boxes create no intents)
clearHands();
w.links.clear(); w.toggle_link('con_1', 'con_2');
w.player = [470, 500]; w.carry_box = [470, 500];
app._playClick(RAY_MID[0], RAY_MID[1]);
ok(w.links.size === 1, 'ray-delete: carrying a box, a ray click does not erase');

// click-by-click → node click links; a bare-ray click erases just that ray
clearHands();
w.links.clear();
w.player = [445, 293]; w.nodes.con_c.pos = [445, 293]; w.carrying = 'con_c';
app.uiState.targeting = { id: 'con_c', kind: 'connector' };
app._playClick(w.nodes.con_1.pos[0], w.nodes.con_1.pos[1]);   // node → create a link
ok(w.links.size === 1, 'ray-delete: in targeting, a node click creates a link');
w.toggle_link('con_1', 'con_2');                              // add a second ray
app._playClick(RAY_MID[0], RAY_MID[1]);                       // bare ray → erase just it
ok(!w.links.has(w._link_key('con_1', 'con_2')) && w.links.size === 1,
   'ray-delete: in targeting, a bare-ray click erases only that ray');
clearHands(); w.links.clear();

// =========================================================================
// Drop commits only inside the activation radius. A click (or a small
// attention-drag released) outside the ring must NOT drop the carried item.
// =========================================================================
clearHands(); w.links.clear();
w.player = [445, 293];
app._pickItem({ kind: 'connector', id: 'con_c' });
app._playClick(w.player[0] + 300, w.player[1]);     // far outside the ring
ok(w.carrying === 'con_c', 'drop-gate: a click outside the activation radius does not drop');
app._playClick(w.player[0] + 20, w.player[1]);      // inside the ring
ok(w.carrying === null, 'drop-gate: a click inside the activation radius drops');
clearHands(); w.links.clear();

// =========================================================================
// E as the operating tool — a ~1/3 s E hold mirrors the mouse tree (straight
// to the end state, no golden arrow); a brief E drops or exits targeting.
// =========================================================================
// targeting only (connector) → click-by-click directly, no arrow
clearHands();
w.player = [445, 293];
app._pickItem({ kind: 'connector', id: 'con_c' });
eHold();
ok(app.uiState.targeting && app.uiState.targeting.kind === 'connector', 'E/B: hold enters click-by-click');
ok(!app._drag.active, 'E/B: no golden arrow from an E hold');
// brief E exits targeting
eTap();
ok(app.uiState.targeting === null, 'E: a brief E exits click-by-click');
ok(w.carrying === 'con_c', 'E: still carrying after the exit tap');

// programmable only (mine) → programming chooser
clearHands();
w.player = [430, 440];
app._pickItem({ kind: 'mine', id: 'mine_a' });
eHold();
ok(app.uiState.menu && app.uiState.menu.items.every(it => it.act === 'program'), 'E/C: hold opens the fuse chooser');
app.uiState.menu = null;

// both (rewirer, filled) → Setup/Target menu
clearHands();
w.player = [520, 440];
app._pickItem({ kind: 'rewirer', id: 'rw_a' });
w.nodes['rw_a'].color = 'red';
eHold();
ok(app.uiState.menu && app.uiState.menu.items.some(i => i.act === 'setup') && app.uiState.menu.items.some(i => i.act === 'target'),
   'E/D: hold opens the Setup/Target menu');
app.uiState.menu = null;

// brief E while carrying (not targeting) drops
clearHands();
w.player = [445, 293];
app._pickItem({ kind: 'connector', id: 'con_c' });
eTap([w.player[0] + 15, w.player[1]]);
ok(w.carrying === null, 'E: a brief E drops the carried item');
clearHands(); w.links.clear();

// =========================================================================
// Jammer targeting — the two paths the player actually uses.
// =========================================================================

// Click-by-click: a click ANYWHERE along a gate segment marks it (not just the
// midpoint — that midpoint-only hit zone was the bug).
clearHands(); w.jam_links.clear();
w.player = [470, 380];
app._pickItem({ kind: 'jammer', id: 'jam_a' });
app._enterTargeting('jammer');
ok(app.uiState.targeting && app.uiState.targeting.kind === 'jammer', 'jammer entered click-by-click');
app._playClick(820, 380);                       // left end of ff_mid (786..1005), NOT its centre
ok(w.jam_links.get('jam_a') === 'ff_mid', 'click-by-click: a click on the gate body marks the gate');

// Re-marking a different gate overwrites (one intent, last wins).
app._playClick(820, 250);                       // ff_top
ok(w.jam_links.get('jam_a') === 'ff_top' && w.jam_links.size === 1, 'click-by-click: re-mark overwrites');
clearHands(); w.jam_links.clear();

// A click on empty space (no gate / mine / ray) leaves targeting.
w.player = [470, 380];
app._pickItem({ kind: 'jammer', id: 'jam_a' });
app._enterTargeting('jammer');
app._playClick(470, 200);                        // nothing there
ok(app.uiState.targeting === null, 'click-by-click: an empty click exits targeting');
clearHands(); w.jam_links.clear();

// Golden arrow: a wire-drag sweep onto a gate marks it.
w.player = [470, 380];
app._pickItem({ kind: 'jammer', id: 'jam_a' });
app._startAimArrow();
ok(app._drag.active && app._drag.kind === 'wire', 'golden arrow: wire drag armed for the jammer');
app._onMouseMove([820, 380], {});                // arrow tip swept onto ff_mid
ok(w.jam_links.get('jam_a') === 'ff_mid', 'golden arrow: sweeping onto a gate marks it');
app._onMouseUp([820, 380], {});
ok(w.jam_links.get('jam_a') === 'ff_mid', 'golden arrow: the mark survives release');
clearHands(); w.jam_links.clear();

// Golden arrow onto a mine marks the mine too.
w.player = [470, 380];
app._pickItem({ kind: 'jammer', id: 'jam_a' });
app._startAimArrow();
app._onMouseMove([430, 440], {});                // mine_a sits at (430,440)
ok(w.jam_links.get('jam_a') === 'mine_a', 'golden arrow: sweeping onto a mine marks it');
app._onMouseUp([430, 440], {});
clearHands(); w.jam_links.clear();

// A carried jammer dragged over a connector must NOT spray light links.
w.player = [445, 293];
app._pickItem({ kind: 'jammer', id: 'jam_a' });
app.uiState.sel = 'jam_a';
app._drag = { active: true, kind: 'player', ref: null, moved: false, linkHit: null,
              preSnap: app._captureState(), preSig: app._sig(), committed: false };
const jamLinksBefore = w.links.size;
app._onMouseMove([445, 293], {});                // dragged onto con_c's spot
ok(w.links.size === jamLinksBefore, 'a carried jammer never auto-wires light links');
clearHands(); w.links.clear(); w.jam_links.clear();
app._drag = { active: false, kind: null, ref: null, moved: false, linkHit: null };

// Regression: the connector golden arrow still toggles a light link.
w.player = [445, 293];
app._pickItem({ kind: 'connector', id: 'con_c' });
app._startAimArrow();
app._onMouseMove(w.nodes['src_g1'].pos.slice(), {});   // sweep onto a source
ok(w.links.has(w._link_key('con_c', 'src_g1')), 'connector golden arrow still links nodes');
app._onMouseUp(w.nodes['src_g1'].pos.slice(), {});
clearHands(); w.links.clear(); w.jam_links.clear();

// =========================================================================
// C clears the carried targeting device's intents — connector links AND a
// jammer's jam mark, in both carrying and click-by-click modes.
// =========================================================================
clearHands(); w.links.clear(); w.jam_links.clear();

// Jammer, plain carrying.
w.player = [470, 380];
app._pickItem({ kind: 'jammer', id: 'jam_a' });
w.set_jam('jam_a', 'ff_mid');
app._handleAction('clear', performance.now());
ok(!w.jam_links.has('jam_a'), 'C clears a carried jammer\u2019s jam mark');
clearHands(); w.jam_links.clear();

// Jammer, in click-by-click.
w.player = [470, 380];
app._pickItem({ kind: 'jammer', id: 'jam_a' });
app._enterTargeting('jammer');
w.set_jam('jam_a', 'ff_top');
app._handleAction('clear', performance.now());
ok(!w.jam_links.has('jam_a'), 'C clears the jam mark in click-by-click too');
clearHands(); w.jam_links.clear();

// Connector regression: C still clears its light links.
w.player = [445, 293];
app._pickItem({ kind: 'connector', id: 'con_c' });
w.toggle_link('con_c', 'src_g1');
ok(w.links.size === 1, 'connector has a link to clear');
app._handleAction('clear', performance.now());
ok(w.links.size === 0, 'C still clears a carried connector\u2019s links');
clearHands(); w.links.clear(); w.jam_links.clear();

// A no-target device (a mine) ignores C without error.
w.player = [430, 440];
app._pickItem({ kind: 'mine', id: 'mine_a' });
app._handleAction('clear', performance.now());
ok(w.carrying === 'mine_a', 'C is a harmless no-op for a non-targeting device');
clearHands();

console.log(`\ntree tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
