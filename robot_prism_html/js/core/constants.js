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
export const CUT_LINGER = 0.33;
export const CROSSING_CUT_INSTANT = false;
export const RECOLOR_DELAY = 3.0;   // seconds a deployed rewirer must hold a clear shot before it fires
export const ACCUM_FILL_SEC = 2.0;  // seconds of an uninterrupted single colour to charge an empty accumulator

export const COLORS = {
  red: '#e23b3b', green: '#27a838', blue: '#2b5cd6',
  yellow: '#e8c020', cyan: '#1fb6c4', magenta: '#c43fb0',
  orange: '#e07b2a', tan: '#d9c79a', purple: '#8e44ad',
  white: '#f3f3f6',
};

export const DIM = {
  red: '#7a3030', green: '#2f5a36', blue: '#34406e',
  yellow: '#776617', cyan: '#175c63', magenta: '#5f2356',
  orange: '#724321', white: '#8a8a93',
};

export const PALETTE = ['red', 'green', 'blue', 'yellow', 'cyan', 'magenta', 'orange'];
export const LOGIC_KINDS = ['and', 'or'];
