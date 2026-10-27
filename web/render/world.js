// WorldView: turns snapshots + effects into a living pixel world.
//
// Two views share one canvas:
//   room  — the cozy workshop: desks, stations, a portal for subagents
//   arena — a stone hall for big fan-outs and Claude Code workflows: one pad
//           per stage, squads instead of crowds, an inbox and a final tome
// The canvas is drawn at a small logical resolution and scaled up, so every
// pixel stays crisp.
//
// Level of detail: up to ~8 subagents per orchestrator are individual
// villagers. Beyond that, same-stage agents merge into a squad (leader + crowd
// + "×N" badge). Any agent with an active alert always steps out of its squad.

import { Scene, circle, ellipse, line } from './scene.js';
import { ArenaScene } from './arena.js';
import { getSprite, SPRITE_W, SPRITE_H } from './sprites.js';
import { drawText, textWidth } from './pixelfont.js';
import { fmtUsd } from '../../core/util.js';

const SPEED = 62;          // px / s
const DWELL_MS = 550;      // a new activity must persist this long before walking there
const SQUAD_AT = 8;        // more live subagents than this under one parent -> squads (room view)
export const ARENA_AT = 12; // a run this big switches the view to the arena (auto mode)
const STATION_OF = { reading: 'read', planning: 'plan', web: 'web', running: 'run' };
const WORK_POSE = new Set(['writing', 'reading', 'running', 'web', 'planning', 'tool']);
export const OUTCOME_COLOR = { clean: '#7dff9a', rough: '#ffd34d', failed: '#ff5c7a', lost: '#c58bff' };
const OUTCOME_TEXT = { clean: 'REPORT!', rough: 'REPORT?', failed: 'FAILED', lost: 'LOST?' };
const MODE_BADGE = { plan: ['P', '#4d9dff'], acceptEdits: ['E', '#3ccf6e'], bypassPermissions: ['!', '#ff4d6d'], auto: ['A', '#b69cff'], dontAsk: ['D', '#ffb35c'] };

export class WorldView {
  constructor(canvas, { onSelect, sound, onViewChange } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.scene = new Scene();
    this.arena = new ArenaScene();
    this.view = 'room';
    this.viewMode = 'auto';
    this.focusRun = null;
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
    this.pendingReturns = new Map(); // childId -> { outcome, parentId }
    this.pendingFanins = new Map();  // parentId -> { f, at }
    this.selected = null;
    this.hover = null;
    this.onSelect = onSelect || (() => {});
    this.onViewChange = onViewChange || (() => {});
    this.sound = sound;
    this.chestShake = 0;
    this.portalPulse = 0;
    this.inboxFlash = 0;
    this.tomeGlow = 0;
    this.shake = 0;
    this.scale = 2;
    this.deskOwner = new Map(); // desk index -> agent id
    this.last = performance.now();
    this.clockOffset = 0;
    this.bigRunEndedAt = 0;
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
    // Integer scaling keeps pixels crisp; below 2× accept a fractional scale rather than a tiny village.
    let scale = fit >= 2 ? Math.min(4, Math.floor(fit)) : Math.max(1, fit);
    let W = Math.max(320, Math.min(640, Math.floor(cw / scale)));
    const H = 240;
    if (cw < 720) { W = 340; scale = cw / W; } // phones: fill the width
    this.scale = scale;
    this.canvas.width = W; this.canvas.height = H;
    this.canvas.style.width = `${W * scale}px`;
    this.canvas.style.height = `${H * scale}px`;
    this.ctx.imageSmoothingEnabled = false;
    this.scene.layout(W, H);
    this.arena.layout(W, H);
    this.arena.key = '';
    this.deskOwner.clear();
    for (const a of this.actors.values()) { a.locKey = ''; a.path = []; }
  }

  pick(e) {
    const r = this.canvas.getBoundingClientRect();
    const x = (e.clientX - r.left) / this.scale, y = (e.clientY - r.top) / this.scale;
    let best = null, bd = 14;
    for (const a of this.actors.values()) {
      if (a.gone || !this.visible(a)) continue;
      const d = Math.hypot(a.x - x, a.y - 8 - y);
      if (d < bd) { bd = d; best = a; }
    }
    return best;
  }

  select(id) {
    this.selected = id;
    this.onSelect(id);
  }

  setViewMode(mode) {
    this.viewMode = mode;
    this.applyView(mode === 'auto' ? this.autoView() : mode, false);
  }

  autoView() {
    const r = this.focusRun;
    if (r && r.total >= ARENA_AT && (!r.endedAt || performance.now() - this.bigRunEndedAt < 15_000)) return 'arena';
    return 'room';
  }

  applyView(v, auto) {
    if (v === this.view) return;
    this.view = v;
    for (const a of this.actors.values()) { a.locKey = ''; a.path = []; a.appear = 0; a.atSeat = false; a.script = a.leaving ? [] : a.script; }
    this.burstAll = performance.now();
    this.onViewChange(v, auto);
  }

  // ------------------------------------------------------------- data in

