// Transcript tailers: the source of truth for tokens, model and context size.
//
//  Claude Code: ~/.claude/projects/<encoded-cwd>/<session>.jsonl
//               ~/.claude/projects/<encoded-cwd>/<session>/subagents/agent-<id>.jsonl
//  Codex CLI:   ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
//
// Both formats are internal to their tools and may change between releases, so
// parsing is defensive: unknown lines are ignored, never fatal.
// We poll (stat + read appended bytes) instead of fs.watch: it is portable,
// cheap for a few dozen files, and survives editors/rotations.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EV } from '../../core/schema.js';

const MAX_READ = 4 * 1024 * 1024;

class JsonlTailer {
  constructor(emit) {
    this.emit = emit;        // (events[]) => void
    this.files = new Map();  // path -> { offset, partial, seen:Set, trackedAt, meta }
  }

  track(file, meta = {}) {
    if (!file || this.files.has(file)) return;
    this.files.set(file, { offset: 0, partial: '', seen: new Set(), trackedAt: Date.now(), meta });
    this.readFile(file);
  }

  poll() {
    for (const file of this.files.keys()) this.readFile(file);
  }

  readFile(file) {
    const st = this.files.get(file);
    let stat;
    try { stat = fs.statSync(file); } catch { return; }
    if (stat.size < st.offset) { st.offset = 0; st.partial = ''; } // truncated / rotated
    if (stat.size === st.offset) return;
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      while (st.offset < stat.size) {
        const len = Math.min(MAX_READ, stat.size - st.offset);
        const buf = Buffer.alloc(len);
        const n = fs.readSync(fd, buf, 0, len, st.offset);
        if (n <= 0) break;
        st.offset += n;
        const text = st.partial + buf.toString('utf8', 0, n);
        const lines = text.split('\n');
        st.partial = lines.pop();
        const events = [];
        for (const line of lines) {
          if (!line.trim()) continue;
          let obj;
          try { obj = JSON.parse(line); } catch { continue; }
          try { this.onLine(obj, st, file, events); } catch { /* defensive: skip odd lines */ }
        }
        if (events.length) this.emit(events);
      }
    } catch { /* file vanished mid-read */ } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch {}
    }
  }

  remember(st, key) {
    if (st.seen.has(key)) return false;
    st.seen.add(key);
    if (st.seen.size > 5000) st.seen = new Set([...st.seen].slice(-2500));
    return true;
  }

  /** Backfill = written before we started watching (more than a few seconds ago). */
  isBackfill(st, ts) {
    return ts < st.trackedAt - 10_000;
  }
}

// ----------------------------------------------------------------- Claude Code

export class ClaudeTranscripts extends JsonlTailer {
  constructor(emit, { root = path.join(os.homedir(), '.claude', 'projects') } = {}) {
    super(emit);
    this.root = root;
    this.sessions = new Map(); // sessionId -> { transcript, cwd }
    this.runNames = new Map(); // workflow runId -> script name
  }

  /** Called with every hook payload: learn where the session's transcript lives. */
  noteSession(sessionId, transcriptPath, cwd) {
    if (!sessionId || !transcriptPath) return;
    if (!this.sessions.has(sessionId)) this.sessions.set(sessionId, { transcript: transcriptPath, cwd });
    this.track(transcriptPath, { sessionId, cwd });
    this.scanSubagents(sessionId);
  }

