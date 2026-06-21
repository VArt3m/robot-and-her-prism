/**
 * 2D canvas renderer.
 *
 * Exposes a render(world, uiState) method and nothing else the caller must
 * know about. A future renderer3d.js can sit alongside this with the same
 * interface so both can be driven from app.js simultaneously.
 */
import { COLORS, DIM, PLAYER_R, BOX_R, BTN_R, CONN_R, MINE_R, CONNECT_REACH, FORGE_R, FORGE_REACH, LOGIC_KINDS, WORLD_W, WORLD_H, ACCUM_FILL_SEC } from '../core/constants.js';
import { dist, pt_seg_dist } from '../core/geometry.js';
import { objType } from '../sim/objects.js';
import { isRelayKind } from '../sim/relays.js';
import { STR } from '../core/strings.js';

function diamond(cx, cy, r = 13) {
  return [[cx, cy-r], [cx+r, cy], [cx, cy+r], [cx-r, cy]];
}

// --- Ray pulsation ("wavy flow") tunables, in world units / seconds. ---------
// A very slow, very subtle wave travels along every lit ray in the direction the
// engine's RANKS flow — always from a beam's origin toward its drawn end. So a
// normal ray (low rank → high rank) shows one wave; a tug-of-war link carries
// two opposing beams and therefore two waves flowing AT each other (meeting at
// the midpoint on a different-colour clash, or — on a same-colour tug, drawn
// full length — passing end to end, each kept to its own side of the centreline).
const WAVE_WIDTH   = 2;      // stroke width — the "two pixel wide" flow
const WAVE_AMP     = 0.7;    // transverse undulation amplitude
const WAVE_LAMBDA  = 30;     // wavelength along the ray
const WAVE_SPEED   = 13;     // crest travel speed (slow)
const WAVE_LANE    = 1.0;    // side-offset for a tug's two waves (own left-normal)
const WAVE_ALPHA   = 0.42;   // peak opacity — subtle
const WAVE_STEP    = 4;      // sampling spacing along the ray
const WAVE_LIGHTEN = 0.55;   // how far the wave colour is pushed toward white
const WAVE_INSET   = 2;      // keep the wave this far inside each end of the ray
const WAVE_RAMP    = 12;     // over this distance the wave eases onto the core at each end
const WAVE_MIN_LEN = 2 * (WAVE_INSET + 4);   // shorter rays get no wave

// Push a #rrggbb colour `amt` (0..1) of the way toward white → an "rgb()" string.
function lightenHex(hex, amt) {
  const h = (hex || '#999999').replace('#', '');
  const r = parseInt(h.slice(0, 2), 16) || 0;
  const g = parseInt(h.slice(2, 4), 16) || 0;
  const b = parseInt(h.slice(4, 6), 16) || 0;
  const mix = (c) => Math.round(c + (255 - c) * amt);
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
}

