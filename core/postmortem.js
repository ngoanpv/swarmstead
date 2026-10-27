// Post-mortem: "why did this cost $40?"
//
// Replays the normalized event log through the real engine and records where
// the money went: by project, agent type, model and *activity* (what the agent
// was doing when it spent), how much was spent while an agent was stuck in a
// loop / stalled / repeating an error ("waste"), the most expensive turns and
// every incident that fired. Pure, isomorphic, no I/O.

import { Village } from './engine.js';
import { EV } from './schema.js';
import { fmtUsd, fmtTokens, fmtDuration } from './util.js';
import { priceUsage } from './pricing.js';
import { getDict, alertText } from './i18n.js';

const WASTE_KINDS = new Set(['loop', 'errorEcho', 'stall']);

export function postmortem(events, { from = -Infinity, to = Infinity, sessionId = null, lang = 'en' } = {}) {
  const evs = events.filter((e) => e && e.ts >= from && e.ts <= to && (!sessionId || e.sessionId === sessionId)).sort((a, b) => a.ts - b.ts);
  const v = new Village({ now: evs[0]?.ts || Date.now() });
  const out = {
    from: evs[0]?.ts || 0, to: evs[evs.length - 1]?.ts || 0, events: evs.length,
    cost: 0, tokens: 0, cacheRead: 0, ctxTokens: 0,
    byProject: {}, byType: {}, byModel: {}, byActivity: {},
    waste: 0, wasteByKind: {}, turns: [], incidents: [], sessions: new Set(), subagents: 0, runs: [],
    commits: 0, prs: 0, outcomes: { clean: 0, rough: 0, failed: 0, lost: 0 },
  };
  const add = (map, k, usd) => { map[k] = (map[k] || 0) + usd; };
  let lastTick = -Infinity;
  for (const e of evs) {
    if (e.kind === EV.USAGE && !e.backfill) {
      const a = v.world.agents.get(e.agentId);
      const usd = Number.isFinite(e.costUsd) ? e.costUsd : priceUsage(e.usage);
      const u = e.usage || {};
      out.cost += usd;
      out.tokens += (u.input || 0) + (u.output || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
      out.cacheRead += u.cacheRead || 0;
      out.ctxTokens += (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
      add(out.byModel, u.model || 'unknown', usd);
      add(out.byProject, a?.project || projectOf(e.cwd), usd);
      add(out.byType, a ? (a.type === 'main' ? 'main agent' : a.type) : 'unknown', usd);
      add(out.byActivity, a ? a.status : 'thinking', usd);
      // spent while this agent had a loop / stall / error-echo alert open = waste
      for (const al of v.detectors.alerts.values()) {
        const ids = al.params?.swarm ? al.params.agents : [al.agentId];
        if (WASTE_KINDS.has(al.kind) && ids?.includes(e.agentId)) { out.waste += usd; add(out.wasteByKind, al.kind, usd); break; }
      }
    }
    if (e.sessionId && e.kind !== EV.GIT) out.sessions.add(e.sessionId);
    const fx = v.ingest(e);
    if (e.ts - lastTick >= 1000) { fx.push(...v.tick(e.ts)); lastTick = e.ts; }
    for (const f of fx) {
      if (f.fx === 'turn') {
        const s = f.summary;
        out.turns.push({ agentId: s.agentId, type: s.type, project: s.project, cost: s.cost, tools: s.tools, edits: s.edits, loops: s.loops, errorEchoes: s.errorEchoes, durationMs: s.durationMs, outcome: s.outcome || null });
        if (s.outcome) out.outcomes[s.outcome] = (out.outcomes[s.outcome] || 0) + 1;
      }
      if (f.fx === 'spawn') { const a = v.world.agents.get(f.agentId); if (a?.parentId) out.subagents++; }
      if (f.fx === 'alert' && !f.escalated) out.incidents.push({ ts: e.ts, kind: f.alert.kind, severity: f.alert.severity, params: f.alert.params });
      if (f.fx === 'ship') { if (f.action === 'commit') out.commits++; if (f.action === 'pr.open') out.prs++; }
      if (f.fx === 'run.end' || f.fx === 'fanin') {
        const run = v.world.runs.get(f.runId);
        if (run && !out.runs.some((r) => r.id === run.id)) out.runs.push({ id: run.id, workflow: run.workflow, project: run.project, total: run.total, failed: run.failed, cost: run.cost, durationMs: (run.endedAt || run.lastActivity) - run.startedAt });
      }
    }
  }
  out.sessions = out.sessions.size;
  out.turns.sort((a, b) => b.cost - a.cost);
  out.topTurns = out.turns.slice(0, 5);
  out.turnCount = out.turns.length;
  delete out.turns;
  out.cacheHit = out.ctxTokens ? out.cacheRead / out.ctxTokens : 0;
  out.durationMs = out.to - out.from;
  out.costPerCommit = out.commits ? out.cost / out.commits : null;
  out.lang = lang;
  return out;
}

function projectOf(cwd) { return String(cwd || '').split(/[\\/]/).filter(Boolean).pop() || 'unknown'; }

const top = (map, n = 5) => Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, n);
const pct = (x, total) => (total ? Math.round((x / total) * 100) : 0);

/** A shareable Markdown write-up. */
export function postmortemMarkdown(pm, { title = 'Swarmstead post-mortem' } = {}) {
  const T = getDict(pm.lang || 'en');
  const when = pm.from ? `${new Date(pm.from).toLocaleString()} – ${new Date(pm.to).toLocaleTimeString()}` : '';
  const L = [];
  L.push(`# ${title}`, '', `${when} · ${fmtDuration(pm.durationMs)} · ${pm.sessions} session(s), ${pm.subagents} subagent(s), ${pm.turnCount} turns`, '');
  L.push('## Summary', '');
  L.push(`- **Spent:** ${fmtUsd(pm.cost)} (${fmtTokens(pm.tokens)} tokens, ${Math.round(pm.cacheHit * 100)}% cache hits)`);
  L.push(`- **Waste:** ${fmtUsd(pm.waste)} (${pct(pm.waste, pm.cost)}%) spent while an agent was looping, stalled or repeating an error`);
  if (pm.commits) L.push(`- **Shipped:** ${pm.commits} commit(s)${pm.prs ? `, ${pm.prs} PR(s)` : ''}, ${fmtUsd(pm.costPerCommit)} per commit`);
  const o = pm.outcomes;
  if (o.clean + o.rough + o.failed + o.lost) L.push(`- **Subagent reports:** ${o.clean} clean, ${o.rough} rough, ${o.failed} failed, ${o.lost} maybe lost`);
  L.push('');
  const section = (name, map) => {
    const rows = top(map);
    if (!rows.length) return;
    L.push(`## ${name}`, '', '| | Cost | Share |', '|---|---:|---:|');
    for (const [k, usd] of rows) L.push(`| ${k} | ${fmtUsd(usd)} | ${pct(usd, pm.cost)}% |`);
    L.push('');
  };
  section('Where it went: activity', pm.byActivity);
  section('By project', pm.byProject);
  section('By agent type', pm.byType);
  section('By model', pm.byModel);
  if (pm.topTurns.length) {
    L.push('## Most expensive turns', '', '| Agent | Project | Cost | Tools | Edits | Loops | Time |', '|---|---|---:|---:|---:|---:|---:|');
    for (const t of pm.topTurns) L.push(`| ${t.type} | ${t.project} | ${fmtUsd(t.cost)} | ${t.tools} | ${t.edits} | ${t.loops} | ${fmtDuration(t.durationMs)} |`);
    L.push('');
  }
  if (pm.runs.length) {
    L.push('## Runs and workflows', '', '| Run | Agents | Failed | Cost | Time |', '|---|---:|---:|---:|---:|');
    for (const r of pm.runs) L.push(`| ${r.workflow || r.project} | ${r.total} | ${r.failed} | ${fmtUsd(r.cost)} | ${fmtDuration(r.durationMs)} |`);
    L.push('');
  }
  if (pm.incidents.length) {
    L.push('## Incidents', '');
    for (const i of pm.incidents.slice(0, 25)) L.push(`- ${new Date(i.ts).toLocaleTimeString()} **${i.severity}** ${alertText(T, i)}`);
    if (pm.incidents.length > 25) L.push(`- …and ${pm.incidents.length - 25} more`);
    L.push('');
  }
  L.push('_Costs are API-equivalent estimates from public list prices._');
  return L.join('\n');
}
