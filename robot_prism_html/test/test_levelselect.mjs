// Headless test of the level-select STATE MACHINE in app.js. It stubs just
// enough of the browser that an App can be constructed with no real DOM — so the
// Panel stays inert and InputHandler's listeners are no-ops — then drives the
// level-select methods directly and asserts the uiState / world transitions.
//
// Covered: opening via the panel's Levels action (a plain click — no hold),
// Escape cancelling without changing the level, a click (and the modal mouse
// intercept) loading the chosen level, a click outside the overlay cancelling
// it like Escape, the "current" mark following the loaded level, a full reset
// rebuilding the CURRENT level, the modal freeze still draining Escape, and the
// absence of any keyboard path.
// Run: node test_levelselect.mjs

// --- minimal browser stubs (this suite runs in its own process) ---
globalThis.window = globalThis.window || { addEventListener() {} };
globalThis.document = globalThis.document || { addEventListener() {} }; // no createElement → Panel inert
if (!globalThis.performance) globalThis.performance = { now: () => Date.now() };
globalThis.requestAnimationFrame = globalThis.requestAnimationFrame || (() => 0);

const ctxStub = new Proxy({}, { get: () => () => {} });
const makeCanvas = () => ({
  parentElement: { appendChild() {} },
  addEventListener() {},
  getContext: () => ctxStub,
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 1018, height: 640 }),
  width: 1018, height: 640,
});

const { App } = await import('../js/ui/app.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL:', m); } };

const newApp = () => new App(makeCanvas(), null);
const count = a => Object.keys(a.world.nodes).length;
const TG = 25, LP = 11;               // node counts (asserted in test_levels.mjs)
const center = r => [r[0] + r[2] / 2, r[1] + r[3] / 2];

// ===========================================================================
// 1. Initial state: Lorem's Puzzle #1 (the registry's first entry), no overlay.
// ===========================================================================
{
  const a = newApp();
  ok(a._levelId === 'lorem_1', "starts on Lorem's Puzzle #1");
  ok(a.uiState.levelMenu === null, 'no overlay at start');
  ok(count(a) === LP, "Lorem's Puzzle #1 world is loaded");
}

// ===========================================================================
// 2. The panel's Levels action opens the overlay directly (a plain click).
// ===========================================================================
{
  const a = newApp();
  a._openLevelMenu();
  ok(a.uiState.levelMenu && a.uiState.levelMenu.items.length === 2, 'opening shows the two-entry overlay');
  ok(a.uiState.levelMenu.items[0].current === true && a.uiState.levelMenu.items[1].current === false,
     "Lorem's Puzzle #1 (first entry) is marked current");
}

// ===========================================================================
// 3. Escape cancels — the level is unchanged.
// ===========================================================================
{
  const a = newApp();
  a._openLevelMenu();
  a._handleAction('escape', 0);
  ok(a.uiState.levelMenu === null, 'Escape closes the overlay');
  ok(a._levelId === 'lorem_1' && count(a) === LP, 'the level is unchanged after a cancel');
}

// ===========================================================================
// 4. Selecting a level loads it; the current mark follows.
// ===========================================================================
{
  const a = newApp();
  a._openLevelMenu();
  const tg = a.uiState.levelMenu.items.find(it => it.id === 'test_grounds');
  a._handleLevelMenuClick(...center(tg.rect));
  ok(a.uiState.levelMenu === null, 'the overlay closes on selection');
  ok(a._levelId === 'test_grounds' && count(a) === TG, 'Test Grounds is loaded');

  // Re-open: now Test Grounds is current; pick Lorem to go back.
  a._openLevelMenu();
  const cur = a.uiState.levelMenu.items.find(it => it.current);
  ok(cur && cur.id === 'test_grounds', 'the current mark now follows Test Grounds');
  const lorem = a.uiState.levelMenu.items.find(it => it.id === 'lorem_1');
  a._handleLevelMenuClick(...center(lorem.rect));
  ok(a._levelId === 'lorem_1' && count(a) === LP, "selecting Lorem's Puzzle #1 loads it back");
}

// ===========================================================================
// 5. A full reset rebuilds the CURRENT level, not always the startup level.
// ===========================================================================
{
  const a = newApp();
  a._loadLevel('test_grounds');
  ok(count(a) === TG, 'on Test Grounds after load');
  a._fullReset();
  ok(a._levelId === 'test_grounds' && count(a) === TG, 'a full reset rebuilds Test Grounds (the current level), not the startup level');
}

// ===========================================================================
// 6. The overlay is modal to the canvas: a click on an entry loads; a click that
//    misses every entry closes the overlay (a click outside cancels, like Esc).
// ===========================================================================
{
  const a = newApp();
  a._openLevelMenu();
  // A miss (top-left corner, far from the centered panel) cancels — closes it.
  a._onMouseDown([3, 3], {});
  ok(a.uiState.levelMenu === null, 'a click missing every entry closes the overlay (cancel)');
  ok(a._levelId === 'lorem_1', 'and changes nothing');
  // A hit on the Test Grounds entry loads it through the same down-intercept.
  a._openLevelMenu();
  const tg = a.uiState.levelMenu.items.find(it => it.id === 'test_grounds');
  a._onMouseDown(center(tg.rect), {});
  ok(a.uiState.levelMenu === null && a._levelId === 'test_grounds', 'a click on an entry loads it via the mouse intercept');
}

// ===========================================================================
// 7. The modal freeze still drains Escape (so the overlay can be closed by key
//    even though the rest of the tick is frozen).
// ===========================================================================
{
  const a = newApp();
  a._openLevelMenu();
  a.input._actions.push('escape');
  a._tick(0);
  ok(a.uiState.levelMenu === null, 'a frozen tick still processes Escape to close the overlay');
}

// ===========================================================================
// 8. No keyboard path: there is no action that opens the overlay. (Reset has the
//    R key; Levels is panel-only.) Feeding a stray 'levels' action does nothing.
// ===========================================================================
{
  const a = newApp();
  a._handleAction('levels', 0);
  ok(a.uiState.levelMenu === null, "there is no 'levels' key action — the overlay stays closed");
}

console.log(`\nlevel-select tests: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
