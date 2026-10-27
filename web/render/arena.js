// The Arena: a stone hall for big fan-outs and Claude Code workflows.
// Stages become pads along a path; the orchestrator stands on a dais at the
// left with its inbox; each pad shows its squad, a pile of finished reports
// and tombstones for failed agents. Drawn in code, like everything else.

import { box, circle, ellipse, line } from './scene.js';
import { drawText, textWidth } from './pixelfont.js';
import { hash32, fmtUsd, fmtDuration } from '../../core/util.js';

const C = {
  wall: '#2b2a40', wallHi: '#3a3956', brick: '#24233a', floorA: '#4a4a63', floorB: '#45455d', seam: '#38384e',
  pad: '#5d5a7e', padHi: '#7b77a6', padLo: '#3d3a58', rune: '#9a8cff', runeDone: '#7dffb0', runeFail: '#ff6b81',
  banner: '#6b2f4a', bannerHi: '#8f3f62', gold: '#ffd34d', torch: '#ffb347', flame: '#ffe08a', stone: '#8d8aa6', stoneLo: '#5e5b78',
  paper: '#f4e6c3', paperLo: '#d9c393', ink: '#1b1a2b', path: '#6d6a8f',
};

export class ArenaScene {
  constructor() { this.W = 400; this.H = 240; this.bg = null; this.pads = []; this.key = ''; }

  layout(W, H) {
    if (W !== this.W || H !== this.H) this.bg = null;
    this.W = W; this.H = H;
    this.dais = { x: 34, y: 136 };
    this.inbox = { x: 54, y: 136 };
    this.tome = { x: W - 24, y: 150 };
  }

  /** Lay out pads for the given stages (call when the stage list changes). */
  setStages(stages) {
    const key = `${this.W}|${stages.map((s) => s.name).join('|')}`;
    if (key === this.key) return;
    this.key = key;
    const n = Math.max(1, stages.length);
    const left = 92, right = this.W - 48;
    const rows = n <= 4 ? 1 : 2;
    const perRow = Math.ceil(n / rows);
    const gap = perRow > 1 ? (right - left) / (perRow - 1) : 0;
    this.pads = stages.map((s, i) => {
      const row = Math.floor(i / perRow);
      let col = i % perRow;
      if (row === 1) col = perRow - 1 - col; // snake back so the path reads continuously
      const x = Math.round(perRow > 1 ? left + gap * col : (left + right) / 2);
      const y = rows === 1 ? 140 : row === 0 ? 96 : 176;
      return { name: s.name, x, y, i };
    });
    // the finished tome waits right after the last stage
    const last = this.pads[this.pads.length - 1];
    if (last) {
      const dir = rows === 2 ? -1 : 1;
      this.tome = { x: Math.max(20, Math.min(this.W - 20, last.x + dir * 42)), y: last.y };
    }
  }

  padOf(name) { return this.pads.find((p) => p.name === name) || null; }

  /** Slot positions around a pad for individual (alerted) agents. */
  slot(pad, i) {
    const ang = -Math.PI / 2 + (i % 8) * (Math.PI / 4) + 0.4;
    return { x: Math.round(pad.x + Math.cos(ang) * 26), y: Math.round(pad.y + 4 + Math.sin(ang) * 9) };
  }

