/**
 * Main application: game loop, mode switching, play interactions.
 *
 * Rendering architecture note: render2d drives the canvas 2D renderer now.
 * A future render3d.js can be imported and called alongside it in the same
 * loop with the same (world, uiState) contract, enabling simultaneous views.
 */

import { SPEED, TICK, PLAYER_R, BOX_R, CONN_R, CONNECT_REACH, DWELL_THRESH, LOGIC_KINDS, MINE_FUSE_DEFAULT } from '../core/constants.js';
import { dist, pt_seg_dist } from '../core/geometry.js';
import { build_level } from '../sim/level.js';
import { Renderer2D } from './renderer2d.js';
import { InputHandler } from './input.js';
import { objType } from '../sim/objects.js';
import { STR } from '../core/strings.js';

// How many rewind (undo) steps to retain, and how long the full-reset key
// must be held continuously (seconds) before the playfield is rebuilt.
const UNDO_MAX = 3;
const RESET_HOLD_SEC = 3;

// Long-press duration (ms) that opens the stack chooser (mouse or E key). Kept
// equal to the tree's AIM_HOLD_MS so every "operating hold" feels the same.
const MENU_HOLD_MS = 333;

// Press-and-hold timing for the targeting/programming tree (a press in the
// annulus while carrying). AIM_HOLD_MS reaches the branch point; AIM_DECIDE_MS
// is the extra window after the golden arrow launches in which the player
// either pulls the cursor out of the ring (keep drawing the arrow) or holds it
// inside (fall into click-by-click targeting / the Setup·Target menu).
const AIM_HOLD_MS = 333;
const AIM_DECIDE_MS = 500;

// Radius (world units) within which a click grabs the character to walk her.
// Smaller than the operating radius so a drag started off the character (but
// inside the operating ring) pulls a connection wire instead of moving her.
const PLAYER_GRAB_R = 11;

// Stacking rules: may an object of type `carried` be set down onto a target of
// type `onto`? Target types: 'ground', 'box' (empty), 'box+connector' (a box
// that already carries a connector), 'connector'. The relation is one-way by
// design — a connector may rest on a box, a box may not rest on a connector,
// and (for now) no two connectors share a box and no connector rests on a
// connector. Extend this table as new objects and rules are introduced.
const STACK_RULES = {
  connector: { ground: true,  box: true,  'box+connector': false, connector: false },
  box:       { ground: true,  box: false, 'box+connector': false, connector: false },
  // The programmable / targeting devices set down on the ground only (for now).
  mine:      { ground: true,  box: false, 'box+connector': false, connector: false },
  rewirer:   { ground: true,  box: false, 'box+connector': false, connector: false },
  jammer:    { ground: true,  box: false, 'box+connector': false, connector: false },
};
function canPlace(carried, onto) {
  return Boolean(STACK_RULES[carried] && STACK_RULES[carried][onto]);
}

export class App {
  constructor(canvas, statusEl) {
    this.canvas = canvas;
    this.statusEl = statusEl;
    this.world = build_level();

    // Rendering — add more renderers here later (e.g. renderer3d)
    this.renderer2d = new Renderer2D(canvas);

    this.input = new InputHandler(canvas);
    this.input.onMouseDown = (pos, e) => this._onMouseDown(pos, e);
    this.input.onMouseMove = (pos, e) => this._onMouseMove(pos, e);
    this.input.onMouseUp   = (pos, e) => this._onMouseUp(pos, e);

    this.uiState = {
      mode:    'play',   // 'play' | 'edit' (editor not yet implemented)
      sel:     null,     // selected connector id
      dwell:   0,
      live:    true,
      dirty:   false,
      pending: null,     // first point of a 2-click segment tool
      mouse:   [0, 0],
      resetProgress: 0,  // 0..1 fill of the full-reset hold (R)
      menu:    null,     // stack chooser { x, y, items:[{label,kind,...,rect}] }
      wireDrag: null,    // [x,y] cursor while pulling a wire from a carried connector
      placePreview: null,// live "shadow" of the carried item: { carried, spot, type, elevated }
      targeting: null,   // click-by-click targeting modal: { id, kind } | null
      hover:   null,     // hover tooltip: { pos:[x,y], radius, lines:[...] } | null
    };

    // Mouse drag tracking
    this._drag = { active: false, kind: null, ref: null, moved: false, linkHit: null };

    // Targeting/programming tree gesture: an annulus press-hold while carrying.
    // { since, kind, branched, decideAt, decided } | null
    this._aim = null;

    // Rewind (undo) stack of pre-action snapshots, newest last (max UNDO_MAX).
    this._undo = [];
    // True while a contiguous box-push is underway (so one push = one undo).
    this._pushRun = false;
    // True once a hold has fired a full reset, until the key is released.
    this._resetConsumed = false;
    // Transient status-bar message: { text, until } in seconds.
    this._flash = null;
    // Long-press (chooser) tracking for the left mouse button and the E key.
    this._press = null;            // { active, t, x, y, moved, consumed } | null
    this._carryConsumed = false;   // true once an E hold has opened the chooser
    this._prevCarrySince = null;

    this._lastTick = null;
    this._frameId  = null;
    // Stable random quip index chosen once per session for the player tooltip.
    this._playerQuip = Math.floor(Math.random() * 5);
  }

  start() {
    this.world.solve(true, false);
    this.uiState.live = true;
    this._resize();
    // Re-size whenever the container changes (window resize, devtools, etc.).
    new ResizeObserver(() => this._resize()).observe(this.canvas.parentElement);
    this._scheduleFrame();
  }

  _resize() {
    const el = this.canvas.parentElement;
    const cssW = el.clientWidth  || 1018;
    const cssH = el.clientHeight || 640;
    this.renderer2d.resize(cssW, cssH);
    // Update mouse→world transform used by InputHandler.
    this.input.toWorld = (x, y) => this.renderer2d.screenToWorld(x, y);
  }

  stop() {
    if (this._frameId !== null) cancelAnimationFrame(this._frameId);
    this._frameId = null;
  }

  // ---- rewind (undo) ----
  // Snapshot only the *input* state of the puzzle; derived state (beams,
  // charge, gate open/shut) is recomputed by solve() on restore.
  _captureState() {
    const w = this.world;
    const nodePos = {}, elevated = {};
    for (const id in w.nodes) {
      nodePos[id] = [...w.nodes[id].pos];
      if (w.nodes[id].kind === 'connector') elevated[id] = !!w.nodes[id].elevated;
    }
    return {
      player: w.player ? [...w.player] : null,
      player_block: w.player_block,
      carrying: w.carrying,
      carry_box: w.carry_box ? [...w.carry_box] : null,
      facing: w.facing ? [...w.facing] : [0, 1],
      boxes: w.boxes.map(b => [...b]),
      links: [...w.links],
      logic_links: w.logic_links.map(l => [...l]),
      jam_links: [...w.jam_links],
      nodePos,
      elevated,
    };
  }

  _restoreState(s) {
    const w = this.world;
    w.player = s.player ? [...s.player] : null;
    w.player_block = s.player_block;
    w.carrying = s.carrying;
    w.carry_box = s.carry_box ? [...s.carry_box] : null;
    w.facing = s.facing ? [...s.facing] : [0, 1];
    w.boxes = s.boxes.map(b => [...b]);
    w.links = new Set(s.links);
    w.logic_links = s.logic_links.map(l => [...l]);
    w.jam_links = new Map(s.jam_links ?? []);
    for (const id in s.nodePos) {
      const n = w.nodes[id];
      if (n) { n.pos[0] = s.nodePos[id][0]; n.pos[1] = s.nodePos[id][1]; }
    }
    if (s.elevated) for (const id in s.elevated) {
      if (w.nodes[id]) w.nodes[id].elevated = s.elevated[id];
    }
    w.solve(true, false);
  }

