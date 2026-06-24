/**
 * The corner tool panel — a small DOM overlay in the upper-left of the
 * playfield, sitting above the canvas. It is deliberately NOT drawn on the
 * canvas: real <button>s give accessible, themeable controls, and keeping the
 * panel in CSS space sidesteps the world↔screen transform for its own layout.
 *
 * It owns its DOM and a little presentation state (collapsed, faded). All game
 * meaning lives in app.js: the panel just reports button presses through the
 * callbacks in `actions` and reflects state pushed back via `refresh()`.
 *
 *   Buttons
 *     • Targets   — sticky toggle: a carried targeting device ALWAYS shows a
 *                   faint dotted contour around what it can target; this toggle
 *                   makes those contours more visible (and distinguishes
 *                   reachable from blocked). Inverted while Shift is held.
 *     • Ray reach — sticky toggle: highlight where its ray can travel.
 *     • Program   — hidden until a programmable item is carried in a Forge's
 *                   range; pressing it summons the programming menu (like F).
 *     • Reset     — press-and-hold (2 s) to rebuild the playfield.
 *     • Undo      — one rewind step.
 *
 *   Collapse: the header's chevron hides the body vertically (CSS max-height
 *   transition), leaving just the title bar.
 *
 *   Polite fade: app.js calls setConflict(true) when the panel is covering a
 *   currently-targetable item and the pointer is over the panel during the
 *   golden-arrow link drag. After ~1 s of sustained conflict the panel fades out
 *   (and stops intercepting pointer events, so the item beneath becomes
 *   reachable); it fades back the moment the conflict clears.
 */

import { STR } from '../core/strings.js';

const FADE_DELAY_MS = 1000;   // sustained-conflict time before the panel hides

