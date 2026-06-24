/**
 * Main application: game loop, mode switching, play interactions.
 *
 * Rendering architecture note: render2d drives the canvas 2D renderer now.
 * A future render3d.js can be imported and called alongside it in the same
 * loop with the same (world, uiState) contract, enabling simultaneous views.
 */

import { SPEED, TICK, PLAYER_R, BOX_R, CONN_R, CONNECT_REACH, FORGE_REACH, DWELL_THRESH, LOGIC_KINDS, WORLD_W, WORLD_H, ACCUM_FILL_SEC } from '../core/constants.js';
import { dist, pt_seg_dist, pointInRect, facingUnit } from '../core/geometry.js';
import { LEVELS } from '../sim/level.js';
import { Renderer2D } from './renderer2d.js';
import { InputHandler } from './input.js';
import { Panel } from './panel.js';
import { objType, isRelay } from '../sim/objects.js';
import { targetSpec, allIntentRays } from '../sim/targeting.js';
import { programSpec, programOptions, stampProgramDefaults, sameProgramValue } from '../sim/programming.js';
import { carriedRayType, visibilityPolygon, rayProfile } from '../sim/occlusion.js';
import { STR } from '../core/strings.js';

// How many rewind (undo) steps to retain, and how long the full-reset key
// must be held continuously (seconds) before the playfield is rebuilt. Both are
// honoured uniformly whether triggered from the keyboard or the tool panel.
const UNDO_MAX = 6;
const RESET_HOLD_SEC = 2;

// Long-press duration (ms) that opens the stack chooser (mouse or E key). Kept
// equal to the tree's AIM_HOLD_MS so every "operating hold" feels the same.
const MENU_HOLD_MS = 333;

// Press-and-hold timing for the golden-arrow wiring gesture (a press in the
// annulus while carrying a targeting device). At AIM_HOLD_MS the held press
// launches the golden arrow, which then keeps drawing until release — there is
// no further decision window. (Click-by-click targeting was removed: a click on
// a target while merely carrying now makes the intent directly. Programming
// lives at a Forge.)
const AIM_HOLD_MS = 333;

// Radius (world units) within which a click grabs the character to walk her.
// Smaller than the operating radius so a drag started off the character (but
// inside the operating ring) pulls a connection wire instead of moving her.
const PLAYER_GRAB_R = 11;

// Stacking rules (generalized form of the old STACK_RULES table): may an object
// of type `carried` be set down onto a target of type `onto`? Target types:
// 'ground', 'box' (empty), 'box+connector' (a box already carrying a connector),
// 'connector'. The relation is one-way by design and encodes exactly the old
// table, but keys the "rests on an empty box" case off isRelay so every relay
// sister (connector / inverter / mixer / any future one) is covered automatically
// — the previous explicit table silently omitted the mixer, which made dropping a
// carried mixer fail with "My hands are full". Rules:
//   • anything may be set on the ground;
//   • only a relay may rest on an EMPTY box;
//   • nothing rests on an already-occupied box, and nothing rests on a connector.
function canPlace(carried, onto) {
  if (onto === 'ground') return true;
  if (onto === 'box')    return isRelay(carried);
  return false;            // 'box+connector' or 'connector' — never
}