  // Signature of the *meaningful* puzzle state, excluding raw player position
  // (so plain walking is never an undo point) and the live position of a
  // carried connector (which tracks the player every frame). Used to decide
  // whether a mouse drag actually changed anything worth rewinding.
  _sig() {
    const w = this.world;
    const boxes = w.boxes.map(b => `${Math.round(b[0])},${Math.round(b[1])}`).join('|');
    const links = [...w.links].sort().join('|');
    const logic = w.logic_links.map(l => l.join(',')).sort().join('|');
    const jam = [...w.jam_links].map(([j, t]) => `${j}>${t}`).sort().join('|');
    return `${w.carrying}#${w.carry_box ? 'B' : '-'}#${boxes}#${links}#${logic}#${jam}`;
  }

  // Push a pre-action snapshot, keeping at most UNDO_MAX of them.
  _pushUndo(snap = null) {
    this._undo.push(snap ?? this._captureState());
    while (this._undo.length > UNDO_MAX) this._undo.shift();
  }

  _rewind() {
    const ui = this.uiState;
    if (this._undo.length === 0) { this._setFlash(STR.flash.nothingToRewind); return; }
    const snap = this._undo.pop();
    this._restoreState(snap);
    ui.sel = null;
    ui.live = true;
    this._pushRun = false;
    const left = this._undo.length;
    this._setFlash(STR.flash.rewound(left));
  }

  // ---- full reset (3-second hold of R) ----
  _updateResetHold() {
    const ui = this.uiState;
    const since = this.input.resetHeldSince;
    if (since === null) { ui.resetProgress = 0; this._resetConsumed = false; return; }
    if (this._resetConsumed) { ui.resetProgress = 0; return; }
    const elapsed = (performance.now() - since) / 1000;
    ui.resetProgress = Math.max(0, Math.min(1, elapsed / RESET_HOLD_SEC));
    if (elapsed >= RESET_HOLD_SEC) {
      this._fullReset();
      this._resetConsumed = true;
      ui.resetProgress = 0;
    }
  }

  _fullReset() {
    this.world = build_level();
    this.world.solve(true, false);
    const ui = this.uiState;
    ui.sel = null;
    ui.live = true;
    ui.dirty = false;
    ui.dwell = 0;
    this._undo = [];
    this._pushRun = false;
    this._drag = { active: false, kind: null, ref: null, moved: false, linkHit: null };
    this._aim = null;
    ui.targeting = null;
    ui.menu = null;
    ui.placePreview = null;
    ui.wireDrag = null;
    this._setFlash(STR.flash.fullReset);
  }

  _setFlash(text, dur = 1.6) {
    this._flash = { text, until: performance.now() / 1000 + dur };
  }

  _scheduleFrame() {
    this._frameId = requestAnimationFrame(ts => this._frame(ts));
  }

  _frame(ts) {
    this._updateResetHold();
    this._updateHoldMenu();
    this._updateGestures();
    const now = ts / 1000;
    if (this._lastTick === null) this._lastTick = now;
    // requestAnimationFrame is paused/throttled while the tab is hidden, so on
    // return `now` can be seconds ahead of _lastTick. Without this guard the
    // fixed-step loop would replay that whole backlog a few ticks per frame for
    // a while, briefly moving the player several times too fast. If we're more
    // than a few ticks behind (a hidden tab, a debugger pause, a GC hitch), drop
    // the backlog and resume at one tick per frame instead of replaying it.
    if (now - this._lastTick > TICK * 3) this._lastTick = now - TICK;
    // Fixed-step game logic while catching up (capped at 3 ticks to avoid spiral)
    let steps = 0;
    while (now - this._lastTick >= TICK && steps < 3) {
      this._tick(this._lastTick);
      this._lastTick += TICK;
      steps++;
    }
    this._updateHover();
    this._draw();
    this._updateStatus();
    this._scheduleFrame();
  }

  _tick(now) {
    const w = this.world;
    const ui = this.uiState;
    if (ui.mode !== 'play' || !w.player) return;

    const { held, hasFocus } = this.input;
    const vx = (held.has('right') ? 1 : 0) - (held.has('left') ? 1 : 0);
    const vy = (held.has('down')  ? 1 : 0) - (held.has('up')   ? 1 : 0);
    let moved = false;
    if ((vx || vy) && hasFocus) {
      const step = SPEED * TICK;
      const before = [...w.player];
      w.move_player(vx * step, 0);
      w.move_player(0, vy * step);
      moved = w.player[0] !== before[0] || w.player[1] !== before[1];
      // Per spec: facing is driven by the mouse-aim gesture, not by walking.
      // (Boxes are no longer pushable, so a walk never moves another object
      // and is never itself an undo point.)
    }

    // Glue the carried connector / box to its live placement preview (the
    // "shadow") so it is shown where it would be set down — not on top of her.
    if (w.carrying || w.carry_box) {
      this._syncCarried();
      ui.dirty = true;
    }

    // A connector can only be "ready" (selected) while it is being carried.
    if (ui.sel && ui.sel !== w.carrying) ui.sel = null;
    // Close the stack chooser if the player walks away.
    if (ui.menu && moved) ui.menu = null;

    // Dwell / player-as-blocker
    ui.dwell = w.player_touching_beam() ? ui.dwell + TICK : 0;
    const wantBlock = ui.dwell >= DWELL_THRESH;
    const blockChanged = wantBlock !== w.player_block;
    if (blockChanged) w.player_block = wantBlock;

    if (moved || ui.dirty || blockChanged || w.beams_live() || ui.live) {
      ui.live = w.step(now);
      ui.dirty = false;
    }

    // Process one-shot key actions
    for (const action of this.input.drainActions()) {
      this._handleAction(action, now);
    }
  }

  _handleAction(action, now) {
    const w = this.world;
    const ui = this.uiState;
    if (action === 'carry_release') {
      // E released. If the hold already fired the tree / chooser, swallow it.
      if (this._carryConsumed) return;
      // A brief E in click-by-click leaves the mode (back to ordinary carrying).
      if (ui.targeting) { this._exitTargeting(); return; }
      if (w.carrying || w.carry_box) {
        // Set the carried item down where it is being previewed (the shadow).
        // The preview is recomputed continuously and is always a legal, in-reach
        // spot, so the commit needs no further reach / teleport test.
        this._commitPlacement(this.uiState.placePreview || this._resolvePlacement(this.uiState.mouse));
      } else {
        // Pick up the nearest object in the active radius, armed by default.
        this._nearestPickup();
      }
    } else if (action === 'clear') {
      // C clears every intent of the carried targeting device. Any object that
      // requires a target listens for C — a connector drops all its light links,
      // a jammer drops its jam mark — and it works the same whether we are plain
      // carrying or in click-by-click targeting. Objects with no target (a box,
      // a mine) ignore C entirely.
      const cid = w.carrying;
      if (cid && objType(this._carriedKind())?.requiresTarget) {
        this._pushUndo();
        w.clear_links_of(cid);     // light links (connector)
        w.clear_jam(cid);          // jam intent (jammer); a no-op for the rest
        ui.live = true; w.step(now);
      }
    } else if (action === 'undo') {
      this._rewind();
    } else if (action === 'gates') {
      w.solve(true, false); ui.live = true;
    }
    // Note: 'reset' is no longer a one-shot action — a full reset is driven by
    // a continuous 3-second hold of R, handled in _updateResetHold().
  }

