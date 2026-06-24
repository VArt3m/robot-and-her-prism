// State-machine test: the annulus press-and-hold gesture (the golden-arrow
// wiring — programming lives at the Forge, and click-by-click targeting was
// removed in favour of a plain click on a target while carrying) plus the Forge
// programming gateway. Drives the gesture timers directly (back-dating
// press/aim timestamps) and asserts each branch. Run: node test_tree.mjs
import { dist } from '../js/core/geometry.js';
import { CONNECT_REACH } from '../js/core/constants.js';
import { targetSpec } from '../js/sim/targeting.js';

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

const { App } = await import('../js/ui/app.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL:', m); } };

const app = new App(canvas, statusEl());
function statusEl() { return { textContent: '' }; }
// Startup now lands on Lorem's Puzzle #1; this suite drives the full sandbox,
// so switch to Test Grounds explicitly.
app._loadLevel('test_grounds');
const w = app.world;

// --- helpers to drive the gesture machine deterministically ---
function clearHands() { w.carrying = null; w.carry_box = null; app._aim = null; app._press = null; app.uiState.menu = null; }
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
ok(app.uiState.menu === null && !app._drag.active,
   'A: nothing happens — no menu, no arrow');

// =========================================================================
// C — programmable only (mine): the hold is SWALLOWED. Programming has moved to
// the Forge (F), so a hold no longer opens a chooser — it behaves like a box.
// =========================================================================
clearHands();
w.player = [430, 440];
ok(app._pickItem({ kind: 'mine', id: 'mine_a' }), 'C: picked up the mine');
holdInAnnulus([430, 440], [450, 440]);
elapse(400); app._updateGestures();
ok(app.uiState.menu === null && !app._drag.active,
   'C: a hold on a programmable-only device does nothing (no chooser)');
ok(app._aim === null && app._press.consumed, 'C: aim resolved + press consumed');
clearHands();

// =========================================================================
// B — targeting device (connector): a hold launches the golden arrow, which
// then keeps drawing until release — there is NO in-ring decision / click-by-
// click mode anymore (whether the cursor stays in or leaves the ring).
// =========================================================================
// B-out: cursor leaves the ring → the arrow keeps drawing.
clearHands();
w.player = [445, 293];
ok(app._pickItem({ kind: 'connector', id: 'con_c' }), 'B: picked up the connector');
holdInAnnulus([445, 293], [465, 293]);
elapse(400); app._updateGestures();       // branch → launch arrow
ok(app._drag.active && app._drag.kind === 'wire', 'B: golden arrow launched at 1/3 s');
ok(app._aim === null, 'B: aim resolved at launch (no decision window)');
app.uiState.mouse = [445 + 200, 293];     // pull the cursor OUT of the ring
app._updateGestures();
ok(app._drag.active && app._drag.kind === 'wire', 'B-out: arrow keeps drawing when cursor left the ring');

// B-in: cursor stays in the ring → the arrow STILL keeps drawing (no mode).
clearHands();
w.player = [445, 293];
app._pickItem({ kind: 'connector', id: 'con_c' });
holdInAnnulus([445, 293], [465, 293]);
elapse(400); app._updateGestures();        // branch → arrow
app.uiState.mouse = [455, 293];            // cursor stays INSIDE the ring (dist 10)
app._updateGestures();
ok(app._drag.active && app._drag.kind === 'wire', 'B-in: arrow keeps drawing even inside the ring');
ok(app.uiState.menu === null, 'B-in: no chooser / mode opened');
app._onMouseUp([455, 293], {});            // release ends the arrow
clearHands();

// B-click: plain carrying (no hold) — a click on a node MAKES the link intent,
// a second click on it toggles it OFF, and links ignore distance (a click on the
// far node still wires it). con_1 is left where it is so later tests are clean.
clearHands(); w.links.clear();
w.player = [445, 293]; w.nodes['con_c'].pos = [445, 293]; w.carrying = 'con_c';
const b1 = w.nodes['con_1'].pos;
ok(!w.links.has(w._link_key('con_c', 'con_1')), 'B-click: no link before clicking');
app._playClick(b1[0], b1[1]);                            // click the target node
ok(w.links.has(w._link_key('con_c', 'con_1')), 'B-click: clicking a node makes the link intent');
ok(w.carrying === 'con_c', 'B-click: making an intent does not drop the device');
app._playClick(b1[0], b1[1]);                            // click it again → toggle off
ok(!w.links.has(w._link_key('con_c', 'con_1')), 'B-click: clicking a linked node toggles the intent off');
clearHands(); w.links.clear();

