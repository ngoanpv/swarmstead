// World state: a deterministic reducer over normalized events.
// apply(event) mutates the world and returns "effects": one-shot things the
// renderer should animate (coins flying, a scroll being handed off, a monster
// appearing). snapshot() returns plain JSON for the renderer / the wire.

import { EV, CATEGORY, categorize, isTestCommand, gitAction, EXHAUSTION, AGENT_FIELDS } from './schema.js';
import { priceUsage } from './pricing.js';
import { projectName, errorSignature, worktreeOf, median, shortPath } from './util.js';

const RING = 12;
const BURN_BUCKET_MS = 10_000;
const BURN_BUCKETS = 60; // 10 minutes of history
const BLOCK_MS = 5 * 3600_000;
const DEFAULT_WINDOW = 200_000;
const RUN_IDLE_MS = 15_000;     // a fan-out run ends after this long with nothing running
const RUN_TIMELINE_CAP = 1000;  // workflows can spawn up to ~1000 agents
const FANIN_QUIET_MS = 2500;    // nothing running for this long = everyone has reported back

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
  EXHAUSTED: 'exhausted',   // rate limit / overloaded / billing — can't continue
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

/** How a subagent's work came back to its orchestrator. */
export const OUTCOME = Object.freeze({ CLEAN: 'clean', ROUGH: 'rough', FAILED: 'failed', LOST: 'lost' });
const MERGE_WINDOW_MS = 24 * 3600_000; // two worktrees touching one file within a day = merge risk