  background() {
    if (this.bg) return this.bg;
    const cv = document.createElement('canvas');
    cv.width = this.W; cv.height = this.H;
    const x = cv.getContext('2d');
    const { W, H } = this;
    // flagstone floor
    for (let y = 40; y < H; y += 12) {
      const off = ((y / 12) % 2) * 9;
      for (let px = -off; px < W; px += 18) {
        const h = hash32(`${px},${y}`);
        x.fillStyle = h % 3 ? C.floorA : C.floorB;
        x.fillRect(px, y, 17, 11);
        x.fillStyle = C.seam; x.fillRect(px + 17, y, 1, 12); x.fillRect(px, y + 11, 18, 1);
        if (h % 11 === 0) { x.fillStyle = '#55557a'; x.fillRect(px + 3 + (h % 9), y + 3, 2, 1); }
      }
    }
    // back wall with bricks
    x.fillStyle = C.wall; x.fillRect(0, 0, W, 40);
    for (let y = 2; y < 38; y += 6) {
      const off = ((y / 6) % 2) * 8;
      for (let px = -off; px < W; px += 16) { x.fillStyle = C.brick; x.fillRect(px, y, 15, 1); x.fillRect(px, y, 1, 6); }
    }
    x.fillStyle = C.wallHi; x.fillRect(0, 38, W, 2);
    x.fillStyle = 'rgba(0,0,0,0.3)'; x.fillRect(0, 40, W, 3);
    // banners
    for (let i = 0; i < Math.floor(W / 90); i++) {
      const bx = 50 + i * 90;
      x.fillStyle = C.banner; x.fillRect(bx, 4, 14, 26);
      x.fillStyle = C.bannerHi; x.fillRect(bx, 4, 14, 2);
      x.fillStyle = C.banner; x.fillRect(bx, 30, 5, 4); x.fillRect(bx + 9, 30, 5, 4);
      x.fillStyle = C.gold; x.fillRect(bx + 5, 12, 4, 4);
    }
    // dais for the orchestrator
    const d = this.dais;
    ellipse(x, d.x, d.y + 3, 24, 9, C.stoneLo);
    ellipse(x, d.x, d.y + 1, 22, 8, C.stone);
    ellipse(x, d.x, d.y, 18, 6, '#a4a1bf');
    // tome pedestal
    const t = this.tome;
    box(x, t.x - 6, t.y - 10, 12, 14, C.stone, C.stoneLo);
    x.fillStyle = C.stoneLo; x.fillRect(t.x - 8, t.y + 3, 16, 3);
    this.bg = cv;
    return cv;
  }