// =========================================================================
// D — programmable + targeting (rewirer): a hold launches the arrow (no Setup/
// Target menu, no programming-first branch — programming is at a Forge), and a
// plain click on a target MARKS the recolour (deferred, never instant).
// =========================================================================
clearHands();
w.player = [520, 440];
ok(app._pickItem({ kind: 'rewirer', id: 'rw_a' }), 'D: picked up the rewirer');
holdInAnnulus([520, 440], [540, 440]);
elapse(400); app._updateGestures();        // branch → arrow
ok(app._drag.active && app._drag.kind === 'wire', 'D: a hold launches the golden arrow');
ok(app.uiState.menu === null, 'D: no Setup/Target menu anymore');
app._onMouseUp([540, 440], {});
// the rewirer MARKS a target it has line of sight to, but does NOT recolour
// instantly — the recolour is deferred to deployment.
clearHands();
w.player = [140, 90];
app._pickItem({ kind: 'rewirer', id: 'rw_a' });
w.nodes['rw_a'].pos[0] = 140; w.nodes['rw_a'].pos[1] = 90;   // (centred on her while carrying)
w.nodes['rw_a'].color = 'blue';
const srcColorBefore = w.nodes['src_red'].color;
app._playClick(w.nodes['src_red'].pos[0], w.nodes['src_red'].pos[1]);
ok(w.nodes['src_red'].color === srcColorBefore, 'D: rewirer does NOT recolour instantly (effect deferred)');
ok(w.recolor_links.get('rw_a') === 'src_red', 'D: the click marks the recolour target');
ok(w.carrying === 'rw_a', 'D: still carrying after marking');
clearHands(); w.recolor_links.clear();

// Even with a blank colour, a hold still just launches the arrow (no chooser).
clearHands();
w.player = [520, 440];
app._pickItem({ kind: 'rewirer', id: 'rw_a' });
w.nodes['rw_a'].color = null;              // blank — used to force a chooser
holdInAnnulus([520, 440], [540, 440]);
elapse(400); app._updateGestures();
ok(app._drag.active && app._drag.kind === 'wire', 'D/blank: a hold still launches the arrow');
ok(app.uiState.menu === null, 'D/blank: no programming chooser from a hold');
app._onMouseUp([540, 440], {});
clearHands();

// =========================================================================
// Jammer — targeting only: a hold launches the arrow; a plain click on a gate
// (anywhere along the segment) marks it, and re-marking another gate overwrites.
// =========================================================================
clearHands(); w.jam_links.clear();
w.player = [470, 380];
ok(app._pickItem({ kind: 'jammer', id: 'jam_a' }), 'J: picked up the jammer');
holdInAnnulus([470, 380], [490, 380]);
elapse(400); app._updateGestures();
ok(app._drag.active && app._drag.kind === 'wire', 'J: a hold launches the golden arrow');
app._onMouseUp([490, 380], {});
const ffMid = w.ffs[0].mid();
ok(!!targetSpec('jammer').targetAt(w, 'jam_a', ffMid[0], ffMid[1]),
   'J: a force field is a valid jam target');
clearHands(); w.jam_links.clear();

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
// Intent-ray deletion is SCOPED to the carried / targeting device: a click only
// ever erases THAT device's own intents, never another device's, and a click on
// the carried item's body drops it rather than wiping its wires.
// =========================================================================
const RAY_MID = [(w.nodes.con_1.pos[0] + w.nodes.con_2.pos[0]) / 2,
                 (w.nodes.con_1.pos[1] + w.nodes.con_2.pos[1]) / 2];

// carrying con_c → a click on the carried device's OWN wire (away from its body)
// erases it, and does NOT drop the device.
clearHands();
w.links.clear();
w.nodes.con_c.pos = [445, 293]; w.player = [445, 293]; w.carrying = 'con_c';
w.toggle_link('con_c', 'con_1');                         // con_c's OWN wire
ok(w.links.size === 1, 'ray-delete: setup own wire con_c–con_1');
const ownMid = [(445 + w.nodes.con_1.pos[0]) / 2, (293 + w.nodes.con_1.pos[1]) / 2];
app._playClick(ownMid[0], ownMid[1]);                   // on the wire, away from con_c's body
ok(w.links.size === 0, "ray-delete: a click on the carried device's OWN wire erases it");
ok(w.carrying === 'con_c', 'ray-delete: erasing an own wire does not drop the device');

