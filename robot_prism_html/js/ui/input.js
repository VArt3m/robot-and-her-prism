/**
 * Keyboard and mouse input handler.
 * Exposes a plain state object; app.js reads it each tick.
 */

const KEY_MAP = {
  'KeyW': 'up',    'ArrowUp':    'up',
  'KeyS': 'down',  'ArrowDown':  'down',
  'KeyA': 'left',  'ArrowLeft':  'left',
  'KeyD': 'right', 'ArrowRight': 'right',
  'KeyE': 'carry',
  'KeyC': 'clear',
  'KeyR': 'reset',
  'KeyG': 'gates',
  'KeyZ': 'undo',
};

export class InputHandler {
  constructor(canvas) {
    this.canvas = canvas;

    // Persistent state (held keys, mouse pos)
    this.held = new Set();
    this.mouse = [0, 0];
    this.hasFocus = true;

    // Timestamp (ms) when the reset key was pressed; null when not held.
    // app.js uses this to require a continuous 3-second hold for a full reset.
    this.resetHeldSince = null;

    // Timestamp (ms) when E was pressed; null when not held. app.js uses this
    // for the ~1/3-second hold that, while carrying, fires the targeting/
    // programming tree, and while empty-handed opens the stack chooser; the
    // pick-up / drop / exit fires on release via the 'carry_release' action.
    this.carryHeldSince = null;

    // Set by App to convert CSS canvas coords → world coords.
    // If null, raw CSS coords are used (fallback for tests / headless).
    this.toWorld = null;

    // One-shot action queue — consumed once per tick by app.js
    this._actions = [];

    // Mouse event callbacks (set by app.js)
    this.onMouseDown = null;
    this.onMouseMove = null;
    this.onMouseUp   = null;

    this._bind();
  }

  _bind() {
    window.addEventListener('keydown', e => {
      if (e.repeat) return;
      const action = KEY_MAP[e.code];
      if (!action) return;
      if (['up','down','left','right'].includes(action)) {
        this.held.add(action);
      } else if (action === 'reset') {
        // Full reset is a timed hold, not a one-shot tap (handled in app.js).
        if (this.resetHeldSince === null) this.resetHeldSince = performance.now();
      } else if (action === 'carry') {
        // E is a timed hold too: a long hold opens the chooser; the pick-up /
        // drop fires on release.
        if (this.carryHeldSince === null) this.carryHeldSince = performance.now();
      } else {
        this._actions.push(action);
      }
      // Prevent page scroll on arrows/space
      if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight',' '].includes(e.code)) e.preventDefault();
    });

    window.addEventListener('keyup', e => {
      const action = KEY_MAP[e.code];
      if (action) this.held.delete(action);
      if (action === 'reset') this.resetHeldSince = null;
      if (action === 'carry') { this.carryHeldSince = null; this._actions.push('carry_release'); }
    });

    window.addEventListener('blur', () => {
      this.held.clear();
      this.hasFocus = false;
      this.resetHeldSince = null;
      this.carryHeldSince = null;
    });

    window.addEventListener('focus', () => { this.hasFocus = true; });

    this.canvas.addEventListener('mousedown', e => {
      const pos = this._canvasPos(e);
      this.onMouseDown?.(pos, e);
    });

    this.canvas.addEventListener('mousemove', e => {
      const pos = this._canvasPos(e);
      this.mouse = pos;
      this.onMouseMove?.(pos, e);
    });

    this.canvas.addEventListener('mouseup', e => {
      const pos = this._canvasPos(e);
      this.onMouseUp?.(pos, e);
    });

    // Touch = mouse: a single finger is routed through the same down/move/up
    // callbacks so every drag/press gesture works identically on touchscreens.
    // We track only the first active finger (id in this._touchId) and ignore the
    // rest, so a stray second touch never hijacks an in-progress drag. preventDefault
    // stops page scroll/zoom and the synthetic mouse events the browser would
    // otherwise fire after a tap (which would double-handle the gesture).
    this._touchId = null;

    this.canvas.addEventListener('touchstart', e => {
      if (this._touchId !== null) return;      // already tracking a finger
      const t = e.changedTouches[0];
      if (!t) return;
      this._touchId = t.identifier;
      const pos = this._canvasPos(t);
      this.mouse = pos;
      e.preventDefault();
      this.onMouseDown?.(pos, e);
    }, { passive: false });

    this.canvas.addEventListener('touchmove', e => {
      const t = this._activeTouch(e);
      if (!t) return;
      const pos = this._canvasPos(t);
      this.mouse = pos;
      e.preventDefault();
      this.onMouseMove?.(pos, e);
    }, { passive: false });

    const endTouch = e => {
      const t = this._activeTouch(e);
      if (!t) return;
      this._touchId = null;
      const pos = this._canvasPos(t);
      this.mouse = pos;
      e.preventDefault();
      this.onMouseUp?.(pos, e);
    };
    this.canvas.addEventListener('touchend', endTouch, { passive: false });
    this.canvas.addEventListener('touchcancel', endTouch, { passive: false });
  }

  // The tracked finger within a touch event's changedTouches, or null if this
  // event does not involve it.
  _activeTouch(e) {
    if (this._touchId === null) return null;
    for (const t of e.changedTouches) {
      if (t.identifier === this._touchId) return t;
    }
    return null;
  }

  // Accepts a MouseEvent or a Touch — both expose clientX / clientY.
  _canvasPos(e) {
    const r = this.canvas.getBoundingClientRect();
    const cssX = e.clientX - r.left;
    const cssY = e.clientY - r.top;
    return this.toWorld ? this.toWorld(cssX, cssY) : [cssX, cssY];
  }

  // Drain and return queued one-shot actions
  drainActions() {
    const out = this._actions.slice();
    this._actions.length = 0;
    return out;
  }
}