export class App {
  constructor(canvas, statusEl) {
    this.canvas = canvas;
    this.statusEl = statusEl;
    // Which level is loaded now (drives a full reset's rebuild and the level
    // overlay's "current" mark). The registry's first entry loads at startup —
    // currently Lorem's Puzzle #1 — and the world is built to match it.
    this._levelId = LEVELS[0].id;
    this.world = this._buildCurrentLevel();

    // Rendering — add more renderers here later (e.g. renderer3d)
    this.renderer2d = new Renderer2D(canvas);

    this.input = new InputHandler(canvas);
    this.input.onMouseDown = (pos, e) => this._onMouseDown(pos, e);
    this.input.onMouseMove = (pos, e) => this._onMouseMove(pos, e);
    this.input.onMouseUp   = (pos, e) => this._onMouseUp(pos, e);

    // Corner tool panel (DOM overlay above the canvas). It reports presses
    // through these callbacks; app.js owns all the resulting game state.
    this._panelResetSince = null;   // ms the panel Reset button has been held; null = up
    this.panel = new Panel(canvas.parentElement, {
      toggleTargets:   () => { this.uiState.panel.targets  = !this.uiState.panel.targets; },
      togglePassable:  () => { this.uiState.panel.passable = !this.uiState.panel.passable; },
      forge:           () => this._invokeForge(),
      discharge:       () => this._handleAction('discharge', performance.now() / 1000),
      beginReset:      () => { this._panelResetSince = performance.now(); },
      endReset:        () => { this._panelResetSince = null; },
      openLevels:      () => this._openLevelMenu(),
      undo:            () => this._rewind(),
    });

    this.uiState = {
      mode:    'play',   // 'play' | 'edit' (editor not yet implemented)
      sel:     null,     // selected connector id
      dwell:   0,
      live:    true,
      dirty:   false,
      pending: null,     // first point of a 2-click segment tool
      mouse:   [0, 0],
      resetProgress: 0,  // 0..1 fill of the full-reset hold (R)
      levelMenu: null,   // modal level-select overlay { items:[{id,name,current,rect}], panel } | null
      menu:    null,     // stack chooser { x, y, items:[{label,kind,...,rect}] }
      wireDrag: null,    // [x,y] cursor while pulling a wire from a carried connector
      placePreview: null,// live "shadow" of the carried item: { carried, spot, type, elevated }
      hover:   null,     // hover tooltip: { pos:[x,y], radius, lines:[...] } | null
      // Tool-panel sticky toggles. Alt/Ctrl XOR against these each frame to give
      // the effective `showTargets` / `showPassable` highlight flags below.
      panel:   { targets: false, passable: false },
      showTargets:   false,   // effective "highlight possible targets" this frame
      showPassable:  false,   // effective "highlight passable ray area" this frame
      targetHints:   null,    // [{ pos, reachable, radius }] | null
      passableRegion:null,    // visibility-polygon points | null
      // Control mode: when true (the default) the robot continuously faces the
      // mouse; when false, facing is driven only by the aim/drag gestures (the
      // original navigation mode). Toggled from the level menu; persisted.
      faceMouse:     this._loadPref('faceMouse', true),
    };

    // Mouse drag tracking
    this._drag = { active: false, kind: null, ref: null, moved: false, linkHit: null };

    // Golden-arrow wiring gesture: an annulus press-hold while carrying a
    // targeting device. { since, kind, branched } | null
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
    const nodePos = {}, elevated = {}, nodeState = {};
    for (const id in w.nodes) {
      const n = w.nodes[id];
      nodePos[id] = [...n.pos];
      if (isRelay(n.kind)) elevated[id] = !!n.elevated;
      // Mutable per-node fields: a recoloured/corrupted colour, an inverter pair,
      // a programmed fuse, the spent flag (a fired rewirer), and a Forge's
      // remaining uses. Capturing these makes recolour, fuse edits, corruption,
      // pair reprogramming, rewirer firing, and Forge spending all undoable.
      nodeState[id] = { color: n.color, pair: n.pair ? [...n.pair] : null, mode: n.mode, fuse: n.fuse, spent: !!n.spent, uses: n.uses };
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
      recolor_links: [...w.recolor_links],
      nodePos,
      elevated,
      nodeState,
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
    w.recolor_links = new Map(s.recolor_links ?? []);
    for (const id in s.nodePos) {
      const n = w.nodes[id];
      if (n) { n.pos[0] = s.nodePos[id][0]; n.pos[1] = s.nodePos[id][1]; }
    }
    if (s.elevated) for (const id in s.elevated) {
      if (w.nodes[id]) w.nodes[id].elevated = s.elevated[id];
    }
    if (s.nodeState) for (const id in s.nodeState) {
      const n = w.nodes[id];
      if (n) {
        n.color = s.nodeState[id].color; n.fuse = s.nodeState[id].fuse;
        n.pair = s.nodeState[id].pair ? [...s.nodeState[id].pair] : null;
        n.mode = s.nodeState[id].mode ?? n.mode;
        n.spent = !!s.nodeState[id].spent; n.uses = s.nodeState[id].uses;
      }
    }
    w.solve(true, false);   // cold solve also clears transient recolour charge
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

  // ---- full reset (2-second hold of R, or of the panel's Reset button) ----
  _updateResetHold() {
    const ui = this.uiState;
    // The modal level overlay blocks the reset hold (and everything else).
    if (ui.levelMenu) { ui.resetProgress = 0; this._resetConsumed = false; return; }
    // Whichever source began holding first drives the gauge; releasing both
    // clears the consumed flag so a later hold can fire again.
    const a = this.input.resetHeldSince;
    const b = this._panelResetSince;
    const since = a === null ? b : (b === null ? a : Math.min(a, b));
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

  // Reset all transient play state — selection, undo history, drag/aim gestures,
  // and any open menus / previews. Shared by a full reset and a level load; each
  // caller does its own world build + flash around this.
  _clearTransientPlayState() {
    const ui = this.uiState;
    ui.sel = null;
    ui.live = true;
    ui.dirty = false;
    ui.dwell = 0;
    this._undo = [];
    this._pushRun = false;
    this._drag = { active: false, kind: null, ref: null, moved: false, linkHit: null };
    this._aim = null;
    ui.menu = null;
    ui.levelMenu = null;
    ui.placePreview = null;
    ui.wireDrag = null;
  }

  _fullReset() {
    this.world = this._buildCurrentLevel();
    this.world.solve(true, false);
    this._clearTransientPlayState();
    this._setFlash(STR.flash.fullReset);
  }

  // Build a fresh world for whichever level is currently selected.
  _buildCurrentLevel() {
    const lvl = LEVELS.find(l => l.id === this._levelId) || LEVELS[0];
    return lvl.build();
  }

  // ---- level-select overlay ----
  // Lay the level entries as a centered vertical stack. The rects are stored on
  // uiState so the renderer draws and app.js hit-tests against the SAME geometry.
  // ---- persisted UI preferences (a real web game, so localStorage is fine) ----
  _loadPref(key, dflt) {
    try { const v = localStorage.getItem('rp_' + key); return v === null ? dflt : JSON.parse(v); }
    catch { return dflt; }
  }
  _savePref(key, val) {
    try { localStorage.setItem('rp_' + key, JSON.stringify(val)); } catch { /* storage off — keep in-memory */ }
  }

  // Face-mouse mode: every frame, point the robot's facing at the cursor. In the
  // other (original) mode this is a no-op and facing stays gesture-driven. Skipped
  // while a modal menu is up or outside play. Facing is cosmetic (eyes + the
  // placement direction fallback), so this needs no sim step — _draw runs each
  // frame and picks it up.
  _updateFacing() {
    const w = this.world, ui = this.uiState;
    if (!ui.faceMouse || ui.mode !== 'play' || ui.levelMenu || !w.player || !ui.mouse) return;
    const dx = ui.mouse[0] - w.player[0], dy = ui.mouse[1] - w.player[1];
    const d = Math.hypot(dx, dy);
    if (d > PLAYER_R) w.facing = [dx / d, dy / d];   // deadzone: hold facing when the cursor is on her
  }

  _openLevelMenu() {
    const IW = 320, IH = 42, GAP = 12, TITLE_H = 52, FOOT_H = 34, PAD = 22;
    const CTRL_H = 38, CTRL_GAP = 16;
    const n = LEVELS.length;
    const entriesH = n * IH + (n - 1) * GAP;
    const blockH = TITLE_H + entriesH + CTRL_GAP + CTRL_H + FOOT_H;
    const top = (WORLD_H - blockH) / 2;
    const left = (WORLD_W - IW) / 2;
    const items = LEVELS.map((l, i) => ({
      id: l.id,
      name: l.name,
      current: l.id === this._levelId,
      rect: [left, top + TITLE_H + i * (IH + GAP), IW, IH],
    }));
    const ctrlY = top + TITLE_H + entriesH + CTRL_GAP;
    this.uiState.levelMenu = {
      items,
      // A control toggle at the foot of the menu (the new face-mouse mode lives here).
      control: { key: 'faceMouse', rect: [left, ctrlY, IW, CTRL_H] },
      panel: [left - PAD, top - PAD, IW + 2 * PAD, blockH + 2 * PAD],
      titleY: top,
      footY: ctrlY + CTRL_H,
    };
  }

  // A click while the overlay is open: load the chosen level, or close the
  // overlay if the click misses every entry (a click outside cancels, like Esc).
  _handleLevelMenuClick(x, y) {
    const menu = this.uiState.levelMenu;
    if (!menu) return;
    // The control toggle: flip the mode, persist it, and keep the menu open.
    if (menu.control && pointInRect(x, y, menu.control.rect)) {
      this.uiState.faceMouse = !this.uiState.faceMouse;
      this._savePref('faceMouse', this.uiState.faceMouse);
      return;
    }
    for (const it of menu.items) {
      if (pointInRect(x, y, it.rect)) {
        this.uiState.levelMenu = null;
        this._loadLevel(it.id);
        return;
      }
    }
    // missed every entry → close (a click outside cancels)
    this.uiState.levelMenu = null;
  }

  // Load a level by id: rebuild the world and clear all transient play state
  // (mirrors a full reset, plus it remembers the new level for later resets).
  _loadLevel(id) {
    const lvl = LEVELS.find(l => l.id === id);
    if (!lvl) return;
    this._levelId = id;
    this.world = lvl.build();
    this.world.solve(true, false);
    this._clearTransientPlayState();
    this._setFlash(STR.flash.levelLoaded(lvl.name));
  }

  _setFlash(text, dur = 1.6) {
    this._flash = { text, until: performance.now() / 1000 + dur };
  }

  // ---- highlights (possible targets / passable ray area) ----
  // The "passable ray area" is the XOR of its sticky panel toggle and the
  // momentary key (Space), so holding the key turns it ON when the toggle is off
  // and SUPPRESSES it while held when the toggle is on. It only renders while
  // carrying an item that has the relevant ray.
  //
  // The "possible targets" contour is different: whenever a targeting device is
  // carried it ALWAYS shows a faint, dotted golden contour around what can be
  // targeted (so the affordance is never hidden). The "Targets" toggle (XOR'd
  // with Shift) does not create those contours — it makes them MORE visible
  // (bright rings, reachable vs. blocked distinguished). `showTargets` carries
  // that prominence flag through to the renderer.
  _updateHighlights() {
    const ui = this.uiState;
    const w = this.world;
    const targetsKey  = this.input.held.has('hl_targets');
    const passableKey = this.input.held.has('hl_passable');
    ui.showTargets  = ui.panel.targets  !== targetsKey;
    ui.showPassable = ui.panel.passable !== passableKey;
    ui.targetHints = null;
    ui.passableRegion = null;
    if (ui.mode !== 'play' || !w.player) return;
    const kind = this._carriedKind();

    // Always populate target hints for a carried targeting device — the renderer
    // draws them faint unless `showTargets` asks for the prominent version.
    if (w.carrying && objType(kind)?.requiresTarget) {
      const spec = targetSpec(kind);
      if (spec && spec.candidates) {
        ui.targetHints = spec.candidates(w, w.carrying, w.player).map(c => ({
          pos: c.pos,
          reachable: c.reachable,
          radius: objType(w.nodes[c.id]?.kind)?.radius ?? 13,
        }));
      }
    }

    if (ui.showPassable && (w.carrying || w.carry_box)) {
      const rt = carriedRayType(kind);
      if (rt) {
        // Exclude the player from blockers — the ray emanates from where she
        // stands, so her own body must not clip every outgoing direction.
        const profile = { ...rayProfile(rt), player: false };
        ui.passableRegion = visibilityPolygon(w, profile, w.player, [0, 0, WORLD_W, WORLD_H]);
      }
    }
  }

  // ---- tool panel ----
  // Push button states each frame and drive the polite fade-on-conflict.
  _updatePanel(nowMs) {
    const ui = this.uiState;
    const w = this.world;
    this.panel.refresh({
      targets:  ui.panel.targets,
      passable: ui.panel.passable,
      targetsFlip: this.input.held.has('hl_targets'),
      passFlip:    this.input.held.has('hl_passable'),
      canForge: this._canForge(),
      canDischarge: Boolean(w.carrying && w.nodes[w.carrying]?.kind === 'accumulator' && w.nodes[w.carrying]?.color),
      canUndo: this._undo.length > 0,
      resetProgress: ui.resetProgress ?? 0,
    });
    this.panel.setInert(Boolean(ui.levelMenu));
    this.panel.setConflict(this._panelConflict(), nowMs);
  }

  // The panel "overrides a currently targetable item" when, during the
  // golden-arrow link drag, the pointer is over the panel AND at least one live
  // target sits behind its footprint. That is the only situation in which the
  // panel is in the player's way, so it is the only one that triggers the fade.
  _panelConflict() {
    const inLinking = this._drag.active && this._drag.kind === 'wire';
    if (!inLinking) return false;
    if (!this.panel.isPointerOver()) return false;
    const cands = this._currentTargetCandidates();
    if (!cands.length) return false;
    const rect = this.panel.footprintRect();
    const cr = this.canvas.getBoundingClientRect();
    for (const c of cands) {
      const [sx, sy] = this.renderer2d.worldToScreen(c.pos[0], c.pos[1]);
      const cx = cr.left + sx, cy = cr.top + sy;     // world → client coords
      if (cx >= rect.left && cx <= rect.right && cy >= rect.top && cy <= rect.bottom) return true;
    }
    return false;
  }

  // Everything the carried targeting device could currently target — used by the
  // conflict check above. Spec-driven, so no per-kind code lives here.
  _currentTargetCandidates() {
    const w = this.world;
    const kind = this._carriedKind();
    if (w.carrying && objType(kind)?.requiresTarget) {
      const spec = targetSpec(kind);
      return spec && spec.candidates ? spec.candidates(w, w.carrying, w.player) : [];
    }
    return [];
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
    this._updateHighlights();
    this._updateFacing();
    this._updatePanel(ts);
    this._draw();
    this._updateStatus();
    this._scheduleFrame();
  }

  _tick(now) {
    const w = this.world;
    const ui = this.uiState;
    if (ui.mode !== 'play' || !w.player) return;

    // Modal level-select overlay: freeze the world (no movement, no sim step).
    // Still drain key actions so Escape can close it — every other queued action
    // is dropped, and held movement keys are simply ignored by returning here.
    if (ui.levelMenu) {
      for (const action of this.input.drainActions()) {
        if (action === 'escape') this._handleAction(action, now);
      }
      return;
    }

    const { held, hasFocus } = this.input;
    const vx = (held.has('right') ? 1 : 0) - (held.has('left') ? 1 : 0);
    const vy = (held.has('down')  ? 1 : 0) - (held.has('up')   ? 1 : 0);
    let moved = false;
    if ((vx || vy) && hasFocus) {
      const step = SPEED * TICK;
      const before = [...w.player];
      // Purple field: walking a carried object into it sets the object DOWN on
      // the near side (it never crosses the field) and she walks on empty-handed.
      // The sole exception is "careful manipulation" — when the cursor is inside
      // her activation ring she is positioning the item by hand, so the field just
      // blocks her as before and nothing is dropped.
      if ((w.carrying || w.carry_box)
          && dist(w.player, ui.mouse) >= CONNECT_REACH
          && w.blocked_by_purple(before, [before[0] + vx * step, before[1] + vy * step])) {
        this._commitPlacement(ui.placePreview || this._resolvePlacement(ui.mouse));
      }
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
    // Fire any rewirer whose charge has completed. Committed here (not in the
    // engine) so the recolour + destruction is a single undoable event.
    this._commitRecolors(now);
    this._commitFills(now);

    // Process one-shot key actions
    for (const action of this.input.drainActions()) {
      this._handleAction(action, now);
    }
  }

  _handleAction(action, now) {
    const w = this.world;
    const ui = this.uiState;
    if (action === 'carry_release') {
      // E released. If the hold already fired the chooser, swallow it.
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
      // C clears every intent of the carried targeting device, through its spec.
      // Any object that requires a target listens for C — connector links, a
      // jammer's jam mark, and so on. Objects with no target (a box, a mine)
      // ignore C entirely.
      const cid = w.carrying;
      const spec = targetSpec(this._carriedKind());
      if (cid && spec && spec.persistent) {
        this._pushUndo();
        spec.clear(w, cid);
        ui.live = true; w.step(now);
      }
    } else if (action === 'undo') {
      this._rewind();
    } else if (action === 'gates') {
      w.solve(true, false); ui.live = true;
    } else if (action === 'forge') {
      this._invokeForge();
    } else if (action === 'discharge') {
      // Q empties a carried accumulator. Carried-only and silent otherwise — like
      // the Forge menu, it does nothing (and shows nothing) unless the item is in
      // hand. Undoable; charge restarts from zero once it is empty again.
      const cid = w.carrying;
      const nd = cid ? w.nodes[cid] : null;
      if (nd && nd.kind === 'accumulator' && nd.color) {
        this._pushUndo();
        nd.color = null;
        ui.live = true; w.step(now);
        this._setFlash(STR.flash.accumDischarged);
      }
    } else if (action === 'escape') {
      // Escape closes the modal level overlay first; else an open chooser menu.
      if (ui.levelMenu) ui.levelMenu = null;
      else if (ui.menu) ui.menu = null;
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
    // Modal level overlay swallows all canvas interaction: a click on a level
    // entry loads it; a click elsewhere is ignored (only Escape leaves).
    if (this.uiState.levelMenu) {
      this._handleLevelMenuClick(x, y);
      this._press = null;
      this._drag = { active:false, kind:null, ref:null, moved:false, linkHit:null };
      return;
    }
    // Track the press for the long-hold chooser / aim-hold (resolved later).
    this._press = { active: true, t: performance.now(), x, y, moved: false, consumed: false };
    this._drag.moved = false;
    this._drag.linkHit = null;
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
      // aim-hold. At the 1/3-second mark _updateGestures either launches the
      // golden arrow (a targeting device) or swallows the press (anything else);
      // until then the placement shadow keeps previewing, and a quick release is
      // still a plain drop.
      this._aim = { since: performance.now(), kind: carriedKind, branched: false };
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
        // Auto-mark on pass-over while a device that opts into it (the connector)
        // is "ready" (selected). Spec-driven: same targetAt as the arrow, and the
        // same enables-only sweep — a character-drag wires exactly what a golden-
        // arrow sweep would, and never un-wires. Other carried devices never auto-mark.
        const dragSpec = targetSpec(this._carriedKind());
        if (dragSpec && dragSpec.dragAutoWire && ui.sel === cid) {
          const tgt = dragSpec.targetAt(w, cid, w.player[0], w.player[1]);
          const tid = tgt ? tgt.id : null;
          if (tid && tid !== this._drag.linkHit) {
            (dragSpec.sweepApply || dragSpec.apply)(w, cid, tid);
            this._drag.linkHit = tid;
          } else if (!tid) {
            this._drag.linkHit = null;
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
      // tracks the cursor. Marking on pass-over is entirely spec-driven: a
      // 'toggle' device flips a target each time the tip enters it, a 'set'
      // device keeps the last target swept. A device with no `sweep` (or no
      // persistent store) just draws the arrow.
      this._drag.moved = true;
      ui.wireDrag = [x, y];
      const cid = w.carrying;
      const spec = targetSpec(this._carriedKind());
      if (spec && spec.persistent && spec.sweep) {
        const tgt = spec.targetAt(w, cid, x, y);
        const tid = tgt ? tgt.id : null;
        if (tid && tid !== this._drag.linkHit) {
          // Enables-only: a sweep adds but never removes (see WIRE_SPEC.sweepApply).
          (spec.sweepApply || spec.apply)(w, cid, tid);
          // Commit one undo point per drag, the first time it actually changes
          // state (an enables-only sweep over an already-wired node is a no-op).
          if (!this._drag.committed && this._drag.preSnap && this._sig() !== this._drag.preSig) {
            this._pushUndo(this._drag.preSnap); this._drag.committed = true;
          }
          this._drag.linkHit = tid;
        } else if (!tid && spec.sweep === 'toggle') {
          this._drag.linkHit = null;          // left a target; re-entering re-adds (a no-op if already wired)
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
    // While the modal overlay is open, any release is inert (the down already
    // resolved or was swallowed).
    if (ui.levelMenu) {
      this._press = null; this._aim = null; ui.wireDrag = null;
      this._drag = { active:false, kind:null, ref:null, moved:false, linkHit:null };
      return;
    }
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

    // Empty-handed: pick something up. A quick click takes the top of the
    // stack; a hold on a real stack (2+ items) opens a chooser menu.
    if (!w.carrying && !w.carry_box) { this._clickPickup(x, y); return; }

    // Carrying a targeting device, a click is its targeting interaction (no
    // separate mode anymore):
    //   • a click ON a valid target MAKES / toggles the intent (link / jam /
    //     recolour) — apply is tried first so clicking a target that sits under
    //     its own ray marks it rather than erasing the ray (the jammer case);
    //   • a click on one of the CARRIED device's OWN intent rays, away from the
    //     item, ERASES that ray (scoped to `w.carrying`, so it only ever removes
    //     this device's own intents — never another device's);
    //   • anything else falls through to the drop test below.
    // The item's own footprint is excluded from the erase so a drop click isn't
    // read as wiping the wires emanating from it; the C key still clears them.
    if (objType(this._carriedKind())?.requiresTarget) {
      if (this._applyTargetIntent(x, y)) return;
      const itemPos = w.carrying ? w.nodes[w.carrying]?.pos : null;
      const guard = (objType(this._carriedKind())?.radius ?? CONN_R) + 4;
      const onItem = itemPos && dist([x, y], itemPos) <= guard;
      if (!onItem && this._deleteIntentAt(x, y, w.carrying)) return;
    }

    // Otherwise a brief click drops the item where the live preview shows it —
    // but only when the click lands INSIDE the operating ring. A click outside
    // the ring is purely an aim (it never drops); the E key is what commits an
    // out-of-ring drop (handled in carry_release).
    if (w.player && dist(w.player, [x, y]) < CONNECT_REACH) {
      this._commitPlacement(ui.placePreview || this._resolvePlacement([x, y]));
    }
  }

  // Fire every rewirer that has finished charging: apply its recolour to the
  // target and spend the rewirer (it vanishes). One undo snapshot covers the
  // batch, taken pre-fire — so undo reverts the recolour and un-spends the
  // rewirer, and its charge restarts from zero (cold-solve clears it).
  // Fill every accumulator that has finished charging: stamp its colour (it
  // becomes a portable source) and drop the link(s) that filled it. One pre-fill
  // undo snapshot covers the batch, so undo reverts the colour and restores the
  // link, and its charge restarts from zero (cold-solve clears it).
  // Shared "fire everything that just finished charging" scaffold: if anything is
  // ready, take ONE pre-action undo snapshot, apply `applyItem` to each, re-run
  // the sim, and flash. The early-out before the snapshot means an empty batch is
  // never an undo point.
  _commitReady(ready, applyItem, flash, now) {
    if (!ready.length) return;
    this._pushUndo();
    for (const item of ready) applyItem(item);
    this.uiState.live = true;
    this.world.step(now);
    this._setFlash(flash);
  }

  _commitFills(now) {
    const w = this.world;
    this._commitReady(w.ready_accumulators(), ({ id, color, feeders }) => {
      const nd = w.nodes[id];
      if (!nd || nd.kind !== 'accumulator') return;
      nd.color = color;                            // empty → charged: now a rank-0 portable source
      for (const f of (feeders || []))            // cut ONLY the feeder links; keep every other intent
        w.links.delete(w._link_key(id, f));
    }, STR.flash.accumFilled, now);
  }

  _commitRecolors(now) {
    const w = this.world;
    this._commitReady(w.ready_rewirers(), (rid) => {
      const rw = w.nodes[rid];
      const tid = w.recolor_links.get(rid);
      const tgt = tid ? w.nodes[tid] : null;
      if (tgt) tgt.color = rw.color;
      rw.spent = true;
      rw.recolor_charge = 0;
      w.clear_recolor(rid);
      if (this.uiState.sel === rid) this.uiState.sel = null;
    }, STR.flash.recolourDone, now);
  }

  // Delete the intent ray(s) under a click that belong to `ownerId` — the device
  // the player is carrying / targeting. A click only ever erases that device's OWN
  // intents (a connector's own wires, a jammer's own jam ray, …), never another
  // device's, so clicking a node B while carrying A removes A's intent toward B and
  // leaves B's other links untouched. The hit zone is a few world units wide; if
  // several of the device's rays share it, all go at once. Returns true if any did.
  _deleteIntentAt(x, y, ownerId) {
    const w = this.world;
    if (ownerId == null) return false;
    const THRESH = 6;
    const seen = new Set();
    const hits = [];
    for (const r of allIntentRays(w)) {
      if (!(r.owners && r.owners.includes(ownerId))) continue;   // only this device's own intents
      if (pt_seg_dist([x, y], r.from, r.to) > THRESH) continue;
      if (seen.has(r.key)) continue;          // a ray shared by two devices: once
      seen.add(r.key); hits.push(r);
    }
    if (hits.length === 0) return false;
    this._pushUndo();
    for (const r of hits) r.remove();
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
    const { pick, blocked } = this.world.nearestPickup();
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
      // Stamp a programmable device's default values on first pickup, generically
      // (every facet), so a fresh device is usable without opening its chooser.
      stampProgramDefaults(nd, programSpec(item.kind));
      if (item.kind === 'mine') nd.fuse_running = false;   // a carried mine isn't counting down
      if (item.kind === 'rewirer') nd.recolor_charge = 0;  // picking up cancels a pending recolour
      ui.sel = item.id;                    // armed (ready) by default
    } else {
      // Lift the box off the field; de-elevate any connector that rested on it.
      const idx = w.boxes.indexOf(item.box);
      if (idx !== -1) w.boxes.splice(idx, 1);
      for (const c of w.relays()) {
        if (c.elevated && dist(c.pos, item.box) < BOX_R) c.elevated = false;
      }
      w.carry_box = item.box;      // now rides with the player
      ui.sel = null;
    }
    ui.live = true; w.step(performance.now() / 1000);
    return true;
  }

  // ---- stack chooser menu ----
  // Lay the items as a vertical stack near (x, y), then clamp the whole block to
  // the playfield: it normally drops below the anchor, but flips to sit above it
  // when that would spill off the bottom (e.g. a Forge near the bottom edge), and
  // is nudged horizontally so it never runs past the left/right edges either.
  _openMenu(x, y, items) {
    const MW = 116, MH = 26, GAP = 4, MARGIN = 6, OFFSET = 14;
    const blockH = items.length * MH + (items.length - 1) * GAP;
    // Vertical: prefer below the anchor; flip above if it would overflow.
    let top = y + OFFSET;
    if (top + blockH > WORLD_H - MARGIN) {
      const above = y - OFFSET - blockH;
      top = above >= MARGIN ? above : WORLD_H - MARGIN - blockH;
    }
    top = Math.max(MARGIN, top);
    // Horizontal: centre on the anchor, clamped to stay fully on-screen.
    let left = x - MW / 2;
    left = Math.max(MARGIN, Math.min(left, WORLD_W - MW - MARGIN));
    const laid = items.map((it, i) => ({
      ...it,
      rect: [left, top + i * (MH + GAP), MW, MH],
    }));
    this.uiState.menu = { x, y, items: laid };
  }

  // ---- golden-arrow wiring gesture (annulus press-hold) ----
  // Resolved each frame: advance the aim-hold to its 1/3 s branch point, where a
  // held press either launches the golden arrow (a targeting device) or is
  // swallowed (anything else). There is no decision window anymore — once the
  // arrow is up it keeps drawing until release.
  _updateGestures() {
    const w = this.world;
    const now = performance.now();

    const a = this._aim;
    if (!a) return;
    const kind = this._carriedKind();
    const p = this._press;
    if (!kind || !w.player || !p || !p.active) { this._aim = null; return; }
    if (this._drag.active && this._drag.kind === 'player') { this._aim = null; return; }
    const reqT = !!(objType(kind) || {}).requiresTarget;

    // Branch point at 1/3 s. Programming lives at a Forge (F / the panel's Forge
    // button); click-by-click targeting was removed (a click on a target while
    // carrying makes the intent directly). So a held annulus press only ever
    // launches the golden-arrow wiring:
    //   • a targeting device launches the arrow, which then draws until release;
    //   • anything else (a programmable-only mine) is simply swallowed.
    if (!a.branched && now - a.since >= AIM_HOLD_MS) {
      a.branched = true;
      if (reqT) this._startAimArrow();
      else p.consumed = true;     // swallow: the release will not drop
      this._aim = null;           // hold resolved; the wire drag (if any) lives on its own
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

  // The programming sequence: a small chooser of values for the carried device,
  // anchored at the player (it is summoned by a key / button, not the cursor).
  // Generic: the spec supplies the choosable values and how each is labelled.
  // `forgeId` tags the menu so a chosen value spends that Forge a use.
  _openProgramming(kind, anchor, forgeId = null) {
    const spec = programSpec(kind);
    if (!spec) return false;
    const w = this.world;
    const nd = w.carrying ? w.nodes[w.carrying] : null;
    const forge = forgeId ? w.nodes[forgeId] : null;
    const canCorrupt = !forge || forge.corrupts !== false;   // omitted ⇒ corrupts
    // The framework yields the surviving options (no-ops dropped; corruptions
    // dropped at a clean-only Forge), each self-describing: its own field, label,
    // confirmation flash, and whether applying re-runs the sim.
    const opts = programOptions(spec, nd, { canCorrupt });
    const items = opts.map(o => ({
      label: STR.menu[o.labelKey](o.value),
      act: 'program',
      value: o.value,
      field: o.field,
      flashKey: o.flashKey,
      live: o.live,
    }));
    if (!items.length) return false;       // this Forge can change nothing here
    this._openMenu(anchor[0], anchor[1], items);
    if (this.uiState.menu) this.uiState.menu.forgeId = forgeId;
    return true;
  }

  // Summon the programming menu (F key / the panel's Forge button). It bites only
  // when the robot stands in EXACTLY ONE Forge's control area. Out of every
  // Forge's radius — or in the overlap of two or more — the press is silent (no
  // beep, no flash): overlapping control areas cancel out, so that shared region
  // offers no programming. In a sole Forge's area the usual feedback applies:
  // nothing programmable in hand, or that Forge is spent, each flash + beep. The
  // menu is anchored at the player (keyed, not aimed) and tagged with the Forge so
  // a chosen value spends a use and is gated by that Forge's corrupt capability.
  _invokeForge() {
    const w = this.world;
    const ui = this.uiState;
    if (ui.mode !== 'play' || !w.player) return;
    if (ui.menu) ui.menu = null;            // not a toggle — a fresh press reopens
    const inRange = w.forges().filter(f => dist(w.player, f.pos) < FORGE_REACH);
    if (inRange.length === 0) return;        // out of every Forge's area → silent
    // A spent Forge has no LIVE control area, so it never blocks: overlap counts
    // only Forges that still have uses. Standing where two live areas meet is the
    // dead zone — silent. One live area (even alongside a spent one) is fine.
    const usable = inRange.filter(f => (f.uses ?? 0) > 0);
    if (usable.length >= 2) return;          // overlap of live areas → silent
    const kind = this._carriedKind();
    if (!kind || !programSpec(kind)) { this._setFlash(STR.flash.notProgrammable); this._beep(); return; }
    if (usable.length === 0) { this._setFlash(STR.flash.forgeSpent); this._beep(); return; }
    // One live Forge: open its chooser. If that Forge can change nothing about the
    // carried item (e.g. a clean-only Forge facing an already-clean connector),
    // the chooser is empty — knock and say so rather than open a blank menu.
    if (!this._openProgramming(kind, [...w.player], usable[0].id)) {
      this._setFlash(STR.flash.forgeNoChange); this._beep();
    }
  }

  // Is programming available right now? Only with a programmable item in hand and
  // the robot in EXACTLY ONE live Forge's area (spent Forges and overlaps of live
  // areas both make it unavailable). Drives the panel's otherwise-hidden button.
  _canForge() {
    const w = this.world;
    const kind = this._carriedKind();
    if (!w.player || !kind || !programSpec(kind)) return false;
    const usable = w.forges().filter(f => (f.uses ?? 0) > 0 && dist(w.player, f.pos) < FORGE_REACH);
    return usable.length === 1;
  }

  // Resolve a menu action item. 'program' (set a value) is generic over the
  // carried device's spec; if the menu came from a Forge (`forgeId`), applying a
  // value spends one of that Forge's uses (the same undo step covers both).
  _runMenuAct(it, forgeId = null) {
    const w = this.world;
    const ui = this.uiState;
    const nd = w.carrying ? w.nodes[w.carrying] : null;
    if (it.act === 'program' && nd) {
      // Each program option is self-describing: it writes its own field. The firm
      // no-op rule still holds at apply time (a value equal to the current state
      // changes nothing and must not spend a Forge use).
      if (sameProgramValue(nd[it.field], it.value)) { this._beep(); return; }
      const forge = forgeId ? w.nodes[forgeId] : null;
      if (forgeId && (!forge || (forge.uses ?? 0) <= 0)) { this._beep(); return; }
      this._pushUndo();
      nd[it.field] = it.value;
      if (forge) forge.uses = Math.max(0, (forge.uses ?? 0) - 1);
      this._setFlash(STR.flash[it.flashKey](it.value));
      if (it.live) { ui.live = true; w.step(performance.now() / 1000); }
    }
  }

  // Apply a target intent for the carried device from a click at (x, y). Generic:
  // the carried kind's spec says what is targetable and how an intent is recorded.
  // Returns true if a valid target sat under the cursor (whether or not the effect
  // could apply) — the caller uses that to know a target was hit (so it neither
  // erases a ray nor drops the item). No per-kind branching lives here.
  _applyTargetIntent(x, y) {
    const w = this.world;
    const ui = this.uiState;
    const cid = w.carrying;
    if (!cid || !w.nodes[cid]) return false;
    const spec = targetSpec(this._carriedKind());
    if (!spec) return false;
    const tgt = spec.targetAt(w, cid, x, y);
    if (!tgt) return false;
    if (spec.persistent) this._pushUndo();
    spec.apply(w, cid, tgt.id);
    if (spec.persistent) { ui.live = true; w.step(performance.now() / 1000); }
    if (spec.flash && STR.flash[spec.flash]) this._setFlash(STR.flash[spec.flash]);
    return true;
  }

  _handleMenuClick(x, y) {
    const menu = this.uiState.menu;
    this.uiState.menu = null;
    if (!menu) return;
    for (const it of menu.items) {
      if (pointInRect(x, y, it.rect)) {
        if (it.act) this._runMenuAct(it, menu.forgeId); else this._pickItem(it);
        return;
      }
    }
    // clicked outside the menu → just cancel
  }

  // Each frame: a ~1/3 s long-press on the left mouse button OR the E key opens
  // the stack chooser, when the player is empty-handed and a stack is in reach.
  // The mouse targets the stack under the cursor; E targets the nearest in-reach
  // stack. While carrying, an E hold does nothing — but it IS consumed, so its
  // release never drops the item: only a brief E tap drops/places.
  _updateHoldMenu() {
    const ui = this.uiState;
    const now = performance.now();

    // E key hold
    const since = this.input.carryHeldSince;
    if (since !== this._prevCarrySince) {
      if (since !== null) this._carryConsumed = false;   // a fresh press began
      this._prevCarrySince = since;
    }
    if (!ui.menu && since !== null && !this._carryConsumed && now - since >= AIM_HOLD_MS) {
      if (this.world.carrying || this.world.carry_box) {
        // Carrying → a hold does nothing, but consume it so the release won't drop.
        this._carryConsumed = true;
      } else if (this._tryOpenMenuForE()) {
        // Empty-handed → the stack chooser (the only thing an E hold does).
        this._carryConsumed = true;
      }
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
    const loc = isRelay(items[0].kind) ? w.nodes[items[0].id].pos : items[0].box;
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
      const conn = w.relays().find(c => c.elevated && dist(c.pos, b) < BOX_R);
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
  // Returns { type, point } where type is one of the placement target kinds
  // canPlace understands ('ground' | 'box' | 'box+connector' | 'connector').
  _targetUnder(x, y, excludeId) {
    const w = this.world;
    let box = null, bd = BOX_R + 4;
    for (const bx of w.boxes) {
      const d = dist([x, y], bx);
      if (d < bd) { box = bx; bd = d; }
    }
    if (box) {
      const occupied = w.relays().some(
        c => c.id !== excludeId && c.elevated && dist(c.pos, box) < BOX_R);
      return { type: occupied ? 'box+connector' : 'box', point: [box[0], box[1]] };
    }
    let conn = null, cd = 16;
    for (const c of w.relays()) {
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
    if (this._drag.active) {
      // Active gesture (walking her / pulling the golden-arrow wire): the item
      // stays centred on the player, no shadow.
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
      [ux, uy] = facingUnit(w.facing);
      d = 0;                                // unused in E-mode (wantDist = gap)
    }

    // A carried connector can stack onto an empty box (elevated):
    //   • click-mode: the box directly under the cursor, if in reach + clear.
    //   • E-mode:     the empty in-reach box most aligned with the facing dir.
    if (isRelay(carried)) {
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
    const f = facingUnit(w.facing);
    const base = Math.atan2(f[1], f[0]);
    const norm = a => Math.atan2(Math.sin(a), Math.cos(a));
    let best = null, bestDiff = Math.PI / 4;   // 45° cone
    for (const b of w.boxes) {
      if (dist(w.player, b) >= CONNECT_REACH) continue;
      if (w.reach_blocked(w.player, b)) continue;
      const occupied = w.relays().some(
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
      w.nodes[cid].elevated = (isRelay(carried) && place.type === 'box');
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
    } catch { /* audio unavailable — fail silently */ }
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
    if (isRelay(kind)) {
      const emit = nd ? w.emit[nd.id] : null;
      parts.push(emit ? S.emits(emit) : S.emitsNone);
      const links = nd ? w.linkCount(nd.id) : 0;
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
    if (this._drag.active || ui.menu || ui.levelMenu) return;
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
        const links = w.linkCount(node.id);
        lines = T.connector(emit, links, w._conn_elevated(node.id), node.color);
        break;
      }
      case 'inverter': {
        const emit = w.emit[node.id] ?? null;
        const links = w.linkCount(node.id);
        lines = T.inverter(emit, links, w._conn_elevated(node.id), node.color, node.pair, node.mode);
        break;
      }
      case 'mixer': {
        const emit = w.emit[node.id] ?? null;
        const links = w.linkCount(node.id);
        lines = T.mixer(emit, links, w._conn_elevated(node.id));
        break;
      }
      case 'mine':     lines = T.mine(node.fuse, node.fuse_running, node.disabled); break;
      case 'accumulator': {
        const links = w.linkCount(node.id);
        const ch = node.color ? 1 : (w.engine.accum_charge[node.id] ?? 0) / ACCUM_FILL_SEC;
        lines = T.accumulator(node.color, links, Math.max(0, Math.min(1, ch)));
        break;
      }
      case 'rewirer':  lines = T.rewirer(node.color); break;
      case 'jammer':   lines = T.jammer(); break;
      case 'forge': {
        const inRange = Boolean(w.player && dist(w.player, node.pos) < FORGE_REACH);
        lines = T.forge(node.uses ?? 0, inRange);
        break;
      }
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