// carrying con_c → a click on a ray NOT owned by con_c does NOT erase it.
clearHands();
w.links.clear(); w.toggle_link('con_1', 'con_2');       // someone else's wire
w.nodes.con_c.pos = [445, 293]; w.player = [445, 293]; w.carrying = 'con_c';
app._playClick(RAY_MID[0], RAY_MID[1]);
ok(w.links.size === 1, "ray-delete: a click does not erase another device's intent");
ok(w.carrying === 'con_c', 'ray-delete: and does not drop the carried device');

// carrying con_c → clicking node B (con_1) erases only MY intent toward B
// (con_c–con_1); B's own other link (con_1–con_2) is left untouched.
clearHands();
w.links.clear();
w.toggle_link('con_c', 'con_1');                         // my intent toward B
w.toggle_link('con_1', 'con_2');                         // B's own other link
w.nodes.con_c.pos = [445, 293]; w.player = [445, 293]; w.carrying = 'con_c';
app._playClick(w.nodes.con_1.pos[0], w.nodes.con_1.pos[1]);   // click on B
ok(!w.links.has(w._link_key('con_c', 'con_1')), 'ray-delete: clicking B erases my A→B intent');
ok(w.links.has(w._link_key('con_1', 'con_2')), "ray-delete: clicking B leaves B's other links untouched");

// PRESERVED: a click ON the carried item's body (its drop spot) is a place, not an
// erase — it must not wipe the wires that emanate from it.
clearHands();
w.links.clear();
w.nodes.con_c.pos = [445, 293]; w.player = [445, 293]; w.carrying = 'con_c';
w.toggle_link('con_c', 'con_1');
app._playClick(445, 293);                                // right on the item's body
ok(w.links.has(w._link_key('con_c', 'con_1')),
   'ray-delete: a click on the item body does not wipe its own wires');

// carrying a box → a ray click is not an eraser (boxes create no intents)
clearHands();
w.links.clear(); w.toggle_link('con_1', 'con_2');
w.player = [470, 500]; w.carry_box = [470, 500];
app._playClick(RAY_MID[0], RAY_MID[1]);
ok(w.links.size === 1, 'ray-delete: carrying a box, a ray click does not erase');

// Plain carrying → a node click toggles the link; a click on con_c's OWN bare
// wire erases it; a click on a ray NOT owned by con_c does NOT erase it.
clearHands();
w.links.clear();
w.player = [445, 293]; w.nodes.con_c.pos = [445, 293]; w.carrying = 'con_c';
app._playClick(w.nodes.con_1.pos[0], w.nodes.con_1.pos[1]);   // node → create con_c↔con_1
ok(w.links.size === 1, 'ray-delete: a node click creates a link');
const tgMid = [(445 + w.nodes.con_1.pos[0]) / 2, (293 + w.nodes.con_1.pos[1]) / 2];
app._playClick(tgMid[0], tgMid[1]);                          // con_c's own bare wire → erase
ok(w.links.size === 0, "ray-delete: a click on the device's own bare wire erases it");
w.toggle_link('con_1', 'con_2');                             // a ray NOT owned by con_c
app._playClick(RAY_MID[0], RAY_MID[1]);                      // bare ray of someone else
ok(w.links.has(w._link_key('con_1', 'con_2')),
   "ray-delete: a click does not erase another device's intent");
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
// E while carrying — the hold no longer has a special role (targeting moved to a
// plain click on a target). A hold does nothing and is NOT consumed, so the
// release drops the item like a brief tap.
// =========================================================================
// targeting device (connector) → a hold does nothing (no arrow, no mode, no menu)
// and is CONSUMED, so the hold's release does NOT drop (only a brief tap drops).
clearHands();
w.player = [445, 293];
app._pickItem({ kind: 'connector', id: 'con_c' });
eHold();
ok(app.uiState.menu === null && !app._drag.active, 'E/B: a hold while carrying does nothing');
ok(app._carryConsumed === true, 'E/B: the hold is consumed (release will not drop)');
ok(w.carrying === 'con_c', 'E/B: still carrying through the hold');
// the physical release of the consumed hold is swallowed → no drop
app.input.carryHeldSince = null;
app._handleAction('carry_release', performance.now());
ok(w.carrying === 'con_c', 'E/B: releasing the held E does not drop the item');

// programmable only (mine) → also nothing (programming is at the Forge)
clearHands();
w.player = [430, 440];
app._pickItem({ kind: 'mine', id: 'mine_a' });
eHold();
ok(app.uiState.menu === null, 'E/C: an E hold on a programmable-only device does nothing');
clearHands();