  _inReach(nid) {
    const w = this.world;
    if (w.carrying === nid) return true;
    return Boolean(w.player && dist(w.player, w.nodes[nid].pos) < CONNECT_REACH);
  }

  // ---- mouse ----
  _onMouseDown([x, y], e) {
    const w = this.world;
    // Track the press for the long-hold chooser / aim-hold (resolved later).
    this._press = { active: true, t: performance.now(), x, y, moved: false, consumed: false };
    this._drag.moved = false;
    this._drag.linkHit = null;
    // In click-by-click targeting, a press is a target click or the hold-to-exit
    // gesture — never a walk / wire-drag / placement drag.
    if (this.uiState.targeting) {
      this._drag = { active:false, kind:null, ref:null, moved:false, linkHit:null };
      return;
    }
    const dp = w.player ? dist([x, y], w.player) : Infinity;
    const carriedKind = this._carriedKind();
    if (w.player && dp < PLAYER_GRAB_R) {
      // Inner radius → grab the character to walk her. Capture a pre-drag
      // snapshot + signature; committed to the undo stack only if the drag
      // actually changes the puzzle (a wire toggle or a box push), so a drag
      // that only walks the player is never an undo point.
      this._drag = {
        active: true, kind: 'player', ref: null, moved: false, linkHit: null,
        preSnap: this._captureState(), preSig: this._sig(), committed: false,
      };
    } else if (w.player && carriedKind && dp < CONNECT_REACH) {
      // Annulus (off her, inside the operating ring) while carrying → begin an
      // aim-hold. The branch (swallow / golden arrow / programming) is chosen at
      // the 1/3-second mark in _updateGestures; until then the placement shadow
      // keeps previewing, and a quick release is still a plain drop.
      this._aim = { since: performance.now(), kind: carriedKind, branched: false, decideAt: null, decided: false };
      this._drag = { active:false, kind:null, ref:null, moved:false, linkHit:null };
    } else {
      this._drag = { active:false, kind:null, ref:null, moved:false, linkHit:null };
    }
  }

  _onMouseMove([x, y], e) {
    const w = this.world;
    const ui = this.uiState;
    ui.mouse = [x, y];
    if (this._press && this._press.active
        && Math.hypot(x - this._press.x, y - this._press.y) > 6) {
      this._press.moved = true;
    }
    // Any LMB drag that is NOT dragging the character makes her eyes follow
    // the cursor (this includes wire/link drags — that's intentional). A
    // singular click (no movement past threshold) and a character drag never
    // change facing.
    if (this._press && this._press.active && this._press.moved
        && this._drag.kind !== 'player' && w.player) {
      const dx = x - w.player[0], dy = y - w.player[1];
      const d = Math.hypot(dx, dy);
      if (d > 1e-3) w.facing = [dx / d, dy / d];
    }
    if (this._drag.active && this._drag.kind === 'player' && w.player) {
      this._drag.moved = true;
      this._dragPlayerTo(x, y);
      if (w.carrying) {
        const cid = w.carrying;
        w.nodes[cid].pos[0] = w.player[0];
        w.nodes[cid].pos[1] = w.player[1];
        // Auto-wire on pass-over only while a CONNECTOR is "ready" (selected).
        // Other carried devices (jammer/rewirer/mine) never auto-link.
        if (this._carriedKind() === 'connector' && ui.sel === cid) {
          let tgt = null, best = 18;
          for (const nd of Object.values(w.nodes)) {
            if (nd.id===cid || !['source','receiver','connector'].includes(nd.kind)) continue;
            const d = dist(w.player, nd.pos);
            if (d < best) { tgt = nd; best = d; }
          }
          if (tgt === null) { this._drag.linkHit = null; }
          else if (tgt.id !== this._drag.linkHit) {
            w.toggle_link(cid, tgt.id);
            this._drag.linkHit = tgt.id;
          }
        } else {
          this._drag.linkHit = null;
        }
      }
      if (w.carry_box) {
        w.carry_box[0] = w.player[0];
        w.carry_box[1] = w.player[1];
      }
      // Commit one undo point per drag, the first time it changes anything.
      if (!this._drag.committed && this._drag.preSnap && this._sig() !== this._drag.preSig) {
        this._pushUndo(this._drag.preSnap);
        this._drag.committed = true;
      }
      ui.live = true; w.step(performance.now()/1000);
    }

    if (this._drag.active && this._drag.kind === 'wire' && w.carrying) {
      // Golden-arrow drag. The character does not move; only the arrow tip
      // tracks the cursor. What a pass-over does depends on the carried device.
      this._drag.moved = true;
      ui.wireDrag = [x, y];
      const cid = w.carrying;
      const kind = this._carriedKind();
      if (kind === 'jammer') {
        // Jammer: sweep the arrow onto a jammable target (a gate or a mine) to
        // mark it. One intent, last wins, so we SET (not toggle); sweeping off a
        // target leaves the last mark in place.
        const tgt = this._jamTargetAt(x, y);
        const tid = tgt ? (tgt.ff ? tgt.ff.id : tgt.mine.id) : null;
        if (tid && tid !== this._drag.linkHit) {
          if (!this._drag.committed && this._drag.preSnap) {
            this._pushUndo(this._drag.preSnap); this._drag.committed = true;
          }
          w.set_jam(cid, tid);
          this._drag.linkHit = tid;
        }
      } else if (kind === 'connector') {
        // Connector: toggle a light link to each node the arrow passes over.
        let tgt = null, best = 18;
        for (const nd of Object.values(w.nodes)) {
          if (nd.id === cid || !['source', 'receiver', 'connector'].includes(nd.kind)) continue;
          const d = dist([x, y], nd.pos);
          if (d < best) { tgt = nd; best = d; }
        }
        if (tgt === null) {
          this._drag.linkHit = null;
        } else if (tgt.id !== this._drag.linkHit) {
          w.toggle_link(cid, tgt.id);
          this._drag.linkHit = tgt.id;
          if (!this._drag.committed && this._drag.preSnap && this._sig() !== this._drag.preSig) {
            this._pushUndo(this._drag.preSnap);
            this._drag.committed = true;
          }
        }
      }
      // Other targeting devices (the rewirer) just draw the arrow for now; their
      // recolour mark is applied through the click-by-click Target step.
      ui.live = true; w.step(performance.now() / 1000);
    }

    // Plain carrying (no active drag gesture): the cursor aims the placement
    // shadow, so refresh it immediately for a crisp, frame-accurate preview.
    if (!this._drag.active && (w.carrying || w.carry_box)) {
      this._syncCarried();
      ui.live = true;
    }
  }

  _onMouseUp([x, y], e) {
    const w = this.world;
    const ui = this.uiState;
    const consumed = this._press && this._press.consumed;   // hold opened a menu / branch
    this._press = null;
    this._aim = null;                                       // any pending aim-hold ends
    ui.wireDrag = null;
    if (this._drag.active && this._drag.kind === 'wire') {
      // The golden-arrow gesture ends on release — it is never a drop, even if
      // the cursor never moved (the object was centred on her, not at a shadow).
      this._drag.active = false;
      ui.live = true; w.step(performance.now()/1000);
      return;
    }
    if (this._drag.moved) {
      this._drag.active = false;
      ui.live = true; w.step(performance.now()/1000);
      return;
    }
    this._drag.active = false;
    if (!consumed && ui.mode === 'play') this._playClick(x, y);
    ui.live = true; w.step(performance.now()/1000);
  }