  scanSubagents(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    const sessionDir = path.join(path.dirname(s.transcript), sessionId);
    this.scanWorkflows(sessionId, sessionDir, s.cwd);
    const dir = path.join(sessionDir, 'subagents');
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      const id = n.replace(/^agent-/, '').replace(/\.jsonl$/, '');
      const file = path.join(dir, n);
      if (this.files.has(file)) continue;
      // agent-<id>.meta.json carries the subagent type (and, for workflows, more context)
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(path.join(dir, `agent-${id}.meta.json`), 'utf8')); } catch {}
      this.track(file, {
        sessionId, cwd: s.cwd, subagentId: id,
        agentType: meta.agentType || meta.agent_type || '',
        stage: meta.stage || meta.workflowStage || meta.phase || '',
        workflow: meta.workflowId || meta.workflow_id || meta.workflowName || '',
      });
    }
  }

  /**
   * Claude Code workflows keep, per run:
   *   <session>/workflows/scripts/<name>-<runId>.js          (gives us the run's name)
   *   <session>/subagents/workflows/<runId>/journal.jsonl    ({type:"started", agentId, label, phase})
   *   <session>/subagents/workflows/<runId>/agent-<id>.jsonl (each agent's transcript: tokens)
   */
  scanWorkflows(sessionId, sessionDir, cwd) {
    let scripts = [];
    try { scripts = fs.readdirSync(path.join(sessionDir, 'workflows', 'scripts')); } catch {}
    for (const f of scripts) {
      const m = f.match(/^(.*)-(wf_[A-Za-z0-9-]+)\.js$/);
      if (m) this.runNames.set(m[2], m[1]);
    }
    const root = path.join(sessionDir, 'subagents', 'workflows');
    let runs = [];
    try { runs = fs.readdirSync(root); } catch { return; }
    for (const runId of runs) {
      const rdir = path.join(root, runId);
      this.track(path.join(rdir, 'journal.jsonl'), { sessionId, cwd, journal: true, runId });
      let names = [];
      try { names = fs.readdirSync(rdir); } catch { continue; }
      for (const n of names) {
        if (!/^agent-.*\.jsonl$/.test(n)) continue;
        const id = n.replace(/^agent-/, '').replace(/\.jsonl$/, '');
        this.track(path.join(rdir, n), { sessionId, cwd, subagentId: id, workflow: this.runNames.get(runId) || runId, agentType: 'workflow-subagent' });
      }
    }
  }

  pollAll() {
    for (const id of this.sessions.keys()) this.scanSubagents(id);
    this.poll();
  }

  /** Pick up today's spend from sessions that ran before the daemon started. */
  bootstrap(maxAgeMs = 24 * 3600_000) {
    let dirs = [];
    try { dirs = fs.readdirSync(this.root); } catch { return 0; }
    const cutoff = Date.now() - maxAgeMs;
    let n = 0;
    for (const d of dirs) {
      const full = path.join(this.root, d);
      let entries = [];
      try { entries = fs.readdirSync(full); } catch { continue; }
      for (const e of entries) {
        if (!e.endsWith('.jsonl') || n > 300) continue;
        const f = path.join(full, e);
        try { if (fs.statSync(f).mtimeMs < cutoff) continue; } catch { continue; }
        const sessionId = e.replace(/\.jsonl$/, '');
        this.sessions.set(sessionId, { transcript: f, cwd: '' });
        this.track(f, { sessionId, cwd: '' });
        this.scanSubagents(sessionId);
        n++;
      }
    }
    return n;
  }

  onLine(o, st, file, out) {
    if (st.meta.journal) {
      if (o.type !== 'started' || !o.agentId) return;
      const ts = Date.parse(o.timestamp || o.ts) || Date.now();
      if (this.isBackfill(st, ts) && ts < st.trackedAt - 60_000) return; // don't resurrect old runs
      out.push({
        v: 1, ts, provider: 'claude', kind: EV.AGENT_META, sessionId: st.meta.sessionId,
        agentId: `${st.meta.sessionId}:${o.agentId}`, parentId: st.meta.sessionId, cwd: st.meta.cwd || '',
        stage: o.phase ? String(o.phase) : undefined, title: o.label ? String(o.label).slice(0, 60) : undefined,
        workflow: this.runNames.get(st.meta.runId) || st.meta.runId,
      });
      return;
    }
    const m = o.message;
    if (o.type !== 'assistant' || !m || !m.usage) return;
    const key = `${m.id || ''}:${o.requestId || ''}`;
    if (key !== ':' && !this.remember(st, key)) return;
    const ts = Date.parse(o.timestamp) || Date.now();
    const sessionId = o.sessionId || st.meta.sessionId;
    const sub = st.meta.subagentId || (o.isSidechain && o.agentId) || null;
    const u = m.usage;
    const cw = u.cache_creation_input_tokens || 0;
    const cw1h = u.cache_creation?.ephemeral_1h_input_tokens || 0;
    let multiplier = 1;
    if (u.speed === 'fast') multiplier *= 2;
    if (typeof u.inference_geo === 'string' && /^us/i.test(u.inference_geo)) multiplier *= 1.1;
    out.push({
      v: 1, ts, provider: 'claude', kind: EV.USAGE,
      sessionId, agentId: sub ? `${sessionId}:${sub}` : sessionId,
      parentId: sub ? sessionId : undefined,
      agentType: sub && st.meta.agentType ? st.meta.agentType : undefined,
      stage: st.meta.stage || undefined,
      workflow: st.meta.workflow || undefined,
      cwd: o.cwd || st.meta.cwd || '',
      backfill: this.isBackfill(st, ts) || undefined,
      usage: {
        model: m.model || '',
        input: u.input_tokens || 0,
        output: u.output_tokens || 0,
        cacheRead: u.cache_read_input_tokens || 0,
        cacheWrite: cw,
        cacheWrite1h: cw1h,
        thinking: u.output_tokens_details?.thinking_tokens || 0,
        multiplier,
      },
    });
  }
}

