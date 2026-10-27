// The village workshop: a cozy top-down room drawn entirely in code.
// Stations map agent activity to places:
//   bookshelf = reading · whiteboard = planning · globe = web · server rack = running
//   desk = writing / thinking · portal = subagents arrive & leave · chest = cost · coffee = waiting for you

import { hash32 } from '../../core/util.js';
import { drawText } from './pixelfont.js';

export const TILE = 16;

const C = {
  wallTop: '#231d33', wall: '#463b62', wallStripe: '#4e4270', wainscot: '#6b4838', wainscotHi: '#8a5f49', wainscotLo: '#4a3026',
  floorA: '#8a6a50', floorB: '#7f6048', floorSeam: '#5f4534', floorHi: '#9a7a5c',
  wood: '#a0714f', woodHi: '#c08a62', woodLo: '#6a442f', woodDark: '#4a2f22',
  metal: '#7d8aa3', metalHi: '#b7c3d6', metalLo: '#4b5468', ink: '#1d1828',
  rug: '#5a3d7a', rugHi: '#7a56a3', rugLo: '#3f2a58',
  plant: '#4fb35f', plantHi: '#7ad86e', plantLo: '#2f7a45', pot: '#c0654a', potLo: '#8a3f30',
  paper: '#efe6d2', screen: '#9ff3ff', gold: '#ffd34d', goldLo: '#c99716',
};

export class Scene {
  constructor() {
    this.W = 400; this.H = 240;
    this.bg = null;
    this.desks = [];
    this.stations = {};
    this.lamps = [];
  }

  layout(W, H) {
    this.W = W; this.H = H;
    const wallH = 48;
    this.wallH = wallH;
    const s = W / 400;
    const at = (x) => Math.round(x * s);
    this.bookshelf = { x: 8, y: 6, w: 40, h: 46 };
    this.window1 = { x: at(66), y: 9, w: 30, h: 22 };
    this.whiteboard = { x: at(110), y: 8, w: 48, h: 28 };
    this.window2 = { x: at(176), y: 9, w: 30, h: 22 };
    this.globe = { x: at(222), y: 34, w: 18, h: 26 };
    this.door = { x: at(268), y: 12, w: 26, h: 36 };
    this.clock = { x: at(310), y: 12 };
    this.rack = { x: W - 44, y: 4, w: 36, h: 52 };

    this.stations = {
      read: slots(this.bookshelf.x + 10, 66, 4, 9),
      plan: slots(this.whiteboard.x + 8, 62, 4, 10),
      web: slots(this.globe.x - 6, 70, 3, 14),
      run: slots(this.rack.x - 2, 68, 3, 12),
      door: [{ x: this.door.x + 13, y: 54 }],
      portal: [{ x: Math.round(W / 2), y: H - 26 }],
      chest: { x: 26, y: H - 22 },
      coffee: slots(W - 52, H - 18, 2, 12),
    };
    this.portal = { x: Math.round(W / 2), y: H - 26 };
    this.chest = { x: 14, y: H - 38 };
    this.coffeeMachine = { x: W - 30, y: H - 44 };

    // Desks: two rows, as many columns as fit.
    const cols = Math.max(3, Math.floor((W - 96) / 64));
    const gap = (W - 64) / cols;
    this.desks = [];
    for (const rowY of [86, 140]) {
      for (let i = 0; i < cols; i++) {
        const x = Math.round(48 + gap * i + (gap - 40) / 2);
        this.desks.push({ x, y: rowY, w: 40, h: 22, seat: { x: x + 20, y: rowY + 4 } });
      }
    }
    this.aisles = [62, 118, 172, H - 26];
    this.lamps = [
      { x: this.bookshelf.x + 20, y: 30, r: 46 },
      { x: this.whiteboard.x + 24, y: 30, r: 52 },
      { x: this.rack.x + 18, y: 30, r: 44 },
      ...this.desks.map((d) => ({ x: d.x + 20, y: d.y + 4, r: 30, desk: d })),
      { x: this.portal.x, y: this.portal.y, r: 40 },
      { x: this.coffeeMachine.x + 8, y: this.coffeeMachine.y + 10, r: 26 },
    ];
    this.bg = null;
  }