  _dragPlayerTo(tx, ty) {
    const w = this.world;
    // Per spec: dragging the character around must NOT change her facing.
    for (let i = 0; i < 60; i++) {
      const [px, py] = w.player;
      const dx = tx-px, dy = ty-py;
      const d = Math.hypot(dx, dy);
      if (d < 0.5) break;
      const step = Math.min(6, d);
      const before = [...w.player];
      w.move_player(dx/d*step, 0); w.move_player(0, dy/d*step);
      if (w.player[0]===before[0] && w.player[1]===before[1]) break;
    }
  }

  _playClick(x, y) {
    const w = this.world;
    const ui = this.uiState;

    // A click while a chooser menu is open resolves (or cancels) the menu.
    if (ui.menu) { this._handleMenuClick(x, y); return; }

    // Click-by-click targeting: a click on a valid target marks it (link / jam /
    // recolour); a click on a bare intent ray (nothing targetable under the
    // cursor) erases that ray; a click that hits neither leaves the mode. Apply
    // is tried first so that clicking a target that happens to sit under its own
    // ray marks it rather than erasing the ray (this is the common case for a
    // jammer, whose ray ends on the gate it targets).
    if (ui.targeting) {
      if (this._applyTargetIntent(x, y)) return;
      if (this._deleteIntentAt(x, y)) return;
      this._exitTargeting();
      return;
    }

    // Empty-handed: pick something up. A quick click takes the top of the
    // stack; a hold on a real stack (2+ items) opens a chooser menu.
    if (!w.carrying && !w.carry_box) { this._clickPickup(x, y); return; }

    // Carrying a targeting device: a click over an existing intent ray erases it
    // (every ray sharing the small hit zone goes at once) rather than dropping.
    if (objType(this._carriedKind())?.requiresTarget && this._deleteIntentAt(x, y)) return;

    // Otherwise a brief click drops the item where the live preview shows it —
    // but only when the click lands INSIDE the operating ring. A click outside
    // the ring is purely an aim (it never drops); the E key is what commits an
    // out-of-ring drop (handled in carry_release).
    if (w.player && dist(w.player, [x, y]) < CONNECT_REACH) {
      this._commitPlacement(ui.placePreview || this._resolvePlacement([x, y]));
    }
  }

  // Delete the intent ray(s) under a click while carrying a targeting device.
  // The hit zone is a few world units wide (no single-pixel hunting). Light
  // links (a connector's wires) and jam rays (a jammer's single intent) both
  // count; if several share the zone, all are removed at once. Returns true if
  // any were.
  _deleteIntentAt(x, y) {
    const w = this.world;
    const THRESH = 6;
    const hits = [];
    for (const [a, b] of w.links_pairs) {
      const na = w.nodes[a], nb = w.nodes[b];
      if (!na || !nb) continue;
      if (pt_seg_dist([x, y], na.pos, nb.pos) <= THRESH) hits.push([a, b]);
    }
    const jamHits = [];
    for (const r of w.jam_rays_draw) {
      if (pt_seg_dist([x, y], r.from, r.to) <= THRESH) {
        // Find which jammer this ray belongs to (by endpoint match).
        for (const [jid, tid] of w.jam_links) {
          const jn = w.nodes[jid];
          if (jn && dist(jn.pos, r.from) < 1e-6) { jamHits.push(jid); break; }
        }
      }
    }
    if (hits.length === 0 && jamHits.length === 0) return false;
    this._pushUndo();
    for (const [a, b] of hits) w.toggle_link(a, b);
    for (const jid of jamHits) w.clear_jam(jid);
    this.uiState.live = true; w.step(performance.now() / 1000);
    return true;
  }

  // The pickable items under (x, y), top of the stack first. A box with a
  // connector resting on it is the one stack type today → [connector, box];
  // every other carriable (mine, rewirer, jammer, a bare connector) is a single
  // ground item.
  _stackAt(x, y) {
    const w = this.world;
    let node = null, nd = 16;
    for (const c of w.carriable_nodes()) {
      const d = dist([x, y], c.pos);
      if (d < nd) { node = c; nd = d; }
    }
    let box = null, bd = BOX_R + 4;
    for (const bx of w.boxes) {
      const d = dist([x, y], bx);
      if (d < bd) { box = bx; bd = d; }
    }
    const items = [];
    if (node) {
      const lbl = (node.label || '').trim();
      const name = STR.kinds[node.kind] || node.kind;
      items.push({ kind: node.kind, id: node.id, label: lbl ? `${name} ${lbl}` : name });
    }
    if (box) items.push({ kind: 'box', box, label: STR.kinds.box });
    return items;            // top (node) first, box underneath
  }

  // Empty-handed click: take the top item under the cursor. (The stack chooser
  // is opened by a long hold instead — see _updateHoldMenu.)
  _clickPickup(x, y) {
    const w = this.world;
    const items = this._stackAt(x, y);
    if (items.length === 0) return false;
    const loc = items[0].id ? w.nodes[items[0].id].pos : items[0].box;
    if (dist(w.player, loc) >= CONNECT_REACH) return false;
    if (w.reach_blocked(w.player, loc)) { this._setFlash(STR.flash.cantReachBlocked); return false; }
    return this._pickItem(items[0]);
  }

  // E key: nearest object — every connector (the top of any stack), plus boxes
  // that have no connector on them (an occupied box's top connector is already
  // a candidate). Honors radius + no-teleport safeguard.
  _nearestPickup() {
    const w = this.world;
    let pick = null, best = CONNECT_REACH, blocked = false;
    const consider = (loc, item) => {
      const d = dist(w.player, loc);
      if (d >= best) return;
      if (w.reach_blocked(w.player, loc)) { blocked = true; return; }
      pick = item; best = d;
    };
    for (const c of w.carriable_nodes()) consider(c.pos, { kind: c.kind, id: c.id });
    for (const bx of w.boxes) {
      const occupied = w.connectors().some(c => dist(c.pos, bx) < BOX_R);
      if (!occupied) consider(bx, { kind: 'box', box: bx });
    }
    if (!pick) { if (blocked) this._setFlash(STR.flash.cantReachBlocked); return false; }
    return this._pickItem(pick);
  }

  // Take a specific item into the player's hands (enforces the single-item rule).
  _pickItem(item) {
    const w = this.world;
    const ui = this.uiState;
    if (w.carrying || w.carry_box) { this._handsFull(); return false; }
    this._pushUndo();
    this._carryAim = null;     // fresh carry — no stale frozen offset
    if (item.id) {
      // A carriable node (connector / mine / rewirer / jammer).
      const nd = w.nodes[item.id];
      w.carrying = item.id;
      nd.elevated = false;                 // carried — not on a box anymore
      if (item.kind === 'mine') {
        if (nd.fuse == null) nd.fuse = MINE_FUSE_DEFAULT;   // default on first pickup
        nd.fuse_running = false;           // a carried mine is not counting down
      }
      if (item.kind === 'rewirer' && !nd.color) nd.color = 'red';
      ui.sel = item.id;                    // armed (ready) by default
    } else {
      // Lift the box off the field; de-elevate any connector that rested on it.
      const idx = w.boxes.indexOf(item.box);
      if (idx !== -1) w.boxes.splice(idx, 1);
      for (const c of w.connectors()) {
        if (c.elevated && dist(c.pos, item.box) < BOX_R) c.elevated = false;
      }
      w.carry_box = item.box;      // now rides with the player
      ui.sel = null;
    }
    ui.live = true; w.step(performance.now() / 1000);
    return true;
  }