  setSnapshot(snap) {
    this.snapshot = snap;
    this.familiars = snap.familiars || this.familiars;
    if (snap.now) this.clockOffset = snap.now - Date.now();
    this.alertsByAgent.clear();
    this.collisions = [];
    for (const al of snap.alerts || []) {
      const ids = al.params?.swarm ? [al.agentId, ...(al.params.agents || [])] : [al.agentId];
      for (const id of ids) {
        if (!id) continue;
        const prev = this.alertsByAgent.get(id);
        if (!prev || rank(al.severity) > rank(prev.severity)) this.alertsByAgent.set(id, al);
      }
      if (al.kind === 'collision' && al.params?.other) this.collisions.push([al.agentId, al.params.other]);
    }
    // focus run: the biggest active run, else the most recent one
    const runs = snap.runs || [];
    const active = runs.filter((r) => !r.endedAt).sort((a, b) => b.total - a.total);
    const prevFocus = this.focusRun;
    this.focusRun = active[0] || runs.slice().sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0))[0] || null;
    if (prevFocus && !prevFocus.endedAt && this.focusRun?.id === prevFocus.id && this.focusRun.endedAt && prevFocus.total >= ARENA_AT) this.bigRunEndedAt = performance.now();
    if (this.focusRun) this.arena.setStages(this.focusRun.stages);
    if (this.viewMode === 'auto') this.applyView(this.autoView(), true);

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
    for (const [i, sid] of this.deskOwner) {
      const a = this.actors.get(sid);
      if (!a || a.gone || a.agent?.parentId) this.deskOwner.delete(i);
    }
    this.computeSquads();
  }

  /** Decide who is drawn individually and who is folded into a squad. */
  computeSquads() {
    const byParent = new Map();
    for (const a of this.actors.values()) {
      a.squad = null;
      const ag = a.agent;
      if (!ag?.parentId || a.gone || a.leaving) continue;
      if (!byParent.has(ag.parentId)) byParent.set(ag.parentId, []);
      byParent.get(ag.parentId).push(a);
    }
    for (const [parentId, kids] of byParent) {
      const inArena = this.view === 'arena' && this.focusRun && kids.some((k) => k.agent.runId === this.focusRun.id);
      if (!inArena && kids.length <= SQUAD_AT) continue;
      const groups = new Map();
      for (const k of kids) {
        const g = k.agent.stage || k.agent.type;
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(k);
      }
      for (const [g, members] of groups) {
        const calm = members.filter((m) => !this.alertsByAgent.has(m.id));
        if (calm.length < 2) continue;
        calm.sort((p, q) => (p.agent.startedAt - q.agent.startedAt) || (p.id < q.id ? -1 : 1));
        const leader = calm[0];
        for (const m of calm) m.squad = { key: `${parentId}|${g}`, size: calm.length, leader: m === leader, leaderId: leader.id };
      }
    }
  }

  visible(a) {
    if (a.squad && !a.squad.leader) return false;
    if (this.view === 'arena') {
      const r = this.focusRun;
      if (!r) return !a.agent?.parentId;
      return a.agent?.id === r.parentId || a.agent?.runId === r.id;
    }
    return true;
  }

  spawnActor(ag) {
    const isSub = !!ag.parentId;
    const start = this.view === 'arena' ? this.arenaPoint(ag) : isSub ? { ...this.scene.portal } : { ...this.scene.stations.door[0] };
    const a = {
      id: ag.id, agent: ag, fam: this.familiars[ag.familiar], x: start.x, y: start.y, path: [],
      facing: 1, animT: Math.random() * 1000, locKey: '', pendingKey: '', pendingSince: 0,
      appear: 0, leaving: false, gone: false, blinkAt: performance.now() + 1000 + Math.random() * 3000,
      bubble: null, happyUntil: 0, attackUntil: 0, castUntil: 0, frozenUntil: 0, readUntil: 0, readColor: '',
      seed: Math.random() * 1000, queue: [], lastParallel: 0,
    };
    this.actors.set(ag.id, a);
    if (this.visibleSoon(ag)) {
      if (isSub) { this.portalPulse = 1; this.burst(start.x, start.y - 6, ['#b69cff', '#ffffff', '#d7c6ff'], 10); }
      else this.burst(start.x, start.y - 4, ['#ffffff', '#ffe08a'], 6);
    }
    return a;
  }

  visibleSoon(ag) { return this.view === 'room' || !this.focusRun || ag.runId === this.focusRun.id || ag.id === this.focusRun.parentId; }

  /** Where an agent belongs in the arena. */
  arenaPoint(ag, a) {
    const ar = this.arena, r = this.focusRun;
    if (!r) return { x: ar.dais.x, y: ar.dais.y };
    if (ag.id === r.parentId) return { x: ar.dais.x, y: ar.dais.y - 2 };
    const pad = ar.padOf(ag.stage || ag.type) || ar.pads[0];
    if (!pad) return { x: ar.dais.x + 30, y: ar.dais.y };
    if (a?.squad?.leader) return { x: pad.x, y: pad.y - 1 };
    const solos = [...this.actors.values()].filter((x) => x.agent?.runId === r.id && !x.squad && (x.agent.stage || x.agent.type) === pad.name && !x.gone);
    return ar.slot(pad, Math.max(0, solos.indexOf(a)));
  }

  leave(a) {
    a.leaving = true;
    a.path = [];
    a.locKey = 'leaving';
    const ag = a.agent;
    const ret = this.pendingReturns.get(a.id);
    const parent = ag.parentId && this.actors.get(ag.parentId);
    const canWalk = this.view === 'room' && parent && !parent.gone && this.visible(a) && this.visible(parent);
    if (ag.parentId && ret && !canWalk) {
      // Folded into a squad, or in the arena: the report flies on its own.
      this.flyReport(a, parent, ret.outcome);
      a.script = [{ vanishNow: true }];
      return;
    }
    const steps = [];
    if (canWalk && ret) steps.push({ deliver: true, parentId: parent.id, outcome: ret.outcome });
    steps.push({ to: ag.parentId ? { ...this.scene.portal } : { ...this.scene.stations.door[0] }, vanish: true });
    if (this.view === 'arena') steps.splice(0, steps.length, { vanishNow: true });
    a.script = steps;
  }

  /** Spot in the reporting queue next to the orchestrator. */
  queueSpot(parent, a) {
    let i = parent.queue.indexOf(a.id);
    if (i < 0) { parent.queue.push(a.id); i = parent.queue.length - 1; }
    const side = parent.x > this.scene.W / 2 ? -1 : 1;
    return { x: Math.round(parent.x + side * (15 + i * 11)), y: Math.round(parent.y + 5) };
  }

  applyFx(list) {
    const now = performance.now();
    for (const f of list) {
      const a = f.agentId && this.actors.get(f.agentId);
      switch (f.fx) {
        case 'coins': if (a && f.usd > 0.0005 && this.visible(a)) this.coins(a, f.usd); else if (a) this.chestShake = Math.max(this.chestShake, 0.4); break;
        case 'handoff':
          if (f.kind === 'return' && f.stay) {
            // teammates answer and stay in the room
            const child = this.actors.get(f.from), parent = this.actors.get(f.to);
            if (child && parent && this.visible(child) && this.visible(parent)) this.deliver(child, parent, f.outcome || 'clean');
          } else if (f.kind === 'return') this.pendingReturns.set(f.from, { outcome: f.outcome || 'clean', parentId: f.to });
          else this.delegate(f);
          break;
        case 'monster':
          if (f.action === 'spawn' && a) this.addMonster(a, f.id);
          if (f.action === 'defeat') this.defeatMonster(f.id, a);
          break;
        case 'bubble': if (a) a.bubble = { icon: f.icon, until: now + 1800 }; break;
        case 'compact': if (a) { a.bubble = { icon: 'zz', until: now + 3000 }; this.floater(a.x, a.y - 30, f.auto ? 'COMPACT!' : 'COMPACT', '#c9a6ff'); } break;
        case 'turn': if (a && !a.agent?.parentId) { a.happyUntil = now + 2200; } break;
        case 'xp': if (a && this.visible(a)) this.floater(a.x, a.y - 34, `+${f.xp} XP`, '#7cf0ff', 1600); break;
        case 'levelup': if (a) { this.floater(a.x, a.y - 42, `LV ${f.level}!`, '#ffe066', 2200); this.ring(a, '#ffe066'); this.sound?.play('level'); } break;
        case 'hatch': case 'evolve': if (a) this.evolve(a, f); break;
        case 'shiny': if (a) { this.floater(a.x, a.y - 44, 'SHINY!', '#ff9df5', 2600); this.burst(a.x, a.y - 10, ['#ff9df5', '#9df5ff', '#ffffff'], 30); } break;
        case 'parallel': if (a && now - a.lastParallel > 2500) { a.lastParallel = now; a.parallelUntil = now + 1400; this.floater(a.x + 10, a.y - 24, `x${f.count}`, '#9ff3ff', 900); } break;
        case 'model': if (a) { a.bubble = { icon: 'swap', until: now + 2000 }; this.floater(a.x, a.y - 32, shortModel(f.to).toUpperCase(), '#9ff3ff', 1800); } break;
        case 'note': if (a) this.floater(a.x, a.y - 32, f.text, '#d7c6ff', 1600); break;
        case 'fanin': this.pendingFanins.set(f.agentId, { f, at: now }); break;
        case 'stage.done': this.stageClear(f); break;
        case 'run.start': this.portalPulse = 1; break;
        case 'alert':
          if (f.alert.severity === 'crit') { this.shake = Math.max(this.shake, 3); this.sound?.play('alert'); }
          if (f.alert.kind === 'collision') this.zap(f.alert.agentId, f.alert.params?.other);
          break;
      }
    }
  }

  // ------------------------------------------------------------- effects

  coins(a, usd) {
    const n = Math.max(1, Math.min(6, Math.round(usd / 0.01)));
    const target = this.view === 'arena' ? { x: this.arena.inbox.x, y: this.arena.inbox.y - 4 } : { x: this.scene.chest.x + 12, y: this.scene.chest.y + 6 };
    for (let i = 0; i < n; i++) {
      this.projectiles.push({
        kind: 'coin', x0: a.x + (Math.random() * 6 - 3), y0: a.y - 18, x1: target.x, y1: target.y,
        t: -i * 0.08, dur: 0.9 + Math.random() * 0.25, arc: 30 + Math.random() * 20,
        done: () => { this.chestShake = 1; },
      });
    }
    if (usd >= 0.02) this.floater(a.x + 8, a.y - 26, fmtUsd(usd), '#ffd34d', 1100);
    this.sound?.play('coin');
  }

  delegate(f) {
    const from = this.actors.get(f.from), to = this.actors.get(f.to);
    if (!from || !this.visible(from)) return;
    from.castUntil = performance.now() + 900;
    this.portalPulse = 1;
    const target = this.view === 'arena'
      ? (to ? this.arenaPoint(to.agent, to) : this.arena.dais)
      : (to && this.visible(to) ? to : this.scene.portal);
    this.projectiles.push({
      kind: 'scroll', color: '#ffe08a', x0: from.x, y0: from.y - 14, x1: target.x, y1: target.y - 12,
      t: 0, dur: this.view === 'arena' ? 0.7 : 1.0, arc: 22,
      done: () => this.burst(target.x, target.y - 12, ['#ffe08a', '#ffffff'], 6),
    });
    this.sound?.play('handoff');
  }

  /** A report flying back without its author walking (squads, arena). */
  flyReport(a, parent, outcome) {
    const color = OUTCOME_COLOR[outcome] || OUTCOME_COLOR.clean;
    const fromPt = this.visible(a) ? a : (a.squad && this.actors.get(a.squad.leaderId)) || a;
    const to = this.view === 'arena' ? this.arena.inbox : parent;
    if (!to) return;
    const inFlight = this.projectiles.filter((p) => p.kind === 'scroll').length;
    this.projectiles.push({
      kind: 'scroll', color, x0: fromPt.x, y0: fromPt.y - 14, x1: to.x, y1: to.y - 10,
      t: -Math.min(1.5, inFlight * 0.15), dur: 0.8, arc: 18,
      done: () => {
        this.inboxFlash = 1;
        this.burst(to.x, to.y - 10, [color, '#ffffff'], 5);
        if (parent && outcome !== 'clean') this.floater(to.x, to.y - 26, OUTCOME_TEXT[outcome], color, 1100);
        this.sound?.play('deliver');
      },
    });
  }

  /** Hand-to-hand delivery at the orchestrator's side. */
  deliver(a, parent, outcome) {
    const color = OUTCOME_COLOR[outcome] || OUTCOME_COLOR.clean;
    a.facing = parent.x >= a.x ? 1 : -1;
    a.happyUntil = performance.now() + 500;
    this.projectiles.push({
      kind: 'scroll', color, x0: a.x, y0: a.y - 12, x1: parent.x, y1: parent.y - 12, t: 0, dur: 0.4, arc: 7, target: parent.id,
      done: () => {
        parent.readUntil = performance.now() + 1300;
        parent.readColor = color;
        this.burst(parent.x, parent.y - 14, [color, '#ffffff'], 8);
        this.floater(parent.x, parent.y - 32, OUTCOME_TEXT[outcome], color, 1300);
        this.inboxFlash = 1;
        this.sound?.play('deliver');
      },
    });
  }

  fanIn(parent, f) {
    const now = performance.now();
    const at = this.view === 'arena' ? { x: this.arena.tome.x, y: this.arena.tome.y } : parent;
    if (!at) return;
    const o = f.outcomes || {};
    const colors = [];
    for (const k of ['clean', 'rough', 'lost', 'failed']) for (let i = 0; i < Math.min(8, o[k] || 0); i++) colors.push(OUTCOME_COLOR[k]);
    this.sequences.push({ kind: 'tome', at, parent, t0: now, dur: 2600, colors: colors.slice(0, 10), f });
    if (this.view === 'arena') {
      // inbox scrolls march into the tome
      for (let i = 0; i < Math.min(6, f.total); i++) {
        this.projectiles.push({ kind: 'scroll', color: colors[i % Math.max(1, colors.length)] || '#7dff9a', x0: this.arena.inbox.x, y0: this.arena.inbox.y - 8, x1: at.x, y1: at.y - 14, t: -i * 0.12, dur: 1.1, arc: 30 });
      }
    }
    const label = f.failed ? `${f.done}/${f.total}  ${f.failed} FAILED` : this.allInText || 'ALL REPORTS IN';
    setTimeout(() => {
      this.floater(at.x, at.y - 44, label, f.failed ? '#ffd34d' : '#7dff9a', 2400);
      this.burst(at.x, at.y - 20, ['#ffd34d', '#ffffff', '#7dff9a', '#9ff3ff'], 36);
      this.tomeGlow = 1;
      this.sound?.play('fanin');
    }, 1200);
  }

  stageClear(f) {
    if (this.view !== 'arena') return;
    const pad = this.arena.padOf(f.stage);
    if (!pad) return;
    this.burst(pad.x, pad.y - 4, ['#7dffb0', '#ffffff', '#ffd34d'], 18);
    this.floater(pad.x, pad.y - 30, 'STAGE CLEAR', '#7dffb0', 1800);
    this.sound?.play('level');
  }

  addMonster(a, id) {
    const n = [...this.monsters.values()].filter((m) => m.agentId === a.id).length;
    this.monsters.set(id, { id, agentId: a.id, x: a.x + 14 + n * 9, y: a.y + 4, hop: Math.random() * 6, dying: 0 });
    if (!this.visible(a)) return;
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

  ring(a, color) { this.sequences.push({ kind: 'ring', actor: a, t0: performance.now(), dur: 700, color }); }

  zap(idA, idB) {
    const a = this.actors.get(idA), b = this.actors.get(idB);
    if (a && b) this.sequences.push({ kind: 'zap', a, b, t0: performance.now(), dur: 1400 });
  }

  burst(x, y, colors, n) {
    if (this.particles.length > 600) return;
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * Math.PI * 2, sp = 20 + Math.random() * 50;
      this.particles.push({ x, y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp - 20, life: 0.5 + Math.random() * 0.5, age: 0, color: colors[i % colors.length], g: 90 });
    }
  }

  floater(x, y, text, color, ms = 1200) {
    if (this.floaters.length > 40) this.floaters.shift();
    this.floaters.push({ x, y, text, color, age: 0, life: ms / 1000 });
  }

  // ------------------------------------------------------------- simulation

  desired(a, now) {
    const ag = a.agent;
    const sc = this.scene;
    if (!ag) return { key: 'none' };
    if (this.view === 'arena') {
      const p = this.arenaPoint(ag, a);
      return { key: `arena:${Math.round(p.x)},${Math.round(p.y)}`, point: p };
    }
    const st = ag.status;
    const isSub = !!ag.parentId;
    const station = STATION_OF[st];
    if (station && !a.squad) return { key: `st:${station}`, station };
    if (!isSub) {
      const desk = this.deskFor(a);
      if (st === 'waiting' && now - ag.statusSince > 45_000) return { key: 'coffee', station: 'coffee' };
      return { key: `desk:${desk.i}`, point: desk.seat, seat: true, desk };
    }
    const parent = this.actors.get(ag.parentId);
    if (parent) return { key: `home:${ag.parentId}:${this.homeIndex(a, parent)}`, point: this.homeFor(a, parent) };
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

  homeIndex(a, parent) {
    const sibs = [...this.actors.values()].filter((x) => x.agent?.parentId === parent.id && !x.gone && !x.leaving && this.visible(x));
    return Math.max(0, sibs.indexOf(a));
  }

  homeFor(a, parent) {
    const idx = this.homeIndex(a, parent);
    const desk = parent.agent && !parent.agent.parentId ? this.deskFor(parent) : null;
    const bx = desk ? desk.x : parent.x - 20, by = desk ? desk.y : parent.y - 6;
    const spots = [[-12, 10], [52, 10], [-12, 28], [52, 28], [6, 34], [34, 34], [-26, 18], [66, 18]];
    const [dx, dy] = spots[idx % spots.length];
    return { x: clampX(bx + dx, this.scene.W), y: Math.min(this.scene.H - 8, by + dy + Math.floor(idx / spots.length) * 8) };
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
    if (this.view === 'arena') { a.path = [{ x: to.x, y: to.y }]; a.atSeat = false; return; }
    const sc = this.scene;
    const pts = [];
    let { x, y } = a;
    if (a.atSeat) { x = a.x - 16; pts.push({ x, y }); }
    const aisle = sc.aisles.reduce((best, ay) => (Math.abs(ay - y) + Math.abs(ay - to.y) < Math.abs(best - y) + Math.abs(best - to.y) ? ay : best), sc.aisles[0]);
    if (Math.abs(y - to.y) >= 6) {
      pts.push({ x, y: aisle });
      const endX = to.seat ? to.x - 16 : to.x;
      pts.push({ x: endX, y: aisle });
      if (to.seat) pts.push({ x: endX, y: to.y });
    }
    pts.push({ x: to.x, y: to.y });
    a.path = pts;
    a.atSeat = false;
  }

  vanish(a) {
    if (this.visible(a)) {
      this.burst(a.x, a.y - 8, a.agent?.parentId ? ['#b69cff', '#ffffff'] : ['#ffffff', '#ffe08a'], 12);
      if (a.agent?.parentId && this.view === 'room') this.portalPulse = 1;
    }
    a.gone = true;
    this.actors.delete(a.id);
    this.pendingReturns.delete(a.id);
    for (const p of this.actors.values()) if (p.queue.length) p.queue = p.queue.filter((id) => id !== a.id);
    if (this.selected === a.id) this.select(null);
    for (const m of this.monsters.values()) if (m.agentId === a.id) this.monsters.delete(m.id);
  }

  stepLeaving(a, now) {
    const s = a.script?.[0];
    if (!s) { this.vanish(a); return; }
    if (s.vanishNow) { this.vanish(a); return; }
    if (s.deliver) {
      const parent = this.actors.get(s.parentId);
      if (!parent || parent.gone) { a.script.shift(); return; }
      const spot = this.queueSpot(parent, a);
      if (!a.path.length && Math.hypot(spot.x - a.x, spot.y - a.y) > 1.5) { a.path = []; this.route(a, spot); return; }
      if (a.path.length) return;
      // first in line, and the orchestrator has finished reading the previous scroll
      if (parent.queue[0] === a.id && now > parent.readUntil && !this.projectiles.some((p) => p.target === parent.id)) {
        this.deliver(a, parent, s.outcome);
        parent.queue.shift();
        a.waitUntil = now + 550;
        a.script.shift();
      }
      return;
    }
    if (a.waitUntil && now < a.waitUntil) return;
    a.waitUntil = 0;
    if (!s.started) { s.started = true; this.route(a, s.to); return; }
    if (!a.path.length && s.vanish) this.vanish(a);
  }

  step(dt, now) {
    for (const a of [...this.actors.values()]) {
      if (a.gone) continue;
      a.animT += dt * 1000;
      a.appear = Math.min(1, a.appear + dt * 3);
      if (now < a.frozenUntil) continue;

      if (a.leaving) this.stepLeaving(a, now);
      else {
        const d = this.desired(a, now);
        if (d.key !== a.locKey) {
          if (d.key !== a.pendingKey) { a.pendingKey = d.key; a.pendingSince = now; }
          if (now - a.pendingSince >= DWELL_MS || !a.locKey) {
            a.locKey = d.key;
            let target = d.point;
            if (d.station) target = this.claimSlot(a, d.station);
            else a.slotStation = null;
            if (target) {
              if (this.view === 'arena' && a.appear < 0.2) { a.x = target.x; a.y = target.y; a.path = []; }
              else this.route(a, { ...target, seat: d.seat });
              a.target = { ...target, seat: !!d.seat };
            }
          }
        } else a.pendingKey = d.key;
      }
      if (a.gone) continue;
      if (a.path.length) {
        const p = a.path[0];
        const dx = p.x - a.x, dy = p.y - a.y;
        const dist = Math.hypot(dx, dy);
        const sp = SPEED * dt * (a.leaving ? 1.2 : 1);
        if (dist <= sp) { a.x = p.x; a.y = p.y; a.path.shift(); if (!a.path.length && a.target?.seat && !a.leaving) a.atSeat = true; }
        else { a.x += (dx / dist) * sp; a.y += (dy / dist) * sp; if (Math.abs(dx) > 0.5) a.facing = dx > 0 ? 1 : -1; }
        a.moving = true;
      } else a.moving = false;
    }

    // fan-in waits until the last scroll is in the orchestrator's hands
    for (const [pid, pf] of this.pendingFanins) {
      const parent = this.actors.get(pid);
      const busy = parent && (parent.queue.length || this.projectiles.some((p) => p.kind === 'scroll' && (p.target === pid || p.t < 1)));
      if (!busy || now - pf.at > 6000) { this.pendingFanins.delete(pid); if (parent) this.fanIn(parent, pf.f); }
    }

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
    this.inboxFlash = Math.max(0, this.inboxFlash - dt * 2.5);
    this.tomeGlow = Math.max(0, this.tomeGlow - dt * 0.5);
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
    const x = this.ctx;
    const ox = this.shake ? Math.round((Math.random() - 0.5) * this.shake) : 0;
    const oy = this.shake ? Math.round((Math.random() - 0.5) * this.shake) : 0;
    x.setTransform(1, 0, 0, 1, ox, oy);
    const agents = [...this.actors.values()].filter((a) => !a.gone && this.visible(a));
    const items = [];
    if (this.view === 'arena') this.drawArenaBase(x, t, items);
    else this.drawRoomBase(x, t, agents, items);
    for (const a of agents) items.push({ y: a.y, draw: () => this.drawActor(x, a, t) });
    for (const m of this.monsters.values()) {
      const owner = this.actors.get(m.agentId);
      if (owner && this.visible(owner)) items.push({ y: m.y, draw: () => this.drawMonster(x, m, t) });
    }
    items.sort((p, q) => p.y - q.y);
    for (const it of items) it.draw();

    if (this.view === 'room') this.drawTeams(x, agents, t);
    for (const [ia, ib] of this.collisions) {
      const a = this.actors.get(ia), b = this.actors.get(ib);
      if (a && b && this.visible(a) && this.visible(b) && Math.floor(t / 90) % 3) this.lightning(x, a.x, a.y - 12, b.x, b.y - 12, '#ff5c7a');
    }
    for (const s of this.sequences) this.drawSequence(x, s, t);
    for (const pr of this.projectiles) this.drawProjectile(x, pr, t);
    for (const p of this.particles) { x.globalAlpha = 1 - p.age / p.life; x.fillStyle = p.color; x.fillRect(Math.round(p.x), Math.round(p.y), 1, 1); }
    x.globalAlpha = 1;

    this.placeLabels(agents);
    for (const a of agents) this.drawOverlay(x, a, t);
    for (const f of this.floaters) {
      const k = f.age / f.life;
      x.globalAlpha = k > 0.7 ? 1 - (k - 0.7) / 0.3 : 1;
      const hw = textWidth(f.text) / 2 + 2;
      const fx = Math.max(hw, Math.min(this.canvas.width - hw, f.x));
      drawText(x, f.text, fx, Math.max(14, f.y - k * 14), f.color, { outline: '#1b1a2b', align: 'center' });
      x.globalAlpha = 1;
    }

    if (this.view === 'room') {
      const sc = this.scene;
      const date = this.date();
      const lights = sc.lamps.map((l) => ({ ...l, strength: l.desk ? (this.deskOwner.size ? 0.95 : 0.4) : 0.85 }));
      for (const a of agents) lights.push({ x: a.x, y: a.y - 8, r: 18, strength: 0.6 });
      sc.drawLighting(x, { date }, lights);
      drawText(x, fmtUsd(this.snapshot?.totals?.cost || 0), sc.chest.x + 12, sc.chest.y - 6, '#ffd34d', { outline: '#1b1a2b', align: 'center' });
    } else if (this.focusRun) {
      this.arena.drawHeader(x, this.focusRun, this.snapshot?.now || Date.now());
    }
    x.setTransform(1, 0, 0, 1, 0, 0);
  }

  date() {
    const d = new Date(Date.now() + this.clockOffset);
    if (this.forceHour != null) d.setHours(this.forceHour, 0);
    return d;
  }

  drawRoomBase(x, t, agents, items) {
    const sc = this.scene;
    x.drawImage(sc.background(), 0, 0);
    const env = {
      date: this.date(), running: agents.filter((a) => a.agent?.status === 'running').length,
      web: agents.filter((a) => a.agent?.status === 'web').length, portalPulse: this.portalPulse,
      planLines: 3 + Math.min(3, agents.length), planDone: Math.floor(t / 4000) % 6, planSeed: Math.floor(t / 24000),
    };
    sc.drawDynamic(x, t, env);
    sc.desks.forEach((d, i) => {
      const owner = this.actors.get(this.deskOwner.get(i));
      const ag = owner?.agent;
      items.push({
        y: d.y + 14, draw: () => sc.drawDesk(x, d, t, ag ? {
          busy: owner.atSeat && ag.status !== 'waiting' && ag.status !== 'idle',
          typing: owner.atSeat && ag.status === 'writing', alert: this.alertsByAgent.has(ag.id),
          label: (ag.worktree || ag.project).toUpperCase(),
          color: this.alertsByAgent.has(ag.id) ? '#ff8fa3' : ag.worktree ? '#7dffb0' : '#ffd34d',
        } : null),
      });
    });
    items.push({ y: sc.chest.y + 18, draw: () => sc.drawChest(x, t, this.chestShake) });
  }

  drawArenaBase(x, t, items) {
    const ar = this.arena, r = this.focusRun;
    x.drawImage(ar.background(), 0, 0);
    ar.drawTorches(x, t);
    if (!r) { drawText(x, 'NO RUN YET', ar.W / 2, ar.H / 2, '#cfcaf5', { align: 'center', outline: '#1b1a2b' }); return; }
    ar.drawPaths(x, r, t);
    for (const st of r.stages) {
      const pad = ar.padOf(st.name);
      if (pad) items.push({ y: pad.y - 6, draw: () => ar.drawPad(x, pad, st, t) });
    }
    items.push({ y: ar.inbox.y, draw: () => ar.drawInbox(x, r, t, this.inboxFlash) });
    items.push({ y: ar.tome.y, draw: () => ar.drawTome(x, r, t, this.tomeGlow) });
  }

  drawTeams(x, agents, t) {
    const teams = this.snapshot?.teams || [];
    for (const tm of teams) {
      const lead = tm.lead && this.actors.get(tm.lead);
      const members = tm.members.map((id) => this.actors.get(id)).filter((a) => a && !a.gone);
      const hub = lead || members[0];
      if (!hub) continue;
      for (const m of members) {
        if (m === hub) continue;
        const n = Math.max(4, Math.round(Math.hypot(m.x - hub.x, m.y - hub.y) / 4));
        for (let k = 1; k < n; k++) if ((k + Math.floor(t / 200)) % 3 === 0) {
          x.fillStyle = '#ffd34d';
          x.fillRect(Math.round(hub.x + ((m.x - hub.x) * k) / n), Math.round(hub.y - 4 + ((m.y - hub.y) * k) / n), 1, 1);
        }
      }
      if (lead) { x.fillStyle = '#5a3a1a'; x.fillRect(lead.x - 9, lead.y - 30, 1, 10); x.fillStyle = '#ffd34d'; x.fillRect(lead.x - 8, lead.y - 30, 5, 3); }
    }
  }

  drawActor(x, a, t) {
    const ag = a.agent, now = t;
    const fam = a.fam || this.familiars[ag.familiar] || { key: ag.id, species: 'egg', stage: 0, genome: { hue: 40, accentHue: 200 } };
    a.fam = fam;
    const st = ag.status;
    let pose = 'idle';
    if (a.moving) pose = 'walk';
    else if (now < a.attackUntil) pose = 'attack';
    else if (now < a.castUntil || (st === 'delegating' && !a.moving)) pose = 'cast';
    else if (st === 'compacting' || st === 'exhausted') pose = 'sleep';
    else if (st === 'permission') pose = 'cheer';
    else if (now < a.readUntil) pose = 'work';
    else if (WORK_POSE.has(st) && (a.atSeat || a.slotStation || ag.parentId || this.view === 'arena')) pose = 'work';
    else if (now < a.happyUntil) pose = 'cheer';
    const speed = pose === 'walk' ? 130 : pose === 'work' ? 160 : 500;
    const frames = pose === 'walk' ? 4 : 2;
    const frame = now < a.readUntil ? 0 : Math.floor((a.animT + a.seed) / speed) % frames;
    const mood = this.alertsByAgent.get(ag.id);
    let eye = '';
    if (now > a.blinkAt) { eye = 'blink'; if (now > a.blinkAt + 140) a.blinkAt = now + 2000 + Math.random() * 3500; }
    if (pose === 'sleep') eye = 'sleep';
    if (mood && (mood.kind === 'loop' || mood.kind === 'errorEcho')) eye = 'dizzy';
    if (now < a.happyUntil || (pose === 'cheer' && st !== 'permission')) eye = 'happy';
    const sp = getSprite(fam, pose, frame, eye);
    const cx = Math.round(a.x), cy = Math.round(a.y);

    ellipse(x, cx, cy + 1, 6, 2, 'rgba(20,12,30,0.35)');
    if (mood && mood.severity !== 'info') {
      const pulse = 0.5 + 0.5 * Math.sin(t / 160);
      x.globalAlpha = 0.5 + pulse * 0.5;
      ringPixels(x, cx, cy + 1, 9, 3, mood.severity === 'crit' ? '#ff4d6d' : '#ffc94d');
      x.globalAlpha = 1;
    }
    if (this.selected === a.id || this.hover === a) ringPixels(x, cx, cy + 1, 10, 3, this.selected === a.id ? '#7cf0ff' : '#ffffff');
    if (fam.stage >= 3) {
      const col = fam.branch === 'alchemist' ? '#ffd34d' : '#7dffb0';
      const n = fam.stage >= 4 ? 4 : 2;
      for (let i = 0; i < n; i++) {
        const ang = t / 500 + i * (Math.PI * 2 / n);
        x.fillStyle = col; x.fillRect(Math.round(cx + Math.cos(ang) * 9), Math.round(cy - 10 + Math.sin(ang) * 4), 1, 1);
      }
    }
    if (fam.shiny && Math.floor((t + a.seed) / 220) % 5 === 0) { x.fillStyle = '#ffffff'; x.fillRect(cx - 7 + Math.floor(a.seed % 14), cy - 18 + Math.floor((t / 220) % 10), 1, 1); }

    let dx = cx - SPRITE_W / 2;
    const dy = cy - SPRITE_H + 1;
    if (fam.corruption >= 0.5 && Math.floor((t + a.seed) / 90) % 17 === 0) dx += 2;
    const blit = (img, ox, alpha) => {
      x.save();
      x.globalAlpha = alpha;
      if (a.facing < 0) { x.translate((cx + ox) * 2, 0); x.scale(-1, 1); }
      x.drawImage(img, Math.round(dx + ox), Math.round(dy));
      x.restore();
    };
    // squad crowd: two followers behind the leader
    if (a.squad?.leader) { blit(sp, -7, 0.55 * a.appear); blit(sp, 7, 0.55 * a.appear); }
    // parallel tool calls: afterimages
    if ((ag.parallel || 0) >= 2 || now < (a.parallelUntil || 0)) {
      const k = 0.25 + 0.1 * Math.sin(t / 90);
      blit(sp, -5, k); if ((ag.parallel || 0) >= 3) blit(sp, 5, k);
    }
    blit(sp, 0, a.appear);

    // props
    if (now < a.readUntil) {
      x.fillStyle = '#1b1a2b'; x.fillRect(cx - 5, cy - 11, 10, 6);
      x.fillStyle = '#f4e6c3'; x.fillRect(cx - 4, cy - 10, 8, 4);
      x.fillStyle = a.readColor || '#7dff9a'; x.fillRect(cx - 4, cy - 10, 1, 4); x.fillRect(cx + 3, cy - 10, 1, 4);
      x.fillStyle = '#9a8a6a'; x.fillRect(cx - 2, cy - 9, 4, 1); x.fillRect(cx - 2, cy - 7, 3, 1);
    }
    if (!a.moving) {
      if (st === 'reading' && a.slotStation === 'read') { x.fillStyle = '#e05d5d'; x.fillRect(cx - 3, cy - 9, 6, 4); x.fillStyle = '#f4ecd8'; x.fillRect(cx - 2, cy - 9, 4, 3); }
      if (st === 'running' && a.slotStation === 'run' && Math.floor(t / 200) % 2) { x.fillStyle = '#5cff8a'; x.fillRect(cx + 6, cy - 14, 1, 1); }
      if (pose === 'sleep') drawZ(x, cx + 6, cy - 22, t);
      if (a.locKey === 'coffee') { x.fillStyle = '#ffffff'; x.fillRect(cx + 5, cy - 9, 3, 3); x.fillStyle = 'rgba(255,255,255,0.6)'; x.fillRect(cx + 6, cy - 12 - Math.floor(t / 300) % 3, 1, 1); }
    }
    if (st === 'exhausted' && Math.floor(t / 350) % 2) { x.fillStyle = '#7cc8ff'; x.fillRect(cx + 7, cy - 17, 1, 2); x.fillRect(cx + 6, cy - 16, 3, 1); }
    // background tasks: little helper orbs circling the feet
    for (let i = 0; i < Math.min(3, ag.background || 0); i++) {
      const ang = t / 400 + i * 2.1;
      x.fillStyle = '#9aa3b5'; x.fillRect(Math.round(cx + Math.cos(ang) * 9), Math.round(cy - 1 + Math.sin(ang) * 2), 2, 2);
    }
    if (mood) {
      if (mood.kind === 'loop' || mood.kind === 'errorEcho') {
        for (let i = 0; i < 3; i++) {
          const ang = t / 200 + i * 2.09;
          x.fillStyle = '#ffe066';
          x.fillRect(Math.round(cx + Math.cos(ang) * 7), Math.round(cy - 21 + Math.sin(ang) * 2), 2, 1);
        }
      }
      if ((mood.kind === 'stall' || mood.kind === 'straggler') && Math.floor(t / 400) % 2) { x.fillStyle = '#7cc8ff'; x.fillRect(cx + 6, cy - 17, 1, 2); x.fillRect(cx + 5, cy - 16, 3, 1); }
      if (mood.kind === 'collision') { x.fillStyle = '#ff4d6d'; x.fillRect(cx + 4, cy - 20, 3, 1); x.fillRect(cx + 5, cy - 21, 1, 3); }
    }
  }

  placeLabels(agents) {
    const placed = [];
    for (const a of [...agents].sort((p, q) => q.y - p.y)) {
      const fam = a.fam || {};
      const w = textWidth(this.labelText(a)) + 4;
      let top = Math.round(a.y) - SPRITE_H - (fam.stage >= 4 ? 2 : 0) - 6;
      for (let i = 0; i < 4; i++) {
        if (!placed.some((r) => Math.abs(r.x - a.x) < (r.w + w) / 2 && Math.abs(r.y - top) < 8)) break;
        top -= 8;
      }
      placed.push({ x: a.x, y: top, w });
      a.labelTop = top;
    }
  }

  labelText(a) {
    const fam = a.fam || {};
    const focus = this.selected === a.id || this.hover === a;
    return (fam.name || '?') + (focus ? ` LV${fam.level || 1}` : '') + (a.squad?.leader ? ` x${a.squad.size}` : '');
  }

  drawOverlay(x, a, t) {
    const ag = a.agent;
    const cx = Math.round(a.x), cy = Math.round(a.y);
    const top = (a.labelTop ?? (cy - SPRITE_H - 6)) + 6;
    const focus = this.selected === a.id || this.hover === a;
    const label = this.labelText(a);
    drawText(x, label, cx, top - 6, ag.parentId ? '#d7c6ff' : '#ffffff', { outline: '#1b1a2b', align: 'center' });
    const half = Math.ceil(textWidth(label) / 2);
    // permission-mode badge to the left of the name
    const mb = MODE_BADGE[ag.mode];
    if (mb && (ag.mode !== 'bypassPermissions' || Math.floor(t / 400) % 2 === 0 || focus)) {
      const bx = cx - half - 8, by = top - 7;
      x.fillStyle = '#1b1a2b'; x.fillRect(bx - 1, by - 1, 7, 7);
      x.fillStyle = mb[1]; x.fillRect(bx, by, 5, 5);
      drawText(x, mb[0], bx + 1, by, '#ffffff');
    }
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
    // inbox counter over an orchestrator with a run in flight (room view)
    if (this.view === 'room' && !ag.parentId && ag.runId) {
      const r = (this.snapshot?.runs || []).find((x2) => x2.id === ag.runId);
      if (r && (!r.endedAt || (this.snapshot.now - r.endedAt) < 8000)) {
        const txt = `${r.done + r.failed}/${r.total}`;
        const w = textWidth(txt) + 9, bx = cx - Math.round(w / 2), by = top - 18;
        x.fillStyle = '#1b1a2b'; x.fillRect(bx - 1, by - 1, w + 2, 8);
        x.fillStyle = this.inboxFlash > 0 ? '#3d5a3d' : '#2b2140'; x.fillRect(bx, by, w, 6);
        x.fillStyle = '#f4e6c3'; x.fillRect(bx + 1, by + 1, 4, 4); x.fillStyle = '#c99716'; x.fillRect(bx + 1, by + 1, 1, 4);
        drawText(x, txt, bx + 7, by + 1, r.failed ? '#ffd34d' : '#7dff9a');
      }
    }
    // speech bubble
    let icon = a.bubble && t < a.bubble.until ? a.bubble.icon : null;
    if (ag.status === 'permission') icon = 'alert';
    else if (ag.status === 'exhausted') icon = 'exhausted';
    else if (ag.status === 'waiting' && !ag.parentId && !icon) icon = 'question';
    else if (ag.status === 'thinking' && !icon && Math.floor((t + a.seed * 10) / 900) % 3 === 0) icon = 'dots';
    else if (ag.status === 'compacting') icon = 'zz';
    if (icon) drawBubble(x, cx + half + 3, top - 1, icon, t);
  }

  drawMonster(x, m, t) {
    const hop = Math.abs(Math.sin(m.hop)) * 3;
    const dying = m.dying ? (performance.now() - m.dying) / 450 : 0;
    const cx = Math.round(m.x), cy = Math.round(m.y - hop);
    if (dying && Math.floor(t / 50) % 2) return;
    ellipse(x, cx, Math.round(m.y) + 1, 4, 1, 'rgba(20,12,30,0.35)');
    x.fillStyle = '#3a0f1d'; x.fillRect(cx - 5, cy - 7, 10, 7); x.fillRect(cx - 4, cy - 8, 8, 9);
    x.fillStyle = '#9a1f3a'; x.fillRect(cx - 4, cy - 7, 8, 7);
    x.fillStyle = '#e8435f'; x.fillRect(cx - 4, cy - 7, 8, 5); x.fillRect(cx - 3, cy - 8, 6, 1);
    x.fillStyle = '#ff8fa3'; x.fillRect(cx - 3, cy - 7, 2, 1);
    x.fillStyle = '#ffffff'; x.fillRect(cx - 3, cy - 5, 2, 2); x.fillRect(cx + 1, cy - 5, 2, 2);
    x.fillStyle = '#1b1a2b'; x.fillRect(cx - 2, cy - 4, 1, 1); x.fillRect(cx + 2, cy - 4, 1, 1);
    x.fillStyle = '#3a0f1d'; x.fillRect(cx - 4, cy - 10, 1, 2); x.fillRect(cx + 3, cy - 10, 1, 2);
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
      return;
    }
    const col = pr.color || '#7dff9a';
    for (let i = 1; i <= 4; i++) {
      const kk = Math.max(0, k - i * 0.04);
      const tx = pr.x0 + (pr.x1 - pr.x0) * kk, ty = pr.y0 + (pr.y1 - pr.y0) * kk - Math.sin(kk * Math.PI) * pr.arc;
      x.fillStyle = col; x.globalAlpha = 1 - i * 0.2; x.fillRect(Math.round(tx), Math.round(ty), 1, 1);
    }
    x.globalAlpha = 1;
    const rx = Math.round(px) - 3, ry = Math.round(py) - 2;
    x.fillStyle = '#5a3a1a'; x.fillRect(rx - 1, ry - 1, 8, 6);
    x.fillStyle = '#f4e6c3'; x.fillRect(rx, ry, 6, 4);
    x.fillStyle = '#d9c393'; x.fillRect(rx, ry, 1, 4); x.fillRect(rx + 5, ry, 1, 4);
    x.fillStyle = col; x.fillRect(rx + 2, ry, 2, 4);
  }

  drawSequence(x, s, t) {
    const k = (t - s.t0) / s.dur;
    if (s.kind === 'ring') {
      const a = s.actor; const r = 4 + k * 16;
      x.globalAlpha = 1 - k; ringPixels(x, a.x, a.y - 8, r, r * 0.6, s.color); x.globalAlpha = 1;
    }
    if (s.kind === 'zap' && Math.floor(t / 60) % 2) this.lightning(x, s.a.x, s.a.y - 12, s.b.x, s.b.y - 12, '#ffffff');
    if (s.kind === 'tome') {
      // reports orbit, spiral in, and bind into a glowing book
      const cx = Math.round(s.at.x), cy = Math.round(s.at.y - 30);
      const n = Math.max(1, s.colors.length);
      if (k < 0.5) {
        const kk = k / 0.5;
        for (let i = 0; i < n; i++) {
          const ang = (i / n) * Math.PI * 2 + kk * 6;
          const r = 22 * (1 - kk) + 2;
          const px = Math.round(cx + Math.cos(ang) * r), py = Math.round(cy + Math.sin(ang) * r * 0.6);
          x.fillStyle = '#1b1a2b'; x.fillRect(px - 3, py - 2, 6, 4);
          x.fillStyle = '#f4e6c3'; x.fillRect(px - 2, py - 1, 4, 2); x.fillStyle = s.colors[i]; x.fillRect(px - 1, py - 1, 1, 2);
        }
      } else {
        const kk = (k - 0.5) / 0.5;
        x.globalAlpha = Math.min(1, (1 - kk) * 2);
        for (let i = 0; i < 8; i++) {
          const ang = (i / 8) * Math.PI * 2 + t / 500;
          line(x, cx, cy, cx + Math.cos(ang) * (8 + kk * 10), cy + Math.sin(ang) * (8 + kk * 10) * 0.7, '#ffd34d');
        }
        x.fillStyle = '#1b1a2b'; x.fillRect(cx - 7, cy - 5, 14, 10);
        x.fillStyle = '#b0472f'; x.fillRect(cx - 6, cy - 4, 12, 8);
        x.fillStyle = '#f4e6c3'; x.fillRect(cx - 5, cy - 3, 10, 6);
        x.fillStyle = '#b0472f'; x.fillRect(cx, cy - 3, 1, 6);
        x.fillStyle = '#ffd34d'; x.fillRect(cx - 3, cy - 1, 2, 1); x.fillRect(cx + 2, cy - 1, 2, 1);
        x.globalAlpha = 1;
      }
    }
    if (s.kind === 'evolve') {
      const a = s.actor;
      const cx = Math.round(a.x), cy = Math.round(a.y);
      for (let i = 0; i < 10; i++) {
        const ang = (i / 10) * Math.PI * 2 + t / 400;
        const len = 10 + k * 40;
        x.globalAlpha = 0.6 * (1 - Math.abs(k - 0.5) * 1.6);
        line(x, cx, cy - 10, cx + Math.cos(ang) * len, cy - 10 + Math.sin(ang) * len * 0.8, i % 2 ? '#fff6c9' : '#ffd34d');
      }
      x.globalAlpha = 1;
      const flip = Math.floor(k * 14) % 2 === 0 && k < 0.8;
      const fam = flip && s.from ? s.from : s.to || a.fam;
      if (fam) {
        const sp = getSprite(fam, 'cheer', 0, 'happy');
        const dx = cx - SPRITE_W / 2, dy = cy - SPRITE_H + 1;
        x.drawImage(sp, dx, dy);
        if (k < 0.85) whiteSilhouette(x, sp, dx, dy, 0.85 - k * 0.5);
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
  const w = icon === 'dots' || icon === 'zz' || icon === 'exhausted' ? 11 : 9, h = 8;
  const col = { alert: '#ff4d6d', question: '#4d9dff', check: '#3ccf6e', spark: '#ffd34d', dots: '#ffffff', zz: '#ffffff', exhausted: '#ff9a3c', deny: '#ff4d6d', swap: '#4dd0c8' }[icon] || '#ffffff';
  const bob = Math.round(Math.sin(t / 250) * 1);
  const X = Math.round(bx), Y = Math.round(by - h + bob);
  x.fillStyle = '#1b1a2b'; x.fillRect(X - 1, Y - 1, w + 2, h + 2); x.fillRect(X + 1, Y + h + 1, 2, 1);
  x.fillStyle = col; x.fillRect(X, Y, w, h); x.fillRect(X + 1, Y + h, 2, 1);
  const fg = icon === 'dots' ? '#1b1a2b' : icon === 'zz' ? '#7a52e0' : '#ffffff';
  const txt = { alert: '!', question: '?', spark: '+', zz: 'ZZ', exhausted: '!!', deny: 'X', swap: '>' }[icon] ?? '';
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

export function shortModel(m) { return String(m || '').replace(/^claude-/, '').replace(/-\d{8}$/, '').replace(/\[1m\]/, ''); }
const easeInOut = (k) => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);
const rank = (s) => (s === 'crit' ? 2 : s === 'warn' ? 1 : 0);
const clampX = (v, W) => Math.max(10, Math.min(W - 10, v));
function hashStr(s) { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0; return h; }