  /** Static background, rendered once per layout. */
  background() {
    if (this.bg) return this.bg;
    const cv = document.createElement('canvas');
    cv.width = this.W; cv.height = this.H;
    const x = cv.getContext('2d');
    const { W, H, wallH } = this;
    // floor planks
    for (let y = wallH; y < H; y += 8) {
      const row = (y - wallH) / 8;
      x.fillStyle = row % 2 ? C.floorA : C.floorB; x.fillRect(0, y, W, 8);
      x.fillStyle = C.floorSeam; x.fillRect(0, y + 7, W, 1);
      const off = (row * 23) % 48;
      for (let px = -off; px < W; px += 48) { x.fillRect(px, y, 1, 7); }
      for (let px = 0; px < W; px += 3) {
        const hsh = hash32(`${px},${y}`);
        if (hsh % 17 === 0) { x.fillStyle = C.floorHi; x.fillRect(px, y + 2 + (hsh % 4), 2, 1); }
        if (hsh % 29 === 0) { x.fillStyle = C.floorSeam; x.fillRect(px, y + 1 + (hsh % 5), 3, 1); }
      }
    }
    // wall
    x.fillStyle = C.wall; x.fillRect(0, 0, W, wallH);
    x.fillStyle = C.wallStripe; for (let px = 4; px < W; px += 10) x.fillRect(px, 4, 3, 32);
    x.fillStyle = C.wallTop; x.fillRect(0, 0, W, 4);
    x.fillStyle = C.wainscot; x.fillRect(0, 36, W, 12);
    x.fillStyle = C.wainscotHi; x.fillRect(0, 36, W, 1);
    x.fillStyle = C.wainscotLo; x.fillRect(0, 46, W, 2);
    for (let px = 0; px < W; px += 24) { x.fillStyle = C.wainscotLo; x.fillRect(px, 38, 1, 8); }
    x.fillStyle = 'rgba(0,0,0,0.25)'; x.fillRect(0, wallH, W, 3);
    // rug under the portal
    const p = this.portal;
    ellipse(x, p.x, p.y + 1, 46, 13, C.rugLo);
    ellipse(x, p.x, p.y, 44, 12, C.rug);
    ellipse(x, p.x, p.y, 36, 9, C.rugHi);
    ellipse(x, p.x, p.y, 34, 8, C.rug);
    // rune circle
    x.fillStyle = '#b9a3ff';
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 10) x.fillRect(Math.round(p.x + Math.cos(a) * 26), Math.round(p.y + Math.sin(a) * 6), 1, 1);
    // bookshelf
    this.drawBookshelf(x);
    // whiteboard frame
    const wb = this.whiteboard;
    box(x, wb.x, wb.y, wb.w, wb.h, '#f4f1ea', C.metalLo);
    x.fillStyle = C.metal; x.fillRect(wb.x + 2, wb.y + wb.h - 2, wb.w - 4, 2);
    x.fillStyle = '#e45b5b'; x.fillRect(wb.x + 6, wb.y + wb.h - 3, 4, 1);
    x.fillStyle = '#4c8df0'; x.fillRect(wb.x + 12, wb.y + wb.h - 3, 4, 1);
    // door
    const d = this.door;
    box(x, d.x - 2, d.y - 2, d.w + 4, d.h + 2, C.woodLo, C.woodDark);
    box(x, d.x, d.y, d.w, d.h, C.wood, C.woodDark);
    x.fillStyle = C.woodHi; x.fillRect(d.x + 3, d.y + 3, d.w - 6, 1); x.fillRect(d.x + 3, d.y + 18, d.w - 6, 1);
    x.fillStyle = C.gold; x.fillRect(d.x + d.w - 6, d.y + 20, 2, 2);
    // doormat
    x.fillStyle = '#6a7a3a'; x.fillRect(d.x - 2, wallH + 1, d.w + 4, 5);
    // server rack
    const r = this.rack;
    box(x, r.x, r.y, r.w, r.h, '#2a2f3d', C.ink);
    for (let i = 0; i < 5; i++) { x.fillStyle = '#3a4152'; x.fillRect(r.x + 3, r.y + 4 + i * 9, r.w - 6, 7); x.fillStyle = '#1b1f29'; x.fillRect(r.x + 5, r.y + 6 + i * 9, 14, 3); }
    // globe stand
    const g = this.globe;
    x.fillStyle = C.woodLo; x.fillRect(g.x + 7, g.y + 14, 4, 10); x.fillRect(g.x + 3, g.y + 23, 12, 3);
    // plants
    this.drawPlant(x, 52, 40); this.drawPlant(x, W - 58, 40); this.drawPlant(x, 4, H - 70);
    // coffee corner table
    const cm = this.coffeeMachine;
    box(x, cm.x - 6, cm.y + 14, 30, 10, C.wood, C.woodDark);
    x.fillStyle = C.woodLo; x.fillRect(cm.x - 4, cm.y + 24, 3, 8); x.fillRect(cm.x + 19, cm.y + 24, 3, 8);
    box(x, cm.x, cm.y, 14, 15, '#3b3b48', C.ink);
    x.fillStyle = '#e85d5d'; x.fillRect(cm.x + 3, cm.y + 3, 2, 2);
    x.fillStyle = '#ffffff'; x.fillRect(cm.x + 4, cm.y + 9, 6, 4);
    x.fillStyle = '#6b3f2a'; x.fillRect(cm.x + 5, cm.y + 10, 4, 2);
    this.bg = cv;
    return cv;
  }

  drawBookshelf(x) {
    const b = this.bookshelf;
    box(x, b.x, b.y, b.w, b.h, C.woodLo, C.woodDark);
    const colors = ['#e05d5d', '#5d8de0', '#e0c25d', '#5dbf7a', '#b06ad9', '#e08a5d', '#d9d4c7'];
    for (let shelf = 0; shelf < 4; shelf++) {
      const sy = b.y + 3 + shelf * 11;
      x.fillStyle = C.woodDark; x.fillRect(b.x + 2, sy + 9, b.w - 4, 2);
      let bx = b.x + 3;
      let i = shelf * 5;
      while (bx < b.x + b.w - 5) {
        const h = hash32(`book${shelf}${bx}`);
        const bw = 2 + (h % 3), bh = 6 + (h % 3);
        x.fillStyle = colors[(i++ + h) % colors.length];
        x.fillRect(bx, sy + 9 - bh, bw, bh);
        x.fillStyle = 'rgba(255,255,255,0.25)'; x.fillRect(bx, sy + 9 - bh, 1, bh);
        bx += bw + (h % 7 === 0 ? 2 : 0);
      }
    }
  }

  drawPlant(x, px, py) {
    box(x, px + 3, py + 10, 10, 8, C.pot, C.potLo);
    x.fillStyle = C.potLo; x.fillRect(px + 3, py + 10, 10, 2);
    const leaves = [[8, 0], [5, 2], [11, 2], [3, 5], [13, 5], [6, 6], [10, 6], [8, 4]];
    for (const [lx, ly] of leaves) { x.fillStyle = C.plantLo; x.fillRect(px + lx - 1, py + ly + 1, 3, 3); }
    for (const [lx, ly] of leaves) { x.fillStyle = C.plant; x.fillRect(px + lx - 1, py + ly, 3, 3); x.fillStyle = C.plantHi; x.fillRect(px + lx - 1, py + ly, 1, 1); }
  }

  /** Animated scenery behind the actors. */
  drawDynamic(x, t, env) {
    this.drawWindow(x, this.window1, t, env);
    this.drawWindow(x, this.window2, t, env, 1);
    this.drawWhiteboard(x, t, env);
    this.drawClock(x, env.date);
    // server LEDs
    const r = this.rack;
    for (let i = 0; i < 5; i++) for (let j = 0; j < 4; j++) {
      const on = (Math.floor(t / (120 + 37 * j + 13 * i)) + i + j) % 3 !== 0;
      const busy = env.running > 0;
      x.fillStyle = on ? (busy && (i + j) % 2 ? '#ff6b6b' : '#5cff8a') : '#1b3a26';
      x.fillRect(r.x + 22 + j * 3, r.y + 7 + i * 9, 2, 1);
    }
    // globe spin
    const g = this.globe;
    const spin = env.web > 0 ? t / 90 : t / 900;
    circle(x, g.x + 9, g.y + 8, 8, '#3f7fd1');
    for (let i = 0; i < 4; i++) {
      const lx = ((Math.floor(spin) + i * 5) % 16) - 8;
      if (Math.abs(lx) < 7) { x.fillStyle = '#5fbf5a'; x.fillRect(g.x + 9 + lx, g.y + 4 + i * 2, 3, 2); }
    }
    x.fillStyle = 'rgba(255,255,255,0.5)'; x.fillRect(g.x + 5, g.y + 3, 2, 2);
    x.fillStyle = C.gold; x.fillRect(g.x + 1, g.y + 7, 1, 3); x.fillRect(g.x + 17, g.y + 7, 1, 3);
    // portal shimmer
    const p = this.portal;
    const k = env.portalPulse || 0;
    const n = 14;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + t / 700;
      const rr = 22 + Math.sin(t / 300 + i) * 2 + k * 6;
      x.fillStyle = i % 2 ? '#d7c6ff' : '#9a7bff';
      x.fillRect(Math.round(p.x + Math.cos(a) * rr), Math.round(p.y + Math.sin(a) * rr * 0.27), 1 + (k > 0.2 ? 1 : 0), 1);
    }
    if (k > 0) {
      x.globalAlpha = Math.min(0.6, k);
      ellipse(x, p.x, p.y, 26 * k + 6, 7 * k + 2, '#b69cff');
      x.globalAlpha = 1;
    }
  }

  drawWindow(x, w, t, env, idx = 0) {
    const sky = skyColors(env.date);
    box(x, w.x - 2, w.y - 2, w.w + 4, w.h + 4, C.woodHi, C.woodDark);
    const grad = x.createLinearGradient(0, w.y, 0, w.y + w.h);
    grad.addColorStop(0, sky[0]); grad.addColorStop(1, sky[1]);
    x.fillStyle = grad; x.fillRect(w.x, w.y, w.w, w.h);
    if (sky.night) {
      for (let i = 0; i < 9; i++) {
        const h = hash32(`star${idx}${i}`);
        if ((Math.floor(t / 600) + i) % 5 === 0) continue;
        x.fillStyle = '#fff6c9'; x.fillRect(w.x + (h % w.w), w.y + ((h >> 8) % (w.h - 6)), 1, 1);
      }
      if (idx === 1) { circle(x, w.x + 22, w.y + 7, 4, '#fff2b0'); circle(x, w.x + 24, w.y + 6, 4, sky[0]); }
    } else {
      if (idx === 0) circle(x, w.x + 7, w.y + 7, 4, sky.sun);
      for (let i = 0; i < 2; i++) {
        const cx = w.x + ((((t / (180 + i * 90)) + i * 17 + idx * 9) % (w.w + 20)) - 10);
        x.fillStyle = 'rgba(255,255,255,0.85)';
        x.fillRect(Math.round(cx), w.y + 5 + i * 8, 8, 2); x.fillRect(Math.round(cx) + 2, w.y + 4 + i * 8, 4, 1);
      }
    }
    x.fillStyle = C.woodHi; x.fillRect(w.x + w.w / 2 - 1, w.y, 2, w.h); x.fillRect(w.x, w.y + w.h / 2 - 1, w.w, 2);
    x.fillStyle = C.woodLo; x.fillRect(w.x - 3, w.y + w.h + 2, w.w + 6, 2);
  }

  drawWhiteboard(x, t, env) {
    const wb = this.whiteboard;
    const lines = Math.min(6, env.planLines || 3);
    x.fillStyle = '#f4f1ea'; x.fillRect(wb.x + 2, wb.y + 2, wb.w - 4, wb.h - 5);
    for (let i = 0; i < lines; i++) {
      const h = hash32(`wb${i}${env.planSeed || 0}`);
      const done = i < (env.planDone || 0);
      x.fillStyle = done ? '#5dbf7a' : '#9aa3b5';
      x.fillRect(wb.x + 4, wb.y + 4 + i * 3, 2, 2);
      x.fillStyle = done ? '#9fd9ae' : '#5b6478';
      x.fillRect(wb.x + 8, wb.y + 5 + i * 3, 10 + (h % 22), 1);
    }
    drawText(x, 'TODO', wb.x + wb.w - 18, wb.y + 3, '#e45b5b');
  }

  drawClock(x, date) {
    const c = this.clock;
    circle(x, c.x, c.y, 7, C.woodDark);
    circle(x, c.x, c.y, 6, '#f4ecd8');
    const h = (date.getHours() % 12) / 12 * Math.PI * 2 - Math.PI / 2;
    const m = date.getMinutes() / 60 * Math.PI * 2 - Math.PI / 2;
    line(x, c.x, c.y, c.x + Math.cos(h) * 3, c.y + Math.sin(h) * 3, C.ink);
    line(x, c.x, c.y, c.x + Math.cos(m) * 5, c.y + Math.sin(m) * 5, '#c0392b');
  }

  /** Desk + laptop, drawn in front of the seated villager. */
  drawDesk(x, d, t, state) {
    const { x: dx, y: dy, w } = d;
    // laptop (back of the lid faces us)
    const glow = state?.busy ? 1 : 0.4;
    box(x, dx + 12, dy - 2, 16, 10, '#c9ced8', '#5d6577');
    x.fillStyle = `rgba(159,243,255,${0.35 * glow})`; x.fillRect(dx + 13, dy - 1, 14, 8);
    x.fillStyle = state?.alert ? '#ff5c7a' : '#ffffff'; x.fillRect(dx + 19, dy + 2, 2, 2);
    // desk top + front
    box(x, dx, dy + 8, w, 6, C.woodHi, C.woodDark);
    box(x, dx + 1, dy + 13, w - 2, 10, C.wood, C.woodDark);
    x.fillStyle = C.woodLo; x.fillRect(dx + 2, dy + 21, w - 4, 1);
    // name plate
    if (state?.label) {
      x.fillStyle = '#2b2236'; x.fillRect(dx + 4, dy + 15, w - 8, 6);
      const plate = state.label.length > 8 ? `${state.label.slice(0, 7)}.` : state.label; // cut names end in a dot
      drawText(x, plate, dx + w / 2, dy + 16, state.color || C.gold, { align: 'center' });
    }
    // mug
    x.fillStyle = '#ffffff'; x.fillRect(dx + 32, dy + 4, 4, 4); x.fillStyle = '#6b3f2a'; x.fillRect(dx + 33, dy + 5, 2, 1);
    if (state?.typing) {
      const k = Math.floor(t / 120) % 4;
      x.fillStyle = '#9ff3ff';
      x.fillRect(dx + 14 + k * 3, dy - 5 - (k % 2), 1, 1);
    }
  }

  drawChest(x, t, shake = 0, amount = 0) {
    const c = this.chest;
    const sx = shake > 0 ? Math.round(Math.sin(t / 25) * shake) : 0;
    const open = shake > 0.3 ? 3 : 0;
    box(x, c.x + sx, c.y + 8, 24, 12, '#9a5b2c', '#4a2a14');
    x.fillStyle = C.gold; x.fillRect(c.x + sx, c.y + 12, 24, 2);
    box(x, c.x + sx, c.y + 2 - open, 24, 7, '#b06a34', '#4a2a14');
    x.fillStyle = C.gold; x.fillRect(c.x + sx + 10, c.y + 6 - open, 4, 4);
    if (open) { x.fillStyle = '#ffe58a'; x.fillRect(c.x + sx + 3, c.y + 7, 18, 2); }
    x.fillStyle = C.goldLo; x.fillRect(c.x + sx, c.y + 19, 24, 1);
  }

  /** Night lighting: darken the room, punch warm light holes around lamps and busy desks. */
  drawLighting(x, env, lights) {
    const dark = darkness(env.date);
    if (dark <= 0.02) return;
    const cv = this._light || (this._light = document.createElement('canvas'));
    if (cv.width !== this.W || cv.height !== this.H) { cv.width = this.W; cv.height = this.H; }
    const l = cv.getContext('2d');
    l.globalCompositeOperation = 'source-over';
    l.clearRect(0, 0, this.W, this.H);
    l.fillStyle = `rgba(14,10,40,${0.55 * dark})`;
    l.fillRect(0, 0, this.W, this.H);
    l.globalCompositeOperation = 'destination-out';
    for (const lp of lights) {
      const g = l.createRadialGradient(lp.x, lp.y, 2, lp.x, lp.y, lp.r);
      g.addColorStop(0, `rgba(0,0,0,${lp.strength ?? 0.9})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      l.fillStyle = g;
      l.beginPath(); l.arc(lp.x, lp.y, lp.r, 0, Math.PI * 2); l.fill();
    }
    x.drawImage(cv, 0, 0);
  }
}

// ---------------------------------------------------------------- helpers

function slots(x0, y, n, step) { return Array.from({ length: n }, (_, i) => ({ x: x0 + i * step, y: y + (i % 2) * 3 })); }

export function box(x, px, py, w, h, fill, outline) {
  x.fillStyle = outline; x.fillRect(px, py, w, h);
  x.fillStyle = fill; x.fillRect(px + 1, py + 1, w - 2, h - 2);
}

export function circle(x, cx, cy, r, color) {
  x.fillStyle = color;
  for (let dy = -r; dy <= r; dy++) {
    const w = Math.floor(Math.sqrt(r * r - dy * dy + r * 0.8));
    x.fillRect(Math.round(cx - w), Math.round(cy + dy), w * 2 + 1, 1);
  }
}

export function ellipse(x, cx, cy, rx, ry, color) {
  x.fillStyle = color;
  for (let dy = -ry; dy <= ry; dy++) {
    const w = Math.round(rx * Math.sqrt(Math.max(0, 1 - (dy * dy) / (ry * ry))));
    x.fillRect(Math.round(cx - w), Math.round(cy + dy), w * 2, 1);
  }
}

export function line(x, x0, y0, x1, y1, color) {
  x.fillStyle = color;
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
  for (let i = 0; i <= n; i++) x.fillRect(Math.round(x0 + ((x1 - x0) * i) / n), Math.round(y0 + ((y1 - y0) * i) / n), 1, 1);
}

function darkness(date) {
  const h = date.getHours() + date.getMinutes() / 60;
  if (h >= 7 && h <= 17) return 0;
  if (h > 17 && h < 19.5) return (h - 17) / 2.5;
  if (h >= 5 && h < 7) return (7 - h) / 2;
  return 1;
}

function skyColors(date) {
  const h = date.getHours() + date.getMinutes() / 60;
  if (h >= 7 && h < 16.5) return Object.assign(['#5fb7ff', '#bfe6ff'], { sun: '#fff1a8' });
  if (h >= 16.5 && h < 19) return Object.assign(['#ff8a5c', '#ffd27a'], { sun: '#fff1a8' });
  if (h >= 5 && h < 7) return Object.assign(['#7a7ad9', '#ffb3a3'], { sun: '#ffe6a8' });
  return Object.assign(['#141a3d', '#2b2f6b'], { night: true });
}
