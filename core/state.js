// World state: a deterministic reducer over normalized events.
// apply(event) mutates the world and returns "effects": one-shot things the
// renderer should animate (coins flying, a scroll being handed off, a monster
// appearing). snapshot() returns plain JSON for the renderer / the wire.

import { EV, CATEGORY, categorize, isTestCommand } from './schema.js';
import { priceUsage } from './pricing.js';
import { projectName, errorSignature } from './util.js';

const RING = 12;
const BURN_BUCKET_MS = 10_000;
const BURN_BUCKETS = 60; // 10 minutes of history
const BLOCK_MS = 5 * 3600_000;
const DEFAULT_WINDOW = 200_000;

export const STATUS = Object.freeze({
  IDLE: 'idle',
  THINKING: 'thinking',
  READING: 'reading',
  WRITING: 'writing',
  RUNNING: 'running',
  WEB: 'web',
  DELEGATING: 'delegating',
  PLANNING: 'planning',
  TOOL: 'tool',
  PERMISSION: 'permission',
  WAITING: 'waiting',
  COMPACTING: 'compacting',
  DONE: 'done',
});

const CATEGORY_STATUS = {
  [CATEGORY.READ]: STATUS.READING,
  [CATEGORY.WRITE]: STATUS.WRITING,
  [CATEGORY.RUN]: STATUS.RUNNING,
  [CATEGORY.WEB]: STATUS.WEB,
  [CATEGORY.DELEGATE]: STATUS.DELEGATING,
  [CATEGORY.PLAN]: STATUS.PLANNING,
  [CATEGORY.TOOL]: STATUS.TOOL,
};

export const BUSY = new Set([
  STATUS.THINKING, STATUS.READING, STATUS.WRITING, STATUS.RUNNING, STATUS.WEB,
  STATUS.DELEGATING, STATUS.PLANNING, STATUS.TOOL, STATUS.COMPACTING,
]);

function newTurn(ts) {
  return {
    startedAt: ts, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
    tools: 0, edits: 0, runs: 0, failedRuns: 0, testFails: 0, testFixes: 0,
    loops: 0, errorEchoes: 0, returns: 0, permissions: 0, compactions: 0,
    cat: { read: 0, write: 0, run: 0, web: 0, delegate: 0, plan: 0, tool: 0 },
  };
}

export function familiarKey(agent) {
  return `${agent.provider}:${agent.project}:${agent.type}`;
}

export class World {
  constructor({ now = Date.now() } = {}) {
    this.agents = new Map();
    this.order = [];           // stable seat order
    this.handoffs = [];        // last N handoffs, for the timeline
    this.feed = [];            // last N human-readable log lines
    this.totals = { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, byModel: {} };
    this.burn = new Array(BURN_BUCKETS).fill(0);
    this.burnHead = Math.floor(now / BURN_BUCKET_MS);
    this.block = null;         // 5-hour usage block, ccusage-style
    this.startedAt = now;
    this.lastTs = now;
    this.fileTouches = new Map(); // abs path -> [{agentId, sessionId, ts}]
    this.limits = {};             // provider -> latest rate-limit snapshot
    this.dayStart = 0;
    this.rollDay(now);
  }

