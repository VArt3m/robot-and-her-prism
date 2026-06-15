/**
 * Main application: game loop, mode switching, play interactions.
 *
 * Rendering architecture note: render2d drives the canvas 2D renderer now.
 * A future render3d.js can be imported and called alongside it in the same
 * loop with the same (world, uiState) contract, enabling simultaneous views.
 */

import { SPEED, TICK, BOX_R, CONNECT_REACH, DWELL_THRESH, LOGIC_KINDS } from '../core/constants.js';
import { dist } from '../core/geometry.js';
import { build_level } from '../sim/level.js';
import { Renderer2D } from './renderer2d.js';
import { InputHandler } from './input.js';

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
    };

    // Mouse drag tracking
    this._drag = { active: false, kind: null, ref: null, moved: false, linkHit: null };

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

  _scheduleFrame() {
    this._frameId = requestAnimationFrame(ts => this._frame(ts));
  }

  _frame(ts) {
    const now = ts / 1000;
    if (this._lastTick === null) this._lastTick = now;
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
    }

    // Sync carried connector to player
    if (w.carrying) {
      w.nodes[w.carrying].pos[0] = w.player[0];
      w.nodes[w.carrying].pos[1] = w.player[1];
      ui.dirty = true;
    }

    // Drop selection if out of reach
    if (ui.sel && !this._inReach(ui.sel)) ui.sel = null;

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
      if (w.carrying) {
        const cid = w.carrying;
        let best = null, bd = BOX_R + 8 + 8; // PLAYER_R
        for (const bx of w.boxes) {
          const d = dist(w.player, bx);
          if (d < bd) { best = bx; bd = d; }
        }
        if (best) { w.nodes[cid].pos[0] = best[0]; w.nodes[cid].pos[1] = best[1]; }
        w.carrying = null;
      } else {
        let best = null, bd = 30;
        for (const n of w.connectors()) {
          const d = dist(w.player, n.pos);
          if (d < bd && !w.reach_blocked(w.player, n.pos)) { best = n; bd = d; }
        }
        if (best) w.carrying = best.id;
      }
      ui.live = true; w.step(now);
    } else if (action === 'clear') {
      if (ui.sel && this._inReach(ui.sel)) {
        w.clear_links_of(ui.sel); ui.live = true; w.step(now);
      }
    } else if (action === 'reset') {
      w.player = [...w.player_start]; w.carrying = null;
      w.solve(true, false); ui.live = true;
    } else if (action === 'gates') {
      w.solve(true, false); ui.live = true;
    }
  }

  _inReach(nid) {
    const w = this.world;
    if (w.carrying === nid) return true;
    return Boolean(w.player && dist(w.player, w.nodes[nid].pos) < CONNECT_REACH);
  }

  // ---- mouse ----
  _onMouseDown([x, y], e) {
    const w = this.world;
    this._drag.moved = false;
    this._drag.linkHit = null;
    if (w.player && dist([x,y], w.player) < 14) {
      this._drag = { active:true, kind:'player', ref:null, moved:false, linkHit:null };
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
        // Toggle link when dragged connector passes over a node (debounced)
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
    if (ui.mode === 'play') this._playClick(x, y);
    ui.live = true; w.step(performance.now()/1000);
  }

  _dragPlayerTo(tx, ty) {
    const w = this.world;
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
    if (ui.sel && !this._inReach(ui.sel)) ui.sel = null;
    const n = this._nodeAt(x, y);
    if (!n) { ui.sel = null; return; }
    if (n.kind === 'connector') {
      if (ui.sel && ui.sel !== n.id) {
        w.toggle_link(ui.sel, n.id);
      } else if (ui.sel === n.id) {
        ui.sel = null;
      } else if (this._inReach(n.id)) {
        ui.sel = n.id;
      }
    } else if (ui.sel) {
      w.toggle_link(ui.sel, n.id);
    }
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
    if (this.statusEl) this.statusEl.textContent = `gates: ${gates}${goal}`;
  }
}