// Draw the travelling wave for one directional ray, from O to E. This is PURELY
// COSMETIC: it is computed only from the already-solved draw segment and never
// feeds back into the engine, so occlusion can't see it — a ray is blocked by the
// solver's geometry alone, never by the wave grazing an obstacle. And it stays
// strictly inside the drawn segment (inset at both ends, amplitude eased onto the
// core near each end), so it never visually pokes past a cut where a ray ends at
// an obstacle either. Phase scrolls in +s (O→E) so crests flow that way; on a tug
// ray the wave rides one side (its own left-normal) so the two opposing waves stay
// distinct.
function drawBeamWave(ctx, O, E, hex, isTug, t) {
  const vx = E[0] - O[0], vy = E[1] - O[1];
  const len = Math.hypot(vx, vy);
  if (len < WAVE_MIN_LEN) return;
  const ux = vx / len, uy = vy / len;       // unit along the ray (flow direction)
  const nx = -uy, ny = ux;                   // left-normal
  const lane = isTug ? WAVE_LANE : 0;
  const k = (2 * Math.PI) / WAVE_LAMBDA;
  const tint = lightenHex(hex, WAVE_LIGHTEN);
  const s0 = WAVE_INSET, s1 = len - WAVE_INSET;   // drawn span, held off both ends
  ctx.save();
  ctx.lineWidth = WAVE_WIDTH;
  ctx.lineCap = 'round';
  ctx.setLineDash([]);
  ctx.strokeStyle = tint;
  // Ease the transverse offset to zero near both ends so the wave hugs the beam
  // core there (and can't lean out past a terminating obstacle).
  const edge = (s) => Math.max(0, Math.min(1, Math.min(s - s0, s1 - s) / WAVE_RAMP));
  const at = (s) => {
    const ph = k * (s - WAVE_SPEED * t);
    const off = (lane + WAVE_AMP * Math.sin(ph)) * edge(s);
    return [O[0] + ux * s + nx * off, O[1] + uy * s + ny * off, ph];
  };
  // Per-segment alpha gives the travelling brightness packet (the "pulsation").
  let [px, py] = at(s0);
  for (let s = s0 + WAVE_STEP; s <= s1; s += WAVE_STEP) {
    const cs = Math.min(s, s1);
    const [cx, cy, ph] = at(cs);
    const env = 0.30 + 0.70 * (0.5 + 0.5 * Math.sin(ph - k * (WAVE_STEP / 2)));
    ctx.globalAlpha = WAVE_ALPHA * env;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(cx, cy);
    ctx.stroke();
    px = cx; py = cy;
  }
  ctx.restore();
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

// Measure the pixel width of a tooltip line. A line is either a plain string
// or a rich segment array [{t, c?, k?, m?}]. Font context is restored on exit.
function measureLine(ctx, line, textFont, keyFont) {
  if (typeof line === 'string') { ctx.font = textFont; return ctx.measureText(line).width; }
  let w = 0;
  for (const seg of line) {
    if (seg.k) { ctx.font = keyFont; w += ctx.measureText(seg.t).width + 6; } // 3px pad each side
    else if (seg.m) { w += 12; }   // mouse icon: W=10 + 2px right margin
    else { ctx.font = textFont; w += ctx.measureText(seg.t).width; }
  }
  ctx.font = textFont;
  return w;
}

// Draw a tiny inline mouse-button icon at (x, y) = top-left corner.
// button: 'L' (left) or 'R' (right). W×H is the icon bounding box.
function drawMouseIcon(ctx, x, y, button, W, H) {
  const splitY = y + Math.round(H * 0.43);
  const midX   = x + W / 2;
  ctx.fillStyle = '#2d3547';
  ctx.strokeStyle = '#5a6890'; ctx.lineWidth = 0.75;
  if (ctx.roundRect) {
    ctx.beginPath(); ctx.roundRect(x, y, W, H, 3); ctx.fill();
    ctx.beginPath(); ctx.roundRect(x, y, W, H, 3); ctx.stroke();
  } else {
    ctx.fillRect(x, y, W, H); ctx.strokeRect(x, y, W, H);
  }
  // Highlighted button half
  const btnH = splitY - y - 1;
  ctx.fillStyle = '#5d8ad0';
  if (button === 'L') ctx.fillRect(x + 1, y + 1, Math.floor(W / 2) - 1, btnH);
  else                ctx.fillRect(Math.ceil(x + W / 2), y + 1, Math.floor(W / 2) - 1, btnH);
  // Dividers
  ctx.beginPath();
  ctx.moveTo(midX, y + 0.5); ctx.lineTo(midX, splitY);       // vertical: L/R split
  ctx.moveTo(x + 0.5, splitY); ctx.lineTo(x + W - 0.5, splitY); // horizontal: buttons/body
  ctx.stroke();
}

function polygon(ctx, pts) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
}

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

  // Inverse of screenToWorld: world coords → CSS-space point relative to the
  // canvas top-left. app.js adds the canvas's client offset to compare a world
  // position against the DOM panel's footprint.
  worldToScreen(wx, wy) {
    const { scale, ox, oy } = this._vp;
    return [wx * scale + ox, wy * scale + oy];
  }

  render(world, uiState) {
    const ctx = this.ctx;
    const { scale, ox, oy, dpr } = this._vp;
    const w = world;
    const { sel, mode } = uiState;
    const canPickup = (pos) => mode === 'play' && w.player && !w.carrying && !w.carry_box
      && dist(w.player, pos) < CONNECT_REACH && !w.reach_blocked(w.player, pos);
    // Pre-compute which item E would pick (nearest reachable carriable).
    let ePick = null;
    if (mode === 'play' && w.player && !w.carrying && !w.carry_box) {
      let best = Infinity;
      for (const c of w.carriable_nodes()) {
        if (!canPickup(c.pos)) continue;
        const d = dist(w.player, c.pos);
        if (d < best) { best = d; ePick = { id: c.id }; }
      }
      for (const bx of w.boxes) {
        const occupied = Object.values(w.nodes).some(n => isRelayKind(n.kind) && dist(n.pos,bx)<BOX_R);
        if (occupied || !canPickup(bx)) continue;
        const d = dist(w.player, bx);
        if (d < best) { best = d; ePick = { box: bx }; }
      }
    }
    const nearHue = (isTop) => isTop ? '#4dd0e1' : '#2a8fa3';

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

    // "Passable ray area" highlight: the reach region of the carried item's ray,
    // drawn first so the whole scene sits on top of it. A soft warm wash with a
    // dashed edge reads as "everywhere this could be aimed" without hiding what
    // is underneath. Populated by app.js (uiState.passableRegion).
    const region = uiState.passableRegion;
    if (region && region.length > 2) {
      ctx.save();
      polygon(ctx, region);
      ctx.fillStyle = 'rgba(245, 197, 24, 0.13)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(214, 158, 10, 0.55)';
      ctx.lineWidth = 1.25; ctx.setLineDash([5, 5]); ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

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
      if (ff.disabled) {
        // Jammed: down and inert — passable to everything. Drawn as a barely
        // there ghost so it reads as "not a barrier right now".
        ctx.strokeStyle = '#c4ccd6'; ctx.lineWidth = 2;
        ctx.setLineDash([1, 6]);
      } else if (ff.is_open) {
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

    // Beams. Occluded and delivered rays share ONE look — same thickness and
    // colour regardless of whether the beam actually reaches its goal. The look
    // is chosen by the beam's colour, not its delivered state: almost every
    // colour uses the bright (formerly "delivered") variant, while white is the
    // exception and uses the dim (formerly "occluded") colour so it stays legible
    // against the pale background. Thickness is uniform (width 4) for all beams.
    // A SAME-COLOUR TUG arrives here already drawn full length with delivered=true
    // (the engine's draw builder does that), so it shows as one smooth, even ray
    // even though mechanically nothing passes across it.
    const waveT = performance.now() / 1000;
    for (const [a, b, col, delivered, tug] of w.beams_draw) {
      const isWhite = col === 'white';
      const shade = isWhite ? (DIM[col] ?? '#999') : (COLORS[col] ?? '#999');
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.strokeStyle = shade;
      ctx.lineWidth = 4;
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
      // Slow, subtle wave flowing from O→end (the rank-flow direction). On a tug
      // ray it rides one side so the two opposing waves read as distinct.
      drawBeamWave(ctx, a, b, isWhite ? (COLORS.white ?? shade) : shade, !!tug, waveT);
    }

    // Jammer rays — "dark matter": practically invisible. A faint hair-line; a
    // deployed ray that actually reaches its target is a touch more present and
    // drops a small pip on the target so the held-down state is legible.
    for (const r of w.jam_rays_draw) {
      ctx.save();
      ctx.globalAlpha = (r.live && r.reaches) ? 0.24 : 0.10;
      ctx.beginPath();
      ctx.moveTo(r.from[0], r.from[1]);
      ctx.lineTo(r.to[0], r.to[1]);
      ctx.strokeStyle = '#171b22';
      ctx.lineWidth = 1;
      ctx.setLineDash([1, 5]);
      ctx.stroke();
      ctx.setLineDash([]);
      if (r.live && r.reaches) {
        ctx.globalAlpha = 0.5;
        ctx.beginPath(); ctx.arc(r.to[0], r.to[1], 4, 0, 2 * Math.PI);
        ctx.strokeStyle = '#171b22'; ctx.lineWidth = 1.2; ctx.stroke();
      }
      ctx.restore();
    }

    // Rewirer rays — faint, tinted to the rewirer's colour. A deployed ray that
    // reaches its target also shows a charge ring at the rewirer (frac of 3 s);
    // a stalled/unreached ray stays dim with no ring.
    for (const r of w.recolor_rays_draw) {
      const tint = COLORS[r.color] ?? '#888';
      ctx.save();
      ctx.globalAlpha = (r.live && r.reaches) ? 0.4 : 0.12;
      ctx.beginPath();
      ctx.moveTo(r.from[0], r.from[1]);
      ctx.lineTo(r.to[0], r.to[1]);
      ctx.strokeStyle = tint;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([2, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
      if (r.live && r.reaches && r.frac > 0) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(r.from[0], r.from[1], 15, -Math.PI / 2, -Math.PI / 2 + 2 * Math.PI * r.frac);
        ctx.strokeStyle = tint; ctx.lineWidth = 2.5; ctx.lineCap = 'round';
        ctx.stroke();
        ctx.lineCap = 'butt';
        ctx.restore();
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
        ctx.fillText(STR.glyph.negate, mx, my);
      }
    }

    // Placement preview ("shadow"): a guide line from the player to the spot
    // where the carried item would land. The item itself is drawn at that spot
    // by the box / connector code below.
    const pp = uiState.placePreview;
    if (pp && w.player) {
      ctx.beginPath();
      ctx.moveTo(w.player[0], w.player[1]);
      ctx.lineTo(pp.spot[0], pp.spot[1]);
      ctx.strokeStyle = pp.elevated ? '#8e44ad' : '#2e8b57';
      ctx.lineWidth = 1.5; ctx.setLineDash([3, 4]); ctx.stroke(); ctx.setLineDash([]);
    }

    // Boxes
    for (const bx of w.boxes) {
      const [x, y] = bx;
      const on = Object.values(w.nodes).some(n => n.kind==='button' && dist(bx,n.pos)<BTN_R);
      const occupied = Object.values(w.nodes).some(n => isRelayKind(n.kind) && dist(n.pos,bx)<BOX_R);
      const near = !occupied && canPickup(bx);
      ctx.fillStyle = on ? '#caa46a' : '#b08d57';
      ctx.strokeStyle = near ? nearHue(ePick?.box === bx) : '#5b4523'; ctx.lineWidth = near ? 3 : 2;
      ctx.fillRect(x-BOX_R, y-BOX_R, 2*BOX_R, 2*BOX_R);
      ctx.strokeRect(x-BOX_R, y-BOX_R, 2*BOX_R, 2*BOX_R);
    }

    // Carried box (shown at its placement shadow). Dashed outline reads as
    // "where it lands".
    if (w.carry_box) {
      const [bxc, byc] = w.carry_box;
      ctx.fillStyle = '#c9a96a';
      ctx.fillRect(bxc-BOX_R, byc-BOX_R, 2*BOX_R, 2*BOX_R);
      ctx.strokeStyle = '#5b4523'; ctx.lineWidth = 2; ctx.setLineDash([4,3]);
      ctx.strokeRect(bxc-BOX_R, byc-BOX_R, 2*BOX_R, 2*BOX_R);
      ctx.setLineDash([]);
    }

    // Forge control-zone overlay. While carrying a programmable item, show the
    // reach of only the Forge(s) the robot is actually STANDING IN: one zone in a
    // single Forge's area, or BOTH when in their shared exclusion lens — there the
    // two zones appear together as an invitation to step out and disambiguate.
    // Each shown zone keeps its warm/cool tint and is carved against every live
    // Forge, so any dead overlap stays an unfilled hole rather than usable area;
    // the Forge the player can actually use right now reads brighter.
    {
      const ck = w.carrying ? w.nodes[w.carrying]?.kind : null;
      const live = (ck && objType(ck)?.programmable)
        ? w.forges().filter(f => (f.uses ?? 0) > 0) : [];
      const R = FORGE_REACH;
      const inside = w.player ? live.filter(f => dist(w.player, f.pos) < R) : [];
      if (inside.length) {
        const sole = inside.length === 1;
        // Faint fill of each shown zone MINUS every other live zone, so a shared
        // lens stays empty. (Clip to this disk, then clip away each other disk.)
        for (const f of inside) {
          const cool = f.corrupts === false;
          ctx.save();
          ctx.beginPath(); ctx.arc(f.pos[0], f.pos[1], R, 0, 2 * Math.PI); ctx.clip();
          for (const g of live) {
            if (g === f) continue;
            ctx.beginPath();
            ctx.rect(-R, -R, WORLD_W + 2 * R, WORLD_H + 2 * R);
            ctx.arc(g.pos[0], g.pos[1], R, 0, 2 * Math.PI);
            ctx.clip('evenodd');
          }
          ctx.fillStyle = cool ? 'rgba(127,147,166,0.06)' : 'rgba(245,197,24,0.06)';
          ctx.fillRect(-R, -R, WORLD_W + 2 * R, WORLD_H + 2 * R);
          ctx.restore();
        }
        // Dashed contour of each shown zone's full circle. When in the overlap,
        // both are drawn and the carved lens is the empty hole between them.
        ctx.setLineDash([6, 6]);
        for (const f of inside) {
          const cool = f.corrupts === false;
          ctx.beginPath(); ctx.arc(f.pos[0], f.pos[1], R, 0, 2 * Math.PI);
          ctx.strokeStyle = sole
            ? (cool ? 'rgba(207,224,240,0.8)' : 'rgba(245,197,24,0.8)')
            : (cool ? 'rgba(120,150,180,0.4)' : 'rgba(214,158,10,0.4)');
          ctx.lineWidth = sole ? 1.5 : 1;
          ctx.stroke();
        }
        ctx.setLineDash([]);
      }
    }

    // Nodes
    for (const n of Object.values(w.nodes)) {
      if (n.spent) continue;            // a fired (destroyed) rewirer is gone
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
          ctx.fillText(STR.fillTime(n.fill_time), x, y1+3);
        }

      } else if (n.kind === 'button') {
        const pr = w.pressed[n.id] ?? false;
        ctx.beginPath(); ctx.arc(x, y, BTN_R, 0, 2*Math.PI);
        ctx.fillStyle = pr ? '#88d18b' : '#e7e7e7'; ctx.fill();
        ctx.strokeStyle = '#555'; ctx.lineWidth = 2; ctx.stroke();
        ctx.fillStyle = '#333'; ctx.font = '8px sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(STR.glyph.button, x, y);

      } else if (LOGIC_KINDS.includes(n.kind)) {
        const on = w.logic_val[n.id] ?? false;
        ctx.fillStyle = on ? '#bfe6c2' : '#eceff1';
        ctx.strokeStyle = '#516'; ctx.lineWidth = 2;
        ctx.fillRect(x-17, y-13, 34, 26);
        ctx.strokeRect(x-17, y-13, 34, 26);
        ctx.fillStyle = '#333'; ctx.font = 'bold 8px sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(n.kind === 'and' ? STR.glyph.and : STR.glyph.or, x, y);

      } else if (isRelayKind(n.kind)) {
        const carriedNow = w.carrying === n.id;
        const targetingNow = uiState.targeting && uiState.targeting.id === n.id;
        const wouldElevate = carriedNow && pp && pp.elevated;
        const near = canPickup(n.pos);
        const dead = Boolean(w.dead_conns && w.dead_conns.has(n.id));
        const ring = targetingNow ? '#f5c518'
          : carriedNow ? (wouldElevate ? '#8e44ad' : '#2e8b57')
          : (dead ? '#e23b3b'
          : (sel===n.id ? '#f5c518' : (near ? nearHue(ePick?.id === n.id) : '#222')));
        const col = w.emit[n.id];
        // Carried connectors are placement previews: a dashed ring marking the
        // spot where the drop would land.
        if (carriedNow) {
          ctx.beginPath(); ctx.arc(x, y, 16, 0, 2*Math.PI);
          ctx.strokeStyle = ring; ctx.lineWidth = 1.5;
          ctx.setLineDash([2,3]); ctx.stroke(); ctx.setLineDash([]);
        }
        if (!carriedNow && w._conn_elevated(n.id)) {
          ctx.beginPath(); ctx.arc(x, y, 16, 0, 2*Math.PI);
          ctx.strokeStyle = '#8e44ad'; ctx.lineWidth = 2;
          ctx.setLineDash([2,2]); ctx.stroke(); ctx.setLineDash([]);
        }
        ctx.beginPath(); ctx.arc(x, y, CONN_R, 0, 2*Math.PI);
        ctx.fillStyle = col ? COLORS[col] : '#fff';
        ctx.fill();
        ctx.strokeStyle = ring; ctx.lineWidth = 3; ctx.stroke();
        // A recoloured connector carries an assigned colour: mark it with an
        // inner ring in that colour so it reads as "fixed to X" even when idle.
        if (n.color && !carriedNow) {
          ctx.beginPath(); ctx.arc(x, y, CONN_R - 3.5, 0, 2*Math.PI);
          ctx.strokeStyle = COLORS[n.color] ?? '#999'; ctx.lineWidth = 2; ctx.stroke();
        }
        ctx.fillStyle = '#111'; ctx.font = 'bold 9px sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        if (dead && !carriedNow) {
          // Colour conflict — dead until the incoming colours reduce to one.
          // The incoming rays are still real (drawn solid, still blocking);
          // only this connector's own output is inert. The X marks that.
          const xr = CONN_R - 4;
          ctx.strokeStyle = '#e23b3b'; ctx.lineWidth = 2.5; ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(x-xr, y-xr); ctx.lineTo(x+xr, y+xr);
          ctx.moveTo(x+xr, y-xr); ctx.lineTo(x-xr, y+xr);
          ctx.stroke(); ctx.lineCap = 'butt';
        } else {
          ctx.fillText(STR.glyph[n.kind] ?? STR.glyph.connector, x, y);   // 'c' connector / 'i' inverter
        }
        if (carriedNow) {
          ctx.fillStyle = ring; ctx.font = '7px sans-serif';
          ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
          ctx.fillText(targetingNow ? STR.badge.targeting : (wouldElevate ? STR.badge.stackHere : STR.badge.dropHere), x, y-14);
        } else if (w._conn_elevated(n.id)) {
          ctx.fillStyle = '#8e44ad'; ctx.font = '7px sans-serif';
          ctx.textBaseline = 'top';
          ctx.fillText(STR.badge.raised, x, y+14);
        }
      } else if (n.kind === 'mine') {
        const carriedNow = w.carrying === n.id;
        const near = canPickup(n.pos);
        ctx.beginPath(); ctx.arc(x, y, MINE_R, 0, 2*Math.PI);
        ctx.fillStyle = n.disabled ? '#5a6472' : '#2b2f36'; ctx.fill();
        ctx.strokeStyle = near ? nearHue(ePick?.id === n.id) : (n.disabled ? '#9aa3b0' : '#e23b3b'); ctx.lineWidth = 2;
        if (carriedNow) ctx.setLineDash([2,3]);
        ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = '#fff'; ctx.font = 'bold 8px sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(n.fuse == null ? '' : `${n.fuse}`, x, y);
        if (carriedNow) {
          ctx.fillStyle = '#e23b3b'; ctx.font = '7px sans-serif'; ctx.textBaseline = 'bottom';
          ctx.fillText(STR.badge.dropHere, x, y-13);
        }

      } else if (n.kind === 'rewirer') {
        const carriedNow = w.carrying === n.id;
        const targetingNow = uiState.targeting && uiState.targeting.id === n.id;
        const near = canPickup(n.pos);
        const c = COLORS[n.color] ?? '#999';
        polygon(ctx, diamond(x, y, 12));
        ctx.fillStyle = '#fff'; ctx.fill();
        ctx.strokeStyle = targetingNow ? '#f5c518' : (near ? nearHue(ePick?.id === n.id) : c); ctx.lineWidth = 3;
        if (carriedNow && !targetingNow) ctx.setLineDash([2,3]);
        ctx.stroke(); ctx.setLineDash([]);
        ctx.beginPath(); ctx.arc(x, y, 4, 0, 2*Math.PI); ctx.fillStyle = c; ctx.fill();
        if (carriedNow) {
          ctx.fillStyle = targetingNow ? '#f5c518' : c; ctx.font = '7px sans-serif';
          ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
          ctx.fillText(targetingNow ? STR.badge.targeting : STR.badge.dropHere, x, y-15);
        }

      } else if (n.kind === 'jammer') {
        const carriedNow = w.carrying === n.id;
        const targetingNow = uiState.targeting && uiState.targeting.id === n.id;
        const near = canPickup(n.pos);
        ctx.beginPath(); ctx.arc(x, y, 12, 0, 2*Math.PI);
        ctx.fillStyle = '#eceff1'; ctx.fill();
        ctx.strokeStyle = targetingNow ? '#f5c518' : (near ? nearHue(ePick?.id === n.id) : '#37474f'); ctx.lineWidth = 3;
        if (carriedNow && !targetingNow) ctx.setLineDash([2,3]);
        ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = '#37474f'; ctx.font = 'bold 11px sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(STR.glyph.jammer, x, y);
        if (carriedNow) {
          ctx.fillStyle = targetingNow ? '#f5c518' : '#37474f'; ctx.font = '7px sans-serif'; ctx.textBaseline = 'bottom';
          ctx.fillText(targetingNow ? STR.badge.targeting : STR.badge.dropHere, x, y-15);
        }

      } else if (n.kind === 'accumulator') {
        const carriedNow = w.carrying === n.id;
        const targetingNow = uiState.targeting && uiState.targeting.id === n.id;
        const near = canPickup(n.pos);
        const charged = !!n.color;
        const c = COLORS[n.color] ?? '#999';
        const r = 12;
        const x0 = x - r, y0 = y - r, s = 2 * r;
        // A rounded square (battery-like) marks it apart from the diamond source
        // and round jammer. Filled with its colour when charged; white when empty.
        ctx.fillStyle = charged ? c : '#fff';
        if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x0, y0, s, s, 4); ctx.fill(); }
        else ctx.fillRect(x0, y0, s, s);
        // Empty accumulators show a charge arc (fraction of ACCUM_FILL_SEC).
        if (!charged) {
          const frac = Math.max(0, Math.min(1, (w.engine.accum_charge[n.id] ?? 0) / ACCUM_FILL_SEC));
          if (frac > 0) {
            const ic = COLORS[w.engine.accum_in?.[n.id]] ?? '#7fb0e0';
            ctx.beginPath();
            ctx.arc(x, y, r - 2, -Math.PI / 2, -Math.PI / 2 + frac * 2 * Math.PI);
            ctx.strokeStyle = ic; ctx.lineWidth = 3; ctx.setLineDash([]); ctx.stroke();
          }
        }
        ctx.strokeStyle = targetingNow ? '#f5c518' : (near ? nearHue(ePick?.id === n.id) : (charged ? '#222' : '#90a4ae'));
        ctx.lineWidth = charged ? 2 : 3;
        if (carriedNow && !targetingNow) ctx.setLineDash([2, 3]);
        if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x0, y0, s, s, 4); ctx.stroke(); }
        else ctx.strokeRect(x0, y0, s, s);
        ctx.setLineDash([]);
        ctx.fillStyle = charged ? (n.color === 'white' || n.color === 'yellow' ? '#333' : '#fff') : '#607d8b';
        ctx.font = 'bold 10px sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(STR.glyph.accumulator, x, y);
        if (carriedNow) {
          ctx.fillStyle = targetingNow ? '#f5c518' : (charged ? c : '#607d8b');
          ctx.font = '7px sans-serif'; ctx.textBaseline = 'bottom';
          ctx.fillText(targetingNow ? STR.badge.targeting : STR.badge.dropHere, x, y - 15);
        }

      } else if (n.kind === 'forge') {
        const uses = n.uses ?? 0;
        const spent = uses <= 0;
        // Subtle "speaking" distinction: a corrupting Forge wears warm brass; a
        // clean-only one (corrupts:false) wears cool steel. Same shape, same count
        // — only the accent hue differs, so it reads without a label.
        const cool = n.corrupts === false;
        const accent   = spent ? '#6b7280' : (cool ? '#7f93a6' : '#b8902a');
        const accentHi = cool ? '#cfe0f0' : '#f5c518';
        // The reach ring (and the carved exclusion overlay) is drawn once, before
        // the nodes — see the Forge control-zone overlay above. Here we only style
        // the Forge icon: it brightens when programming is available at it.
        const carriedKind = w.carrying ? w.nodes[w.carrying]?.kind : null;
        const sole = w.player && w.forges().filter(f => dist(w.player, f.pos) < FORGE_REACH && (f.uses ?? 0) > 0).length === 1;
        const armed = !spent && sole && !!carriedKind && objType(carriedKind)?.programmable
          && w.player && dist(w.player, n.pos) < FORGE_REACH;
        ctx.save();
        ctx.globalAlpha = spent ? 0.45 : 1;
        const bx0 = x - FORGE_R, by0 = y - FORGE_R, bs = 2 * FORGE_R;
        ctx.fillStyle = spent ? '#3a3f47' : '#2b2f36';
        if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(bx0, by0, bs, bs, 4); ctx.fill(); }
        else ctx.fillRect(bx0, by0, bs, bs);
        ctx.strokeStyle = armed ? accentHi : accent;
        ctx.lineWidth = armed ? 3 : 2;
        if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(bx0, by0, bs, bs, 4); ctx.stroke(); }
        else ctx.strokeRect(bx0, by0, bs, bs);
        // Uses left, drawn boldly so the remaining count reads at a glance.
        ctx.fillStyle = spent ? '#9aa3b0' : (cool ? '#cbd6e2' : '#f3e3b0');
        ctx.font = 'bold 13px sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(`${uses}`, x, y + 0.5);
        ctx.restore();
      }
    }

    // Goal star
    if (w.goal) {
      polygon(ctx, starPts(w.goal[0], w.goal[1]));
      ctx.fillStyle = '#f5c518'; ctx.fill();
      ctx.strokeStyle = '#b8860b'; ctx.lineWidth = 1; ctx.stroke();
    }

    // "Possible targets" highlight: a ring around everything the carried item
    // can target. A reachable target (clear ray) gets a bright solid ring; an
    // unreachable one (the shot is blocked) a fainter dashed ring, so the player
    // can tell "I could mark it, but it won't bite from here". Populated by
    // app.js (uiState.targetHints).
    if (uiState.targetHints) {
      for (const h of uiState.targetHints) {
        const [hx, hy] = h.pos;
        const r = (h.radius ?? 14) + 5;
        ctx.beginPath(); ctx.arc(hx, hy, r, 0, 2 * Math.PI);
        if (h.reachable) {
          ctx.strokeStyle = '#f5c518'; ctx.lineWidth = 2.5; ctx.setLineDash([]);
        } else {
          ctx.strokeStyle = 'rgba(120, 130, 145, 0.7)'; ctx.lineWidth = 1.5; ctx.setLineDash([3, 4]);
        }
        ctx.stroke(); ctx.setLineDash([]);
      }
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
      const eyeR = PLAYER_R * 0.22;   // scales with the body so eyes stay natural
      ctx.fillStyle = '#fff';
      for (const s of [-1, 1]) {
        const ex = px + fx*fwd + perpx*spread*s;
        const ey = py + fy*fwd + perpy*spread*s;
        ctx.beginPath(); ctx.arc(ex, ey, eyeR, 0, 2*Math.PI); ctx.fill();
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

    // Hover tooltip: a small card above the item under the cursor, describing
    // what it is and its current state. Populated by app.js (uiState.hover).
    if (uiState.hover && uiState.hover.lines && uiState.hover.lines.length) {
      this._drawTooltip(ctx, uiState.hover);
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
      ctx.textAlign = 'left';
      this._drawRichLine(ctx, STR.resetOverlay, bx + 16, by + 10, 'bold 13px sans-serif', '#ffffff', 14);
      const tx = bx + 16, ty = by + 32, tw = bw - 32, th = 12;
      ctx.fillStyle = '#3a3f4b';
      ctx.fillRect(tx, ty, tw, th);
      ctx.fillStyle = '#e23b3b';
      ctx.fillRect(tx, ty, tw * Math.min(1, rp), th);
    }

    // Reset transform so nothing leaks between frames.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  // Draw a small info card centred horizontally over an item. `hover` is
  // { pos:[x,y], radius, lines:[title, ...details] }. The first line is the
  // title (slightly larger / brighter); the rest are state details. The card
  // floats above the item and is clamped to stay inside the world bounds.
  //
  // Each line may be a plain string OR a rich segment array [{t, c?, k?, m?}]:
  //   c = colorKey ('red' etc.) → text drawn in that game color
  //   k = true                  → text drawn as an inline key chip
  //   m = 'L'|'R'              → inline mouse-button icon
  _drawTooltip(ctx, hover) {
    const { pos, lines } = hover;
    const radius = hover.radius ?? 14;
    const TITLE_FONT = 'bold 12px sans-serif';
    const LINE_FONT  = '11px sans-serif';
    const KEY_FONT   = 'bold 9px sans-serif';
    const padX = 8, padY = 6, lineH = 14, gap = 8;

    // Measure the widest line to size the card.
    let maxW = 0;
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    for (let i = 0; i < lines.length; i++) {
      const font = i === 0 ? TITLE_FONT : LINE_FONT;
      maxW = Math.max(maxW, measureLine(ctx, lines[i], font, KEY_FONT));
    }
    const cardW = maxW + padX * 2;
    const cardH = lines.length * lineH + padY * 2;

    // Default: above the item; flip below if it would clip the top edge.
    let cardX = pos[0] - cardW / 2;
    let cardY = pos[1] - radius - gap - cardH;
    if (cardY < 4) cardY = pos[1] + radius + gap;
    cardX = Math.max(4, Math.min(cardX, WORLD_W - cardW - 4));

    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(20, 22, 28, 0.92)';
    if (ctx.roundRect) {
      ctx.beginPath(); ctx.roundRect(cardX, cardY, cardW, cardH, 5); ctx.fill();
      ctx.strokeStyle = '#3a4150'; ctx.lineWidth = 1; ctx.stroke();
    } else {
      ctx.fillRect(cardX, cardY, cardW, cardH);
      ctx.strokeStyle = '#3a4150'; ctx.lineWidth = 1;
      ctx.strokeRect(cardX, cardY, cardW, cardH);
    }

    ctx.textAlign = 'left';
    for (let i = 0; i < lines.length; i++) {
      const ty        = cardY + padY + i * lineH;
      const isTitle   = i === 0;
      const baseFont  = isTitle ? TITLE_FONT : LINE_FONT;
      const baseColor = isTitle ? '#ffffff' : '#aeb6c2';
      this._drawRichLine(ctx, lines[i], cardX + padX, ty, baseFont, baseColor, lineH);
    }
  }

  // Draw a plain string or rich segment array [{t, c?, k?, m?}] starting at
  // (x, ty) with textBaseline='top'. font/baseColor are defaults for plain text.
  // lineH drives vertical centering of key chips and mouse icons.
  _drawRichLine(ctx, line, x, ty, font, baseColor, lineH = 14) {
    const KEY_FONT  = 'bold 9px sans-serif';
    const KEY_PAD_X = 3;
    const KEY_H     = 11;
    const MOUSE_W   = 10;
    const MOUSE_H   = 13;

    ctx.textBaseline = 'top';
    if (typeof line === 'string') {
      ctx.font = font; ctx.fillStyle = baseColor;
      ctx.fillText(line, x, ty);
      return;
    }
    let cx = x;
    for (const seg of line) {
      if (seg.k) {
        ctx.font = KEY_FONT;
        const kw    = ctx.measureText(seg.t).width;
        const chipW = kw + KEY_PAD_X * 2;
        const chipY = ty + Math.max(0, (lineH - KEY_H) / 2);
        ctx.fillStyle = '#2d3547';
        if (ctx.roundRect) {
          ctx.beginPath(); ctx.roundRect(cx, chipY, chipW, KEY_H, 3);
          ctx.fill();
          ctx.strokeStyle = '#5a6890'; ctx.lineWidth = 0.75; ctx.stroke();
        } else {
          ctx.fillRect(cx, chipY, chipW, KEY_H);
          ctx.strokeStyle = '#5a6890'; ctx.lineWidth = 0.75;
          ctx.strokeRect(cx, chipY, chipW, KEY_H);
        }
        ctx.fillStyle = '#dde8ff';
        ctx.textBaseline = 'middle';
        ctx.fillText(seg.t, cx + KEY_PAD_X, chipY + KEY_H / 2);
        ctx.textBaseline = 'top';
        cx += chipW;
        ctx.font = font; ctx.fillStyle = baseColor;
      } else if (seg.m) {
        const iy = ty + Math.max(0, (lineH - MOUSE_H) / 2);
        drawMouseIcon(ctx, cx, iy, seg.m, MOUSE_W, MOUSE_H);
        cx += MOUSE_W + 2;
        ctx.font = font; ctx.fillStyle = baseColor;
      } else if (seg.c) {
        ctx.font = font;
        ctx.fillStyle = COLORS[seg.c] ?? '#fff';
        ctx.fillText(seg.t, cx, ty);
        cx += ctx.measureText(seg.t).width;
        ctx.fillStyle = baseColor;
      } else {
        ctx.font = font; ctx.fillStyle = baseColor;
        ctx.fillText(seg.t, cx, ty);
        cx += ctx.measureText(seg.t).width;
      }
    }
  }
}