  // ---- stack chooser menu ----
  _openMenu(x, y, items) {
    const MW = 116, MH = 26, GAP = 4;
    const laid = items.map((it, i) => ({
      ...it,
      rect: [x - MW / 2, y + 14 + i * (MH + GAP), MW, MH],
    }));
    this.uiState.menu = { x, y, items: laid };
  }

  // ---- targeting / programming tree (annulus press-hold) ----
  // Resolved each frame. Two jobs: (1) while click-by-click targeting is active,
  // a still ~1/3 s hold anywhere exits it; (2) otherwise advance the aim-hold
  // through its branch point and the golden-arrow decision window.
  _updateGestures() {
    const w = this.world;
    const ui = this.uiState;
    const now = performance.now();

    // While click-by-click targeting is active the aim-hold never runs. Exit is
    // a brief click on empty space (handled in _playClick) or a tap of E
    // (handled in carry_release) — not a timed hold.
    if (ui.targeting) return;

    const a = this._aim;
    if (!a) return;
    const kind = this._carriedKind();
    const p = this._press;
    if (!kind || !w.player || !p || !p.active) { this._aim = null; return; }
    if (this._drag.active && this._drag.kind === 'player') { this._aim = null; return; }
    const ot = objType(kind) || {};
    const reqT = !!ot.requiresTarget, prog = !!ot.programmable;

    // (1) Branch point at 1/3 s.
    if (!a.branched && now - a.since >= AIM_HOLD_MS) {
      a.branched = true;
      if (!reqT && !prog) {
        // A — neither: swallow. Nothing happens; the release will not drop.
        p.consumed = true;
        this._aim = null;
      } else if (reqT && !prog) {
        // B — targeting only: launch the golden arrow, open the decision window.
        this._startAimArrow();
        a.decideAt = now + AIM_DECIDE_MS;
      } else if (!reqT && prog) {
        // C — programmable only: open the programming sequence.
        this._openProgramming(kind);
        p.consumed = true;
        this._aim = null;
      } else {
        // D — both: program first if a field is blank, else arm the arrow.
        if (this._progFieldsNA(kind)) { this._openProgramming(kind); p.consumed = true; this._aim = null; }
        else { this._startAimArrow(); a.decideAt = now + AIM_DECIDE_MS; }
      }
      return;
    }

    // (2) Decision window: did the cursor leave the operating ring?
    if (a.decideAt && !a.decided && now >= a.decideAt) {
      a.decided = true;
      const inRing = dist(w.player, ui.mouse) < CONNECT_REACH;
      if (inRing) {
        // Stayed inside → fall out of arrow-drawing into the sticky interaction.
        this._endAimArrow();
        p.consumed = true;
        if (reqT && prog) this._openSetupTarget(kind);   // D → choose Setup or Target
        else this._enterTargeting(kind);                 // B → click-by-click
      }
      // Left the ring → the golden arrow keeps drawing (the wire drag lives on).
      this._aim = null;
    }
  }

  _startAimArrow() {
    // Launch the golden-arrow wire drag; the carried object snaps to her centre
    // (handled by _syncCarried's drag branch) and the wire endpoint tracks the
    // cursor (handled by the existing kind==='wire' move handler).
    this._drag = {
      active: true, kind: 'wire', ref: null, moved: false, linkHit: null,
      preSnap: this._captureState(), preSig: this._sig(), committed: false,
    };
    this.uiState.wireDrag = [...this.uiState.mouse];
  }

  _endAimArrow() {
    this._drag.active = false;
    this.uiState.wireDrag = null;
  }

  // Enter click-by-click targeting: the object turns gold and stays on the
  // player; clicks create intents until a ~1/3 s hold exits.
  _enterTargeting(kind) {
    const w = this.world;
    if (!w.carrying) return;
    this._endAimArrow();
    this.uiState.targeting = { id: w.carrying, kind };
    this.uiState.placePreview = null;
    w.nodes[w.carrying].pos[0] = w.player[0];
    w.nodes[w.carrying].pos[1] = w.player[1];
    const what = STR.targetWhat[kind] ?? STR.targetWhat.default;
    this._setFlash(STR.flash.targeting(what));
  }

  _exitTargeting() {
    this.uiState.targeting = null;
    this._setFlash(STR.flash.doneTargeting);
  }

  // The programming sequence: a small chooser of values for the carried device.
  _openProgramming(kind) {
    const ui = this.uiState;
    const [ax, ay] = ui.mouse;
    if (kind === 'mine') {
      this._openMenu(ax, ay, [1, 2, 3, 5, 8].map(s => ({ label: STR.menu.fuse(s), act: 'mineFuse', value: s })));
    } else if (kind === 'rewirer') {
      this._openMenu(ax, ay, [[STR.menu.colorRed, 'red'], [STR.menu.colorGreen, 'green'], [STR.menu.colorBlue, 'blue']]
        .map(([l, c]) => ({ label: l, act: 'rewirerColor', value: c })));
    }
  }

  _openSetupTarget(kind) {
    const ui = this.uiState;
    this._openMenu(ui.mouse[0], ui.mouse[1], [
      { label: STR.menu.setup,  act: 'setup' },
      { label: STR.menu.target, act: 'target' },
    ]);
  }

  // Are the carried device's programmable fields blank (would need setup first)?
  _progFieldsNA(kind) {
    const w = this.world;
    const nd = w.carrying ? w.nodes[w.carrying] : null;
    if (!nd) return false;
    if (kind === 'mine') return nd.fuse == null;
    if (kind === 'rewirer') return !nd.color;
    return false;
  }

  // Resolve a menu action item.
  _runMenuAct(it) {
    const w = this.world;
    const ui = this.uiState;
    const nd = w.carrying ? w.nodes[w.carrying] : null;
    if (it.act === 'mineFuse' && nd) {
      this._pushUndo(); nd.fuse = it.value; this._setFlash(STR.flash.fuseSet(it.value));
    } else if (it.act === 'rewirerColor' && nd) {
      this._pushUndo(); nd.color = it.value;
      this._setFlash(STR.flash.colourSet(it.value)); ui.live = true; w.step(performance.now() / 1000);
    } else if (it.act === 'setup') {
      this._openProgramming(this._carriedKind());     // re-open as the colour chooser
    } else if (it.act === 'target') {
      this._enterTargeting(this._carriedKind());
    }
  }

  // Apply a click-by-click target intent for the carried device. Returns true if
  // a valid target sat under the cursor (whether or not the effect could apply),
  // false if the click hit nothing — the caller uses that to leave the mode.
  _applyTargetIntent(x, y) {
    const w = this.world;
    const ui = this.uiState;
    const t = ui.targeting;
    if (!t || !w.nodes[t.id]) return false;
    const cid = t.id;
    if (t.kind === 'connector') {
      const n = this._nodeAt(x, y);
      if (n && n.id !== cid && ['source', 'receiver', 'connector'].includes(n.kind)) {
        this._pushUndo(); w.toggle_link(cid, n.id);
        ui.live = true; w.step(performance.now() / 1000);
        return true;
      }
      return false;
    }
    if (t.kind === 'rewirer') {
      // Like the jammer, the rewirer's effect is deferred: with line of sight it
      // *marks* a source or receiver now; the actual recolour is applied once the
      // rewirer is deployed. Storing that persistent intent (and drawing its ray)
      // and applying it on drop is phase 3/4 — so it no longer recolours instantly.
      const n = this._nodeAt(x, y);
      if (n && ['source', 'receiver'].includes(n.kind)) {
        if (w.reach_blocked(w.player, n.pos)) { this._setFlash(STR.flash.noLineOfSight); this._beep(); return true; }
        this._setFlash(STR.flash.recolourMarked);
        return true;
      }
      return false;
    }
    if (t.kind === 'jammer') {
      // Mark the single target. A jammer holds exactly one intent, so this
      // overwrites any previous one. There is no mark-time line-of-sight gate:
      // the jammer isn't deployed yet, and once it is, its reach is re-checked
      // live every frame (an active force field in the way blocks it until that
      // field goes down). The jam bites only while the jammer is on the ground.
      const tgt = this._jamTargetAt(x, y);
      if (tgt) {
        const tid = tgt.ff ? tgt.ff.id : tgt.mine.id;
        this._pushUndo();
        w.set_jam(cid, tid);
        ui.live = true; w.step(performance.now() / 1000);
        this._setFlash(STR.flash.jamMarked);
        return true;
      }
      return false;
    }
    return false;
  }

