/**
 * Centralised UI text catalog.
 *
 * i18n-readiness (English-only for now):
 *   - Every user-facing string lives here, keyed by a stable identifier.
 *   - Parameterised messages are functions (params) => string, so call sites
 *     stay identical no matter the language's word order.
 *   - To add a language later: define a sibling catalog with the same shape,
 *     register it in `CATALOGS`, and call `setLanguage('xx')`. The exported
 *     `STR` proxy always points at the active catalog, so importing modules
 *     never need to change.
 */

const en = {
  // Toolbar / static chrome (mirrors index.html so it can be driven from JS).
  toolbar: {
    play: 'PLAY',
    edit: 'EDIT',
    hint: [
      '[WASD] / arrows — move',
      '[E] — pick up nearest / drop in front',
      '[LMB] an item or [E] to grab; hold ½ s over a stack to choose',
      'carrying: [LMB] it = toggle ready, [LMB] node = target, [LMB] spot/box = place',
      '[F] at a Forge — program the carried item',
      'hold [Shift] — show targets   |   hold [Space] — show ray reach',
      '[C] — clear the carried device’s targets',
      '[Z] — rewind',
      'hold [R] (2s) — full reset',
      '[G] — reset gates',
    ].join('   |   '),
  },

  // Human-readable names for every object kind on the field.
  kinds: {
    source: 'Source',
    receiver: 'Receiver',
    button: 'Button',
    connector: 'Connector',
    inverter: 'Inverter',
    mine: 'Mine',
    rewirer: 'Rewirer',
    jammer: 'Jammer',
    forge: 'Forge',
    and: 'AND gate',
    or: 'OR gate',
    box: 'Box',
    goal: 'Goal',
    field: 'Force field',
  },

  // Colour names (used in tooltips / status / menus).
  colors: {
    red: 'red', green: 'green', blue: 'blue',
    yellow: 'yellow', cyan: 'cyan', magenta: 'magenta',
    orange: 'orange', tan: 'tan', purple: 'purple',
  },

  // Short glyphs drawn inside shapes on the canvas.
  glyph: {
    button: 'B',
    jammer: 'J',
    connector: 'c',
    inverter: 'i',
    and: 'AND',
    or: 'OR',
    negate: '!',
  },

  // Small badges drawn above a carried / placed object on the canvas.
  badge: {
    targeting: '(targeting)',
    stackHere: '(stack here)',
    dropHere: '(drop here)',
    raised: '(raised)',
  },

  // The corner tool panel: title, button labels, and their hover hints.
  panel: {
    title: 'Tools',
    collapseHint: 'Collapse / expand',
    targets: 'Targets',
    targetsHint: 'Highlight what the carried item can target (or hold Shift)',
    passable: 'Ray reach',
    passableHint: 'Highlight where the carried item’s ray can travel (or hold Space)',
    targeting: 'Targeting',
    targetingHint: 'Enter / leave click-by-click targeting of the carried device',
    forge: 'Program',
    forgeHint: 'Program the carried item at this Forge (or press F)',
    reset: 'Reset',
    resetHint: 'Hold 2s to rebuild the whole playfield',
    undo: 'Undo',
    undoHint: 'Rewind one step (up to 6)',
  },

  // Receiver fill-time label shown in edit mode.
  fillTime: (s) => `${s}s`,

  // Centered full-reset hold overlay (rich line so [R] renders as a key chip).
  resetOverlay: [{ t: 'RESETTING — keep holding ' }, { t: 'R', k: true }],

  // Transient status-bar notices (flash messages).
  flash: {
    cantReachBlocked: "Can't reach that — blocked",
    handsFull: 'My hands are full',
    noRoom: 'No room to set it down',
    nothingToRewind: 'Nothing to rewind',
    rewound: (left) => `Rewound — ${left} step${left === 1 ? '' : 's'} left`,
    fullReset: 'Playfield fully reset',
    fuseSet: (s) => `Fuse set to ${s}s`,
    colourSet: (c) => `Colour set to ${en.colors[c] ?? c}`,
    connColorSet: (c) => (c ? `Corrupted — locked to ${en.colors[c] ?? c}` : 'Cleaned — a plain relay again'),
    invPairSet: (p) => `Inverter set to swap ${en.colors[p[0]] ?? p[0]} ↔ ${en.colors[p[1]] ?? p[1]}`,
    // (No "No Forge in range" message: pressing F out of any Forge's radius is a
    // silent no-op, not a programming attempt, so there is nothing to report.)
    forgeSpent: 'This Forge is spent',
    forgeNoChange: 'This Forge has nothing to change about it',
    notProgrammable: 'Nothing here to program',
    recolourMarked: 'Recolour target set — it charges and fires once the rewirer is down with a clear shot',
    recolourDone: 'Recolour applied — the rewirer is spent',
    jamMarked: 'Jam target set — active once the jammer is on the ground',
    noLineOfSight: 'No line of sight',
    targeting: (what) => `Targeting — click ${what}; click empty or tap E to finish`,
    doneTargeting: 'Done targeting',
  },

  // What the click-by-click targeting prompt should tell the player to click.
  targetWhat: {
    connector: 'a node',
    rewirer: 'a source/receiver',
    default: 'a field or mine',
  },

  // Stack-chooser / programming menu labels.
  menu: {
    fuse: (s) => `${s}s fuse`,
    color: (c) => ({ red: 'Red', green: 'Green', blue: 'Blue' }[c] ?? c),
    // Connector corruption chooser: a "Clean" entry plus the corrupt-to-X colours.
    connColor: (c) => (c == null ? 'Clean' : `Corrupt → ${({ red: 'Red', green: 'Green', blue: 'Blue' }[c] ?? c)}`),
    // Inverter colour-pair chooser: the two colours it swaps between.
    invPair: (p) => `Swap ${({ red: 'Red', green: 'Green', blue: 'Blue' }[p[0]] ?? p[0])}↔${({ red: 'Red', green: 'Green', blue: 'Blue' }[p[1]] ?? p[1])}`,
  },

  // Bottom status bar.
  status: {
    gatesLabel: 'gates',
    gateOpen: 'open',
    gateShut: 'shut',
    none: 'none',
    goalReached: '*** GOAL REACHED ***',
    sep: '   —   ',
    // Carried-item read-out (the detailed segment requested for the status bar).
    carrying: (detail) => `carrying: ${detail}`,
    empty: 'hands empty',
    armed: 'armed',
    idle: 'idle',
    links: (n) => `${n} link${n === 1 ? '' : 's'}`,
    emits: (c) => `emits ${en.colors[c] ?? c}`,
    emitsNone: 'no output',
    fuse: (s) => (s == null ? 'fuse not set' : `fuse ${s}s`),
    colour: (c) => (c ? `colour ${en.colors[c] ?? c}` : 'colour not set'),
    raised: 'raised',
    onGround: 'on ground',
  },

  // Hover tooltips. Each returns an array of lines; the first is the title.
  // A line is either a plain string or a rich segment array:
  //   string             → rendered as plain text
  //   [{t, c?, k?}, …]  → rendered segment-by-segment:
  //                        c = colorKey ('red' etc.) → text drawn in that color
  //                        k = true                  → text drawn as a key chip
  tooltip: {
    recvState: { powered: 'powered', charging: 'charging', idle: 'idle' },
    playerQuips: ["That's me!", "It's me!", '...hi.', 'Yep, that\'s me.', 'Hello!'],
    player: (quipIdx) => [
      en.tooltip.playerQuips[quipIdx % en.tooltip.playerQuips.length],
      'drag to move',
    ],
    source: (color) => [
      en.kinds.source,
      en.colors[color]
        ? [{ t: 'emits ' }, { t: en.colors[color], c: color }]
        : 'no colour',
    ],
    receiver: (color, state) => [
      en.kinds.receiver,
      en.colors[color]
        ? [{ t: 'wants ' }, { t: en.colors[color], c: color }]
        : 'no colour',
      state,
    ],
    button: (pressed) => [en.kinds.button, pressed ? 'pressed' : 'released'],
    connector: (emitColor, links, raised, fixedColor) => {
      const lines = [en.kinds.connector];
      if (fixedColor) lines.push([{ t: 'corrupted — locked to ' }, { t: en.colors[fixedColor] ?? fixedColor, c: fixedColor }]);
      lines.push(emitColor
        ? [{ t: 'emits ' }, { t: en.colors[emitColor] ?? emitColor, c: emitColor }]
        : 'no output');
      lines.push(`${links} link${links === 1 ? '' : 's'}`);
      if (raised) lines.push('raised on a box');
      return lines;
    },
    inverter: (emitColor, links, raised, fixedColor, pair) => {
      const lines = [en.kinds.inverter];
      if (fixedColor) lines.push([{ t: 'corrupted — locked to ' }, { t: en.colors[fixedColor] ?? fixedColor, c: fixedColor }]);
      else if (pair) lines.push([
        { t: 'swaps ' }, { t: en.colors[pair[0]] ?? pair[0], c: pair[0] },
        { t: ' ↔ ' }, { t: en.colors[pair[1]] ?? pair[1], c: pair[1] },
      ]);
      lines.push(emitColor
        ? [{ t: 'emits ' }, { t: en.colors[emitColor] ?? emitColor, c: emitColor }]
        : 'no output');
      lines.push(`${links} link${links === 1 ? '' : 's'}`);
      if (raised) lines.push('raised on a box');
      return lines;
    },
    mine: (fuse, running, disabled) => {
      const lines = [en.kinds.mine];
      lines.push(fuse == null ? 'fuse not set' : `fuse ${fuse}s`);
      if (disabled) lines.push('jammed');
      else if (running) lines.push('counting down');
      return lines;
    },
    rewirer: (color) => [
      en.kinds.rewirer,
      color
        ? [{ t: 'recolours to ' }, { t: en.colors[color] ?? color, c: color }]
        : 'colour not set',
    ],
    jammer: () => [en.kinds.jammer, 'freezes a field or mine'],
    forge: (uses, inRange) => {
      const lines = [en.kinds.forge];
      lines.push(uses > 0 ? `${uses} use${uses === 1 ? '' : 's'} left` : 'spent');
      if (uses > 0) lines.push(inRange
        ? [{ t: 'carry an item here, press ' }, { t: 'F', k: true }]
        : 'program a carried item nearby');
      return lines;
    },
    and: (on) => [en.kinds.and, on ? 'output on' : 'output off'],
    or: (on) => [en.kinds.or, on ? 'output on' : 'output off'],
    box: (onButton) => [en.kinds.box, onButton ? 'on a button' : 'pushable platform'],
    goal: () => [en.kinds.goal, 'reach here'],
    field: (open, disabled) => [en.kinds.field, disabled ? 'jammed — held down' : (open ? 'open' : 'shut')],
    pickHint: [{ m: 'L' }, { t: ' or ' }, { t: 'E', k: true }, { t: ' to pick up' }],
  },
};

const CATALOGS = { en };
let active = en;

export function setLanguage(code) {
  if (CATALOGS[code]) active = CATALOGS[code];
}

// A stable proxy so importers can `import { STR }` once and always read the
// currently-active language, even after setLanguage() swaps it.
export const STR = new Proxy({}, {
  get(_t, prop) { return active[prop]; },
});
