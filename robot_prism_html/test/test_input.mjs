// Pins the keyboard bindings for the momentary highlight holds: Shift shows
// possible targets, Space shows the passable ray area, and Space's browser
// default (scroll / focused-button activation) is suppressed. Movement keys are
// spot-checked so a future rebind can't silently break them.
// Run: node test_input.mjs

// --- minimal DOM mocks that capture the window-level key handlers ---
const handlers = {};        // event name → handler
const noop = () => {};
globalThis.window = {
  addEventListener: (name, fn) => { handlers[name] = fn; },
  removeEventListener: noop,
};
globalThis.document = { addEventListener: noop };
globalThis.performance = globalThis.performance || { now: () => Date.now() };
const canvas = { addEventListener: noop, getBoundingClientRect: () => ({ left: 0, top: 0 }) };

const { InputHandler } = await import('../js/ui/input.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL:', m); } };

const input = new InputHandler(canvas);
const keydown = handlers['keydown'];
const keyup   = handlers['keyup'];
ok(typeof keydown === 'function' && typeof keyup === 'function', 'key handlers registered');

// Helper: fake a key event, recording whether preventDefault was called.
const fire = (handler, code, repeat = false) => {
  let prevented = false;
  handler({ code, repeat, preventDefault: () => { prevented = true; } });
  return prevented;
};

// Shift → possible-targets highlight.
fire(keydown, 'ShiftLeft');
ok(input.held.has('hl_targets'), 'ShiftLeft holds the targets highlight');
fire(keyup, 'ShiftLeft');
ok(!input.held.has('hl_targets'), 'releasing Shift clears the targets highlight');
fire(keydown, 'ShiftRight');
ok(input.held.has('hl_targets'), 'ShiftRight also holds the targets highlight');
fire(keyup, 'ShiftRight');

// Space → passable-ray highlight, and its default is always suppressed.
const prevented = fire(keydown, 'Space');
ok(input.held.has('hl_passable'), 'Space holds the passable-area highlight');
ok(prevented === true, 'Space keydown calls preventDefault (no scroll / button activation)');
ok(fire(keydown, 'Space', true) === true, 'Space preventDefault fires even on auto-repeat');
fire(keyup, 'Space');
ok(!input.held.has('hl_passable'), 'releasing Space clears the passable-area highlight');

// The old letter bindings are gone (Q/F are no longer highlight keys).
fire(keydown, 'KeyQ'); fire(keydown, 'KeyF');
ok(!input.held.has('hl_targets') && !input.held.has('hl_passable'), 'Q/F no longer trigger highlights');
fire(keyup, 'KeyQ'); fire(keyup, 'KeyF');

// Movement still works and Shift does not disturb it (Shift+W is a valid combo).
fire(keydown, 'KeyW');
ok(input.held.has('up'), 'W still moves up');
fire(keydown, 'ShiftLeft');
ok(input.held.has('up') && input.held.has('hl_targets'), 'Shift+W: move and highlight coexist');
fire(keyup, 'ShiftLeft'); fire(keyup, 'KeyW');

// blur clears every held key, highlights included.
fire(keydown, 'Space'); fire(keydown, 'ShiftLeft');
handlers['blur']?.();
ok(input.held.size === 0, 'blur clears held highlight keys');

console.log(`\ninput binding tests: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
