// Issue detectors. Pure rules over World state, evaluated on every event and
// on a 1s tick. Each rule raises an alert keyed by (kind, subject); the alert
// resolves itself when the condition clears. Alerts carry a `kind` plus
// `params`; the UI turns them into words via core/i18n.js.

import { STATUS, BUSY } from './state.js';

export const DEFAULT_THRESHOLDS = {
  loopWarn: 3,             // same tool+input this many times in the window
  loopCrit: 5,
  loopWindow: 8,           // last N tool calls
  loopWindowMs: 10 * 60_000,
  errorEcho: 3,            // same error signature N times
  stallTools: 25,          // tool calls since the last file edit…
  stallMs: 10 * 60_000,    // …and this long since the last edit…
  stallUsd: 0.5,           // …and this much spent since the last edit
  burnUsdPerMin: 1.0,      // 5-minute average
  dailyBudgetUsd: 0,       // 0 = disabled
  contextWarn: 0.65,
  contextCrit: 0.8,
  permissionMs: 20_000,
  waitingMs: 3 * 60_000,
  collisionTtlMs: 10 * 60_000,
};

const READ_ONLY_ROLE = /explor|review|research|plan|search|guide|audit|analy/i;

export const SEVERITY_RANK = { info: 0, warn: 1, crit: 2 };

export class Detectors {
  constructor(thresholds = {}) {
    this.t = { ...DEFAULT_THRESHOLDS, ...thresholds };
    this.alerts = new Map();   // key -> alert
    this.history = [];         // resolved alerts
    this.sticky = new Map();   // event-driven alerts with TTL: key -> expiresAt
  }

  /** Called with the effects produced by World.apply, to turn one-shot facts into alerts. */
  onEffects(world, effects, now, out) {
    for (const f of effects) {
      if (f.fx === 'collision') {
        const key = `collision:${f.file}`;
        this.sticky.set(key, now + this.t.collisionTtlMs);
        const a = world.agents.get(f.a), b = world.agents.get(f.b);
        this.raise(out, key, 'collision', 'crit', f.a, now, {
          file: f.file, a: a ? sessionLabel(a) : f.a, b: b ? sessionLabel(b) : f.b, other: f.b,
        });
      }
      if (f.fx === 'compact') {
        const a = world.agents.get(f.agentId);
        if (!a) continue;
        const busyKids = a.children.map((id) => world.agents.get(id)).filter((c) => c && c.alive);
        const recentReturn = world.handoffs.some((h) => h.to === a.id && h.kind === 'return' && now - h.ts < 60_000);
        if (f.auto && (busyKids.length || recentReturn)) {
          const key = `compactRisk:${a.id}`;
          this.sticky.set(key, now + 3 * 60_000);
          this.raise(out, key, 'compactRisk', 'warn', a.id, now, { who: labelOf(a), kids: busyKids.length });
        }
      }
    }
  }