  // Nearest jammable target under (x, y). A force field is hit anywhere along
  // its segment (it is a long line, so midpoint-only hunting was the bug); a
  // jammable node (a mine) is hit near its centre.
  _jamTargetAt(x, y) {
    const w = this.world;
    let best = null, bd = 18;
    for (const ff of w.ffs) {
      const d = pt_seg_dist([x, y], ff.p1, ff.p2);
      if (d < bd) { best = { pos: ff.mid(), ff }; bd = d; }
    }
    for (const n of Object.values(w.nodes)) {
      if (!objType(n.kind)?.jammable) continue;
      const d = dist([x, y], n.pos);
      if (d < bd) { best = { pos: n.pos, mine: n }; bd = d; }
    }
    return best;
  }

  _handleMenuClick(x, y) {
    const menu = this.uiState.menu;
    this.uiState.menu = null;
    if (!menu) return;
    for (const it of menu.items) {
      const [rx, ry, rw, rh] = it.rect;
      if (x >= rx && x <= rx + rw && y >= ry && y <= ry + rh) {
        if (it.act) this._runMenuAct(it); else this._pickItem(it);
        return;
      }
    }
    // clicked outside the menu → just cancel
  }

  // Each frame: a ~half-second long-press on the left mouse button OR the E key
  // opens the stack chooser, when the player is empty-handed and a stack is in
  // reach. The mouse targets the stack under the cursor; E targets the nearest
  // in-reach stack.
  _updateHoldMenu() {
    const ui = this.uiState;
    const now = performance.now();

    // E key hold
    const since = this.input.carryHeldSince;
    if (since !== this._prevCarrySince) {
      if (since !== null) this._carryConsumed = false;   // a fresh press began
      this._prevCarrySince = since;
    }
    if (!ui.menu && !ui.targeting && since !== null && !this._carryConsumed && now - since >= AIM_HOLD_MS) {
      if (this.world.carrying || this.world.carry_box) {
        // Carrying → E is the operating tool: a ~1/3 s hold fires the same branch
        // as the mouse tree, but goes straight to the end state (no golden arrow).
        this._fireECarryTree();
        this._carryConsumed = true;          // the release must not also drop
      } else if (this._tryOpenMenuForE()) {
        this._carryConsumed = true;          // empty-handed → stack chooser
      }
    }

    // Left mouse hold
    const p = this._press;
    if (!ui.menu && p && p.active && !p.consumed && !p.moved && now - p.t >= MENU_HOLD_MS) {
      if (this._tryOpenMenuAt(p.x, p.y)) p.consumed = true;
    }
  }

  // E-as-operating-tool: a ~1/3 s E hold while carrying enters the carried
  // device's end state directly — click-by-click for a targeting device, the
  // programming chooser for a programmable one, the Setup/Target menu for both.
  // No golden-arrow / linking step (that would be awkward off a key hold); a
  // "neither" device (a box) is simply swallowed, exactly like the mouse tree.
  _fireECarryTree() {
    const kind = this._carriedKind();
    const ot = objType(kind) || {};
    const reqT = !!ot.requiresTarget, prog = !!ot.programmable;
    if (reqT && prog) {
      if (this._progFieldsNA(kind)) this._openProgramming(kind);
      else this._openSetupTarget(kind);
    } else if (reqT) {
      this._enterTargeting(kind);
    } else if (prog) {
      this._openProgramming(kind);
    }
    // neither → nothing (swallowed)
  }

  // Open the chooser for the stack under (x, y), if it is a real (2+) stack in
  // reach. Returns true if a menu opened.
  _tryOpenMenuAt(x, y) {
    const w = this.world;
    if (w.carrying || w.carry_box) return false;
    const items = this._stackAt(x, y);
    if (items.length < 2) return false;
    const loc = items[0].kind === 'connector' ? w.nodes[items[0].id].pos : items[0].box;
    if (dist(w.player, loc) >= CONNECT_REACH) return false;
    if (w.reach_blocked(w.player, loc)) return false;
    this._openMenu(loc[0], loc[1], items);
    return true;
  }

  // Open the chooser for the nearest in-reach stack (box with a connector on
  // it). Used by an E long-press. Returns true if a menu opened.
  _tryOpenMenuForE() {
    const w = this.world;
    if (w.carrying || w.carry_box) return false;
    let best = null, bd = CONNECT_REACH;
    for (const b of w.boxes) {
      const conn = w.connectors().find(c => c.elevated && dist(c.pos, b) < BOX_R);
      if (!conn) continue;
      const d = dist(w.player, b);
      if (d >= bd) continue;
      if (w.reach_blocked(w.player, b)) continue;
      best = { box: b, conn }; bd = d;
    }
    if (!best) return false;
    this._openMenu(best.box[0], best.box[1], [
      { kind: 'connector', id: best.conn.id, label: STR.kinds.connector },
      { kind: 'box', box: best.box, label: STR.kinds.box },
    ]);
    return true;
  }

  // Classify what sits under (x, y) for placement, ignoring `excludeId`.
  // Returns { type, point } where type is one of the STACK_RULES target kinds.
  _targetUnder(x, y, excludeId) {
    const w = this.world;
    let box = null, bd = BOX_R + 4;
    for (const bx of w.boxes) {
      const d = dist([x, y], bx);
      if (d < bd) { box = bx; bd = d; }
    }
    if (box) {
      const occupied = w.connectors().some(
        c => c.id !== excludeId && c.elevated && dist(c.pos, box) < BOX_R);
      return { type: occupied ? 'box+connector' : 'box', point: [box[0], box[1]] };
    }
    let conn = null, cd = 16;
    for (const c of w.connectors()) {
      if (c.id === excludeId) continue;
      const d = dist([x, y], c.pos);
      if (d < cd) { conn = c; cd = d; }
    }
    if (conn) return { type: 'connector', point: [conn.pos[0], conn.pos[1]] };
    return { type: 'ground', point: [x, y] };
  }

  // The kind of whatever is currently carried — a node kind ('connector',
  // 'mine', 'rewirer', 'jammer') or 'box' — or null when hands are empty.
  _carriedKind() {
    const w = this.world;
    if (w.carrying) return w.nodes[w.carrying]?.kind ?? null;
    if (w.carry_box) return 'box';
    return null;
  }

