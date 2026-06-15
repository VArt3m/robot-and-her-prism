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
};

export class InputHandler {
  constructor(canvas) {
    this.canvas = canvas;

    // Persistent state (held keys, mouse pos)
    this.held = new Set();
    this.mouse = [0, 0];
    this.hasFocus = true;

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
      } else {
        this._actions.push(action);
      }
      // Prevent page scroll on arrows/space
      if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight',' '].includes(e.code)) e.preventDefault();
    });

    window.addEventListener('keyup', e => {
      const action = KEY_MAP[e.code];
      if (action) this.held.delete(action);
    });

    window.addEventListener('blur', () => {
      this.held.clear();
      this.hasFocus = false;
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
  }

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
