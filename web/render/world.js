// WorldView: turns snapshots + effects into a living pixel room.
// The canvas is drawn at a small logical resolution and scaled up by an
// integer factor, so every pixel stays crisp.

import { Scene, box, circle, ellipse, line } from './scene.js';
import { getSprite, SPRITE_W, SPRITE_H } from './sprites.js';
import { drawText, textWidth } from './pixelfont.js';
import { fmtUsd } from '../../core/util.js';

const SPEED = 62;          // px / s
const DWELL_MS = 550;      // how long a new activity must persist before walking there
const STATION_OF = { reading: 'read', planning: 'plan', web: 'web', running: 'run' };
const WORK_POSE = new Set(['writing', 'reading', 'running', 'web', 'planning', 'tool']);

export class WorldView {
  constructor(canvas, { onSelect, sound } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.scene = new Scene();
    this.actors = new Map();
    this.particles = [];
    this.projectiles = [];
    this.floaters = [];
    this.monsters = new Map();
    this.sequences = [];
    this.snapshot = null;
    this.familiars = {};
    this.alertsByAgent = new Map();
    this.collisions = [];
    this.selected = null;
    this.hover = null;
    this.onSelect = onSelect || (() => {});
    this.sound = sound;
    this.chestShake = 0;
    this.portalPulse = 0;
    this.shake = 0;
    this.scale = 2;
    this.deskOwner = new Map(); // desk index -> sessionId
    this.last = performance.now();
    this.clockOffset = 0;
    this.resize();
    window.addEventListener('resize', () => this.resize());
    canvas.addEventListener('mousemove', (e) => { this.hover = this.pick(e); canvas.style.cursor = this.hover ? 'pointer' : 'default'; });
    canvas.addEventListener('mouseleave', () => { this.hover = null; });
    canvas.addEventListener('click', (e) => { const a = this.pick(e); this.select(a ? a.id : null); });
    requestAnimationFrame((t) => this.loop(t));
  }

  resize() {
    const wrap = this.canvas.parentElement;
    const cw = wrap.clientWidth, ch = wrap.clientHeight || 520;
    const fit = Math.min(cw / 360, ch / 240);
    // Integer scaling keeps pixels perfectly crisp; below 2× we accept a fractional
    // scale rather than a tiny village.
    let scale = fit >= 2 ? Math.min(4, Math.floor(fit)) : Math.max(1, fit);
    let W = Math.max(320, Math.min(640, Math.floor(cw / scale)));
    const H = 240;
    if (cw < 720) { W = 340; scale = cw / W; } // phones: fill the width, slightly soft but readable
    this.scale = scale;
    this.canvas.width = W; this.canvas.height = H;
    this.canvas.style.width = `${W * scale}px`;
    this.canvas.style.height = `${H * scale}px`;
    this.ctx.imageSmoothingEnabled = false;
    this.scene.layout(W, H);
    this.deskOwner.clear();
    for (const a of this.actors.values()) { a.home = null; a.locKey = ''; a.path = []; }
  }

  pick(e) {
    const r = this.canvas.getBoundingClientRect();
    const x = (e.clientX - r.left) / this.scale, y = (e.clientY - r.top) / this.scale;
    let best = null, bd = 14;
    for (const a of this.actors.values()) {
      if (a.gone) continue;
      const d = Math.hypot(a.x - x, a.y - 8 - y);
      if (d < bd) { bd = d; best = a; }
    }
    return best;
  }

  select(id) {
    this.selected = id;
    this.onSelect(id);
  }

  // ------------------------------------------------------------- data in

  setSnapshot(snap) {
    this.snapshot = snap;
    this.familiars = snap.familiars || this.familiars;
    if (snap.now) this.clockOffset = snap.now - Date.now();
    this.alertsByAgent.clear();
    this.collisions = [];
    for (const al of snap.alerts || []) {
      if (al.agentId) {
        const prev = this.alertsByAgent.get(al.agentId);
        if (!prev || rank(al.severity) > rank(prev.severity)) this.alertsByAgent.set(al.agentId, al);
      }
      if (al.kind === 'collision' && al.params?.other) this.collisions.push([al.agentId, al.params.other]);
    }
    const seen = new Set();
    for (const ag of snap.agents) {
      seen.add(ag.id);
      let a = this.actors.get(ag.id);
      if (!a && ag.alive) a = this.spawnActor(ag);
      if (!a) continue;
      a.agent = ag;
      a.fam = this.familiars[ag.familiar] || a.fam;
      if (!ag.alive && !a.leaving) this.leave(a);
    }
    for (const a of this.actors.values()) if (!seen.has(a.id) && !a.leaving) this.leave(a);
    // release desks of sessions that are gone
    for (const [i, sid] of this.deskOwner) {
      const a = this.actors.get(sid);
      if (!a || a.gone) this.deskOwner.delete(i);
    }
  }