// rewirer (programmable + targeting) → likewise nothing from a hold
clearHands();
w.player = [520, 440];
app._pickItem({ kind: 'rewirer', id: 'rw_a' });
w.nodes['rw_a'].color = 'red';
eHold();
ok(app.uiState.menu === null && !app._drag.active, 'E/D: an E hold while carrying the rewirer does nothing');
clearHands();

// brief E while carrying drops
clearHands();
w.player = [445, 293];
app._pickItem({ kind: 'connector', id: 'con_c' });
eTap([w.player[0] + 15, w.player[1]]);
ok(w.carrying === null, 'E: a brief E drops the carried item');
clearHands(); w.links.clear();

// =========================================================================
// Forge — the only gateway to programming now. _invokeForge (F / the panel
// button) opens the chooser for a carried programmable item ONLY within a
// Forge's range, spends a use per applied value, and Escape closes it for free.
// =========================================================================
clearHands(); w.links.clear();
const forge = w.nodes['forge_a'];
forge.uses = 3;

// Out of range → nothing opens, nothing spent.
w.player = [100, 100];
app._pickItem({ kind: 'mine', id: 'mine_a' });
app._invokeForge();
ok(app.uiState.menu === null, 'forge: out of range, F opens nothing');
ok(forge.uses === 3, 'forge: an out-of-range F spends no use');
clearHands();

// In range with a programmable item → chooser opens, tagged with the forge.
w.player = [forge.pos[0], forge.pos[1] - 30];   // well within FORGE_REACH
app._pickItem({ kind: 'mine', id: 'mine_a' });
app._invokeForge();
ok(app.uiState.menu && app.uiState.menu.forgeId === 'forge_a', 'forge: in range, F opens the chooser tagged with the forge');
// Escape closes it WITHOUT spending a use.
app._handleAction('escape', performance.now());
ok(app.uiState.menu === null && forge.uses === 3, 'forge: Escape closes the menu for free');
// Re-open and actually pick a value → spends one use.
app._invokeForge();
clickMenu('5s fuse');
ok(w.nodes['mine_a'].fuse === 5, 'forge: choosing a value programs the carried item');
ok(forge.uses === 2, 'forge: an applied value spends one use');
clearHands();

// Connector corruption via the Forge: clean ↔ colour, the connector now being
// "technically programmable".
w.player = [forge.pos[0], forge.pos[1] - 30];
w.nodes['con_c'].color = null;
app._pickItem({ kind: 'connector', id: 'con_c' });
ok(w.nodes['con_c'].color == null, 'forge: a fresh connector is clean (pickup never corrupts it)');
app._invokeForge();
clickMenu('Corrupt → Green');
ok(w.nodes['con_c'].color === 'green', 'forge: a connector is corrupted to a colour');
ok(forge.uses === 1, 'forge: corrupting spends a use');
app._invokeForge();
clickMenu('Clean');
ok(w.nodes['con_c'].color == null, 'forge: a connector is cleaned back to a plain relay');
ok(forge.uses === 0, 'forge: cleaning spends the last use');
// Spent → grays out: opens nothing.
app._invokeForge();
ok(app.uiState.menu === null, 'forge: a spent Forge opens nothing');
clearHands(); w.links.clear();
w.nodes['con_c'].color = null;            // leave con_c clean for later sections
forge.uses = 3;

// =========================================================================
// Jammer targeting — the two paths the player actually uses (a plain click on a
// gate, and the golden-arrow sweep).
// =========================================================================

// Plain carrying: a click ANYWHERE along a gate segment marks it (not just the
// midpoint — that midpoint-only hit zone was the bug).
clearHands(); w.jam_links.clear();
w.player = [470, 380];
app._pickItem({ kind: 'jammer', id: 'jam_a' });
app._playClick(820, 380);                       // left end of ff_mid (786..1005), NOT its centre
ok(w.jam_links.get('jam_a') === 'ff_mid', 'carry-click: a click on the gate body marks the gate');

// Re-marking a different gate overwrites (one intent, last wins).
app._playClick(820, 250);                       // ff_top
ok(w.jam_links.get('jam_a') === 'ff_top' && w.jam_links.size === 1, 'carry-click: re-mark overwrites');
clearHands(); w.jam_links.clear();

