// Issue detectors. Pure rules over World state, evaluated on every event and
// on a 1s tick. Each rule raises an alert keyed by (kind, subject); the alert
// resolves itself when the condition clears. Alerts carry a `kind` plus
// `params`; the UI turns them into words via core/i18n.js.
//
// Swarm-aware: when 3+ subagents of the same orchestrator trip the same rule
// (e.g. 7 workflow agents stuck on permission prompts), they collapse into ONE
// alert on the orchestrator instead of 7 toasts.

import { STATUS, BUSY } from './state.js';
import { median } from './util.js';

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
  runBudgetUsd: 0,         // per fan-out run / workflow, 0 = disabled
  contextWarn: 0.65,
  contextCrit: 0.8,
  permissionMs: 20_000,
  waitingMs: 3 * 60_000,
  collisionTtlMs: 10 * 60_000,
  stragglerFactor: 3,      // running > 3× the stage's median duration…
  stragglerMinMs: 2 * 60_000, // …and at least this long
  sprawlTotal: 50,         // agents in one run before we say "that's a lot"
  sprawlPerMin: 20,        // spawn rate
  swarmGroup: 3,           // collapse identical subagent alerts at this count
};

const READ_ONLY_ROLE = /explor|review|research|plan|search|guide|audit|analy|refut|verif|classif|scan/i;
const SWARMABLE = new Set(['loop', 'errorEcho', 'stall', 'context', 'permissionSub', 'straggler', 'exhausted']);

export const SEVERITY_RANK = { info: 0, warn: 1, crit: 2 };

