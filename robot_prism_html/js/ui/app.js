/**
 * Main application: game loop, mode switching, play interactions.
 *
 * Rendering architecture note: render2d drives the canvas 2D renderer now.
 * A future render3d.js can be imported and called alongside it in the same
 * loop with the same (world, uiState) contract, enabling simultaneous views.
 */

import { SPEED, TICK, PLAYER_R, BOX_R, CONN_R, CONNECT_REACH, DWELL_THRESH, LOGIC_KINDS } from '../core/constants.js';
import { dist } from '../core/geometry.js';
import { build_level } from '../sim/level.js';
import { Renderer2D } from './renderer2d.js';
import { InputHandler } from './input.js';

// How many rewind (undo) steps to retain, and how long the full-reset key
// must be held continuously (seconds) before the playfield is rebuilt.
const UNDO_MAX = 3;
const RESET_HOLD_SEC = 3;

// A mouse press shorter than this (ms) is a "click"; longer is a "hold".
const HOLD_MS = 250;

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
      // Face the direction of travel. (Boxes are no longer pushable, so a walk
      // never moves another object and is never itself an undo point.)
      if (moved) { const m = Math.hypot(vx, vy); w.facing = [vx / m, vy / m]; }
    }

    // Sync carried connector / box to the player
    if (w.carrying) {
      w.nodes[w.carrying].pos[0] = w.player[0];
      w.nodes[w.carrying].pos[1] = w.player[1];
      ui.dirty = true;
    }
    if (w.carry_box) {
      w.carry_box[0] = w.player[0];
      w.carry_box[1] = w.player[1];
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
    if (action === 'carry') {
      if (w.carrying || w.carry_box) {
        // Drop the carried item at the closest free spot in the facing
        // direction (clockwise fallback). See _dropCarriedDirectional().
        this._dropCarriedDirectional();
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
    this._downT = performance.now();         // for click-vs-hold on release
    this._drag.moved = false;
    this._drag.linkHit = null;
    if (w.player && dist([x,y], w.player) < 14) {
      // Capture a pre-drag snapshot + signature; committed to the undo stack
      // only if the drag actually changes the puzzle (a wire toggle or a box
      // push), so a drag that only walks the player is never an undo point.
      this._drag = {
        active: true, kind: 'player', ref: null, moved: false, linkHit: null,
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
  }

  _onMouseUp([x, y], e) {
    const w = this.world;
    const ui = this.uiState;
    if (this._drag.moved) {
      this._drag.active = false;
      ui.live = true; w.step(performance.now()/1000);
      return;
    }
    this._drag.active = false;
    const held = (performance.now() - (this._downT ?? performance.now())) >= HOLD_MS;
    if (ui.mode === 'play') this._playClick(x, y, held);
    ui.live = true; w.step(performance.now()/1000);
  }

  _dragPlayerTo(tx, ty) {
    const w = this.world;
    const fdx = tx - w.player[0], fdy = ty - w.player[1];
    const fd = Math.hypot(fdx, fdy);
    if (fd > 0.5) w.facing = [fdx / fd, fdy / fd];
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

  _playClick(x, y, held) {
    const w = this.world;
    const ui = this.uiState;

    // A click while a chooser menu is open resolves (or cancels) the menu.
    if (ui.menu) { this._handleMenuClick(x, y); return; }

    // Empty-handed: pick something up. A quick click takes the top of the
    // stack; a hold on a real stack (2+ items) opens a chooser menu.
    if (!w.carrying && !w.carry_box) { this._clickPickup(x, y, held); return; }

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
    }

    // Carrying a connector (not a link) or a box: set it down at the click.
    this._placeCarriedAt(x, y);
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

  // Empty-handed click: take the top item, or — on a hold over a 2+ stack —
  // open a chooser menu. Honors radius + no-teleport-through-barriers.
  _clickPickup(x, y, held) {
    const w = this.world;
    const items = this._stackAt(x, y);
    if (items.length === 0) return false;
    const loc = items[0].kind === 'connector' ? w.nodes[items[0].id].pos : items[0].box;
    if (dist(w.player, loc) >= CONNECT_REACH) return false;
    if (w.reach_blocked(w.player, loc)) { this._setFlash("Can't reach that — blocked"); return false; }
    if (held && items.length >= 2) { this._openMenu(loc[0], loc[1], items); return true; }
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

  // Set the carried object (connector or box) down at (x, y), classifying the
  // target and applying the stacking rules. Honors the no-teleport safeguards:
  // the drop point must be inside the active radius and reachable in a straight
  // line (no wall / force field / barrier between the player and the point).
  _placeCarriedAt(x, y) {
    const w = this.world;
    const ui = this.uiState;
    const carried = w.carrying ? 'connector' : (w.carry_box ? 'box' : null);
    if (!carried || !w.player) return false;
    const tgt = this._targetUnder(x, y, w.carrying);

    if (dist(w.player, tgt.point) >= CONNECT_REACH) { this._setFlash('Out of reach'); return false; }
    if (w.reach_blocked(w.player, tgt.point)) { this._setFlash("Can't place there — blocked"); return false; }
    if (!canPlace(carried, tgt.type)) { this._handsFull(); return false; }

    if (carried === 'connector') {
      const cid = w.carrying;
      if (tgt.type === 'box') {
        // Stack onto the (empty) box → elevated. The box's cell is clear of
        // anything else (it is material), so no extra room check is needed.
        this._pushUndo();
        w.nodes[cid].pos[0] = tgt.point[0];
        w.nodes[cid].pos[1] = tgt.point[1];
        w.nodes[cid].elevated = true;
      } else {
        // Ground placement — a connector is material, so it needs room.
        if (w.object_pos_blocked(tgt.point, CONN_R, { ignoreConn: cid })) {
          this._setFlash('No room there'); return false;
        }
        this._pushUndo();
        w.nodes[cid].pos[0] = tgt.point[0];
        w.nodes[cid].pos[1] = tgt.point[1];
        w.nodes[cid].elevated = false;
      }
      w.carrying = null;
      ui.sel = null;
    } else {
      if (w.object_pos_blocked(tgt.point, BOX_R)) { this._setFlash('No room there'); return false; }
      this._pushUndo();
      w.carry_box[0] = tgt.point[0];
      w.carry_box[1] = tgt.point[1];
      w.boxes.push(w.carry_box);
      w.carry_box = null;
    }
    ui.live = true; w.step(performance.now() / 1000);
    return true;
  }

  // Drop the carried item (connector or box) at the closest free spot in the
  // direction the player faces. If the facing spot is impossible, search
  // clockwise; if a whole ring is blocked, step farther out. A box must land
  // somewhere material-legal; a connector just needs a clear straight line and
  // avoids landing on a box (use a click to stack a connector onto a box).
  _dropCarriedDirectional() {
    const w = this.world;
    const carried = w.carrying ? 'connector' : (w.carry_box ? 'box' : null);
    if (!carried || !w.player) return false;

    // Auto-stack: if a carried connector faces a stackable (empty) box that is
    // in reach, E sets it onto that box's centre (elevated). Otherwise the
    // directional ground-drop below runs.
    if (carried === 'connector') {
      const box = this._boxAheadForStack();
      if (box) {
        const cid = w.carrying;
        this._pushUndo();
        w.nodes[cid].pos[0] = box[0];
        w.nodes[cid].pos[1] = box[1];
        w.nodes[cid].elevated = true;
        w.carrying = null;
        this.uiState.sel = null;
        this.uiState.live = true; w.step(performance.now() / 1000);
        return true;
      }
    }

    const r = carried === 'box' ? BOX_R : CONN_R;
    const f = (w.facing && (w.facing[0] || w.facing[1])) ? w.facing : [0, 1];
    const base = Math.atan2(f[1], f[0]);
    const gap = PLAYER_R + r + 2;
    const STEP_A = Math.PI / 12;   // 15°, clockwise (screen y points down)
    for (let extra = 0; extra <= r * 6; extra += r) {
      const radius = gap + extra;
      for (let k = 0; k < 24; k++) {
        const ang = base + k * STEP_A;
        const spot = [w.player[0] + Math.cos(ang) * radius,
                      w.player[1] + Math.sin(ang) * radius];
        // Everything material now (boxes and connectors): the spot must be
        // clear of all solids and other objects.
        if (!w.object_pos_blocked(spot, r, { ignoreConn: w.carrying })) {
          this._commitDrop(carried, spot); return true;
        }
      }
    }
    this._setFlash('No room to drop it');
    this._beep();
    return false;
  }

  // The empty, in-reach box most aligned with the facing direction (within a
  // ~45° cone), or null. Used by E to auto-stack a carried connector.
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

  _commitDrop(carried, spot) {
    const w = this.world;
    const ui = this.uiState;
    this._pushUndo();
    if (carried === 'connector') {
      const cid = w.carrying;
      w.nodes[cid].pos[0] = spot[0];
      w.nodes[cid].pos[1] = spot[1];
      w.nodes[cid].elevated = false;   // dropped on the ground
      w.carrying = null;
      ui.sel = null;
    } else {
      w.carry_box[0] = spot[0];
      w.carry_box[1] = spot[1];
      w.boxes.push(w.carry_box);
      w.carry_box = null;
    }
    ui.live = true; w.step(performance.now() / 1000);
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