// A click on empty space (no gate / mine / ray) just aims/drops — it never marks
// a jam target, and the existing mark (if any) is left alone.
w.player = [470, 380];
app._pickItem({ kind: 'jammer', id: 'jam_a' });
app._playClick(470, 200);                        // nothing there → no mark made
ok(!w.jam_links.has('jam_a'), 'carry-click: an empty click marks nothing');
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

// Regression: the connector golden arrow still links a node on sweep.
w.player = [445, 293];
app._pickItem({ kind: 'connector', id: 'con_c' });
app._startAimArrow();
app._onMouseMove(w.nodes['src_g1'].pos.slice(), {});   // sweep onto a source
ok(w.links.has(w._link_key('con_c', 'src_g1')), 'connector golden arrow still links nodes');
app._onMouseUp(w.nodes['src_g1'].pos.slice(), {});
clearHands(); w.links.clear(); w.jam_links.clear();

// Enables-only: a sweep ADDS but never REMOVES. Sweeping onto an already-wired
// node leaves it wired (it does not toggle off), and sweeping out and back in
// keeps it wired. (A single click is still the way to remove a link.)
w.player = [445, 293];
app._pickItem({ kind: 'connector', id: 'con_c' });
w.toggle_link('con_c', 'src_g1');                       // pre-existing link
ok(w.links.has(w._link_key('con_c', 'src_g1')), 'enables-only: setup — link exists');
app._startAimArrow();
app._onMouseMove(w.nodes['src_g1'].pos.slice(), {});   // sweep onto the wired node
ok(w.links.has(w._link_key('con_c', 'src_g1')), 'enables-only: a sweep onto a wired node does NOT remove it');
app._onMouseMove([700, 100], {});                       // leave all targets
app._onMouseMove(w.nodes['src_g1'].pos.slice(), {});   // re-enter the same node
ok(w.links.has(w._link_key('con_c', 'src_g1')), 'enables-only: sweeping out and back in keeps it wired');
app._onMouseUp(w.nodes['src_g1'].pos.slice(), {});
// a single click, by contrast, still toggles the link off
app._playClick(w.nodes['src_g1'].pos[0], w.nodes['src_g1'].pos[1]);
ok(!w.links.has(w._link_key('con_c', 'src_g1')), 'enables-only: a single click still removes the link');
clearHands(); w.links.clear(); w.jam_links.clear();

// =========================================================================
// C clears the carried targeting device's intents — connector links AND a
// jammer's jam mark — while carrying.
// =========================================================================
clearHands(); w.links.clear(); w.jam_links.clear();

// Jammer, plain carrying.
w.player = [470, 380];
app._pickItem({ kind: 'jammer', id: 'jam_a' });
w.set_jam('jam_a', 'ff_mid');
app._handleAction('clear', performance.now());
ok(!w.jam_links.has('jam_a'), 'C clears a carried jammer\u2019s jam mark');
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

// =========================================================================
// Rewirer firing + undo: a charged, deployed rewirer recolours its target ONCE
// and is destroyed (spent); _rewind restores the target colour, the spent flag
// and the intent. (The 3 s charge build-up itself is covered at the sim level
// in test_rewirer; here we drive the committed effect through the App + undo.)
// =========================================================================
clearHands(); w.links.clear(); w.jam_links.clear(); w.recolor_links.clear();
w.nodes['rw_a'].spent = false;
w.nodes['rw_a'].color = 'red';
const conColor0 = w.nodes['con_c'].color;          // a plain connector (no colour yet)
w.set_recolor('rw_a', 'con_c');
w.nodes['rw_a'].recolor_charge = 999;              // force the charge complete
ok(w.ready_rewirers().includes('rw_a'), 'fire: a fully-charged deployed rewirer is ready');
app._commitRecolors(performance.now());
ok(w.nodes['con_c'].color === 'red', 'fire: the connector is recoloured to the rewirer\u2019s colour');
ok(w.nodes['rw_a'].spent === true, 'fire: the rewirer is spent (destroyed) after firing');
ok(!w.recolor_links.has('rw_a'), 'fire: the spent rewirer\u2019s intent is cleared');
ok(!w.carriable_nodes().some(n => n.id === 'rw_a'), 'fire: a spent rewirer is no longer on the field');
app._rewind();
ok(w.nodes['con_c'].color === conColor0, 'undo: the target colour is restored');
ok(w.nodes['rw_a'].spent === false, 'undo: the rewirer is un-spent (back on the field)');
ok(w.recolor_links.get('rw_a') === 'con_c', 'undo: the recolour intent is restored');
clearHands(); w.recolor_links.clear();

console.log(`\ntree tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
