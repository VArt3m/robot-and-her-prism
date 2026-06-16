/**
 * 2D canvas renderer.
 *
 * Exposes a render(world, uiState) method and nothing else the caller must
 * know about. A future renderer3d.js can sit alongside this with the same
 * interface so both can be driven from app.js simultaneously.
 */
import { COLORS, DIM, PLAYER_R, BOX_R, BTN_R, CONN_R, CONNECT_REACH, LOGIC_KINDS } from '../core/constants.js';
import { dist, pt_seg_dist } from '../core/geometry.js';

function diamond(cx, cy, r = 13) {
  return [[cx, cy-r], [cx+r, cy], [cx, cy+r], [cx-r, cy]];
}

function starPts(cx, cy, r = 16, ri = 7, n = 5) {
  const pts = [];
  for (let i = 0; i < 2*n; i++) {
    const rad = i%2===0 ? r : ri;
    const ang = -Math.PI/2 + i*Math.PI/n;
    pts.push([cx + rad*Math.cos(ang), cy + rad*Math.sin(ang)]);
  }
  return pts;
}

function polygon(ctx, pts) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
}

const WORLD_W = 1018;
const WORLD_H = 640;

export class Renderer2D {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    // Viewport transform: maps world coords → physical canvas pixels.
    // Updated by resize(); read by screenToWorld() for input mapping.
    this._vp = { scale: 1, ox: 0, oy: 0, dpr: 1 };
  }

  // Call this whenever the canvas's CSS display size changes.
  resize(cssW, cssH) {
    const dpr = window.devicePixelRatio || 1;
    // Uniform "contain" scale with letterboxing.
    const scale = Math.min(cssW / WORLD_W, cssH / WORLD_H);
    const ox = (cssW - WORLD_W * scale) / 2;
    const oy = (cssH - WORLD_H * scale) / 2;
    this._vp = { scale, ox, oy, dpr };
    // Physical pixel buffer size — this is where DPR sharpness comes from.
    this.canvas.width  = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
  }

  // Convert a CSS-space point (from mouse events) to world coordinates.
  screenToWorld(cssX, cssY) {
    const { scale, ox, oy } = this._vp;
    return [(cssX - ox) / scale, (cssY - oy) / scale];
  }

  render(world, uiState) {
    const ctx = this.ctx;
    const { scale, ox, oy, dpr } = this._vp;
    const w = world;
    const { sel, mode } = uiState;

    // Map world coordinates → physical pixels in one transform.
    ctx.setTransform(scale * dpr, 0, 0, scale * dpr, ox * dpr, oy * dpr);

    // Clear physical pixels (in default/identity space before we set the transform).
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.restore();

    // Game-world background (within letterbox).
    ctx.fillStyle = '#fafafa';
    ctx.fillRect(0, 0, WORLD_W, WORLD_H);

    // Barriers
    for (const bar of w.barriers) {
      ctx.beginPath();
      ctx.moveTo(bar.p1[0], bar.p1[1]);
      ctx.lineTo(bar.p2[0], bar.p2[1]);
      ctx.strokeStyle = COLORS[bar.kind];
      ctx.lineWidth = 6;
      ctx.lineCap = 'round';
      ctx.stroke();
    }

    // Walls
    for (const wl of w.walls) {
      ctx.beginPath();
      ctx.moveTo(wl.p1[0], wl.p1[1]);
      ctx.lineTo(wl.p2[0], wl.p2[1]);
      ctx.strokeStyle = '#111';
      ctx.lineWidth = 5;
      ctx.lineCap = 'round';
      ctx.setLineDash([]);
      ctx.stroke();
    }

    // Force fields
    for (const ff of w.ffs) {
      ctx.beginPath();
      ctx.moveTo(ff.p1[0], ff.p1[1]);
      ctx.lineTo(ff.p2[0], ff.p2[1]);
      if (ff.is_open) {
        ctx.strokeStyle = '#bfe3ec'; ctx.lineWidth = 3;
        ctx.setLineDash([3, 7]);
      } else {
        ctx.strokeStyle = '#8fd3e8'; ctx.lineWidth = 6;
        ctx.setLineDash([]);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Light link wires (dashed gray)
    for (const [a, b] of w.links_pairs) {
      const na = w.nodes[a], nb = w.nodes[b];
      if (!na || !nb) continue;
      ctx.beginPath();
      ctx.moveTo(na.pos[0], na.pos[1]);
      ctx.lineTo(nb.pos[0], nb.pos[1]);
      ctx.strokeStyle = '#a7adb3';
      ctx.lineWidth = 1.4;
      ctx.setLineDash([3, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Beams
    for (const [a, b, col, delivered, bo, bt] of w.beams_draw) {
      // A connector killed by conflicting incoming colours is inert: show
      // its links as the dotted wire only, like a carried connector.
      if (w.dead_conns && (w.dead_conns.has(bo) || w.dead_conns.has(bt))) continue;
      const shade = delivered ? COLORS[col] : (DIM[col] ?? '#999');
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.strokeStyle = shade;
      ctx.lineWidth = delivered ? 4 : 3;
      ctx.lineCap = 'round';
      ctx.setLineDash([]);
      ctx.stroke();
      if (!delivered) {
        ctx.beginPath();
        ctx.arc(b[0], b[1], 3, 0, 2*Math.PI);
        ctx.strokeStyle = shade;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }

    // Logic wiring
    for (const [src, dst, neg] of w.logic_links) {
      const sp = w.nodes[src]?.pos;
      const dp = w.consumer_pos(dst);
      if (!sp || !dp) continue;
      const active = neg !== Boolean(w.logic_val[src] ?? false);
      ctx.beginPath();
      ctx.moveTo(sp[0], sp[1]);
      ctx.lineTo(dp[0], dp[1]);
      ctx.strokeStyle = active ? '#5aa0e0' : '#cbd3da';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
      // Arrow head
      const angle = Math.atan2(dp[1]-sp[1], dp[0]-sp[0]);
      const ax = dp[0] - 10*Math.cos(angle), ay = dp[1] - 10*Math.sin(angle);
      ctx.beginPath();
      ctx.moveTo(dp[0], dp[1]);
      ctx.lineTo(ax + 5*Math.sin(angle), ay - 5*Math.cos(angle));
      ctx.lineTo(ax - 5*Math.sin(angle), ay + 5*Math.cos(angle));
      ctx.closePath();
      ctx.fillStyle = active ? '#5aa0e0' : '#cbd3da';
      ctx.fill();
      if (neg) {
        const mx = (sp[0]+dp[0])/2, my = (sp[1]+dp[1])/2;
        ctx.beginPath(); ctx.arc(mx, my, 5, 0, 2*Math.PI);
        ctx.fillStyle = '#fff'; ctx.fill();
        ctx.strokeStyle = '#c0392b'; ctx.lineWidth = 2; ctx.stroke();
        ctx.fillStyle = '#c0392b'; ctx.font = 'bold 8px sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('!', mx, my);
      }
    }

    // Boxes
    for (const bx of w.boxes) {
      const [x, y] = bx;
      const on = Object.values(w.nodes).some(n => n.kind==='button' && dist(bx,n.pos)<BTN_R);
      ctx.fillStyle = on ? '#caa46a' : '#b08d57';
      ctx.strokeStyle = '#5b4523'; ctx.lineWidth = 2;
      ctx.fillRect(x-BOX_R, y-BOX_R, 2*BOX_R, 2*BOX_R);
      ctx.strokeRect(x-BOX_R, y-BOX_R, 2*BOX_R, 2*BOX_R);
    }

    // Carried box (rides on the player) — dashed outline to read as "held".
    if (w.carry_box) {
      const [bxc, byc] = w.carry_box;
      ctx.fillStyle = '#c9a96a';
      ctx.fillRect(bxc-BOX_R, byc-BOX_R, 2*BOX_R, 2*BOX_R);
      ctx.strokeStyle = '#5b4523'; ctx.lineWidth = 2; ctx.setLineDash([4,3]);
      ctx.strokeRect(bxc-BOX_R, byc-BOX_R, 2*BOX_R, 2*BOX_R);
      ctx.setLineDash([]);
    }

    // Nodes
    for (const n of Object.values(w.nodes)) {
      const [x, y] = n.pos;
      if (n.kind === 'source') {
        polygon(ctx, diamond(x, y));
        ctx.fillStyle = COLORS[n.color] ?? '#999';
        ctx.fill();
        ctx.strokeStyle = '#222'; ctx.lineWidth = 1; ctx.stroke();

      } else if (n.kind === 'receiver') {
        const col = COLORS[n.color] ?? '#999';
        const [x0,y0,x1,y1] = [x-11, y-13, x+11, y+13];
        const active = w.active[n.id] ?? false;
        const lit = w.lit[n.id] ?? false;
        let frac = 0;
        if (active) frac = 1;
        else if (lit && n.fill_time > 0) frac = Math.max(0, Math.min(1, (w.charge[n.id]??0)/n.fill_time));
        ctx.fillStyle = '#fff';
        ctx.fillRect(x0, y0, x1-x0, y1-y0);
        if (frac > 0) {
          const fh = (y1-y0)*frac;
          ctx.fillStyle = col;
          ctx.fillRect(x0, y1-fh, x1-x0, fh);
        }
        ctx.strokeStyle = col; ctx.lineWidth = 3; ctx.setLineDash([]);
        ctx.strokeRect(x0, y0, x1-x0, y1-y0);
        if (mode === 'edit') {
          ctx.fillStyle = '#666'; ctx.font = '7px sans-serif';
          ctx.textAlign = 'center'; ctx.textBaseline = 'top';
          ctx.fillText(`${n.fill_time}s`, x, y1+3);
        }

      } else if (n.kind === 'button') {
        const pr = w.pressed[n.id] ?? false;
        ctx.beginPath(); ctx.arc(x, y, BTN_R, 0, 2*Math.PI);
        ctx.fillStyle = pr ? '#88d18b' : '#e7e7e7'; ctx.fill();
        ctx.strokeStyle = '#555'; ctx.lineWidth = 2; ctx.stroke();
        ctx.fillStyle = '#333'; ctx.font = '8px sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('B', x, y);

      } else if (LOGIC_KINDS.includes(n.kind)) {
        const on = w.logic_val[n.id] ?? false;
        ctx.fillStyle = on ? '#bfe6c2' : '#eceff1';
        ctx.strokeStyle = '#516'; ctx.lineWidth = 2;
        ctx.fillRect(x-17, y-13, 34, 26);
        ctx.strokeRect(x-17, y-13, 34, 26);
        ctx.fillStyle = '#333'; ctx.font = 'bold 8px sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(n.kind === 'and' ? 'AND' : 'OR', x, y);

      } else if (n.kind === 'connector') {
        const near = mode === 'play' && w.player
          && (w.carrying===n.id || dist(w.player, n.pos)<CONNECT_REACH);
        const ring = sel===n.id ? '#f5c518' : (near ? '#2e8b57' : '#222');
        const col = w.emit[n.id];
        if (w._conn_elevated(n.id)) {
          ctx.beginPath(); ctx.arc(x, y, 16, 0, 2*Math.PI);
          ctx.strokeStyle = '#8e44ad'; ctx.lineWidth = 2;
          ctx.setLineDash([2,2]); ctx.stroke(); ctx.setLineDash([]);
        }
        ctx.beginPath(); ctx.arc(x, y, CONN_R, 0, 2*Math.PI);
        ctx.fillStyle = col ? COLORS[col] : '#fff';
        ctx.fill();
        ctx.strokeStyle = ring; ctx.lineWidth = 3; ctx.stroke();
        ctx.fillStyle = '#111'; ctx.font = 'bold 9px sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('c', x, y);   // identical for every connector (still tracked separately)
        if (w.carrying === n.id) {
          ctx.fillStyle = '#666'; ctx.font = '7px sans-serif';
          ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
          ctx.fillText('(carried)', x, y-14);
        } else if (w._conn_elevated(n.id)) {
          ctx.fillStyle = '#8e44ad'; ctx.font = '7px sans-serif';
          ctx.textBaseline = 'top';
          ctx.fillText('(raised)', x, y+14);
        }
      }
    }

    // Goal star
    if (w.goal) {
      polygon(ctx, starPts(w.goal[0], w.goal[1]));
      ctx.fillStyle = '#f5c518'; ctx.fill();
      ctx.strokeStyle = '#b8860b'; ctx.lineWidth = 1; ctx.stroke();
    }

    // Player
    if (w.player) {
      const [px, py] = w.player;
      ctx.beginPath(); ctx.arc(px, py, PLAYER_R, 0, 2*Math.PI);
      ctx.fillStyle = w.player_block ? '#c0392b' : '#222'; ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
      // Little face: two eyes toward the direction she last moved.
      const f = (w.facing && (w.facing[0] || w.facing[1])) ? w.facing : [0, 1];
      const fl = Math.hypot(f[0], f[1]) || 1;
      const fx = f[0] / fl, fy = f[1] / fl;
      const perpx = -fy, perpy = fx;
      const fwd = PLAYER_R * 0.40, spread = PLAYER_R * 0.42;
      ctx.fillStyle = '#fff';
      for (const s of [-1, 1]) {
        const ex = px + fx*fwd + perpx*spread*s;
        const ey = py + fy*fwd + perpy*spread*s;
        ctx.beginPath(); ctx.arc(ex, ey, 1.8, 0, 2*Math.PI); ctx.fill();
      }
      if (mode === 'play') {
        ctx.beginPath(); ctx.arc(px, py, CONNECT_REACH, 0, 2*Math.PI);
        ctx.strokeStyle = '#e7e7e7'; ctx.lineWidth = 1;
        ctx.setLineDash([2,4]); ctx.stroke(); ctx.setLineDash([]);
      }
    }

    // Wire-drag preview: a connection being pulled from the carried connector.
    if (uiState.wireDrag && w.carrying && w.player) {
      const from = w.nodes[w.carrying].pos;
      ctx.beginPath();
      ctx.moveTo(from[0], from[1]);
      ctx.lineTo(uiState.wireDrag[0], uiState.wireDrag[1]);
      ctx.strokeStyle = '#f5c518'; ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]); ctx.stroke(); ctx.setLineDash([]);
    }

    // Pending wall/field preview line
    if (uiState.pending && uiState.mouse) {
      const [px, py] = uiState.pending;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(uiState.mouse[0], uiState.mouse[1]);
      ctx.strokeStyle = '#888'; ctx.lineWidth = 1;
      ctx.setLineDash([2,2]); ctx.stroke(); ctx.setLineDash([]);
    }

    // Stack chooser menu (opened by holding the mouse over a stack).
    if (uiState.menu && uiState.menu.items) {
      ctx.setLineDash([]);
      for (const it of uiState.menu.items) {
        const [rx, ry, rw, rh] = it.rect;
        ctx.fillStyle = 'rgba(20, 22, 28, 0.92)';
        ctx.fillRect(rx, ry, rw, rh);
        ctx.strokeStyle = '#f5c518'; ctx.lineWidth = 1.5;
        ctx.strokeRect(rx, ry, rw, rh);
        ctx.fillStyle = '#ffffff';
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillText(it.label, rx + 10, ry + rh / 2);
      }
    }

    // Full-reset hold gauge (centered). Visible while R is held; fills over 3s.
    const rp = uiState.resetProgress ?? 0;
    if (rp > 0) {
      const bw = 380, bh = 56;
      const bx = (WORLD_W - bw) / 2, by = (WORLD_H - bh) / 2;
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(20, 22, 28, 0.85)';
      ctx.fillRect(bx, by, bw, bh);
      ctx.strokeStyle = '#e23b3b'; ctx.lineWidth = 2;
      ctx.strokeRect(bx, by, bw, bh);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 13px sans-serif';
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText('RESETTING \u2014 keep holding R', bx + 16, by + 17);
      const tx = bx + 16, ty = by + 32, tw = bw - 32, th = 12;
      ctx.fillStyle = '#3a3f4b';
      ctx.fillRect(tx, ty, tw, th);
      ctx.fillStyle = '#e23b3b';
      ctx.fillRect(tx, ty, tw * Math.min(1, rp), th);
    }

    // Reset transform so nothing leaks between frames.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
}