  spawnActor(ag) {
    const sc = this.scene;
    const isSub = !!ag.parentId;
    const start = isSub ? { ...sc.portal } : { ...sc.stations.door[0] };
    const a = {
      id: ag.id, agent: ag, fam: this.familiars[ag.familiar], x: start.x, y: start.y, path: [],
      facing: 1, pose: 'idle', frame: 0, animT: Math.random() * 1000, locKey: '', pendingKey: '', pendingSince: 0,
      appear: 0, leaving: false, gone: false, blinkAt: performance.now() + 1000 + Math.random() * 3000,
      bubble: null, happyUntil: 0, attackUntil: 0, castUntil: 0, frozenUntil: 0, flash: 0, seed: Math.random() * 1000,
    };
    this.actors.set(ag.id, a);
    if (isSub) { this.portalPulse = 1; this.burst(start.x, start.y - 6, ['#b69cff', '#ffffff', '#d7c6ff'], 14); }
    else this.burst(start.x, start.y - 4, ['#ffffff', '#ffe08a'], 6);
    return a;
  }

  leave(a) {
    a.leaving = true;
    const sc = this.scene;
    const isSub = !!a.agent.parentId;
    const parent = isSub && this.actors.get(a.agent.parentId);
    const steps = [];
    if (parent && !parent.gone) steps.push({ to: this.besideOf(parent), wait: 450, then: 'deliver' });
    steps.push({ to: isSub ? { ...sc.portal } : { ...sc.stations.door[0] }, wait: 120, then: 'vanish' });
    a.script = steps;
    a.path = [];
    a.locKey = 'leaving';
  }

  besideOf(p) {
    return { x: p.x + (p.x > this.scene.W / 2 ? -14 : 14), y: p.y + 2 };
  }

  applyFx(list) {
    for (const f of list) {
      const a = f.agentId && this.actors.get(f.agentId);
      switch (f.fx) {
        case 'coins': if (a && f.usd > 0.0005) this.coins(a, f.usd); break;
        case 'handoff': this.handoff(f); break;
        case 'monster':
          if (f.action === 'spawn' && a) this.addMonster(a, f.id);
          if (f.action === 'defeat') this.defeatMonster(f.id, a);
          break;
        case 'bubble': if (a) a.bubble = { icon: f.icon, until: performance.now() + 1800 }; break;
        case 'compact': if (a) { a.bubble = { icon: 'zz', until: performance.now() + 3000 }; this.floater(a.x, a.y - 30, f.auto ? 'COMPACT!' : 'COMPACT', '#c9a6ff'); } break;
        case 'turn': if (a) { a.happyUntil = performance.now() + 2200; a.bubble = { icon: 'check', until: performance.now() + 1600 }; } break;
        case 'xp': if (a) this.floater(a.x, a.y - 34, `+${f.xp} XP`, '#7cf0ff', 1600); break;
        case 'levelup': if (a) { this.floater(a.x, a.y - 42, `LV ${f.level}!`, '#ffe066', 2200); this.ring(a, '#ffe066'); this.sound?.play('level'); } break;
        case 'hatch': case 'evolve': if (a) this.evolve(a, f); break;
        case 'shiny': if (a) { this.floater(a.x, a.y - 44, 'SHINY!', '#ff9df5', 2600); this.burst(a.x, a.y - 10, ['#ff9df5', '#9df5ff', '#ffffff'], 30); } break;
        case 'alert':
          if (f.alert.severity === 'crit') { this.shake = Math.max(this.shake, 3); this.sound?.play('alert'); }
          if (f.alert.kind === 'collision') this.zap(f.alert.agentId, f.alert.params?.other);
          break;
        case 'spawn': break;
      }
    }
  }

  // ------------------------------------------------------------- effects

  coins(a, usd) {
    const n = Math.max(1, Math.min(6, Math.round(usd / 0.01)));
    const sc = this.scene;
    for (let i = 0; i < n; i++) {
      this.projectiles.push({
        kind: 'coin', x0: a.x + (Math.random() * 6 - 3), y0: a.y - 18, x1: sc.chest.x + 12, y1: sc.chest.y + 6,
        t: -i * 0.08, dur: 0.9 + Math.random() * 0.25, arc: 30 + Math.random() * 20,
        done: () => { this.chestShake = 1; },
      });
    }
    if (usd >= 0.02) this.floater(a.x + 8, a.y - 26, fmtUsd(usd), '#ffd34d', 1100);
    this.sound?.play('coin');
  }

  handoff(f) {
    const from = this.actors.get(f.from), to = this.actors.get(f.to);
    if (!from) return;
    const sc = this.scene;
    const target = to && !to.leaving ? to : (f.kind === 'delegate' ? { x: sc.portal.x, y: sc.portal.y } : null);
    if (!target) return;
    if (f.kind === 'delegate') { from.castUntil = performance.now() + 900; this.portalPulse = 1; }
    this.projectiles.push({
      kind: 'scroll', ret: f.kind === 'return', x0: from.x, y0: from.y - 14, get x1() { return target.x; }, get y1() { return target.y - 14; },
      t: f.kind === 'return' ? -0.5 : 0, dur: 1.0, arc: 26,
      done: () => {
        this.burst(target.x, target.y - 14, f.kind === 'return' ? ['#7dff9a', '#ffffff'] : ['#ffe08a', '#ffffff'], 10);
        this.floater(target.x, target.y - 30, f.kind === 'return' ? 'REPORT!' : 'TASK!', f.kind === 'return' ? '#7dff9a' : '#ffe08a', 1200);
      },
    });
    this.sound?.play('handoff');
  }