  // ---------------------------------------------------------------- agents
  ensureAgent(ev) {
    let a = this.agents.get(ev.agentId);
    if (a) return { agent: a, created: false };
    const isSub = !!ev.parentId || ev.agentId !== ev.sessionId;
    const parent = ev.parentId ? this.agents.get(ev.parentId) : this.agents.get(ev.sessionId);
    const cwd = ev.cwd || parent?.cwd || '';
    a = {
      id: ev.agentId,
      sessionId: ev.sessionId || ev.agentId,
      parentId: isSub ? (ev.parentId || ev.sessionId) : null,
      provider: ev.provider || 'claude',
      type: ev.agentType || (isSub ? 'subagent' : 'main'),
      label: ev.label || '',
      cwd,
      project: projectName(cwd),
      status: STATUS.IDLE,
      tool: '', detail: '', statusSince: ev.ts,
      startedAt: ev.ts, lastTs: ev.ts, endedAt: 0, alive: true,
      model: '', cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
      context: { used: 0, window: DEFAULT_WINDOW },
      turn: newTurn(ev.ts), turns: 0,
      recentTools: [], recentErrors: [],
      lastWriteTs: ev.ts, toolsSinceWrite: 0, costSinceWrite: 0,
      monsters: [],            // open failures (ids)
      openTools: {},           // toolUseId -> {tool, category, detail, ts, cmd}
      children: [],
      waitingSince: 0, permissionSince: 0,
      mood: 'ok',
    };
    a.familiar = familiarKey(a);
    this.agents.set(a.id, a);
    this.order.push(a.id);
    if (a.parentId) {
      const p = this.agents.get(a.parentId);
      if (p && !p.children.includes(a.id)) p.children.push(a.id);
    }
    return { agent: a, created: true };
  }

  setStatus(a, status, ts, tool = '', detail = '') {
    if (a.status !== status || a.tool !== tool) a.statusSince = ts;
    a.status = status;
    a.tool = tool;
    a.detail = detail;
  }

  log(ts, agentId, text, level = 'info') {
    this.feed.push({ ts, agentId, text, level });
    if (this.feed.length > 200) this.feed.splice(0, this.feed.length - 200);
  }