  // Keep the carried item glued to its live placement preview (the "shadow").
  // While a drag gesture is in progress (walking her, or pulling a wire) the
  // item rides on the player exactly as before; otherwise it floats at the spot
  // where it would land, and she looks that way. Called every tick and on every
  // bare mouse move, so the preview is always current.
  _syncCarried() {
    const w = this.world;
    const ui = this.uiState;
    if (!(w.carrying || w.carry_box) || !w.player) { ui.placePreview = null; return; }
    const sit = (p) => {
      if (w.carrying) { w.nodes[w.carrying].pos[0] = p[0]; w.nodes[w.carrying].pos[1] = p[1]; }
      if (w.carry_box) { w.carry_box[0] = p[0]; w.carry_box[1] = p[1]; }
    };
    if (this._drag.active || ui.targeting) {
      // Active gesture (walking her / pulling a wire) or click-by-click
      // targeting: the item stays centred on the player, no shadow.
      ui.placePreview = null;
      sit(w.player);
      return;
    }
    // The aim tracks the cursor ONLY while it is inside the operating radius.
    // Each in-radius frame we also remember the item's offset relative to her.
    // The moment the cursor leaves the radius we stop tracking it and hold that
    // frozen offset — the item keeps its relative position (still travelling
    // with her as she walks) until the cursor returns to the radius.
    const dx = ui.mouse[0] - w.player[0], dy = ui.mouse[1] - w.player[1];
    const dl = Math.hypot(dx, dy);
    let aim;
    if (dl < CONNECT_REACH) {
      if (dl > PLAYER_R) w.facing = [dx / dl, dy / dl];
      this._carryAim = [dx, dy];                  // remember relative offset
      aim = ui.mouse;
    } else if (this._carryAim) {
      aim = [w.player[0] + this._carryAim[0], w.player[1] + this._carryAim[1]];
    } else {
      aim = [...w.player];                        // no frozen offset yet → hug her
    }
    const place = this._resolvePlacement(aim);
    ui.placePreview = place;
    sit(place ? place.spot : w.player);   // nowhere legal → keep it on her
  }

  // Compute where the carried item would be set down if dropped right now,
  // given an aim point (the cursor). The returned spot is, by construction,
  // legal AND reachable: clear of every solid and other object, with an
  // unobstructed straight line from the player to it — which is why the commit
  // step needs no separate "in reach / not teleporting" test.
  //
  // Callers pass an in-radius aim (the live cursor while inside the ring, or the
  // frozen relative spot once it leaves), so the prediction lands the item right
  // at that aim, clamped to a legal, in-reach spot. The facing fallback (aim on
  // top of her / out of radius) hugs the player at `gap`.
  // Returns { carried, spot, type, elevated } or null when there is genuinely
  // no legal spot in reach.
  _resolvePlacement(aim) {
    const w = this.world;
    const carried = this._carriedKind();
    if (!carried || !w.player) return null;
    const r = objType(carried)?.radius ?? CONN_R;
    const P = w.player;
    const gap = PLAYER_R + r + 2;            // closest the centre may sit to her
    const maxD = Math.max(gap, CONNECT_REACH - 1);  // centre stays within reach

    // Inside the operating radius the cursor is a precise click target; outside
    // it E-logic takes over and the cursor is ignored entirely.
    const clickMode = dist(P, aim) < CONNECT_REACH;

    // Aim direction:
    //   • click-mode → toward the cursor (the precise target the click implies).
    //   • E-mode     → her eyes (facing). The cursor's position out here does
    //     NOT steer the drop, so a far-roaming cursor never drags the item; it
    //     stays put next to her, in the direction she is looking.
    let ux, uy, d;
    if (clickMode) {
      let dx = aim[0] - P[0], dy = aim[1] - P[1];
      d = Math.hypot(dx, dy);
      if (d < 1e-6) {                       // cursor on top of her → use facing
        const f = (w.facing && (w.facing[0] || w.facing[1])) ? w.facing : [0, 1];
        dx = f[0]; dy = f[1]; d = Math.hypot(dx, dy) || 1;
      }
      ux = dx / d; uy = dy / d;
    } else {
      const f = (w.facing && (w.facing[0] || w.facing[1])) ? w.facing : [0, 1];
      const fl = Math.hypot(f[0], f[1]) || 1;
      ux = f[0] / fl; uy = f[1] / fl;
      d = 0;                                // unused in E-mode (wantDist = gap)
    }

    // A carried connector can stack onto an empty box (elevated):
    //   • click-mode: the box directly under the cursor, if in reach + clear.
    //   • E-mode:     the empty in-reach box most aligned with the facing dir.
    if (carried === 'connector') {
      let boxPt = null;
      if (clickMode) {
        const tgt = this._targetUnder(aim[0], aim[1], w.carrying);
        if (tgt.type === 'box'
            && dist(P, tgt.point) < CONNECT_REACH
            && !w.reach_blocked(P, tgt.point)) boxPt = tgt.point;
      } else {
        const b = this._boxAheadForStack();
        if (b) boxPt = b;
      }
      if (boxPt) {
        return { carried, spot: [boxPt[0], boxPt[1]], type: 'box', elevated: true };
      }
    }

    // Ground placement. click-mode honours the cursor distance (land at the
    // cursor); the facing fallback hugs the player at `gap`. Either way the
    // resolver slides inward along the ray to the first clear, reachable spot,
    // sweeping clockwise as a fallback. The sim owns this geometry (placement_spot)
    // and guarantees a legal result.
    const wantDist = clickMode ? d : gap;
    const spot = w.placement_spot(P, ux, uy, r, gap, maxD, wantDist, w.carrying);
    if (!spot) return null;
    return { carried, spot, type: 'ground', elevated: false };
  }

  // The empty, in-reach box most aligned with the facing direction (within a
  // ~45° cone), or null. Used by the E-drop prediction to auto-stack a carried
  // connector onto a box it is pointed at.
  _boxAheadForStack() {
    const w = this.world;
    const f = (w.facing && (w.facing[0] || w.facing[1])) ? w.facing : [0, 1];
    const base = Math.atan2(f[1], f[0]);
    const norm = a => Math.atan2(Math.sin(a), Math.cos(a));
    let best = null, bestDiff = Math.PI / 4;   // 45° cone
    for (const b of w.boxes) {
      if (dist(w.player, b) >= CONNECT_REACH) continue;
      if (w.reach_blocked(w.player, b)) continue;
      const occupied = w.connectors().some(
        c => c.id !== w.carrying && c.elevated && dist(c.pos, b) < BOX_R);
      if (occupied) continue;
      const diff = Math.abs(norm(Math.atan2(b[1] - w.player[1], b[0] - w.player[0]) - base));
      if (diff < bestDiff) { best = b; bestDiff = diff; }
    }
    return best;
  }

  // Set the carried item down at an already-resolved placement (from
  // _resolvePlacement). The spot is guaranteed legal and reachable, so the only
  // rule still worth checking is the stacking table — and the resolver never
  // returns a target that violates it, so canPlace is just future-proofing.
  _commitPlacement(place) {
    const w = this.world;
    const ui = this.uiState;
    const carried = this._carriedKind();
    if (!carried) return false;
    if (!place) { this._setFlash(STR.flash.noRoom); this._beep(); return false; }
    if (!canPlace(carried, place.type)) { this._handsFull(); return false; }
    this._pushUndo();
    if (w.carrying) {
      const cid = w.carrying;
      w.nodes[cid].pos[0] = place.spot[0];
      w.nodes[cid].pos[1] = place.spot[1];
      // Only connectors ride on boxes; other devices always rest on the ground.
      w.nodes[cid].elevated = (carried === 'connector' && place.type === 'box');
      // A mine begins counting down the moment it is first set down.
      if (carried === 'mine') w.nodes[cid].fuse_running = true;
      w.carrying = null;
      ui.sel = null;
    } else {
      w.carry_box[0] = place.spot[0];
      w.carry_box[1] = place.spot[1];
      w.boxes.push(w.carry_box);
      w.carry_box = null;
    }
    ui.placePreview = null;
    ui.live = true; w.step(performance.now() / 1000);
    return true;
  }