  addMonster(a, id) {
    const n = [...this.monsters.values()].filter((m) => m.agentId === a.id).length;
    this.monsters.set(id, { id, agentId: a.id, x: a.x + 14 + n * 9, y: a.y + 4, hop: Math.random() * 6, hp: 1, dying: 0, born: performance.now() });
    this.burst(a.x + 14, a.y, ['#ff5c7a', '#ffb3c1'], 10);
    this.floater(a.x + 14, a.y - 18, 'BUG!', '#ff5c7a', 1300);
    this.sound?.play('monster');
  }

  defeatMonster(id, a) {
    let m = this.monsters.get(id);
    if (!m && a) m = [...this.monsters.values()].find((x) => x.agentId === a.id && !x.dying);
    if (!m) return;
    m.dying = performance.now();
    if (a) { a.attackUntil = performance.now() + 700; a.facing = m.x >= a.x ? 1 : -1; }
    setTimeout(() => {
      this.burst(m.x, m.y - 4, ['#ff5c7a', '#ffe066', '#ffffff', '#7dff9a'], 22);
      this.floater(m.x, m.y - 16, '+BUG SLAIN', '#7dff9a', 1500);
      this.monsters.delete(m.id);
      this.sound?.play('defeat');
    }, 450);
  }

  evolve(a, f) {
    const now = performance.now();
    const fam = this.familiars[a.agent.familiar];
    a.frozenUntil = now + 2600;
    this.sequences.push({ kind: 'evolve', actor: a, t0: now, dur: 2600, from: a.fam, to: fam });
    this.sound?.play('evolve');
    this.onEvolve?.(a, f);
  }

  ring(a, color) {
    this.sequences.push({ kind: 'ring', actor: a, t0: performance.now(), dur: 700, color });
  }

  zap(idA, idB) {
    const a = this.actors.get(idA), b = this.actors.get(idB);
    if (!a || !b) return;
    this.sequences.push({ kind: 'zap', a, b, t0: performance.now(), dur: 1400 });
  }