function newTurn(ts) {
  return {
    startedAt: ts, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
    tools: 0, edits: 0, runs: 0, failedRuns: 0, testFails: 0, testFixes: 0,
    loops: 0, errorEchoes: 0, returns: 0, permissions: 0, compactions: 0, denied: 0,
    lastEditTs: 0, lastTestTs: 0, lastTestOkTs: 0, testRuns: 0, commits: 0, unverified: false,
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
    this.handoffs = [];        // last N handoffs
    this.feed = [];            // last N human-readable log lines
    this.totals = { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, byModel: {} };
    this.burn = new Array(BURN_BUCKETS).fill(0);
    this.burnHead = Math.floor(now / BURN_BUCKET_MS);
    this.block = null;         // 5-hour usage block, ccusage-style
    this.startedAt = now;
    this.lastTs = now;
    this.fileTouches = new Map(); // abs path -> [{agentId, sessionId, ts}]
    this.limits = {};             // provider -> latest rate-limit snapshot
    this.runs = new Map();        // runId -> fan-out run (subagent swarm / workflow)
    this.teams = new Map();       // team name -> { lead, members:Set, open, done }
    this.ledger = new Map();      // project -> today's shipping ledger (cost per commit / PR)
    this.treeEdits = new Map();   // `${repoRoot}|${relPath}` -> Map(tree -> {agentId, ts})
    this.dayStart = 0;
    this.runSeq = 0;
    this.pastBlocks = [];         // costs of finished 5-hour blocks (seeded from disk by the daemon)
    this.forecasts = { runs: {}, block: null, limits: {} };
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
      worktree: worktreeOf(cwd)?.name || '',
      status: STATUS.IDLE,
      tool: '', detail: '', statusSince: ev.ts,
      startedAt: ev.ts, lastTs: ev.ts, endedAt: 0, alive: true,
      model: '', cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0,
      context: { used: 0, window: DEFAULT_WINDOW },
      turn: newTurn(ev.ts), turns: 0,
      recentTools: [], recentErrors: [],
      lastWriteTs: ev.ts, toolsSinceWrite: 0, costSinceWrite: 0,
      monsters: [],            // open failures (ids)
      openTools: {},           // toolUseId -> {tool, category, detail, ts, cmd}
      children: [],
      waitingSince: 0, permissionSince: 0, lastCompactTs: 0,
      mood: 'ok',
      mode: '', effort: '', background: 0, crons: 0, team: '', teammate: '', stage: '', workflow: '',
      exhausted: null, source: '', runId: null, outcome: null,
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

  reparent(a, parentId) {
    if (!parentId || a.parentId === parentId || parentId === a.id) return;
    const old = this.agents.get(a.parentId);
    if (old) old.children = old.children.filter((c) => c !== a.id);
    a.parentId = parentId;
    const p = this.agents.get(parentId);
    if (p && !p.children.includes(a.id)) p.children.push(a.id);
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
      this.limits[ev.provider || 'claude'] = { ...ev.limits, ts, history: [...(this.limits[ev.provider || 'claude']?.history || []), [ts, ev.limits?.primary?.usedPercent]].filter((h) => h[1] != null).slice(-60) };
      return fx;
    }
    if (ev.kind === EV.GIT) {
      this.ship(projectName(ev.cwd || ''), ev.action, ts, fx, null, { sha: ev.sha, human: true });
      return fx;
    }
    this.lastTs = Math.max(this.lastTs, ts);
    const { agent: a, created } = this.ensureAgent(ev);
    if (ev.cwd && !a.cwd) { a.cwd = ev.cwd; a.project = projectName(ev.cwd); a.worktree = worktreeOf(ev.cwd)?.name || ''; a.familiar = familiarKey(a); }
    if (ev.label) a.label = ev.label;
    for (const k of AGENT_FIELDS) if (ev[k] != null && ev[k] !== '') a[k] = ev[k];
    // an agent first seen through a transcript/journal line learns its real type later
    if (ev.agentType && a.parentId && a.type === 'subagent' && ev.agentType !== 'subagent') { a.type = ev.agentType; a.familiar = familiarKey(a); }
    a.lastTs = ts;
    // Late transcript lines must not resurrect an agent that already finished.
    if (!a.alive && ev.kind !== EV.SESSION_END && ev.kind !== EV.SUBAGENT_END && ev.kind !== EV.USAGE) {
      a.alive = true; a.endedAt = 0; fx.push({ fx: 'spawn', agentId: a.id });
    }
    if (created) fx.push({ fx: 'spawn', agentId: a.id });

    switch (ev.kind) {
      case EV.SESSION_START:
        this.setStatus(a, STATUS.IDLE, ts);
        a.source = ev.reason || '';
        if (ev.reason === 'resume' || ev.reason === 'fork') fx.push({ fx: 'note', agentId: a.id, text: ev.reason === 'fork' ? 'FORKED' : 'RESUMED' });
        this.log(ts, a.id, `${a.project}: session ${ev.reason && ev.reason !== 'startup' ? ev.reason : 'started'}`);
        break;

      case EV.SESSION_END:
        this.endAgent(a, ts, fx);
        this.log(ts, a.id, `${a.project}: session ended`);
        break;

      case EV.PROMPT:
        a.turn = newTurn(ts);
        a.waitingSince = 0; a.permissionSince = 0; a.exhausted = null;
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
        const parallel = Object.keys(a.openTools).length;
        if (parallel >= 2) fx.push({ fx: 'parallel', agentId: a.id, count: parallel });
        break;
      }

      case EV.TOOL_END: {
        const open = a.openTools[ev.toolUseId || ev.tool];
        delete a.openTools[ev.toolUseId || ev.tool];
        const category = ev.category || open?.category || categorize(ev.tool);
        const cmd = ev.command || open?.cmd || '';
        if (ev.denied) {
          a.turn.denied++;
          fx.push({ fx: 'bubble', agentId: a.id, icon: 'deny' });
          this.log(ts, a.id, `${ev.tool || 'tool'} was denied`, 'warn');
        }
        if (category === CATEGORY.RUN && isTestCommand(cmd)) {
          a.turn.testRuns++;
          a.turn.lastTestTs = ts;
          if (ev.ok !== false) a.turn.lastTestOkTs = ts;
        }
        if (category === CATEGORY.RUN && ev.ok !== false) {
          const act = gitAction(cmd);
          if (act) { if (act === 'commit') a.turn.commits++; this.ship(a.project, act, ts, fx, a); }
        }
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
            a.turn.lastEditTs = ts;
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
        this.setStatus(a, STATUS.WAITING, ts, '', ev.detail || '');
        fx.push({ fx: 'bubble', agentId: a.id, icon: 'question' });
        break;

      case EV.TURN_END: {
        a.turns++;
        a.permissionSince = 0;
        this.verify(a, ev, ts, fx);
        const reason = ev.reason || '';
        const summary = this.closeTurn(a, ts, { failure: reason || null });
        if (EXHAUSTION.has(reason)) {
          a.exhausted = { reason, since: ts };
          this.setStatus(a, STATUS.EXHAUSTED, ts, '', reason);
          fx.push({ fx: 'bubble', agentId: a.id, icon: 'exhausted' });
          this.log(ts, a.id, `${a.project}: stopped — ${reason.replace(/_/g, ' ')}`, 'warn');
        } else {
          this.setStatus(a, a.parentId ? STATUS.DONE : STATUS.WAITING, ts);
          a.waitingSince = a.parentId ? 0 : ts;
          fx.push({ fx: 'bubble', agentId: a.id, icon: reason ? 'alert' : 'check' });
          if (reason) this.log(ts, a.id, `${a.project}: turn failed — ${reason}`, 'warn');
        }
        fx.push({ fx: 'turn', agentId: a.id, summary });
        break;
      }

      case EV.SUBAGENT_START: {
        if (ev.parentId) this.reparent(a, ev.parentId);
        const parent = this.agents.get(a.parentId);
        if (parent) {
          this.handoff(parent.id, a.id, 'delegate', ts, ev.detail || a.type, fx);
          this.log(ts, parent.id, `delegated to ${a.type}${ev.detail ? ': ' + ev.detail : ''}`);
          this.joinRun(parent, a, ev, ts, fx);
        }
        a.turn = newTurn(ts);
        this.setStatus(a, STATUS.THINKING, ts);
        break;
      }

      case EV.SUBAGENT_END: {
        const parent = this.agents.get(a.parentId);
        if (a.alive) {
          a.turns++;
          this.verify(a, ev, ts, fx);
          const outcome = ev.outcome || this.outcomeOf(a, parent, ts, ev.reason);
          a.outcome = outcome;
          const run = a.runId ? this.runs.get(a.runId) : null;
          const summary = this.closeTurn(a, ts, { outcome, swarm: run ? run.total : 1 });
          fx.push({ fx: 'turn', agentId: a.id, summary });
          if (parent) {
            parent.turn.returns++;
            this.handoff(a.id, parent.id, 'return', ts, ev.detail || 'report', fx, { outcome });
            this.log(ts, a.id, `${a.type} reported back to ${parent.type === 'main' ? parent.project : parent.type} (${outcome})`, outcome === OUTCOME.CLEAN ? 'good' : 'warn');
          }
          if (run) this.leaveRun(run, a, outcome, ts, fx);
        }
        this.endAgent(a, ts, fx);
        break;
      }

      case EV.COMPACT:
        a.turn.compactions++;
        a.lastCompactTs = ts;
        this.setStatus(a, STATUS.COMPACTING, ts);
        fx.push({ fx: 'compact', agentId: a.id, auto: ev.reason !== 'manual' });
        this.log(ts, a.id, `${ev.reason === 'manual' ? 'manual' : 'auto'} compaction — memory is getting squeezed`, ev.reason === 'manual' ? 'info' : 'warn');
        break;

      case EV.COMPACT_END:
        a.context.used = Math.min(a.context.used, Math.round(a.context.window * 0.15));
        this.setStatus(a, STATUS.THINKING, ts);
        break;

      case EV.MODEL_SWITCH:
        if (ev.to) a.model = ev.to;
        fx.push({ fx: 'model', agentId: a.id, from: ev.from || '', to: ev.to || '' });
        this.log(ts, a.id, `model switched ${ev.from || '?'} → ${ev.to || '?'}`);
        break;

      case EV.WORKTREE:
        if (ev.action === 'create' || ev.action === 'cwd') {
          const wt = worktreeOf(ev.path || '');
          a.worktree = ev.name || wt?.name || a.worktree;
          if (ev.action === 'cwd' && ev.path) a.cwd = ev.path;
        }
        if (ev.action === 'remove') a.worktree = '';
        fx.push({ fx: 'note', agentId: a.id, text: ev.action === 'remove' ? 'WORKTREE -' : `WORKTREE ${a.worktree || ''}`.trim() });
        this.log(ts, a.id, `worktree ${ev.action}${a.worktree ? ': ' + a.worktree : ''}`);
        break;

      case EV.AGENT_META: {
        if (ev.title) a.title = ev.title;
        if (ev.parentId) this.reparent(a, ev.parentId);
        if (ev.stage && a.runId) this.moveStage(a, ev.stage);
        if (ev.workflow && a.runId) { const run = this.runs.get(a.runId); if (run && (!run.workflow || run.workflow.startsWith('wf_'))) run.workflow = ev.workflow; }
        break;
      }

      case EV.TEAM: {
        const name = ev.team || a.team || 'team';
        let t = this.teams.get(name);
        if (!t) { t = { name, lead: null, members: new Set(), open: 0, done: 0 }; this.teams.set(name, t); }
        a.team = name;
        if (ev.lead) t.lead = a.id; else t.members.add(a.id);
        if (ev.action === 'task.created') { t.open++; this.log(ts, a.id, `team task: ${ev.subject || 'new task'}`); }
        if (ev.action === 'task.completed') { t.open = Math.max(0, t.open - 1); t.done++; fx.push({ fx: 'note', agentId: a.id, text: 'TASK DONE' }); }
        // In-process teammates handle one message at a time: the lead hands a message
        // over (assign) and gets an answer back (report); the teammate stays in the room.
        if (ev.action === 'assign') {
          const lead = this.agents.get(a.parentId);
          if (lead) { t.lead = lead.id; this.handoff(lead.id, a.id, 'delegate', ts, ev.subject || 'message', fx); }
          a.turn = newTurn(ts);
          this.setStatus(a, STATUS.THINKING, ts);
        }
        if (ev.action === 'report') {
          this.verify(a, ev, ts, fx);
          const lead = this.agents.get(a.parentId);
          const outcome = this.outcomeOf(a, lead, ts, ev.reason);
          const summary = this.closeTurn(a, ts, { outcome });
          a.turns++;
          fx.push({ fx: 'turn', agentId: a.id, summary });
          if (lead) { lead.turn.returns++; this.handoff(a.id, lead.id, 'return', ts, 'reply', fx, { outcome, stay: true }); }
          this.setStatus(a, STATUS.IDLE, ts, '', 'teammate idle');
        }
        break;
      }

      case EV.NOTICE:
        this.log(ts, a.id, ev.text || 'notice', ev.level || 'info');
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

  /** Decide how a subagent's report came back. */
  outcomeOf(a, parent, ts, reason) {
    if (reason || a.monsters.length || a.exhausted) return OUTCOME.FAILED;
    if (parent && (parent.status === STATUS.COMPACTING || ts - parent.lastCompactTs < 60_000)) return OUTCOME.LOST;
    const t = a.turn;
    if (t.loops || t.errorEchoes || t.failedRuns > t.testFixes || t.denied || t.unverified) return OUTCOME.ROUGH;
    return OUTCOME.CLEAN;
  }

  // ---------------------------------------------------------------- runs (fan-out / workflows)
  joinRun(parent, a, ev, ts, fx) {
    let run = parent.runId ? this.runs.get(parent.runId) : null;
    const wf = ev.workflow || a.workflow || '';
    if (!run || run.endedAt || (wf && run.workflow && wf !== run.workflow)) {
      run = {
        id: `run${++this.runSeq}`, parentId: parent.id, project: parent.project, workflow: wf,
        startedAt: ts, endedAt: 0, lastActivity: ts, total: 0, running: 0, done: 0, failed: 0, cost: 0,
        outcomes: { clean: 0, rough: 0, failed: 0, lost: 0 }, stages: [], timeline: [], finishedCost: 0,
      };
      this.runs.set(run.id, run);
      parent.runId = run.id;
      fx.push({ fx: 'run.start', runId: run.id, agentId: parent.id, workflow: wf });
      if (this.runs.size > 20) this.runs.delete(this.runs.keys().next().value);
    }
    if (wf && !run.workflow) run.workflow = wf;
    a.runId = run.id;
    const stageName = ev.stage || a.stage || a.type;
    a.stage = stageName;
    let st = run.stages.find((s) => s.name === stageName);
    if (!st) { st = { name: stageName, total: 0, running: 0, done: 0, failed: 0, cost: 0, durations: [], first: ts, last: ts, type: a.type }; run.stages.push(st); }
    st.total++; st.running++; st.last = ts;
    run.total++; run.running++; run.lastActivity = ts; run.fannedIn = false; run.quietSince = 0;
    run.timeline.push({ id: a.id, stage: stageName, start: ts, end: 0, outcome: '' });
    if (run.timeline.length > RUN_TIMELINE_CAP) run.timeline.shift();
  }

  leaveRun(run, a, outcome, ts, fx) {
    const st = run.stages.find((s) => s.name === a.stage);
    run.running = Math.max(0, run.running - 1);
    run.lastActivity = ts;
    if (outcome === OUTCOME.FAILED) run.failed++; else run.done++;
    run.outcomes[outcome] = (run.outcomes[outcome] || 0) + 1;
    run.finishedCost += a.cost;
    if (st) {
      st.running = Math.max(0, st.running - 1);
      if (outcome === OUTCOME.FAILED) st.failed++; else st.done++;
      st.cost += a.cost; st.last = ts;
      st.durations.push(ts - a.startedAt);
      if (st.durations.length > 200) st.durations.shift();
      if (st.running === 0 && st.done + st.failed === st.total) fx.push({ fx: 'stage.done', runId: run.id, stage: st.name, agentId: run.parentId });
    }
    const item = [...run.timeline].reverse().find((x) => x.id === a.id);
    if (item) { item.end = ts; item.outcome = outcome; }
    // Fan-in is decided in tickRuns after a short quiet period: workflow pipelines
    // hit running === 0 for a moment between stages, and that is not the end.
    if (run.running === 0) run.quietSince = ts;
  }

  /**
   * "All tests pass!" — did they actually run after the last edit?
   * ev.claims comes from the adapter (a boolean read from the final message).
   */
  verify(a, ev, ts, fx) {
    if (!ev.claims) return;
    const t = a.turn;
    const ranAfterEdit = t.lastTestOkTs && t.lastTestOkTs >= t.lastEditTs;
    if (ranAfterEdit) return;
    t.unverified = true;
    const why = t.testRuns === 0 ? 'none' : t.lastTestOkTs ? 'stale' : 'failing';
    fx.push({ fx: 'unverified', agentId: a.id, why, ts });
    this.log(ts, a.id, `claims tests pass, but ${why === 'none' ? 'no test ran this turn' : why === 'stale' ? 'files changed after the last passing run' : 'the last test run failed'}`, 'warn');
  }

  /** Shipping ledger: cost per commit / PR, per project, for today. */
  ship(project, action, ts, fx, a, extra = {}) {
    const L = this.ledgerOf(project);
    if (action === 'commit') {
      // a git post-commit hook right after an agent's own `git commit` is the same commit
      if (extra.human && L.commits.length && ts - L.commits[L.commits.length - 1].ts < 15_000 && !L.commits[L.commits.length - 1].human) { L.commits[L.commits.length - 1].sha = extra.sha; return; }
      L.commits.push({ ts, cost: L.sinceCommit, agentId: a?.id || null, sha: extra.sha || null, human: !!extra.human });
      if (L.commits.length > 500) L.commits.shift();
      L.sinceCommit = 0;
    }
    if (action === 'push') L.pushes++;
    if (action === 'pr.open') { L.prs.push({ ts, cost: L.sincePr, agentId: a?.id || null }); L.sincePr = 0; }
    if (action === 'pr.merge') L.merged++;
    fx.push({ fx: 'ship', agentId: a?.id || null, project, action, cost: action === 'commit' ? L.commits[L.commits.length - 1]?.cost : action === 'pr.open' ? L.prs[L.prs.length - 1]?.cost : 0 });
    this.log(ts, a?.id || null, `${project}: ${action === 'commit' ? 'commit' : action === 'push' ? 'push' : action === 'pr.open' ? 'pull request opened' : 'pull request merged'}`, 'good');
  }

  ledgerOf(project) {
    let L = this.ledger.get(project);
    if (!L) { L = { project, cost: 0, sinceCommit: 0, sincePr: 0, commits: [], prs: [], pushes: 0, merged: 0 }; this.ledger.set(project, L); }
    return L;
  }

  /** A late fact (workflow journal) says this agent belongs to another stage. */
  moveStage(a, stageName) {
    const run = this.runs.get(a.runId);
    if (!run) { a.stage = stageName; return; }
    // a.stage may already be overwritten by the event's fields; the run timeline remembers where it was counted
    const item = [...run.timeline].reverse().find((x) => x.id === a.id);
    const fromName = item ? item.stage : a.stage;
    if (fromName === stageName) { a.stage = stageName; return; }
    const from = run.stages.find((s) => s.name === fromName);
    if (from) { from.total--; if (a.alive) from.running--; else if (a.outcome === OUTCOME.FAILED) from.failed--; else from.done--; }
    let st = run.stages.find((s) => s.name === stageName);
    if (!st) { st = { name: stageName, total: 0, running: 0, done: 0, failed: 0, cost: 0, durations: [], first: a.startedAt, last: a.lastTs, type: a.type }; run.stages.push(st); }
    st.total++; if (a.alive) st.running++; else if (a.outcome === OUTCOME.FAILED) st.failed++; else st.done++;
    if (from && from.total <= 0) run.stages = run.stages.filter((s) => s !== from);
    if (item) item.stage = stageName;
    a.stage = stageName;
  }

  /** Close runs that have been quiet for a while (called from tick). */
  tickRuns(now, fx) {
    for (const run of this.runs.values()) {
      if (!run.endedAt && run.running === 0 && run.quietSince && !run.fannedIn && now - run.quietSince >= FANIN_QUIET_MS) {
        run.fannedIn = true;
        // Everyone who went out has reported back: the fan-in moment.
        fx.push({ fx: 'fanin', runId: run.id, agentId: run.parentId, done: run.done, failed: run.failed, total: run.total, outcomes: { ...run.outcomes } });
      }
      if (!run.endedAt && run.running === 0 && now - run.lastActivity > RUN_IDLE_MS) {
        run.endedAt = run.lastActivity;
        fx.push({ fx: 'run.end', runId: run.id, agentId: run.parentId });
      }
    }
  }

  applyUsage(a, ev, ts, fx) {
    const u = ev.usage || {};
    const cost = this.addTotals(ev, ts);
    const input = u.input || 0, output = u.output || 0, cr = u.cacheRead || 0, cw = u.cacheWrite || 0;
    if (u.model) a.model = u.model;
    for (const t of [a, a.turn]) {
      t.cost += cost; t.input += input; t.output += output; t.cacheRead += cr; t.cacheWrite += cw;
    }
    a.thinking += u.thinking || 0;
    if (a.runId) { const run = this.runs.get(a.runId); if (run) run.cost += cost; } // live run cost, incl. agents still working
    a.costSinceWrite += cost;
    const L = this.ledgerOf(a.project);
    L.cost += cost; L.sinceCommit += cost; L.sincePr += cost;
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
      if (this.ledger) this.ledger.clear();
    }
  }

  closeTurn(a, ts, extra = {}) {
    const t = a.turn;
    const summary = {
      agentId: a.id, familiar: a.familiar, type: a.type, project: a.project, provider: a.provider,
      durationMs: ts - t.startedAt, ...t, cat: { ...t.cat }, ...extra,
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

  handoff(from, to, kind, ts, text, fx, extra = {}) {
    const h = { from, to, kind, ts, text: text || '', ...extra };
    this.handoffs.push(h);
    if (this.handoffs.length > 100) this.handoffs.shift();
    fx.push({ fx: 'handoff', ...h });
  }

  /** Same file, different worktrees (or worktree vs main checkout) = a merge conflict waiting to happen. */
  mergeRisk(a, file, ts, fx) {
    const wt = worktreeOf(file);
    let root, tree, rel;
    if (wt) {
      root = wt.root; tree = wt.name;
      const base = file.slice(0, file.indexOf(wt.name) + wt.name.length);
      rel = file.slice(base.length + 1);
    } else {
      root = worktreeOf(a.cwd)?.root || a.cwd;
      if (!root || !file.startsWith(root + '/') && !file.startsWith(root + '\\')) return;
      tree = 'main'; rel = file.slice(root.length + 1);
    }
    if (!rel) return;
    const key = `${root}|${rel}`;
    let trees = this.treeEdits.get(key);
    if (!trees) { trees = new Map(); this.treeEdits.set(key, trees); }
    trees.set(tree, { agentId: a.id, ts });
    const others = [...trees].filter(([t, v]) => t !== tree && ts - v.ts < MERGE_WINDOW_MS);
    if (others.length) {
      fx.push({ fx: 'mergeRisk', agentId: a.id, other: others[0][1].agentId, file: rel, project: projectName(root), trees: [tree, ...others.map(([t]) => t)], ts });
    }
    if (this.treeEdits.size > 5000) this.treeEdits.delete(this.treeEdits.keys().next().value);
  }

  touchFile(a, file, ts, fx) {
    this.mergeRisk(a, file, ts, fx);
    let list = this.fileTouches.get(file);
    if (!list) { list = []; this.fileTouches.set(file, list); }
    const prev = list.filter((x) => x.agentId !== a.id && ts - x.ts < 10 * 60_000);
    list.push({ agentId: a.id, sessionId: a.sessionId, ts });
    if (list.length > 8) list.shift();
    for (const p of prev) {
      // Parent/child (or siblings under one orchestrator) editing in sequence is coordinated work.
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
      if (this.block && this.block.cost > 0) { this.pastBlocks.push(this.block.cost); if (this.pastBlocks.length > 60) this.pastBlocks.shift(); }
      const start = Math.floor(ts / 3600_000) * 3600_000;
      this.block = { start, end: start + BLOCK_MS, cost: 0, tokens: 0 };
    }
    this.block.cost += cost;
    this.block.tokens += tokens;
  }

  /**
   * Remove long-finished agents so the village does not fill up forever.
   * Subagents of a big swarm go quickly; their story lives on in the run timeline.
   */
  gc(now, keepMs = 3 * 60_000) {
    let removed = false;
    for (const id of this.order) {
      const a = this.agents.get(id);
      if (!a || a.alive) continue;
      const run = a.runId && this.runs.get(a.runId);
      const keep = a.parentId ? (run && run.total > 12 ? 20_000 : 60_000) : keepMs;
      if (now - a.endedAt > keep) {
        this.agents.delete(id);
        removed = true;
        const p = a.parentId && this.agents.get(a.parentId);
        if (p) p.children = p.children.filter((c) => c !== id);
      }
    }
    if (removed) this.order = this.order.filter((id) => this.agents.has(id));
  }

  runView(run, now) {
    return {
      id: run.id, parentId: run.parentId, project: run.project, workflow: run.workflow, forecast: this.forecasts.runs[run.id] || null,
      startedAt: run.startedAt, endedAt: run.endedAt, total: run.total, running: run.running,
      done: run.done, failed: run.failed, cost: run.cost, outcomes: { ...run.outcomes },
      stages: run.stages.map((s) => ({
        name: s.name, type: s.type, total: s.total, running: s.running, done: s.done, failed: s.failed,
        cost: s.cost, median: median(s.durations), first: s.first, last: s.last,
      })),
      // compact timeline: [agentId, stageIndex, start, end, outcome]
      timeline: run.timeline.map((x) => [x.id, run.stages.findIndex((s) => s.name === x.stage), x.start, x.end, x.outcome]),
    };
  }

  snapshot(now = this.lastTs) {
    const agents = this.order.filter((id) => this.agents.has(id)).map((id) => {
      const a = this.agents.get(id);
      return {
        id: a.id, sessionId: a.sessionId, parentId: a.parentId, provider: a.provider, type: a.type,
        label: a.label, project: a.project, cwd: a.cwd, worktree: a.worktree, status: a.status, tool: a.tool, detail: a.detail,
        statusSince: a.statusSince, startedAt: a.startedAt, lastTs: a.lastTs, endedAt: a.endedAt, alive: a.alive,
        model: a.model, cost: a.cost, input: a.input, output: a.output, cacheRead: a.cacheRead, cacheWrite: a.cacheWrite,
        thinking: a.thinking, context: { ...a.context }, turns: a.turns, monsters: a.monsters.length, children: [...a.children],
        familiar: a.familiar, mood: a.mood, turnCost: a.turn.cost, turnTools: a.turn.tools,
        mode: a.mode, effort: a.effort, background: a.background, crons: a.crons, team: a.team, teammate: a.teammate,
        stage: a.stage, workflow: a.workflow, title: a.title || '', exhausted: a.exhausted, source: a.source, runId: a.runId, outcome: a.outcome,
        parallel: Object.keys(a.openTools).length,
      };
    });
    const runs = [...this.runs.values()]
      .filter((r) => !r.endedAt || now - r.endedAt < 5 * 60_000)
      .map((r) => this.runView(r, now));
    const teams = [...this.teams.values()].map((t) => ({ name: t.name, lead: t.lead, members: [...t.members], open: t.open, done: t.done }));
    const ledger = [...this.ledger.values()].filter((L) => L.cost > 0 || L.commits.length || L.prs.length).map((L) => {
      const shipped = L.commits.filter((c) => c.cost > 0);
      return {
        project: L.project, cost: L.cost, commits: L.commits.length, pushes: L.pushes, prsOpened: L.prs.length, prsMerged: L.merged,
        shippedCost: shipped.reduce((s, c) => s + c.cost, 0), shipped: shipped.length,
        costPerCommit: shipped.length ? shipped.reduce((s, c) => s + c.cost, 0) / shipped.length : null,
        costPerPr: L.prs.length ? L.prs.reduce((s, p) => s + p.cost, 0) / L.prs.length : null,
        unshipped: L.sinceCommit, lastCommitTs: L.commits.length ? L.commits[L.commits.length - 1].ts : 0,
        recent: L.commits.slice(-6).map((c) => ({ ts: c.ts, cost: c.cost, sha: c.sha ? String(c.sha).slice(0, 7) : null, human: c.human })),
      };
    }).sort((p, q) => q.cost - p.cost);
    return {
      now,
      agents,
      runs,
      teams,
      ledger,
      totals: { ...this.totals, byModel: { ...this.totals.byModel } },
      burnRate: this.burnRate(now, 5),
      burn: [...this.burn],
      block: this.block ? { ...this.block, forecast: this.forecasts.block } : null,
      limitForecasts: this.forecasts.limits,
      limits: JSON.parse(JSON.stringify(this.limits)),
      dayStart: this.dayStart,
      handoffs: this.handoffs.slice(-30),
      feed: this.feed.slice(-60),
    };
  }
}
