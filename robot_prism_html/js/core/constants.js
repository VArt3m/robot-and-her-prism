export const EPS = 1e-7;
// The fixed internal playfield resolution. The canvas is letterboxed to this
// aspect; world coordinates run 0..WORLD_W × 0..WORLD_H. Renderer, level border
// and the ray-reach highlight all read these so there is one source of truth.
export const WORLD_W = 1018;
export const WORLD_H = 640;
export const PLAYER_R = 9;
export const BOX_R = 12;
export const CONN_R = 12;
export const MINE_R = 10;
export const MINE_FUSE_DEFAULT = 3;   // seconds; reprogrammable, counts from first drop
export const BTN_R = 16;
export const BEAM_TOUCH = PLAYER_R + 1;
export const DWELL_THRESH = 0.5;
export const SPEED = 150.0;
export const TICK = 0.033;
export const CONNECT_REACH = 37;
// Forge: a stationary programming station. Its body half-extent (it occludes /
// blocks like other material objects), its generous activation radius (at least
// thrice the robot's CONNECT_REACH so it reads as an area, not a touch), and the
// number of times its menu may be used before it grays out.
export const FORGE_R = 16;
export const FORGE_REACH = CONNECT_REACH * 3;
export const FORGE_USES_DEFAULT = 3;
export const CUT_LINGER = 0.75;
export const CROSSING_CUT_INSTANT = false;
export const RECOLOR_DELAY = 3.0;   // seconds a deployed rewirer must hold a clear shot before it fires
export const ACCUM_FILL_SEC = 4.0;  // seconds of an UNINTERRUPTED outcome colour to charge an empty accumulator
// While charging, a few ticks of grace before an OUTCOME change resets the charge,
// so a momentary flicker (white→yellow→white) does not throw away progress.
export const ACCUM_FLICKER_GRACE = 0.13;
// A charging accumulator grows a second contour outside its body: an external
// layer at radius CONN_R + GAP, of width WIDTH. The grown footprint is what it
// occludes light at (and, in a later pass, what pushes objects). Pure cosmetics
// + light reach; the inner contour (CONN_R) is what feeders still connect to.
export const ACCUM_LAYER_GAP = 8;
export const ACCUM_LAYER_WIDTH = 4;
// A charging accumulator holds the WEAKEST possible rank: it never pushes back on
// a feeder and everything that reaches it is absorbed by the external layer. The
// engine already treats an unfed/empty accumulator as +Infinity (weaker than any
// finite rank), so this constant documents the intent and is used where a finite
// sentinel reads more clearly than Infinity.
export const ACCUM_CHARGE_RANK = 32;

// Ray-occlusion edge case: where two live beams intercept (cross, or a T-junction
// where one ends on the other), the crossing POINT itself is given a small
// occlusion presence so the directional-suppression rule sees it — even when a
// beam meets it exactly at its own endpoint (which the beam-segment obstacles miss).
// This presence lives ONLY in the ray-obstacle set (it never blocks the player or
// object placement). Kept small so only beams genuinely reaching the spot register.
export const CROSS_OCCLUDE_R = 4;

// A ray's logical HALF-thickness. Rays are solved as centrelines, but they are not
// truly zero-width — this is their official thickness for the one place it must be
// judged: whether an incoming ray brushes an interception spot (see _rayCrosses).
// The renderer's beam width / crossing bulges are cosmetic and may differ; THIS is
// the number the simulation uses. Folding it into the interception test means a
// ray whose body merely grazes a junction is still caught — we prefer intercepting
// a barely-touching ray over letting one that visually blends slip through.
export const RAY_HALF_W = 2;

export const COLORS = {
  red: '#e23b3b', green: '#27a838', blue: '#2b5cd6',
  yellow: '#e8c020', cyan: '#1fb6c4', magenta: '#c43fb0',
  orange: '#e07b2a', tan: '#d9c79a', purple: '#8e44ad',
  white: '#f3f3f6', black: '#16161e',
};

export const DIM = {
  red: '#7a3030', green: '#2f5a36', blue: '#34406e',
  yellow: '#776617', cyan: '#175c63', magenta: '#5f2356',
  orange: '#724321', white: '#8a8a93', black: '#0c0c12',
};

export const PALETTE = ['red', 'green', 'blue', 'yellow', 'cyan', 'magenta', 'orange'];
export const LOGIC_KINDS = ['and', 'or'];