  burst(x, y, colors, n) {
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * Math.PI * 2, sp = 20 + Math.random() * 50;
      this.particles.push({ x, y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp - 20, life: 0.5 + Math.random() * 0.5, age: 0, color: colors[i % colors.length], g: 90 });
    }
  }

  floater(x, y, text, color, ms = 1200) {
    this.floaters.push({ x, y, text, color, age: 0, life: ms / 1000 });
  }

  // ------------------------------------------------------------- simulation

  desired(a, now) {
    const ag = a.agent;
    const sc = this.scene;
    if (!ag) return { key: 'none' };
    const st = ag.status;
    const isSub = !!ag.parentId;
    const station = STATION_OF[st];
    if (station) return { key: `st:${station}`, station };
    if (!isSub) {
      const desk = this.deskFor(a);
      if (st === 'waiting' && now - ag.statusSince > 45_000) return { key: 'coffee', station: 'coffee' };
      return { key: `desk:${desk.i}`, point: desk.seat, seat: true, desk };
    }
    const parent = this.actors.get(ag.parentId);
    if (parent) return { key: `home:${ag.parentId}`, point: this.homeFor(a, parent) };
    return { key: 'portal-side', point: { x: sc.portal.x + 30, y: sc.portal.y - 6 } };
  }

  deskFor(a) {
    const desks = this.scene.desks;
    for (const [i, sid] of this.deskOwner) if (sid === a.id) return { i, ...desks[i] };
    for (let i = 0; i < desks.length; i++) {
      if (!this.deskOwner.has(i)) { this.deskOwner.set(i, a.id); return { i, ...desks[i] }; }
    }
    const i = Math.abs(hashStr(a.id)) % desks.length; // more sessions than desks: share
    return { i, ...desks[i] };
  }

  homeFor(a, parent) {
    const siblings = [...this.actors.values()].filter((x) => x.agent?.parentId === parent.id && !x.gone);
    const idx = Math.max(0, siblings.indexOf(a));
    const desk = parent.agent && !parent.agent.parentId ? this.deskFor(parent) : null;
    const bx = desk ? desk.x : parent.x - 20, by = desk ? desk.y : parent.y - 6;
    const spots = [[-12, 10], [52, 10], [-12, 28], [52, 28], [6, 34], [34, 34], [-26, 18], [66, 18]];
    const [dx, dy] = spots[idx % spots.length];
    return { x: clampX(bx + dx, this.scene.W), y: Math.min(this.scene.H - 8, by + dy) };
  }

  claimSlot(a, station) {
    const slots = this.scene.stations[station];
    if (!Array.isArray(slots)) return slots;
    const used = new Set([...this.actors.values()].filter((x) => x !== a && x.slotStation === station && !x.gone).map((x) => x.slotIdx));
    let idx = slots.findIndex((_, i) => !used.has(i));
    if (idx < 0) idx = Math.abs(hashStr(a.id)) % slots.length;
    a.slotStation = station; a.slotIdx = idx;
    return slots[idx];
  }

  route(a, to) {
    const sc = this.scene;
    const pts = [];
    let { x, y } = a;
    if (a.atSeat) { x = a.x - 16; pts.push({ x, y }); }
    const aisle = sc.aisles.reduce((best, ay) => (Math.abs(ay - y) + Math.abs(ay - to.y) < Math.abs(best - y) + Math.abs(best - to.y) ? ay : best), sc.aisles[0]);
    const near = Math.abs(y - to.y) < 6;
    if (!near) {
      pts.push({ x, y: aisle });
      const endX = to.seat ? to.x - 16 : to.x;
      pts.push({ x: endX, y: aisle });
      if (to.seat) pts.push({ x: endX, y: to.y });
    }
    pts.push({ x: to.x, y: to.y });
    a.path = pts;
    a.atSeat = false;
  }

  step(dt, now) {
    for (const a of this.actors.values()) {
      if (a.gone) continue;
      a.animT += dt * 1000;
      a.appear = Math.min(1, a.appear + dt * 3);
      if (now < a.frozenUntil) continue;

      if (a.leaving && a.script) {
        if (!a.path.length && !a.waitUntil) {
          const s = a.script[0];
          if (!s) { a.gone = true; continue; }
          if (!s.started) { s.started = true; this.route(a, s.to); }
          else if (s.then === 'vanish') {
            this.burst(a.x, a.y - 8, a.agent?.parentId ? ['#b69cff', '#ffffff'] : ['#ffffff', '#ffe08a'], 16);
            if (a.agent?.parentId) this.portalPulse = 1;
            a.gone = true; this.actors.delete(a.id);
            if (this.selected === a.id) this.select(null);
            for (const m of this.monsters.values()) if (m.agentId === a.id) this.monsters.delete(m.id);
            continue;
          } else { a.waitUntil = now + s.wait; a.script.shift(); }
        }
        if (a.waitUntil && now > a.waitUntil) a.waitUntil = 0;
      } else if (!a.leaving) {
        const d = this.desired(a, now);
        if (d.key !== a.locKey) {
          if (d.key !== a.pendingKey) { a.pendingKey = d.key; a.pendingSince = now; }
          if (now - a.pendingSince >= DWELL_MS || !a.locKey) {
            a.locKey = d.key;
            let target = d.point;
            if (d.station) target = this.claimSlot(a, d.station);
            else a.slotStation = null;
            if (target) { this.route(a, { ...target, seat: d.seat }); a.target = { ...target, seat: !!d.seat, desk: d.desk }; }
          }
        } else a.pendingKey = d.key;
      }

      // movement
      if (a.path.length) {
        const p = a.path[0];
        const dx = p.x - a.x, dy = p.y - a.y;
        const dist = Math.hypot(dx, dy);
        const sp = SPEED * dt * (a.leaving ? 1.15 : 1);
        if (dist <= sp) { a.x = p.x; a.y = p.y; a.path.shift(); if (!a.path.length && a.target?.seat && !a.leaving) a.atSeat = true; }
        else { a.x += (dx / dist) * sp; a.y += (dy / dist) * sp; if (Math.abs(dx) > 0.5) a.facing = dx > 0 ? 1 : -1; }
        a.moving = true;
      } else a.moving = false;
    }

    // monsters hop around their agent
    for (const m of this.monsters.values()) {
      const a = this.actors.get(m.agentId);
      if (!a) { this.monsters.delete(m.id); continue; }
      const idx = [...this.monsters.values()].filter((x) => x.agentId === a.id).indexOf(m);
      const tx = a.x + (a.facing > 0 ? 14 : -14) + idx * 9 * (a.facing > 0 ? 1 : -1), ty = a.y + 3;
      m.x += (tx - m.x) * Math.min(1, dt * 2.5);
      m.y += (ty - m.y) * Math.min(1, dt * 2.5);
      m.hop += dt * 6;
    }

    for (const p of this.particles) { p.age += dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vy += p.g * dt; p.vx *= 0.98; }
    this.particles = this.particles.filter((p) => p.age < p.life);
    for (const f of this.floaters) f.age += dt;
    this.floaters = this.floaters.filter((f) => f.age < f.life);
    for (const pr of this.projectiles) { pr.t += dt / pr.dur; if (pr.t >= 1 && !pr.fired) { pr.fired = true; pr.done?.(); } }
    this.projectiles = this.projectiles.filter((p) => !p.fired);
    this.sequences = this.sequences.filter((s) => now - s.t0 < s.dur);
    this.chestShake = Math.max(0, this.chestShake - dt * 2);
    this.portalPulse = Math.max(0, this.portalPulse - dt * 0.8);
    this.shake = Math.max(0, this.shake - dt * 8);
  }

  // ------------------------------------------------------------- drawing

  loop(t) {
    const dt = Math.min(0.05, (t - this.last) / 1000);
    this.last = t;
    try { this.step(dt, t); this.draw(t); } catch (err) { console.error(err); }
    requestAnimationFrame((tt) => this.loop(tt));
  }

  draw(t) {
    const x = this.ctx, sc = this.scene;
    const date = new Date(Date.now() + this.clockOffset);
    if (this.forceHour != null) date.setHours(this.forceHour, 0);
    const ox = this.shake ? Math.round((Math.random() - 0.5) * this.shake) : 0;
    const oy = this.shake ? Math.round((Math.random() - 0.5) * this.shake) : 0;
    x.setTransform(1, 0, 0, 1, ox, oy);
    x.drawImage(sc.background(), 0, 0);
    const agents = [...this.actors.values()].filter((a) => !a.gone);
    const env = {
      date, running: agents.filter((a) => a.agent?.status === 'running').length,
      web: agents.filter((a) => a.agent?.status === 'web').length,
      portalPulse: this.portalPulse,
      planLines: 3 + Math.min(3, agents.length), planDone: Math.floor(t / 4000) % 6, planSeed: Math.floor(t / 24000),
    };
    sc.drawDynamic(x, t, env);

    // depth-sorted drawables
    const items = [];
    sc.desks.forEach((d, i) => {
      const owner = this.actors.get(this.deskOwner.get(i));
      const ag = owner?.agent;
      items.push({
        y: d.y + 14, draw: () => sc.drawDesk(x, d, t, ag ? {
          busy: owner.atSeat && ag.status !== 'waiting' && ag.status !== 'idle',
          typing: owner.atSeat && ag.status === 'writing', alert: this.alertsByAgent.has(ag.id),
          label: ag.project.toUpperCase(), color: this.alertsByAgent.has(ag.id) ? '#ff8fa3' : '#ffd34d',
        } : null),
      });
    });
    items.push({ y: sc.chest.y + 18, draw: () => sc.drawChest(x, t, this.chestShake) });
    for (const a of agents) items.push({ y: a.y, draw: () => this.drawActor(x, a, t) });
    for (const m of this.monsters.values()) items.push({ y: m.y, draw: () => this.drawMonster(x, m, t) });
    items.sort((p, q) => p.y - q.y);
    for (const it of items) it.draw();

    // collisions: crackling line between the two agents
    for (const [ia, ib] of this.collisions) {
      const a = this.actors.get(ia), b = this.actors.get(ib);
      if (a && b && !a.gone && !b.gone && Math.floor(t / 90) % 3) this.lightning(x, a.x, a.y - 12, b.x, b.y - 12, '#ff5c7a');
    }
    for (const s of this.sequences) this.drawSequence(x, s, t);
    for (const pr of this.projectiles) this.drawProjectile(x, pr, t);
    for (const p of this.particles) { x.globalAlpha = 1 - p.age / p.life; x.fillStyle = p.color; x.fillRect(Math.round(p.x), Math.round(p.y), 1, 1); }
    x.globalAlpha = 1;

    // overlays: names, HP bars, bubbles — nudge labels apart so they never overlap
    const placed = [];
    for (const a of [...agents].sort((p, q) => q.y - p.y)) {
      const fam = a.fam || {};
      const w = textWidth((fam.name || '?') + (this.selected === a.id || this.hover === a ? ` LV${fam.level || 1}` : '')) + 4;
      let top = Math.round(a.y) - SPRITE_H - (fam.stage >= 4 ? 2 : 0) - 6;
      for (let i = 0; i < 4; i++) {
        const hit = placed.some((r) => Math.abs(r.x - a.x) < (r.w + w) / 2 && Math.abs(r.y - top) < 8);
        if (!hit) break;
        top -= 8;
      }
      placed.push({ x: a.x, y: top, w });
      a.labelTop = top;
    }
    for (const a of agents) this.drawOverlay(x, a, t);
    for (const f of this.floaters) {
      const k = f.age / f.life;
      x.globalAlpha = k > 0.7 ? 1 - (k - 0.7) / 0.3 : 1;
      drawText(x, f.text, f.x, f.y - k * 14, f.color, { outline: '#1b1a2b', align: 'center' });
      x.globalAlpha = 1;
    }

    // night lighting
    const lights = sc.lamps.map((l) => ({ ...l, strength: l.desk ? (this.deskOwner.size ? 0.95 : 0.4) : 0.85 }));
    for (const a of agents) lights.push({ x: a.x, y: a.y - 8, r: 18, strength: 0.6 });
    sc.drawLighting(x, env, lights);

    // counter on the chest
    const today = this.snapshot?.totals?.cost || 0;
    drawText(x, fmtUsd(today), sc.chest.x + 12, sc.chest.y - 6, '#ffd34d', { outline: '#1b1a2b', align: 'center' });
    x.setTransform(1, 0, 0, 1, 0, 0);
  }

  drawActor(x, a, t) {
    const ag = a.agent, now = t;
    const fam = a.fam || this.familiars[ag.familiar] || { key: ag.id, species: 'egg', stage: 0, genome: { hue: 40, accentHue: 200 } };
    a.fam = fam;
    let pose = 'idle';
    const st = ag.status;
    if (a.moving) pose = 'walk';
    else if (now < a.attackUntil) pose = 'attack';
    else if (now < a.castUntil || (st === 'delegating' && !a.moving)) pose = 'cast';
    else if (st === 'compacting') pose = 'sleep';
    else if (st === 'permission') pose = 'cheer';
    else if (WORK_POSE.has(st) && (a.atSeat || a.slotStation || ag.parentId)) pose = 'work';
    else if (now < a.happyUntil) pose = 'cheer';
    const speed = pose === 'walk' ? 130 : pose === 'work' ? 160 : 500;
    const frames = pose === 'walk' ? 4 : 2;
    const frame = Math.floor((a.animT + a.seed) / speed) % frames;
    const mood = this.alertsByAgent.get(ag.id);
    let eye = '';
    if (now > a.blinkAt) { eye = 'blink'; if (now > a.blinkAt + 140) a.blinkAt = now + 2000 + Math.random() * 3500; }
    if (pose === 'sleep') eye = 'sleep';
    if (mood && (mood.kind === 'loop' || mood.kind === 'errorEcho')) eye = 'dizzy';
    if (now < a.happyUntil || pose === 'cheer' && st !== 'permission') eye = 'happy';
    const sp = getSprite(fam, pose, frame, eye);

    const cx = Math.round(a.x), cy = Math.round(a.y);
    // shadow + alert ring
    x.fillStyle = 'rgba(20,12,30,0.35)';
    ellipse(x, cx, cy + 1, 6, 2, 'rgba(20,12,30,0.35)');
    if (mood && mood.severity !== 'info') {
      const pulse = 0.5 + 0.5 * Math.sin(t / 160);
      x.globalAlpha = 0.5 + pulse * 0.5;
      ringPixels(x, cx, cy + 1, 9, 3, mood.severity === 'crit' ? '#ff4d6d' : '#ffc94d');
      x.globalAlpha = 1;
    }
    if (this.selected === a.id || this.hover === a) {
      ringPixels(x, cx, cy + 1, 10, 3, this.selected === a.id ? '#7cf0ff' : '#ffffff');
    }
    // aura for evolved familiars
    if (fam.stage >= 3) {
      const col = fam.branch === 'alchemist' ? '#ffd34d' : '#7dffb0';
      for (let i = 0; i < (fam.stage >= 4 ? 4 : 2); i++) {
        const ang = t / 500 + i * (Math.PI * 2 / (fam.stage >= 4 ? 4 : 2));
        x.fillStyle = col; x.fillRect(Math.round(cx + Math.cos(ang) * 9), Math.round(cy - 10 + Math.sin(ang) * 4), 1, 1);
      }
    }
    if (fam.shiny && Math.floor((t + a.seed) / 220) % 5 === 0) { x.fillStyle = '#ffffff'; x.fillRect(cx - 7 + Math.floor(a.seed % 14), cy - 18 + Math.floor((t / 220) % 10), 1, 1); }

    const k = a.appear;
    const w = SPRITE_W, h = SPRITE_H;
    let dx = cx - w / 2, dy = cy - h + 1;
    if (pose === 'work' && a.atSeat) dy += 0;
    x.save();
    x.globalAlpha = k;
    if (fam.corruption >= 0.5 && Math.floor((t + a.seed) / 90) % 17 === 0) dx += 2;
    if (a.facing < 0) { x.translate(cx * 2, 0); x.scale(-1, 1); }
    x.drawImage(sp, Math.round(dx), Math.round(dy));
    if (a.flash > 0) { x.globalCompositeOperation = 'source-atop'; }
    x.restore();
    x.globalAlpha = 1;

    // working props
    if (!a.moving) {
      if (st === 'reading' && a.slotStation === 'read') { x.fillStyle = '#e05d5d'; x.fillRect(cx - 3, cy - 9, 6, 4); x.fillStyle = '#f4ecd8'; x.fillRect(cx - 2, cy - 9, 4, 3); }
      if (st === 'running' && a.slotStation === 'run' && Math.floor(t / 200) % 2) { x.fillStyle = '#5cff8a'; x.fillRect(cx + 6, cy - 14, 1, 1); }
      if (pose === 'sleep') drawZ(x, cx + 6, cy - 22, t);
      if (this.actors.get(ag.id) && a.locKey === 'coffee') { x.fillStyle = '#ffffff'; x.fillRect(cx + 5, cy - 9, 3, 3); x.fillStyle = 'rgba(255,255,255,0.6)'; x.fillRect(cx + 6, cy - 12 - Math.floor(t / 300) % 3, 1, 1); }
    }
    // mood extras
    if (mood) {
      if (mood.kind === 'loop' || mood.kind === 'errorEcho') {
        for (let i = 0; i < 3; i++) {
          const ang = t / 200 + i * 2.09;
          x.fillStyle = '#ffe066';
          x.fillRect(Math.round(cx + Math.cos(ang) * 7), Math.round(cy - 21 + Math.sin(ang) * 2), 1, 1);
          x.fillRect(Math.round(cx + Math.cos(ang) * 7) + 1, Math.round(cy - 21 + Math.sin(ang) * 2), 1, 1);
        }
      }
      if (mood.kind === 'stall' && Math.floor(t / 400) % 2) { x.fillStyle = '#7cc8ff'; x.fillRect(cx + 6, cy - 17, 1, 2); x.fillRect(cx + 5, cy - 16, 3, 1); }
      if (mood.kind === 'collision') { x.fillStyle = '#ff4d6d'; x.fillRect(cx + 4, cy - 20, 3, 1); x.fillRect(cx + 5, cy - 21, 1, 3); }
    }
  }

  drawOverlay(x, a, t) {
    const ag = a.agent, fam = a.fam || {};
    const cx = Math.round(a.x), cy = Math.round(a.y);
    const top = (a.labelTop ?? (cy - SPRITE_H - (fam.stage >= 4 ? 2 : 0) - 6)) + 6;
    const focus = this.selected === a.id || this.hover === a;
    const label = (fam.name || '?') + (focus ? ` LV${fam.level || 1}` : '');
    const subColor = ag.parentId ? '#d7c6ff' : '#ffffff';
    drawText(x, label, cx, top - 6, subColor, { outline: '#1b1a2b', align: 'center' });
    // context "HP" bar
    const pct = ag.context?.window ? ag.context.used / ag.context.window : 0;
    if (pct >= 0.45 || focus) {
      const w = 14, bx = cx - w / 2, by = top - 9;
      x.fillStyle = '#1b1a2b'; x.fillRect(bx - 1, by - 1, w + 2, 4);
      x.fillStyle = '#3a3346'; x.fillRect(bx, by, w, 2);
      const left = Math.max(0, 1 - pct);
      x.fillStyle = left > 0.5 ? '#5cff8a' : left > 0.25 ? '#ffd34d' : '#ff4d6d';
      x.fillRect(bx, by, Math.round(w * left), 2);
    }
    // speech bubble
    const now = t;
    let icon = a.bubble && now < a.bubble.until ? a.bubble.icon : null;
    if (ag.status === 'permission') icon = 'alert';
    else if (ag.status === 'waiting' && !ag.parentId && !icon) icon = 'question';
    else if (ag.status === 'thinking' && !icon && Math.floor((t + a.seed * 10) / 900) % 3 === 0) icon = 'dots';
    else if (ag.status === 'compacting') icon = 'zz';
    if (icon) drawBubble(x, cx + Math.ceil(textWidth(label) / 2) + 3, top - 1, icon, t);
  }

  drawMonster(x, m, t) {
    const hop = Math.abs(Math.sin(m.hop)) * 3;
    const dying = m.dying ? (performance.now() - m.dying) / 450 : 0;
    const cx = Math.round(m.x), cy = Math.round(m.y - hop);
    if (dying && Math.floor(t / 50) % 2) return;
    ellipse(x, cx, Math.round(m.y) + 1, 4, 1, 'rgba(20,12,30,0.35)');
    const body = '#e8435f', hi = '#ff8fa3', lo = '#9a1f3a';
    x.fillStyle = '#3a0f1d'; x.fillRect(cx - 5, cy - 7, 10, 7); x.fillRect(cx - 4, cy - 8, 8, 9);
    x.fillStyle = lo; x.fillRect(cx - 4, cy - 7, 8, 7);
    x.fillStyle = body; x.fillRect(cx - 4, cy - 7, 8, 5); x.fillRect(cx - 3, cy - 8, 6, 1);
    x.fillStyle = hi; x.fillRect(cx - 3, cy - 7, 2, 1);
    x.fillStyle = '#ffffff'; x.fillRect(cx - 3, cy - 5, 2, 2); x.fillRect(cx + 1, cy - 5, 2, 2);
    x.fillStyle = '#1b1a2b'; x.fillRect(cx - 2, cy - 4, 1, 1); x.fillRect(cx + 2, cy - 4, 1, 1);
    x.fillStyle = '#3a0f1d'; x.fillRect(cx - 4, cy - 10, 1, 2); x.fillRect(cx + 3, cy - 10, 1, 2); // antennae
    if (!m.dying) { x.fillStyle = '#3a0f1d'; x.fillRect(cx - 1, cy - 2, 3, 1); }
  }

  drawProjectile(x, pr, t) {
    if (pr.t < 0) return;
    const k = easeInOut(Math.min(1, pr.t));
    const px = pr.x0 + (pr.x1 - pr.x0) * k;
    const py = pr.y0 + (pr.y1 - pr.y0) * k - Math.sin(k * Math.PI) * pr.arc;
    if (pr.kind === 'coin') {
      const spin = Math.floor(t / 80) % 4;
      const w = [3, 2, 1, 2][spin];
      x.fillStyle = '#8a5a0a'; x.fillRect(Math.round(px - w / 2) - 1, Math.round(py) - 1, w + 2, 5);
      x.fillStyle = spin === 2 ? '#c99716' : '#ffd34d'; x.fillRect(Math.round(px - w / 2), Math.round(py), w, 3);
    } else {
      // scroll with sparkle trail
      for (let i = 1; i <= 4; i++) {
        const kk = Math.max(0, k - i * 0.04);
        const tx = pr.x0 + (pr.x1 - pr.x0) * kk, ty = pr.y0 + (pr.y1 - pr.y0) * kk - Math.sin(kk * Math.PI) * pr.arc;
        x.fillStyle = pr.ret ? '#7dff9a' : '#ffe08a'; x.globalAlpha = 1 - i * 0.2; x.fillRect(Math.round(tx), Math.round(ty), 1, 1);
      }
      x.globalAlpha = 1;
      const rx = Math.round(px) - 3, ry = Math.round(py) - 2;
      x.fillStyle = '#5a3a1a'; x.fillRect(rx - 1, ry - 1, 8, 6);
      x.fillStyle = '#f4e6c3'; x.fillRect(rx, ry, 6, 4);
      x.fillStyle = '#d9c393'; x.fillRect(rx, ry, 1, 4); x.fillRect(rx + 5, ry, 1, 4);
      x.fillStyle = pr.ret ? '#2fbf5f' : '#e04b5a'; x.fillRect(rx + 2, ry, 2, 4);
    }
  }

  drawSequence(x, s, t) {
    const k = (t - s.t0) / s.dur;
    if (s.kind === 'ring') {
      const a = s.actor; const r = 4 + k * 16;
      x.globalAlpha = 1 - k; ringPixels(x, a.x, a.y - 8, r, r * 0.6, s.color); x.globalAlpha = 1;
    }
    if (s.kind === 'zap') {
      if (Math.floor(t / 60) % 2) this.lightning(x, s.a.x, s.a.y - 12, s.b.x, s.b.y - 12, '#ffffff');
    }
    if (s.kind === 'evolve') {
      const a = s.actor;
      const cx = Math.round(a.x), cy = Math.round(a.y);
      // light rays
      const n = 10;
      for (let i = 0; i < n; i++) {
        const ang = (i / n) * Math.PI * 2 + t / 400;
        const len = 10 + k * 40;
        x.globalAlpha = 0.6 * (1 - Math.abs(k - 0.5) * 1.6);
        line(x, cx, cy - 10, cx + Math.cos(ang) * len, cy - 10 + Math.sin(ang) * len * 0.8, i % 2 ? '#fff6c9' : '#ffd34d');
      }
      x.globalAlpha = 1;
      // flickering silhouette between old and new form
      const flip = Math.floor(k * 14) % 2 === 0 && k < 0.8;
      const fam = flip && s.from ? s.from : s.to || a.fam;
      if (fam) {
        const sp = getSprite(fam, 'cheer', 0, 'happy');
        const dx = cx - SPRITE_W / 2, dy = cy - SPRITE_H + 1;
        x.save();
        x.drawImage(sp, dx, dy);
        if (k < 0.85) { x.globalCompositeOperation = 'source-atop'; x.fillStyle = `rgba(255,255,255,${0.9 - k * 0.6})`; }
        x.restore();
        if (k < 0.85) { whiteSilhouette(x, sp, dx, dy, 0.85 - k * 0.5); }
      }
      if (k > 0.82 && !s.burst) { s.burst = true; this.burst(cx, cy - 10, ['#ffd34d', '#ffffff', '#7cf0ff', '#ff9df5'], 40); this.ring(a, '#ffffff'); }
    }
  }

  lightning(x, x0, y0, x1, y1, color) {
    const n = 7;
    let px = x0, py = y0;
    for (let i = 1; i <= n; i++) {
      const nx = x0 + ((x1 - x0) * i) / n + (i < n ? (Math.random() - 0.5) * 6 : 0);
      const ny = y0 + ((y1 - y0) * i) / n + (i < n ? (Math.random() - 0.5) * 6 : 0);
      line(x, px, py, nx, ny, color);
      px = nx; py = ny;
    }
  }
}

