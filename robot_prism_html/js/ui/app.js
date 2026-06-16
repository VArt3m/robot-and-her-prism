/**
 * Main application: game loop, mode switching, play interactions.
 *
 * Rendering architecture note: render2d drives the canvas 2D renderer now.
 * A future render3d.js can be imported and called alongside it in the same
 * loop with the same (world, uiState) contract, enabling simultaneous views.
 */

import { SPEED, TICK, PLAYER_R, BOX_R, CONN_R, CONNECT_REACH, DWELL_THRESH, LOGIC_KINDS } from '../core/constants.js';
import { dist, pt_seg_dist } from '../core/geometry.js';
import { build_level } from '../sim/level.js';
import { Renderer2D } from './renderer2d.js';
import { InputHandler } from './input.js';
import { objType } from '../sim/objects.js';

// How many rewind (undo) steps to retain, and how long the full-reset key
// must be held continuously (seconds) before the playfield is rebuilt.
const UNDO_MAX = 3;
const RESET_HOLD_SEC = 3;

// Long-press duration (ms) that opens the stack chooser (mouse or E key).
const MENU_HOLD_MS = 500;

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
    };

    // Mouse drag tracking
    this._drag = { active: false, kind: null, ref: null, moved: false, linkHit: null };

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
    return `${w.carrying}#${w.carry_box ? 'B' : '-'}#${boxes}#${links}#${logic}`;
  }

  // Push a pre-action snapshot, keeping at most UNDO_MAX of them.
  _pushUndo(snap = null) {
    this._undo.push(snap ?? this._captureState());
    while (this._undo.length > UNDO_MAX) this._undo.shift();
  }

  _rewind() {
    const ui = this.uiState;
    if (this._undo.length === 0) { this._setFlash('Nothing to rewind'); return; }
    const snap = this._undo.pop();
    this._restoreState(snap);
    ui.sel = null;
    ui.live = true;
    this._pushRun = false;
    const left = this._undo.length;
    this._setFlash(`Rewound — ${left} step${left === 1 ? '' : 's'} left`);
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
    this._setFlash('Playfield fully reset');
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
      // E released. If the hold already opened the chooser, consume it silently.
      if (this._carryConsumed) return;
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
      if (ui.sel && ui.sel === w.carrying) {
        this._pushUndo();
        w.clear_links_of(ui.sel); ui.live = true; w.step(now);
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
    // Track the press for the long-hold chooser (resolved in _onMouseUp).
    this._press = { active: true, t: performance.now(), x, y, moved: false, consumed: false };
    this._drag.moved = false;
    this._drag.linkHit = null;
    const dp = w.player ? dist([x, y], w.player) : Infinity;
    const carriedKind = w.carrying ? 'connector' : (w.carry_box ? 'box' : null);
    const carriedAimable = Boolean(carriedKind && objType(carriedKind)?.requiresTarget);
    if (w.player && dp < PLAYER_GRAB_R) {
      // Inner radius → grab the character to walk her. Capture a pre-drag
      // snapshot + signature; committed to the undo stack only if the drag
      // actually changes the puzzle (a wire toggle or a box push), so a drag
      // that only walks the player is never an undo point.
      this._drag = {
        active: true, kind: 'player', ref: null, moved: false, linkHit: null,
        preSnap: this._captureState(), preSig: this._sig(), committed: false,
      };
    } else if (w.player && carriedAimable && dp < CONNECT_REACH) {
      // Outer operating radius (off the character) while carrying an item that
      // needs a target → pull a connection wire out, without moving her.
      this._drag = {
        active: true, kind: 'wire', ref: null, moved: false, linkHit: null,
        preSnap: this._captureState(), preSig: this._sig(), committed: false,
      };
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
        // Auto-wire on pass-over only while the connector is "ready" (selected).
        // Toggled off-ready, a drag just repositions without rewiring.
        if (ui.sel === cid) {
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
      // Pull a connection wire from the carried connector to a target node.
      // The character does not move; only the wire endpoint tracks the cursor.
      this._drag.moved = true;
      ui.wireDrag = [x, y];
      const cid = w.carrying;
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
    const consumed = this._press && this._press.consumed;   // hold opened a menu
    this._press = null;
    ui.wireDrag = null;
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

    // Empty-handed: pick something up. A quick click takes the top of the
    // stack; a hold on a real stack (2+ items) opens a chooser menu.
    if (!w.carrying && !w.carry_box) { this._clickPickup(x, y); return; }

    // Carrying a connector: operate it.
    if (w.carrying) {
      const cid = w.carrying;
      // Click the carried connector itself (on the player) → toggle ready.
      if (dist([x, y], w.player) < CONN_R + 4) {
        ui.sel = (ui.sel === cid) ? null : cid;
        return;
      }
      // Ready + click a node → program a link (aim). Not distance-limited.
      const n = this._nodeAt(x, y);
      if (ui.sel === cid && n && n.id !== cid) {
        this._pushUndo();
        w.toggle_link(cid, n.id);
        ui.live = true; w.step(performance.now() / 1000);
        return;
      }
      // Click on an existing intent ray (away from any node) → delete it.
      if (!n && this._deleteIntentAt(x, y)) return;
    }

    // Carrying a connector (not a link) or a box: set it down. A click predicts
    // the same shadow the cursor was previewing — the item lands at the legal,
    // in-reach spot in that direction, never across a wall.
    this._commitPlacement(this._resolvePlacement([x, y]));
  }

  // Delete the intent ray(s) under a click while carrying a connector. The hit
  // zone is a few world units wide (no single-pixel hunting); if several rays
  // share the zone, all of them are removed at once. Returns true if any were.
  _deleteIntentAt(x, y) {
    const w = this.world;
    const THRESH = 6;
    const hits = [];
    for (const [a, b] of w.links_pairs) {
      const na = w.nodes[a], nb = w.nodes[b];
      if (!na || !nb) continue;
      if (pt_seg_dist([x, y], na.pos, nb.pos) <= THRESH) hits.push([a, b]);
    }
    if (hits.length === 0) return false;
    this._pushUndo();
    for (const [a, b] of hits) w.toggle_link(a, b);
    this.uiState.live = true; w.step(performance.now() / 1000);
    return true;
  }

  // The pickable items under (x, y), top of the stack first. The only stack
  // type today is a box with a connector resting on it → [connector, box].
  _stackAt(x, y) {
    const w = this.world;
    let conn = null, cd = 16;
    for (const c of w.connectors()) {
      const d = dist([x, y], c.pos);
      if (d < cd) { conn = c; cd = d; }
    }
    let box = null, bd = BOX_R + 4;
    for (const bx of w.boxes) {
      const d = dist([x, y], bx);
      if (d < bd) { box = bx; bd = d; }
    }
    const items = [];
    if (conn) {
      const lbl = (w.nodes[conn.id].label || '').trim();
      items.push({ kind: 'connector', id: conn.id, label: lbl ? `Connector ${lbl}` : 'Connector' });
    }
    if (box) items.push({ kind: 'box', box, label: 'Box' });
    return items;            // top (connector) first, box underneath
  }

  // Empty-handed click: take the top item under the cursor. (The stack chooser
  // is opened by a long hold instead — see _updateHoldMenu.)
  _clickPickup(x, y) {
    const w = this.world;
    const items = this._stackAt(x, y);
    if (items.length === 0) return false;
    const loc = items[0].kind === 'connector' ? w.nodes[items[0].id].pos : items[0].box;
    if (dist(w.player, loc) >= CONNECT_REACH) return false;
    if (w.reach_blocked(w.player, loc)) { this._setFlash("Can't reach that — blocked"); return false; }
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
    for (const c of w.connectors()) consider(c.pos, { kind: 'connector', id: c.id });
    for (const bx of w.boxes) {
      const occupied = w.connectors().some(c => dist(c.pos, bx) < BOX_R);
      if (!occupied) consider(bx, { kind: 'box', box: bx });
    }
    if (!pick) { if (blocked) this._setFlash("Can't reach that — blocked"); return false; }
    return this._pickItem(pick);
  }

  // Take a specific item into the player's hands (enforces the single-item rule).
  _pickItem(item) {
    const w = this.world;
    const ui = this.uiState;
    if (w.carrying || w.carry_box) { this._handsFull(); return false; }
    this._pushUndo();
    if (item.kind === 'connector') {
      w.carrying = item.id;
      w.nodes[item.id].elevated = false;   // carried — not on a box anymore
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

  _handleMenuClick(x, y) {
    const menu = this.uiState.menu;
    this.uiState.menu = null;
    if (!menu) return;
    for (const it of menu.items) {
      const [rx, ry, rw, rh] = it.rect;
      if (x >= rx && x <= rx + rw && y >= ry && y <= ry + rh) { this._pickItem(it); return; }
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
    if (!ui.menu && since !== null && !this._carryConsumed && now - since >= MENU_HOLD_MS) {
      if (this._tryOpenMenuForE()) this._carryConsumed = true;
    }

    // Left mouse hold
    const p = this._press;
    if (!ui.menu && p && p.active && !p.consumed && !p.moved && now - p.t >= MENU_HOLD_MS) {
      if (this._tryOpenMenuAt(p.x, p.y)) p.consumed = true;
    }
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
      { kind: 'connector', id: best.conn.id, label: 'Connector' },
      { kind: 'box', box: best.box, label: 'Box' },
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
    if (this._drag.active) {
      // Active gesture: the drag handlers keep the item on the player.
      ui.placePreview = null;
      sit(w.player);
      return;
    }
    // Aim at the cursor. Her eyes follow it ONLY while it is inside the
    // operating radius (mouse-placement). Outside it, E-logic holds: her gaze
    // freezes, and the held item stays put in that direction instead of
    // chasing the far cursor.
    const aim = ui.mouse;
    const dx = aim[0] - w.player[0], dy = aim[1] - w.player[1];
    const dl = Math.hypot(dx, dy);
    if (dl > PLAYER_R && dl < CONNECT_REACH) w.facing = [dx / dl, dy / dl];
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
  // The prediction follows whichever action the cursor position implies:
  //   • cursor OUTSIDE the operating radius  → predict the E-drop: the item is
  //     set down right next to her, in the direction she is looking (facing).
  //     Drawn SOLID (translucent === false); the cursor out here is ignored.
  //   • cursor INSIDE the operating radius   → predict the mouse-click drop: the
  //     item lands right at the cursor (clamped to a legal, in-reach spot).
  //     Drawn TRANSLUCENT, a ghost of where a click would set it.
  // Returns { carried, spot, type, elevated, translucent } or null when there
  // is genuinely no legal spot in reach.
  _resolvePlacement(aim) {
    const w = this.world;
    const carried = w.carrying ? 'connector' : (w.carry_box ? 'box' : null);
    if (!carried || !w.player) return null;
    const r = carried === 'box' ? BOX_R : CONN_R;
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
        return { carried, spot: [boxPt[0], boxPt[1]], type: 'box',
                 elevated: true, translucent: clickMode };
      }
    }

    // Ground placement. click-mode honours the cursor distance (land at the
    // cursor); E-mode hugs the player — the closest legal spot — in the facing
    // direction, so an E-drop sets the item down right next to her rather than
    // flung out toward a distant cursor. Either way the resolver slides inward
    // along the ray to the first clear, reachable spot, sweeping clockwise as a
    // fallback. The simulation layer owns this geometry (Motion.placement_spot)
    // and guarantees a legal result.
    const wantDist = clickMode ? d : gap;
    const spot = w.placement_spot(P, ux, uy, r, gap, maxD, wantDist, w.carrying);
    if (!spot) return null;
    return { carried, spot, type: 'ground', elevated: false, translucent: clickMode };
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
    const carried = w.carrying ? 'connector' : (w.carry_box ? 'box' : null);
    if (!carried) return false;
    if (!place) { this._setFlash('No room to set it down'); this._beep(); return false; }
    if (!canPlace(carried, place.type)) { this._handsFull(); return false; }
    this._pushUndo();
    if (carried === 'connector') {
      const cid = w.carrying;
      w.nodes[cid].pos[0] = place.spot[0];
      w.nodes[cid].pos[1] = place.spot[1];
      w.nodes[cid].elevated = (place.type === 'box');
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
    this._setFlash('My hands are full');
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
    const gates = w.ffs.map(ff => `${ff.id}: ${ff.is_open ? 'open' : 'shut'}`).join('  ');
    const goal = w.at_goal() ? '   *** GOAL REACHED ***' : '';
    let flash = '';
    if (this._flash) {
      if (performance.now() / 1000 < this._flash.until) flash = `   —   ${this._flash.text}`;
      else this._flash = null;
    }
    if (this.statusEl) this.statusEl.textContent = `gates: ${gates}${goal}${flash}`;
  }
}