  // Disallowed grab/stack while carrying: a beep and a brief notice, no change.
  _handsFull() {
    this._beep();
    this._setFlash(STR.flash.handsFull);
  }

  _beep() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!this._audioCtx) this._audioCtx = new Ctx();
      const ctx = this._audioCtx;
      if (ctx.state === 'suspended') ctx.resume();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.value = 196;
      const t = ctx.currentTime;
      gain.gain.setValueAtTime(0.06, t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.13);
    } catch (e) { /* audio unavailable — fail silently */ }
  }

  _nodeAt(x, y, kinds = null) {
    let best = null, bd = 18;
    for (const n of Object.values(this.world.nodes)) {
      if (kinds && !kinds.includes(n.kind)) continue;
      const d = dist([x,y], n.pos);
      if (d < bd) { best = n; bd = d; }
    }
    return best;
  }

  _draw() {
    // 2D render (always active)
    this.renderer2d.render(this.world, this.uiState);
    // Future: this.renderer3d?.render(this.world, this.uiState);
  }

  _updateStatus() {
    const w = this.world;
    const S = STR.status;
    const gatesList = w.ffs.map(ff => `${ff.id}: ${ff.is_open ? S.gateOpen : S.gateShut}`).join('  ');
    const gates = `${S.gatesLabel}: ${gatesList || S.none}`;
    const carried = `${S.sep}${this._carriedStatus()}`;
    const goal = w.at_goal() ? `${S.sep}${S.goalReached}` : '';
    let flash = '';
    if (this._flash) {
      if (performance.now() / 1000 < this._flash.until) flash = `${S.sep}${this._flash.text}`;
      else this._flash = null;
    }
    if (this.statusEl) this.statusEl.textContent = `${gates}${carried}${goal}${flash}`;
  }

  // A detailed read-out of whatever the player is currently carrying, for the
  // bottom status bar. Falls back to "hands empty" when not carrying.
  _carriedStatus() {
    const w = this.world;
    const S = STR.status;
    const kind = this._carriedKind();
    if (!kind) return S.empty;
    const name = STR.kinds[kind] || kind;
    if (kind === 'box') return S.carrying(name);

    const nd = w.carrying ? w.nodes[w.carrying] : null;
    const parts = [];
    if (kind === 'connector') {
      const emit = nd ? w.emit[nd.id] : null;
      parts.push(emit ? S.emits(emit) : S.emitsNone);
      const links = nd ? w.links_pairs.filter(([a, b]) => a === nd.id || b === nd.id).length : 0;
      parts.push(S.links(links));
      parts.push(this.uiState.sel === w.carrying ? S.armed : S.idle);
    } else if (kind === 'mine') {
      parts.push(S.fuse(nd ? nd.fuse : null));
    } else if (kind === 'rewirer') {
      parts.push(S.colour(nd ? nd.color : null));
    }
    const detail = parts.length ? `${name} — ${parts.join(', ')}` : name;
    return S.carrying(detail);
  }

  // Compute the hover tooltip for the item under the cursor. Suppressed while
  // carrying, dragging, targeting, or when a menu / reset overlay is up — those
  // modes have their own affordances and a tooltip would only add noise.
  _updateHover() {
    const w = this.world;
    const ui = this.uiState;
    ui.hover = null;
    if (ui.mode !== 'play') return;
    if (w.carrying || w.carry_box) return;
    if (this._drag.active || ui.targeting || ui.menu) return;
    if (ui.resetProgress > 0 || !ui.mouse) return;

    const hit = this._hoverTarget(ui.mouse[0], ui.mouse[1]);
    if (!hit) return;
    ui.hover = { pos: hit.pos, radius: hit.radius, lines: hit.lines };
  }

  // The topmost interesting thing under (x, y): a node, a box, the goal, or a
  // force field. Returns { pos, radius, lines } where lines drives the tooltip
  // card, or null when nothing is under the cursor.
  _hoverTarget(x, y) {
    const w = this.world;
    const T = STR.tooltip;
    const p = [x, y];

    // Player (drawn on top of everything).
    if (w.player && dist(p, w.player) < PLAYER_R + 4) {
      return { pos: [...w.player], radius: PLAYER_R + 2, lines: T.player(this._playerQuip) };
    }

    // Nodes first (they sit on top of boxes / the field).
    let node = null, nd = 18;
    for (const n of Object.values(w.nodes)) {
      const d = dist(p, n.pos);
      if (d < nd) { node = n; nd = d; }
    }
    if (node) {
      const lines = this._nodeTooltipLines(node);
      const radius = (objType(node.kind)?.radius ?? 13) + 2;
      return { pos: [node.pos[0], node.pos[1]], radius, lines };
    }

    // Boxes.
    let box = null, bd = BOX_R + 4;
    for (const bx of w.boxes) {
      const d = dist(p, bx);
      if (d < bd) { box = bx; bd = d; }
    }
    if (box) {
      const onBtn = Object.values(w.nodes).some(n => n.kind === 'button' && dist(box, n.pos) < 16);
      return { pos: [box[0], box[1]], radius: BOX_R + 2, lines: T.box(onBtn) };
    }

    // Goal star.
    if (w.goal && dist(p, w.goal) < 18) {
      return { pos: [w.goal[0], w.goal[1]], radius: 18, lines: T.goal() };
    }

    // Force fields (hit-test the segment).
    for (const ff of w.ffs) {
      if (pt_seg_dist(p, ff.p1, ff.p2) < 8) {
        const m = ff.mid();
        return { pos: [m[0], m[1]], radius: 10, lines: T.field(ff.is_open, ff.disabled) };
      }
    }
    return null;
  }

  // Build the tooltip lines for a node, reflecting its live state. A carriable
  // item also gets a short "pick up" hint as its last line.
  _nodeTooltipLines(node) {
    const w = this.world;
    const T = STR.tooltip;
    let lines;
    switch (node.kind) {
      case 'source':   lines = T.source(node.color); break;
      case 'receiver': {
        const active = w.active[node.id] ?? false;
        const lit = w.lit[node.id] ?? false;
        const state = T.recvState[active ? 'powered' : (lit ? 'charging' : 'idle')];
        lines = T.receiver(node.color, state);
        break;
      }
      case 'button':   lines = T.button(w.pressed[node.id] ?? false); break;
      case 'connector': {
        const emit = w.emit[node.id] ?? null;
        const links = w.links_pairs.filter(([a, b]) => a === node.id || b === node.id).length;
        lines = T.connector(emit, links, w._conn_elevated(node.id));
        break;
      }
      case 'mine':     lines = T.mine(node.fuse, node.fuse_running, node.disabled); break;
      case 'rewirer':  lines = T.rewirer(node.color); break;
      case 'jammer':   lines = T.jammer(); break;
      case 'and':      lines = T.and(w.logic_val[node.id] ?? false); break;
      case 'or':       lines = T.or(w.logic_val[node.id] ?? false); break;
      default:         lines = [STR.kinds[node.kind] || node.kind];
    }
    lines = [...lines];
    if (objType(node.kind)?.carriable && w.player && dist(w.player, node.pos) < CONNECT_REACH) {
      lines.push(T.pickHint);
    }
    return lines;
  }
}