// ------------------------------------------------------------- small drawers

function drawBubble(x, bx, by, icon, t) {
  const w = icon === 'dots' ? 11 : icon === 'zz' ? 11 : 9, h = 8;
  const col = { alert: '#ff4d6d', question: '#4d9dff', check: '#3ccf6e', spark: '#ffd34d', dots: '#ffffff', zz: '#b69cff' }[icon] || '#ffffff';
  const bob = Math.round(Math.sin(t / 250) * 1);
  const X = Math.round(bx), Y = Math.round(by - h + bob);
  x.fillStyle = '#1b1a2b'; x.fillRect(X - 1, Y - 1, w + 2, h + 2); x.fillRect(X + 1, Y + h + 1, 2, 1);
  x.fillStyle = icon === 'dots' || icon === 'zz' ? '#ffffff' : col; x.fillRect(X, Y, w, h); x.fillRect(X + 1, Y + h, 2, 1);
  const fg = icon === 'dots' ? '#1b1a2b' : icon === 'zz' ? '#7a52e0' : '#ffffff';
  const txt = { alert: '!', question: '?', check: '', spark: '+', dots: '...', zz: 'ZZ' }[icon] ?? '';
  if (icon === 'check') { x.fillStyle = fg; x.fillRect(X + 2, Y + 4, 1, 1); x.fillRect(X + 3, Y + 5, 1, 1); x.fillRect(X + 4, Y + 4, 1, 1); x.fillRect(X + 5, Y + 3, 1, 1); x.fillRect(X + 6, Y + 2, 1, 1); }
  else if (icon === 'dots') { const k = Math.floor(t / 250) % 4; for (let i = 0; i < 3; i++) if (i < k) { x.fillStyle = fg; x.fillRect(X + 2 + i * 3, Y + 4, 1, 1); } }
  else drawText(x, txt, X + w / 2, Y + 2, fg, { align: 'center' });
}