  evaluate(world, now) {
    const out = [];
    const seen = new Set();
    const t = this.t;
    const mark = (key, kind, sev, agentId, params) => {
      seen.add(key);
      this.raise(out, key, kind, sev, agentId, now, params);
    };

    for (const a of world.agents.values()) {
      if (!a.alive) continue;
      const who = labelOf(a);

      // 1. Loops: the same tool call with the same input, over and over.
      const recent = a.recentTools.slice(-t.loopWindow).filter((x) => now - x.ts < t.loopWindowMs);
      const counts = new Map();
      for (const r of recent) counts.set(r.key, (counts.get(r.key) || 0) + 1);
      let maxKey = '', max = 0;
      for (const [k, c] of counts) if (c > max) { max = c; maxKey = k; }
      if (max >= t.loopWarn) {
        const first = !this.alerts.has(`loop:${a.id}`);
        mark(`loop:${a.id}`, 'loop', max >= t.loopCrit ? 'crit' : 'warn', a.id, {
          who, times: max, call: maxKey.split('#')[0],
        });
        if (first) a.turn.loops++;
      }

      // 2. Error echo: the same failure message repeating.
      const errs = new Map();
      for (const e of a.recentErrors) if (now - e.ts < t.loopWindowMs) errs.set(e.sig, (errs.get(e.sig) || 0) + 1);
      for (const [sig, c] of errs) {
        if (c >= t.errorEcho) {
          const key = `errorEcho:${a.id}`;
          if (!this.alerts.has(key)) a.turn.errorEchoes++;
          mark(key, 'errorEcho', 'warn', a.id, { who, times: c, error: sig.slice(0, 90) });
          break;
        }
      }

      // 3. Stall: spending without producing any edits.
      if (BUSY.has(a.status) && !READ_ONLY_ROLE.test(a.type) &&
          a.toolsSinceWrite >= t.stallTools && now - a.lastWriteTs > t.stallMs && a.costSinceWrite >= t.stallUsd) {
        mark(`stall:${a.id}`, 'stall', 'warn', a.id, {
          who, tools: a.toolsSinceWrite, minutes: Math.round((now - a.lastWriteTs) / 60_000), usd: a.costSinceWrite,
        });
      }

      // 4. Context window pressure.
      const pct = a.context.window ? a.context.used / a.context.window : 0;
      if (pct >= t.contextWarn) {
        mark(`context:${a.id}`, 'context', pct >= t.contextCrit ? 'crit' : 'warn', a.id, { who, pct: Math.round(pct * 100) });
      }

      // 5. Blocked on a permission prompt (silent killer for background subagents).
      if (a.status === STATUS.PERMISSION && a.permissionSince && now - a.permissionSince > t.permissionMs) {
        const sub = !!a.parentId;
        mark(`permission:${a.id}`, sub ? 'permissionSub' : 'permission', sub ? 'crit' : 'warn', a.id, {
          who, seconds: Math.round((now - a.permissionSince) / 1000), tool: a.tool,
        });
      }

      // 6. Waiting for the human.
      if (!a.parentId && a.status === STATUS.WAITING && a.waitingSince && now - a.waitingSince > t.waitingMs) {
        mark(`waiting:${a.id}`, 'waiting', 'info', a.id, { who, minutes: Math.round((now - a.waitingSince) / 60_000) });
      }

      // mood drives the character's face/aura
      a.mood = 'ok';
    }

    // 7. Burn rate (global).
    const burn = world.burnRate(now, 5);
    if (t.burnUsdPerMin > 0 && burn >= t.burnUsdPerMin) {
      mark('burn', 'burn', burn >= t.burnUsdPerMin * 3 ? 'crit' : 'warn', null, { rate: burn, limit: t.burnUsdPerMin });
    }

    // 8. Daily budget.
    if (t.dailyBudgetUsd > 0 && world.totals.cost >= t.dailyBudgetUsd) {
      mark('budget', 'budget', 'crit', null, { spent: world.totals.cost, budget: t.dailyBudgetUsd });
    }

    // Sticky (event-driven) alerts stay until their TTL.
    for (const [key, exp] of this.sticky) {
      if (now < exp) seen.add(key);
      else this.sticky.delete(key);
    }

    // Resolve anything whose condition cleared.
    for (const [key, al] of this.alerts) {
      if (!seen.has(key)) {
        al.active = false;
        al.resolvedAt = now;
        this.alerts.delete(key);
        this.history.push(al);
        if (this.history.length > 50) this.history.shift();
        out.push({ fx: 'alert.resolve', alert: al });
      }
    }

    // Moods: worst active alert per agent.
    for (const al of this.alerts.values()) {
      const a = al.agentId && world.agents.get(al.agentId);
      if (!a) continue;
      const mood = al.kind === 'loop' || al.kind === 'errorEcho' ? 'dizzy'
        : al.kind === 'context' ? 'sleepy'
        : al.kind === 'permission' || al.kind === 'permissionSub' ? 'blocked'
        : al.kind === 'stall' ? 'stuck'
        : al.kind === 'collision' ? 'angry' : 'ok';
      if (mood !== 'ok' && (a.mood === 'ok' || SEVERITY_RANK[al.severity] >= 2)) a.mood = mood;
    }
    return out;
  }

  raise(out, key, kind, severity, agentId, now, params) {
    const existing = this.alerts.get(key);
    if (existing) {
      const escalated = SEVERITY_RANK[severity] > SEVERITY_RANK[existing.severity];
      existing.severity = severity;
      existing.params = params;
      existing.lastSeen = now;
      if (escalated) out.push({ fx: 'alert', alert: existing, escalated: true });
      return existing;
    }
    const al = { id: key, kind, severity, agentId, params, since: now, lastSeen: now, active: true };
    this.alerts.set(key, al);
    out.push({ fx: 'alert', alert: al });
    return al;
  }

  list() {
    return [...this.alerts.values()].sort(
      (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.since - a.since,
    );
  }
}

export function labelOf(a) {
  if (!a) return '?';
  if (a.label) return a.label;
  return a.type === 'main' ? a.project : `${a.type}@${a.project}`;
}

/** Like labelOf, but tells two sessions of the same project apart. */
function sessionLabel(a) {
  const id = String(a.sessionId || a.id);
  return `${labelOf(a)} #${id.replace(/[^a-z0-9]/gi, '').slice(-4)}`;
}