export class Panel {
  // `parent` is the canvas wrapper (position: relative). `actions` carries the
  // callbacks into app.js.
  constructor(parent, actions) {
    this.actions = actions;
    this._collapsed = false;
    this._faded = false;
    this._conflictSince = null;
    // Last pointer position in client coords, tracked at the window level so
    // "is the pointer over the panel" stays correct even after the panel goes
    // pointer-events:none (which would otherwise stop mouseenter/leave firing
    // and make the fade oscillate).
    this._ptr = null;

    this._build(parent);
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('pointermove', e => { this._ptr = [e.clientX, e.clientY]; });
    }
  }

  _build(parent) {
    // No real DOM (headless tests / unusual hosts): construct inert. Every
    // public method below guards on `this.el`, so the panel simply does nothing.
    if (typeof document === 'undefined' || typeof document.createElement !== 'function'
        || !parent || typeof parent.appendChild !== 'function') {
      this.el = null; this.body = null; this.btn = {};
      return;
    }
    const P = STR.panel;
    const root = document.createElement('div');
    root.className = 'ui-panel';
    root.innerHTML = `
      <div class="ui-panel-head">
        <span class="ui-panel-title"></span>
        <button type="button" class="ui-panel-collapse" title="">▾</button>
      </div>
      <div class="ui-panel-body">
        <button type="button" class="ui-btn ui-toggle" data-act="targets"></button>
        <button type="button" class="ui-btn ui-toggle" data-act="passable"></button>
        <button type="button" class="ui-btn ui-forge" data-act="forge" hidden></button>
        <button type="button" class="ui-btn ui-discharge" data-act="discharge" hidden></button>
        <button type="button" class="ui-btn ui-hold" data-act="reset"><span class="ui-fill"></span><span class="ui-label"></span></button>
        <button type="button" class="ui-btn" data-act="undo"></button>
        <button type="button" class="ui-btn ui-levels" data-act="levels"></button>
      </div>`;
    parent.appendChild(root);
    this.el = root;
    this.body = root.querySelector('.ui-panel-body');

    root.querySelector('.ui-panel-title').textContent = P.title;
    const collapseBtn = root.querySelector('.ui-panel-collapse');
    collapseBtn.title = P.collapseHint;

    this.btn = {};
    for (const b of root.querySelectorAll('.ui-btn')) this.btn[b.dataset.act] = b;
    const label = (b, text, hint) => {
      const span = b.querySelector('.ui-label');
      if (span) span.textContent = text; else b.textContent = text;
      b.title = hint;
    };
    label(this.btn.targets,   P.targets,   P.targetsHint);
    label(this.btn.passable,  P.passable,  P.passableHint);
    label(this.btn.forge,     P.forge,     P.forgeHint);
    label(this.btn.discharge, P.discharge, P.dischargeHint);
    label(this.btn.reset,     P.reset,     P.resetHint);
    label(this.btn.undo,      P.undo,      P.undoHint);
    label(this.btn.levels,    P.levels,    P.levelsHint);

    // --- wiring ---
    collapseBtn.addEventListener('click', () => {
      this._collapsed = !this._collapsed;
      this.el.classList.toggle('collapsed', this._collapsed);
      collapseBtn.blur();
    });

    const click = (act, fn) => this.btn[act].addEventListener('click', e => {
      fn(); this.btn[act].blur();   // hand focus back so Space/Enter don't re-fire
    });
    click('targets',   () => this.actions.toggleTargets?.());
    click('passable',  () => this.actions.togglePassable?.());
    click('forge',     () => this.actions.forge?.());
    click('discharge', () => this.actions.discharge?.());
    click('undo',      () => this.actions.undo?.());
    click('levels',    () => this.actions.openLevels?.());

    // Reset is a press-and-hold (mirrors the R key). Pointer events cover mouse,
    // pen and touch uniformly; any release / leave / cancel ends the hold.
    const rb = this.btn.reset;
    const begin = e => { e.preventDefault(); this.actions.beginReset?.(); };
    const end   = () => this.actions.endReset?.();
    rb.addEventListener('pointerdown', begin);
    rb.addEventListener('pointerup', end);
    rb.addEventListener('pointerleave', end);
    rb.addEventListener('pointercancel', end);
    // A plain click on reset should do nothing (only the hold acts); swallow it.
    rb.addEventListener('click', e => { e.preventDefault(); rb.blur(); });
  }

  // Push current game state onto the buttons. `s` carries:
  //   targets, passable      sticky toggle prefs (button "on" state)
  //   targetsFlip, passFlip   true when a modifier is momentarily inverting it
  //   resetProgress           0..1 fill of the reset hold
  refresh(s) {
    if (!this.el) return;
    const set = (b, on) => b.classList.toggle('active', !!on);
    set(this.btn.targets,   s.targets);
    set(this.btn.passable,  s.passable);
    // A small dot cue when Shift/Space are flipping a toggle from its sticky value.
    this.btn.targets.classList.toggle('flip', !!s.targetsFlip);
    this.btn.passable.classList.toggle('flip', !!s.passFlip);
    // The Forge button is entirely hidden until programming is actually available
    // (a programmable item in hand, a Forge with uses in range); then it appears.
    this.btn.forge.hidden = !s.canForge;
    // The Discharge button mirrors the Forge button: entirely hidden until a
    // charged accumulator is actually in hand (carried-only, like Q); then it shows.
    this.btn.discharge.hidden = !s.canDischarge;
    this.btn.undo.disabled = !s.canUndo;
    const fill = this.btn.reset.querySelector('.ui-fill');
    if (fill) fill.style.width = `${Math.round((s.resetProgress ?? 0) * 100)}%`;
    this.btn.reset.classList.toggle('holding', (s.resetProgress ?? 0) > 0);
  }

  // Dim + disable the whole panel while the modal level overlay is open, so only
  // the overlay (and Escape) take input.
  setInert(inert) {
    if (!this.el) return;
    this.el.classList.toggle('inert', !!inert);
  }

  // Footprint of the panel in client coords (header-only when collapsed, since
  // the body collapses to zero height). Opacity-based fading does not change
  // layout, so this stays stable even while faded — no oscillation.
  footprintRect() {
    return this.el ? this.el.getBoundingClientRect() : { left: 0, top: 0, right: 0, bottom: 0 };
  }

  isPointerOver() {
    if (!this.el || !this._ptr) return false;
    const r = this.footprintRect();
    const [x, y] = this._ptr;
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }

  // Drive the polite fade. `conflict` is computed by app.js each frame.
  setConflict(conflict, nowMs = performance.now()) {
    if (!this.el) return;
    if (conflict) {
      if (this._conflictSince === null) this._conflictSince = nowMs;
      if (!this._faded && nowMs - this._conflictSince >= FADE_DELAY_MS) this._setFaded(true);
    } else {
      this._conflictSince = null;
      if (this._faded) this._setFaded(false);
    }
  }

  _setFaded(faded) {
    this._faded = faded;
    this.el.classList.toggle('faded', faded);
  }
}