function drawZ(x, px, py, t) {
  const k = (t / 900) % 1;
  x.globalAlpha = 1 - k;
  drawText(x, 'Z', px + k * 4, py - k * 8, '#d7c6ff');
  x.globalAlpha = 1;
}

function ringPixels(x, cx, cy, rx, ry, color) {
  x.fillStyle = color;
  const n = Math.max(16, Math.round(rx * 3));
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    x.fillRect(Math.round(cx + Math.cos(a) * rx), Math.round(cy + Math.sin(a) * ry), 1, 1);
  }
}

const silCache = new WeakMap();
function whiteSilhouette(x, sp, dx, dy, alpha) {
  let s = silCache.get(sp);
  if (!s) {
    s = document.createElement('canvas'); s.width = SPRITE_W; s.height = SPRITE_H;
    const c = s.getContext('2d'); c.drawImage(sp, 0, 0); c.globalCompositeOperation = 'source-in'; c.fillStyle = '#ffffff'; c.fillRect(0, 0, SPRITE_W, SPRITE_H);
    silCache.set(sp, s);
  }
  x.globalAlpha = Math.max(0, alpha);
  x.drawImage(s, dx, dy);
  x.globalAlpha = 1;
}

const easeInOut = (k) => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);
const rank = (s) => (s === 'crit' ? 2 : s === 'warn' ? 1 : 0);
const clampX = (v, W) => Math.max(10, Math.min(W - 10, v));
function hashStr(s) { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0; return h; }