export class Detectors {
  constructor(thresholds = {}) {
    this.t = { ...DEFAULT_THRESHOLDS, ...thresholds };
    this.alerts = new Map();   // key -> alert
    this.history = [];         // resolved alerts
    this.sticky = new Map();   // event-driven alerts with TTL: key -> expiresAt
    this.spawns = [];          // recent spawn timestamps per parent, for sprawl
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
      if (f.fx === 'unverified') {
        const a = world.agents.get(f.agentId);
        const key = `unverified:${f.agentId}:${f.ts}`;
        this.sticky.set(key, now + 10 * 60_000);
        this.raise(out, key, 'unverified', 'warn', f.agentId, now, { who: labelOf(a), why: f.why });
      }
      if (f.fx === 'mergeRisk') {
        const key = `mergeRisk:${f.project}|${f.file}`;
        this.sticky.set(key, now + 30 * 60_000);
        this.raise(out, key, 'mergeRisk', 'warn', f.agentId, now, { file: f.file, project: f.project, trees: f.trees, other: f.other });
      }
      if (f.fx === 'handoff' && f.kind === 'delegate') {
        this.spawns.push({ parent: f.from, ts: now });
        if (this.spawns.length > 2000) this.spawns.splice(0, 1000);
      }
    }
  }

  evaluate(world, now) {
    const out = [];
    const t = this.t;
    const cand = []; // { key, kind, sev, agentId, params, parentId? }
    const add = (key, kind, sev, a, params) => cand.push({ key, kind, sev, agentId: a ? a.id : null, parentId: a?.parentId || null, params });

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
        if (!this.alerts.has(`loop:${a.id}`) && !a._loopCounted) { a.turn.loops++; a._loopCounted = true; }
        add(`loop:${a.id}`, 'loop', max >= t.loopCrit ? 'crit' : 'warn', a, { who, times: max, call: maxKey.split('#')[0] });
      } else a._loopCounted = false;

      // 2. Error echo: the same failure message repeating.
      const errs = new Map();
      for (const e of a.recentErrors) if (now - e.ts < t.loopWindowMs) errs.set(e.sig, (errs.get(e.sig) || 0) + 1);
      for (const [sig, c] of errs) {
        if (c >= t.errorEcho) {
          if (!a._echoCounted) { a.turn.errorEchoes++; a._echoCounted = true; }
          add(`errorEcho:${a.id}`, 'errorEcho', 'warn', a, { who, times: c, error: sig.slice(0, 90) });
          break;
        }
      }
      if (![...errs.values()].some((c) => c >= t.errorEcho)) a._echoCounted = false;

      // 3. Stall: spending without producing any edits.
      if (BUSY.has(a.status) && !READ_ONLY_ROLE.test(a.type) &&
          a.toolsSinceWrite >= t.stallTools && now - a.lastWriteTs > t.stallMs && a.costSinceWrite >= t.stallUsd) {
        add(`stall:${a.id}`, 'stall', 'warn', a, {
          who, tools: a.toolsSinceWrite, minutes: Math.round((now - a.lastWriteTs) / 60_000), usd: a.costSinceWrite,
        });
      }

      // 4. Context window pressure. A subagent that isn't working has nothing left to compact.
      const pct = a.context.window ? a.context.used / a.context.window : 0;
      if (pct >= t.contextWarn && (!a.parentId || BUSY.has(a.status))) add(`context:${a.id}`, 'context', pct >= t.contextCrit ? 'crit' : 'warn', a, { who, pct: Math.round(pct * 100) });

      // 5. Blocked on a permission prompt (silent killer for background subagents).
      if (a.status === STATUS.PERMISSION && a.permissionSince && now - a.permissionSince > t.permissionMs) {
        const sub = !!a.parentId;
        add(`permission:${a.id}`, sub ? 'permissionSub' : 'permission', sub ? 'crit' : 'warn', a, {
          who, seconds: Math.round((now - a.permissionSince) / 1000), tool: a.tool,
        });
      }

      // 6. Waiting for the human.
      if (!a.parentId && a.status === STATUS.WAITING && a.waitingSince && now - a.waitingSince > t.waitingMs) {
        add(`waiting:${a.id}`, 'waiting', 'info', a, { who, minutes: Math.round((now - a.waitingSince) / 60_000) });
      }

      // 7. Exhausted: rate limit / overloaded / billing.
      if (a.status === STATUS.EXHAUSTED && a.exhausted) {
        add(`exhausted:${a.id}`, 'exhausted', a.parentId ? 'warn' : 'crit', a, { who, reason: a.exhausted.reason });
      }

      // 8. Permissions bypassed: not a bug, but you should know.
      if (a.mode === 'bypassPermissions') add(`bypass:${a.id}`, 'bypass', 'warn', a, { who });

      // 9. Straggler in a swarm: much slower than its stage-mates.
      const run = a.runId && world.runs.get(a.runId);
      if (run && a.parentId) {
        const st = run.stages.find((s) => s.name === a.stage);
        if (st && st.durations.length >= 3) {
          const med = median(st.durations), age = now - a.startedAt;
          if (age > Math.max(t.stragglerMinMs, t.stragglerFactor * med)) {
            add(`straggler:${a.id}`, 'straggler', 'warn', a, { who, stage: st.name, minutes: Math.round(age / 60_000), factor: Math.round(age / Math.max(1, med)) });
          }
        }
      }
      a.mood = 'ok';
    }

    // 10. Spawn sprawl and run budget, per run.
    for (const run of world.runs.values()) {
      if (run.endedAt) continue;
      const parent = world.agents.get(run.parentId);
      const perMin = this.spawns.filter((s) => s.parent === run.parentId && now - s.ts < 60_000).length;
      if (run.total >= t.sprawlTotal || perMin >= t.sprawlPerMin) {
        add(`sprawl:${run.id}`, 'sprawl', perMin >= t.sprawlPerMin ? 'warn' : 'info', parent, { who: labelOf(parent), total: run.total, perMin });
      }
      if (t.runBudgetUsd > 0 && run.cost >= t.runBudgetUsd) {
        add(`runBudget:${run.id}`, 'runBudget', 'crit', parent, { who: labelOf(parent), spent: run.cost, budget: t.runBudgetUsd });
      }
    }

    // 10b. Forecasts: a run heading over its budget, a block or provider limit running out early.
    const F = world.forecasts || {};
    for (const run of world.runs.values()) {
      const f = F.runs?.[run.id];
      if (!f || run.endedAt) continue;
      const parent = world.agents.get(run.parentId);
      if (t.runBudgetUsd > 0 && f.projectedCost >= t.runBudgetUsd && run.cost < t.runBudgetUsd) {
        add(`runForecast:${run.id}`, 'runForecast', 'warn', parent, { who: labelOf(parent), projected: f.projectedCost, budget: t.runBudgetUsd, basis: f.basis, samples: f.samples || 0 });
      } else if (f.basis === 'history' && run.cost > f.expectedCost * 1.5 && run.cost > 0.5) {
        add(`runOverrun:${run.id}`, 'runOverrun', 'warn', parent, { who: labelOf(parent), spent: run.cost, usual: f.expectedCost, samples: f.samples });
      }
    }
    const bf = F.block;
    if (bf && (bf.hitsBeforeReset || bf.aboveUsual)) {
      add('blockForecast', 'blockForecast', bf.hitsBeforeReset ? 'warn' : 'info', null, {
        projected: bf.projectedEnd, ceiling: bf.ceiling, heaviest: bf.heaviest,
        minutes: bf.eta ? Math.max(1, Math.round((bf.eta - now) / 60_000)) : null, resetMin: Math.round((bf.resetsAt - now) / 60_000),
      });
    }
    for (const [prov, lf] of Object.entries(F.limits || {})) {
      if (lf.eta && lf.hitsBeforeReset && lf.eta - now < 3 * 3600_000) {
        add(`limitForecast:${prov}`, 'limitForecast', lf.eta - now < 30 * 60_000 ? 'crit' : 'warn', null, {
          provider: prov, used: Math.round(lf.used), minutes: Math.max(1, Math.round((lf.eta - now) / 60_000)),
          resetMin: lf.resetsAt ? Math.round((lf.resetsAt - now) / 60_000) : null,
        });
      }
    }

    // 11. Burn rate (global).
    const burn = world.burnRate(now, 5);
    if (t.burnUsdPerMin > 0 && burn >= t.burnUsdPerMin) {
      add('burn', 'burn', burn >= t.burnUsdPerMin * 3 ? 'crit' : 'warn', null, { rate: burn, limit: t.burnUsdPerMin });
    }

    // 12. Daily budget.
    if (t.dailyBudgetUsd > 0 && world.totals.cost >= t.dailyBudgetUsd) {
      add('budget', 'budget', 'crit', null, { spent: world.totals.cost, budget: t.dailyBudgetUsd });
    }

    // Collapse identical subagent alerts under one orchestrator.
    const groups = new Map();
    for (const c of cand) {
      if (!c.parentId || !SWARMABLE.has(c.kind)) continue;
      const g = `${c.kind}|${c.parentId}`;
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(c);
    }
    const swallowed = new Set();
    for (const [g, list] of groups) {
      if (list.length < t.swarmGroup) continue;
      const [kind, parentId] = g.split('|');
      const parent = world.agents.get(parentId);
      const sev = list.reduce((s, c) => (SEVERITY_RANK[c.sev] > SEVERITY_RANK[s] ? c.sev : s), 'info');
      for (const c of list) swallowed.add(c);
      cand.push({
        key: `${kind}:swarm:${parentId}`, kind, sev, agentId: parentId, parentId: null,
        params: { ...list[0].params, who: labelOf(parent), swarm: true, count: list.length, agents: list.map((c) => c.agentId) },
      });
    }

    const seen = new Set();
    for (const c of cand) {
      if (swallowed.has(c)) continue;
      seen.add(c.key);
      this.raise(out, c.key, c.kind, c.sev, c.agentId, now, c.params);
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

    // Moods: worst active alert per agent (swarm alerts mark every member).
    const moodOf = (kind) => kind === 'loop' || kind === 'errorEcho' ? 'dizzy'
      : kind === 'context' ? 'sleepy'
      : kind === 'permission' || kind === 'permissionSub' ? 'blocked'
      : kind === 'stall' || kind === 'straggler' ? 'stuck'
      : kind === 'exhausted' ? 'exhausted'
      : kind === 'collision' ? 'angry' : 'ok';
    for (const al of this.alerts.values()) {
      const ids = al.params?.swarm ? al.params.agents : [al.agentId];
      for (const id of ids || []) {
        const a = id && world.agents.get(id);
        if (!a) continue;
        const mood = moodOf(al.kind);
        if (mood !== 'ok' && (a.mood === 'ok' || SEVERITY_RANK[al.severity] >= 2)) a.mood = mood;
      }
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
  if (a.teammate) return `${a.teammate}@${a.project}`;
  return a.type === 'main' ? a.project + (a.worktree ? `:${a.worktree}` : '') : `${a.type}@${a.project}`;
}

/** Like labelOf, but tells two sessions of the same project apart. */
function sessionLabel(a) {
  const id = String(a.sessionId || a.id);
  return `${labelOf(a)} #${id.replace(/[^a-z0-9]/gi, '').slice(-4)}`;
}