  // ---------------------------------------------------------------- reducer
  apply(ev) {
    const fx = [];
    const ts = ev.ts || Date.now();
    this.rollDay(ts);
    // Backfilled usage (from transcripts written before we started watching)
    // only feeds today's totals; it must not wake agents up or animate.
    if (ev.backfill) {
      if (ev.kind === EV.USAGE && ts >= this.dayStart) this.addTotals(ev, ts);
      return fx;
    }
    if (ev.kind === EV.LIMITS) {
      this.limits[ev.provider || 'claude'] = { ...ev.limits, ts };
      return fx;
    }
    this.lastTs = Math.max(this.lastTs, ts);
    const { agent: a, created } = this.ensureAgent(ev);
    if (ev.cwd && !a.cwd) { a.cwd = ev.cwd; a.project = projectName(ev.cwd); a.familiar = familiarKey(a); }
    if (ev.label) a.label = ev.label;
    a.lastTs = ts;
    // Late transcript lines must not resurrect an agent that already finished.
    if (!a.alive && ev.kind !== EV.SESSION_END && ev.kind !== EV.SUBAGENT_END && ev.kind !== EV.USAGE) {
      a.alive = true; a.endedAt = 0; fx.push({ fx: 'spawn', agentId: a.id });
    }
    if (created) fx.push({ fx: 'spawn', agentId: a.id });

    switch (ev.kind) {
      case EV.SESSION_START:
        this.setStatus(a, STATUS.IDLE, ts);
        this.log(ts, a.id, `${a.project}: session started`);
        break;

      case EV.SESSION_END:
        this.endAgent(a, ts, fx);
        this.log(ts, a.id, `${a.project}: session ended`);
        break;

      case EV.PROMPT:
        a.turn = newTurn(ts);
        a.waitingSince = 0; a.permissionSince = 0;
        this.setStatus(a, STATUS.THINKING, ts);
        fx.push({ fx: 'bubble', agentId: a.id, icon: 'spark' });
        break;

      case EV.TOOL_START: {
        const category = ev.category || categorize(ev.tool);
        a.permissionSince = 0; a.waitingSince = 0;
        a.openTools[ev.toolUseId || ev.tool] = { tool: ev.tool, category, detail: ev.detail || '', ts, cmd: ev.command || '' };
        a.turn.tools++;
        a.turn.cat[category] = (a.turn.cat[category] || 0) + 1;
        const key = `${ev.tool}#${ev.inputHash ?? ev.detail ?? ''}`;
        a.recentTools.push({ key, ts });
        if (a.recentTools.length > RING) a.recentTools.shift();
        this.setStatus(a, CATEGORY_STATUS[category] || STATUS.TOOL, ts, ev.tool, ev.detail || '');
        if (category === CATEGORY.WRITE && ev.file) this.touchFile(a, ev.file, ts, fx);
        if (category === CATEGORY.RUN) a.turn.runs++;
        break;
      }

      case EV.TOOL_END: {
        const open = a.openTools[ev.toolUseId || ev.tool];
        delete a.openTools[ev.toolUseId || ev.tool];
        const category = ev.category || open?.category || categorize(ev.tool);
        const cmd = ev.command || open?.cmd || '';
        if (ev.ok === false) {
          const sig = errorSignature(ev.error || `${ev.tool} failed`);
          a.recentErrors.push({ sig, ts, text: ev.error || '' });
          if (a.recentErrors.length > RING) a.recentErrors.shift();
          if (category === CATEGORY.RUN) a.turn.failedRuns++;
          if (category === CATEGORY.RUN && isTestCommand(cmd)) {
            a.turn.testFails++;
            const id = `m_${a.id}_${ts}`;
            a.monsters.push(id);
            if (a.monsters.length > 4) a.monsters.shift();
            fx.push({ fx: 'monster', action: 'spawn', agentId: a.id, id, text: ev.error || '' });
            this.log(ts, a.id, `${cmd || ev.tool} failed — a bug monster appears!`, 'warn');
          }
        } else {
          if (category === CATEGORY.WRITE) {
            a.turn.edits++;
            a.lastWriteTs = ts; a.toolsSinceWrite = 0; a.costSinceWrite = 0;
            if (ev.file) this.touchFile(a, ev.file, ts, fx);
          }
          if (category === CATEGORY.RUN && isTestCommand(cmd) && a.monsters.length) {
            const id = a.monsters.shift();
            a.turn.testFixes++;
            fx.push({ fx: 'monster', action: 'defeat', agentId: a.id, id });
            this.log(ts, a.id, `${cmd} passes — bug monster defeated!`, 'good');
          }
        }
        if (category !== CATEGORY.WRITE) a.toolsSinceWrite++;
        if (a.status !== STATUS.PERMISSION && a.status !== STATUS.WAITING) this.setStatus(a, STATUS.THINKING, ts);
        break;
      }

      case EV.PERMISSION:
        a.permissionSince = a.permissionSince || ts;
        a.turn.permissions++;
        this.setStatus(a, STATUS.PERMISSION, ts, ev.tool || a.tool, ev.detail || '');
        fx.push({ fx: 'bubble', agentId: a.id, icon: 'alert' });
        break;

      case EV.WAITING:
        a.waitingSince = a.waitingSince || ts;
        this.setStatus(a, STATUS.WAITING, ts);
        fx.push({ fx: 'bubble', agentId: a.id, icon: 'question' });
        break;

      case EV.TURN_END: {
        a.turns++;
        a.permissionSince = 0;
        const summary = this.closeTurn(a, ts);
        this.setStatus(a, a.parentId ? STATUS.DONE : STATUS.WAITING, ts);
        a.waitingSince = a.parentId ? 0 : ts;
        fx.push({ fx: 'turn', agentId: a.id, summary });
        fx.push({ fx: 'bubble', agentId: a.id, icon: 'check' });
        break;
      }

      case EV.SUBAGENT_START: {
        const parent = this.agents.get(a.parentId);
        if (parent) {
          this.handoff(parent.id, a.id, 'delegate', ts, ev.detail || a.type, fx);
          this.log(ts, parent.id, `delegated to ${a.type}${ev.detail ? ': ' + ev.detail : ''}`);
        }
        a.turn = newTurn(ts);
        this.setStatus(a, STATUS.THINKING, ts);
        break;
      }

      case EV.SUBAGENT_END: {
        const parent = this.agents.get(a.parentId);
        if (a.alive) {
          a.turns++;
          const summary = this.closeTurn(a, ts);
          fx.push({ fx: 'turn', agentId: a.id, summary });
          if (parent) {
            parent.turn.returns++;
            this.handoff(a.id, parent.id, 'return', ts, ev.detail || 'report', fx);
            this.log(ts, a.id, `${a.type} reported back to ${parent.type === 'main' ? parent.project : parent.type}`, 'good');
          }
        }
        this.endAgent(a, ts, fx);
        break;
      }

      case EV.COMPACT:
        a.turn.compactions++;
        this.setStatus(a, STATUS.COMPACTING, ts);
        fx.push({ fx: 'compact', agentId: a.id, auto: ev.reason !== 'manual' });
        this.log(ts, a.id, `${ev.reason === 'manual' ? 'manual' : 'auto'} compaction — memory is getting squeezed`, ev.reason === 'manual' ? 'info' : 'warn');
        break;

      case EV.COMPACT_END:
        a.context.used = Math.min(a.context.used, Math.round(a.context.window * 0.15));
        this.setStatus(a, STATUS.THINKING, ts);
        break;

      case EV.USAGE:
        this.applyUsage(a, ev, ts, fx);
        break;
    }

    if (ev.context && ev.context.used >= 0) {
      a.context.used = ev.context.used;
      if (ev.context.window) a.context.window = ev.context.window;
    }
    return fx;
  }