  /** Path between pads, drawn under everything else. */
  drawPaths(x, run, t) {
    const pts = [this.dais, ...this.pads, this.tome];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const st = i > 0 ? run.stages[i - 1] : null;
      const lit = i === 0 || (st && st.running === 0 && st.done + st.failed === st.total && st.total > 0);
      const n = Math.max(4, Math.round(Math.hypot(b.x - a.x, b.y - a.y) / 5));
      for (let k = 1; k < n; k++) {
        if (k % 2) continue;
        const px = a.x + ((b.x - a.x) * k) / n, py = a.y + 6 + ((b.y - a.y) * k) / n;
        const pulse = lit && Math.floor(t / 120 - k) % 6 === 0;
        x.fillStyle = pulse ? C.flame : lit ? '#8f8bc0' : C.path;
        x.fillRect(Math.round(px), Math.round(py), 2, 1);
      }
    }
  }

  drawTorches(x, t) {
    for (let i = 0; i < Math.floor(this.W / 90); i++) {
      const tx = 80 + i * 90;
      x.fillStyle = '#5a3a1a'; x.fillRect(tx, 16, 2, 8);
      const f = Math.floor(t / 110 + i) % 3;
      x.fillStyle = C.torch; x.fillRect(tx - 1, 12 - f % 2, 4, 4);
      x.fillStyle = C.flame; x.fillRect(tx, 13 - f, 2, 2);
    }
  }

  drawPad(x, pad, st, t, { selected = false } = {}) {
    const done = st.done, failed = st.failed, total = st.total, running = st.running;
    const finished = total > 0 && running === 0 && done + failed === total;
    const idle = running === 0 && done + failed === 0;
    ellipse(x, pad.x, pad.y + 3, 22, 8, C.padLo);
    ellipse(x, pad.x, pad.y + 1, 21, 7, idle ? '#4c4a68' : C.pad);
    ellipse(x, pad.x, pad.y, 17, 5, idle ? '#57557a' : C.padHi);
    // rune ring: brightness = progress
    const n = 16, prog = total ? (done + failed) / total : 0;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + (running ? t / 900 : 0);
      x.fillStyle = i / n < prog ? (failed && i / n > done / Math.max(1, total) ? C.runeFail : C.runeDone) : running ? C.rune : '#6c6a8c';
      x.fillRect(Math.round(pad.x + Math.cos(a) * 19), Math.round(pad.y + 1 + Math.sin(a) * 6), 1, 1);
    }
    if (finished) { x.globalAlpha = 0.25 + 0.15 * Math.sin(t / 300); ellipse(x, pad.x, pad.y, 17, 5, failed ? C.runeFail : C.runeDone); x.globalAlpha = 1; }
    // report pile (right) and tombstones (left)
    const pile = Math.min(6, done);
    for (let i = 0; i < pile; i++) {
      const px = pad.x + 12, py = pad.y + 2 - i * 2;
      x.fillStyle = C.ink; x.fillRect(px - 1, py - 1, 8, 4);
      x.fillStyle = C.paper; x.fillRect(px, py, 6, 2); x.fillStyle = C.paperLo; x.fillRect(px, py, 1, 2);
    }
    for (let i = 0; i < Math.min(3, failed); i++) {
      const gx = pad.x - 18 + i * 5, gy = pad.y + 2;
      x.fillStyle = C.ink; x.fillRect(gx - 1, gy - 6, 6, 7);
      x.fillStyle = '#8b8aa0'; x.fillRect(gx, gy - 5, 4, 5); x.fillRect(gx + 1, gy - 6, 2, 1);
      x.fillStyle = C.runeFail; x.fillRect(gx + 1, gy - 4, 2, 1);
    }
    // sign: name + counters
    const name = st.name.toUpperCase().slice(0, 11);
    const w = Math.max(textWidth(name), 34) + 8;
    // sign sits below the pad, so villager names above never collide with it
    const sy = pad.y + 10;
    x.fillStyle = '#5a3a1a'; x.fillRect(pad.x - 1, sy - 4, 2, 4);
    x.fillStyle = C.ink; x.fillRect(pad.x - w / 2 - 1, sy - 1, w + 2, 17);
    x.fillStyle = selected ? '#3b3a63' : '#2f2d4c'; x.fillRect(pad.x - w / 2, sy, w, 15);
    drawText(x, name, pad.x, sy + 2, finished ? (failed ? '#ffb3c1' : C.runeDone) : '#ffffff', { align: 'center' });
    const counts = `${running}> ${done}/${total}${failed ? ` ${failed}X` : ''}`;
    drawText(x, counts, pad.x, sy + 9, running ? '#7cf0ff' : '#a8a4cc', { align: 'center' });
  }

  drawInbox(x, run, t, flash = 0) {
    const ib = this.inbox;
    box(x, ib.x - 5, ib.y - 6, 12, 9, '#7a5230', '#3a2414');
    x.fillStyle = C.paper; x.fillRect(ib.x - 3, ib.y - 8, 8, 3);
    const label = `${run.done + run.failed}/${run.total}`;
    drawText(x, label, ib.x + 1, ib.y + 6, flash > 0 ? '#ffffff' : C.gold, { outline: C.ink, align: 'center' });
  }

  drawTome(x, run, t, glow = 0) {
    const tm = this.tome;
    const ready = run.running === 0 && run.total > 0;
    const k = ready ? 1 : 0.3;
    x.fillStyle = C.ink; x.fillRect(tm.x - 6, tm.y - 17, 12, 8);
    x.fillStyle = ready ? '#b0472f' : '#5c3a33'; x.fillRect(tm.x - 5, tm.y - 16, 10, 6);
    x.fillStyle = C.paper; x.fillRect(tm.x - 4, tm.y - 15, 8, 4); x.fillStyle = ready ? '#b0472f' : '#5c3a33'; x.fillRect(tm.x, tm.y - 15, 1, 4);
    if (ready || glow) {
      x.globalAlpha = (0.3 + 0.2 * Math.sin(t / 250)) * k + glow * 0.5;
      circle(x, tm.x, tm.y - 13, 9, C.gold);
      x.globalAlpha = 1;
    }
  }

  drawHeader(x, run, now) {
    const title = (run.workflow ? `WORKFLOW ${run.workflow}` : `${run.project} FAN-OUT`).toUpperCase().slice(0, 34);
    const f = run.forecast;
    const left = f && !run.endedAt && f.eta && f.eta > now ? `  ${fmtDuration(f.eta - now)} LEFT` : '';
    const est = f && !run.endedAt && f.projectedCost ? ` / EST ${fmtUsd(f.projectedCost)}` : '';
    const time = left || `  ${fmtDuration((run.endedAt || now) - run.startedAt)}${run.endedAt ? ' TOTAL' : ' SO FAR'}`;
    const meta = `${run.done + run.failed}/${run.total} DONE  ${run.running} RUNNING  ${fmtUsd(run.cost)}${est}${time}`;
    x.fillStyle = 'rgba(15,12,30,0.75)'; x.fillRect(0, 0, this.W, 11);
    drawText(x, title, 4, 3, C.gold);
    drawText(x, meta.toUpperCase(), this.W - 4, 3, '#cfcaf5', { align: 'right' });
  }
}

export { line };