// ----------------------------------------------------------------- Codex CLI (beta)

export class CodexRollouts extends JsonlTailer {
  constructor(emit, { root = path.join(os.homedir(), '.codex', 'sessions') } = {}) {
    super(emit);
    this.root = root;
  }

  noteSession(sessionId, rolloutPath, cwd) {
    if (rolloutPath) this.track(rolloutPath, { sessionId, cwd });
  }

  // Without hooks (not installed, or not trusted in /hooks) nothing tells us a
  // session started, so keep looking for new rollouts in today's folder.
  pollAll() {
    this.scan(new Date());
    this.poll();
  }

  bootstrap() { return this.scan(new Date()); }

  scan(d) {
    const dir = path.join(this.root, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return 0; }
    let n = 0;
    for (const f of names) if (f.startsWith('rollout-') && f.endsWith('.jsonl')) { this.track(path.join(dir, f), {}); n++; }
    return n;
  }

  onLine(o, st, file, out) {
    const p = o.payload || {};
    const ts = Date.parse(o.timestamp) || Date.now();
    if (o.type === 'session_meta') {
      st.meta.threadId = p.id || p.session_id;
      st.meta.parent = p.parent_thread_id || null;
      st.meta.cwd = p.cwd || st.meta.cwd;
      st.meta.role = p.agent_role || p.agent_nickname || null;
      return;
    }
    if (o.type === 'turn_context') {
      if (p.model) st.meta.model = p.model;
      return;
    }
    const threadId = st.meta.threadId || st.meta.sessionId || path.basename(file);
    const sessionId = st.meta.parent || st.meta.sessionId || threadId;
    const agentId = st.meta.parent ? `${st.meta.parent}:${threadId}` : sessionId;
    const base = {
      v: 1, ts, provider: 'codex', sessionId, agentId, cwd: st.meta.cwd || '',
      parentId: st.meta.parent || undefined, agentType: st.meta.parent ? (st.meta.role || 'subagent') : undefined,
    };

    let usage = null;
    if (o.type === 'token_usage_record') {
      st.meta.hasRecords = true;
      if (!this.remember(st, `r:${p.response_id || o.ordinal || ts}`)) return;
      usage = p.usage;
    } else if (o.type === 'event_msg' && p.type === 'token_count') {
      if (p.rate_limits) out.push({ ...base, kind: EV.LIMITS, limits: codexLimits(p.rate_limits) });
      const info = p.info;
      if (!info) return;
      st.meta.window = info.model_context_window || st.meta.window;
      st.meta.lastInput = info.last_token_usage?.input_tokens ?? st.meta.lastInput;
      if (st.meta.hasRecords) return;
      const total = info.total_token_usage?.total_tokens;
      if (total != null && !this.remember(st, `t:${total}`)) return;
      usage = info.last_token_usage;
    }
    if (!usage) return;
    const cached = usage.cached_input_tokens || 0;
    out.push({
      ...base, kind: EV.USAGE,
      backfill: this.isBackfill(st, ts) || undefined,
      usage: {
        model: st.meta.model || '',
        input: Math.max(0, (usage.input_tokens || 0) - cached), // Codex input includes cached tokens
        output: usage.output_tokens || 0,                         // includes reasoning tokens
        cacheRead: cached,
        cacheWrite: usage.cache_write_input_tokens || 0,
        contextWindow: st.meta.window || undefined,
      },
    });
  }
}

function codexLimits(r) {
  const w = (x) => x && { usedPercent: x.used_percent, windowMinutes: x.window_minutes, resetsAt: x.resets_at ? x.resets_at * 1000 : null };
  return { primary: w(r.primary), secondary: w(r.secondary), plan: r.plan_type || null, name: r.limit_name || null };
}