  applyUsage(a, ev, ts, fx) {
    const u = ev.usage || {};
    const cost = this.addTotals(ev, ts);
    const input = u.input || 0, output = u.output || 0, cr = u.cacheRead || 0, cw = u.cacheWrite || 0;
    if (u.model) a.model = u.model;
    for (const t of [a, a.turn]) {
      t.cost += cost; t.input += input; t.output += output; t.cacheRead += cr; t.cacheWrite += cw;
    }
    a.costSinceWrite += cost;
    // Context size = everything the model had to read for this response.
    if (!ev.context && (input + cr + cw) > 0 && !u.noContext) {
      a.context.used = input + cr + cw;
      if (u.contextWindow) a.context.window = u.contextWindow;
      else if (/\[1m\]|-1m\b/i.test(u.model || '')) a.context.window = 1_000_000;
      if (a.context.used > a.context.window) a.context.window = 1_000_000;
    }
    this.addBurn(ts, cost);
    if (cost > 0) fx.push({ fx: 'coins', agentId: a.id, usd: cost });
  }

  /** Add one usage record to today's totals; returns its cost. */
  addTotals(ev, ts) {
    const u = ev.usage || {};
    const cost = Number.isFinite(ev.costUsd) ? ev.costUsd : priceUsage(u);
    const t = this.totals;
    t.cost += cost; t.input += u.input || 0; t.output += u.output || 0;
    t.cacheRead += u.cacheRead || 0; t.cacheWrite += u.cacheWrite || 0;
    const m = u.model || 'unknown';
    t.byModel[m] = (t.byModel[m] || 0) + cost;
    this.addBlock(ts, cost, (u.input || 0) + (u.output || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0));
    return cost;
  }

  /** "Spent today" resets at local midnight. */
  rollDay(ts) {
    const d = new Date(ts);
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    if (start > this.dayStart) {
      this.dayStart = start;
      this.totals = { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, byModel: {} };
    }
  }

  closeTurn(a, ts) {
    const t = a.turn;
    const summary = {
      agentId: a.id, familiar: a.familiar, type: a.type, project: a.project, provider: a.provider,
      durationMs: ts - t.startedAt, ...t, cat: { ...t.cat },
    };
    delete summary.startedAt;
    a.turn = newTurn(ts);
    return summary;
  }

  endAgent(a, ts, fx) {
    if (!a.alive) return;
    a.alive = false;
    a.endedAt = ts;
    this.setStatus(a, STATUS.DONE, ts);
    a.openTools = {};
    fx.push({ fx: 'despawn', agentId: a.id });
  }

  handoff(from, to, kind, ts, text, fx) {
    const h = { from, to, kind, ts, text: text || '' };
    this.handoffs.push(h);
    if (this.handoffs.length > 100) this.handoffs.shift();
    fx.push({ fx: 'handoff', ...h });
  }

  touchFile(a, file, ts, fx) {
    let list = this.fileTouches.get(file);
    if (!list) { list = []; this.fileTouches.set(file, list); }
    const prev = list.filter((x) => x.agentId !== a.id && ts - x.ts < 10 * 60_000);
    list.push({ agentId: a.id, sessionId: a.sessionId, ts });
    if (list.length > 8) list.shift();
    for (const p of prev) {
      // Parent/child editing the same file in sequence is coordinated work, not a collision.
      const other = this.agents.get(p.agentId);
      if (!other || !other.alive) continue;
      const related = other.id === a.parentId || a.id === other.parentId;
      if (related) continue;
      fx.push({ fx: 'collision', a: a.id, b: other.id, file, ts });
    }
    if (this.fileTouches.size > 2000) {
      const firstKey = this.fileTouches.keys().next().value;
      this.fileTouches.delete(firstKey);
    }
  }

  addBurn(ts, cost) {
    this.rollBurn(ts);
    const idx = Math.floor(ts / BURN_BUCKET_MS);
    const back = this.burnHead - idx;
    if (back >= 0 && back < BURN_BUCKETS) this.burn[BURN_BUCKETS - 1 - back] += cost;
  }

  rollBurn(ts) {
    const head = Math.floor(ts / BURN_BUCKET_MS);
    const shift = head - this.burnHead;
    if (shift <= 0) return;
    if (shift >= BURN_BUCKETS) this.burn.fill(0);
    else { this.burn.splice(0, shift); for (let i = 0; i < shift; i++) this.burn.push(0); }
    this.burnHead = head;
  }

  /** USD per minute over the last `minutes` minutes. */
  burnRate(now, minutes = 5) {
    this.rollBurn(now);
    const n = Math.min(BURN_BUCKETS, Math.round((minutes * 60_000) / BURN_BUCKET_MS));
    let s = 0;
    for (let i = BURN_BUCKETS - n; i < BURN_BUCKETS; i++) s += this.burn[i];
    return s / minutes;
  }

  addBlock(ts, cost, tokens) {
    if (!this.block || ts >= this.block.end) {
      const start = Math.floor(ts / 3600_000) * 3600_000;
      this.block = { start, end: start + BLOCK_MS, cost: 0, tokens: 0 };
    }
    this.block.cost += cost;
    this.block.tokens += tokens;
  }

  /** Remove long-finished agents so the village does not fill up forever. */
  gc(now, keepMs = 3 * 60_000) {
    for (const id of [...this.order]) {
      const a = this.agents.get(id);
      if (a && !a.alive && now - a.endedAt > keepMs) {
        this.agents.delete(id);
        this.order = this.order.filter((x) => x !== id);
        const p = a.parentId && this.agents.get(a.parentId);
        if (p) p.children = p.children.filter((c) => c !== id);
      }
    }
  }

  snapshot(now = this.lastTs) {
    const agents = this.order.map((id) => {
      const a = this.agents.get(id);
      return {
        id: a.id, sessionId: a.sessionId, parentId: a.parentId, provider: a.provider, type: a.type,
        label: a.label, project: a.project, cwd: a.cwd, status: a.status, tool: a.tool, detail: a.detail,
        statusSince: a.statusSince, startedAt: a.startedAt, lastTs: a.lastTs, endedAt: a.endedAt, alive: a.alive,
        model: a.model, cost: a.cost, input: a.input, output: a.output, cacheRead: a.cacheRead, cacheWrite: a.cacheWrite,
        context: { ...a.context }, turns: a.turns, monsters: a.monsters.length, children: [...a.children],
        familiar: a.familiar, mood: a.mood, turnCost: a.turn.cost, turnTools: a.turn.tools,
      };
    });
    return {
      now,
      agents,
      totals: { ...this.totals, byModel: { ...this.totals.byModel } },
      burnRate: this.burnRate(now, 5),
      burn: [...this.burn],
      block: this.block ? { ...this.block } : null,
      limits: JSON.parse(JSON.stringify(this.limits)),
      dayStart: this.dayStart,
      handoffs: this.handoffs.slice(-30),
      feed: this.feed.slice(-60),
    };
  }
}
