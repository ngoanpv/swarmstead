// Claude Code hook payload  ->  normalized events.
// Reference: https://code.claude.com/docs/en/hooks
//
// Notes on the payloads we rely on:
//  - Every payload has session_id, transcript_path, cwd, hook_event_name; most
//    carry permission_mode, and effort.level.
//  - Inside a subagent, payloads also carry agent_id + agent_type, so tool calls
//    are attributed to the right character. A subagent that spawns its own
//    subagent is linked to it (nested delegation), not flattened to the session.
//  - Hook payloads carry no token usage; that comes from the transcript tailer.

import { EV, claimsPassing } from '../../core/schema.js';
import { oneLine } from '../../core/util.js';
import { summarizeTool, responseFailed } from './summarize.js';

const count = (v) => Array.isArray(v) ? v.length
  : v && typeof v === 'object' ? (Array.isArray(v.tasks) ? v.tasks.length : Object.keys(v).length)
  : Number.isFinite(v) ? v : 0;

export class ClaudeHookAdapter {
  constructor({ capture = 'summary', provider = 'claude' } = {}) {
    this.capture = capture;
    this.provider = provider;
    this.pendingSpawns = new Map(); // sessionId -> [{agentType, detail, toolUseId, parent, ts}]
    this.parents = new Map();       // our agent id -> parent agent id (for nested subagents)
    this.workflows = new Map();     // sessionId -> { runId, name } of the workflow in flight
    this.runOf = new Map();         // our agent id -> workflow runId (from transcript paths)
    this.teammates = new Map();     // our agent id -> { name, team } (agent-team teammates)
  }

  /** Register teammates from ~/.claude/teams/<team>/config.json. */
  registerTeam(config, team) {
    const lead = config?.leadSessionId;
    if (!lead || !Array.isArray(config.members)) return;
    for (const m of config.members) {
      if (!m?.agentId || m.agentType === 'team-lead') continue;
      this.teammates.set(`${lead}:${m.agentId}`, { name: m.name || m.agentId, team });
    }
  }

  agentIdFor(p) {
    return p.agent_id ? `${p.session_id}:${p.agent_id}` : p.session_id;
  }

  /** @returns {object[]} normalized events (possibly empty) */
  translate(p, ts = Date.now()) {
    if (!p || typeof p !== 'object' || !p.session_id || !p.hook_event_name) return [];
    const agentId = this.agentIdFor(p);
    const base = { v: 1, ts, provider: this.provider, sessionId: p.session_id, agentId, cwd: p.cwd || '' };
    if (p.agent_id) {
      base.parentId = this.parents.get(agentId) || p.session_id;
      base.agentType = p.agent_type || 'subagent';
    }
    if (p.permission_mode) base.mode = p.permission_mode;
    const effort = p.effort?.level ?? (typeof p.effort === 'string' ? p.effort : undefined);
    if (effort) base.effort = effort;
    // Optional workflow / team context, when the payload provides it.
    const wf = p.workflow_id || p.workflow_name || p.workflow?.id || p.workflow?.name;
    if (wf) base.workflow = String(wf);
    const stage = p.stage || p.workflow_stage || p.workflow?.stage || p.phase;
    if (stage) base.stage = String(stage);
    if (p.team_name) base.team = String(p.team_name);
    if (p.teammate_name) base.teammate = String(p.teammate_name);
    if (p.agent_id && p.teammate_name) this.teammates.set(agentId, { name: String(p.teammate_name), team: p.team_name || this.teammates.get(agentId)?.team || `session-${String(p.session_id).slice(0, 8)}` });
    const mate = this.teammates.get(agentId);
    if (mate) { base.teammate = mate.name; base.team = mate.team; }
    const ev = (kind, extra = {}) => ({ ...base, kind, ...extra });

    switch (p.hook_event_name) {
      case 'SessionStart':
        return [ev(EV.SESSION_START, { reason: p.source || '', model: typeof p.model === 'string' ? p.model : p.model?.id })];
      case 'SessionEnd':
        return [ev(EV.SESSION_END, { reason: p.reason || '' })];
      case 'UserPromptSubmit':
        return [ev(EV.PROMPT)];

      case 'PreToolUse': {
        const s = summarizeTool(p.tool_name, p.tool_input, this.capture);
        if (s.agentType) {
          const list = this.pendingSpawns.get(p.session_id) || [];
          list.push({ agentType: s.agentType, detail: s.detail, toolUseId: p.tool_use_id, parent: agentId, ts });
          this.pendingSpawns.set(p.session_id, list.slice(-50));
        }
        return [ev(EV.TOOL_START, {
          tool: p.tool_name, toolUseId: p.tool_use_id, category: s.category,
          detail: s.detail, file: s.file, command: s.command, inputHash: s.inputHash,
        })];
      }
      case 'PostToolUse': {
        const s = summarizeTool(p.tool_name, p.tool_input, this.capture);
        if (p.tool_name === 'Workflow') {
          const r = typeof p.tool_response === 'object' && p.tool_response ? p.tool_response : {};
          const runId = r.runId || r.run_id;
          const name = r.workflowName || r.workflow_name || r.title || runId;
          if (runId || name) this.workflows.set(p.session_id, { runId, name: String(name || 'workflow') });
        }
        const err = responseFailed(p.tool_response);
        return [ev(EV.TOOL_END, {
          tool: p.tool_name, toolUseId: p.tool_use_id, category: s.category, file: s.file,
          command: s.command, ok: !err, error: err || undefined, durationMs: p.duration_ms,
        })];
      }
      case 'PostToolUseFailure': {
        const s = summarizeTool(p.tool_name, p.tool_input, this.capture);
        return [ev(EV.TOOL_END, {
          tool: p.tool_name, toolUseId: p.tool_use_id, category: s.category, file: s.file, command: s.command,
          ok: !!p.is_interrupt, error: p.is_interrupt ? undefined : oneLine(p.error || 'failed', 300),
        })];
      }
      case 'PermissionRequest': {
        const s = summarizeTool(p.tool_name, p.tool_input, this.capture);
        return [ev(EV.PERMISSION, { tool: p.tool_name, detail: s.detail })];
      }
      case 'PermissionDenied':
        return [ev(EV.TOOL_END, { tool: p.tool_name, toolUseId: p.tool_use_id, ok: false, denied: true, error: oneLine(`permission denied: ${p.reason || ''}`, 200) })];

      case 'Notification': {
        const type = p.notification_type || '';
        if (type === 'permission_prompt') return [ev(EV.PERMISSION, { detail: oneLine(p.message, 80) })];
        if (type === 'idle_prompt' || type === 'agent_needs_input') return [ev(EV.WAITING)];
        if (type.startsWith('elicitation')) return type === 'elicitation_dialog' || type === 'elicitation_url_dialog' ? [ev(EV.WAITING, { detail: 'MCP asks for input' })] : [];
        if (type.startsWith('quota_')) return [ev(EV.NOTICE, { text: `quota: ${type.replace('quota_', '').replace(/_/g, ' ')}`, level: type.endsWith('fired') ? 'good' : 'warn' })];
        return [];
      }
      case 'Elicitation':
        return [ev(EV.WAITING, { detail: 'MCP asks for input' })];
      case 'ElicitationResult':
        return [ev(EV.NOTICE, { text: 'MCP input answered' })];

      case 'Stop':
        return [ev(EV.TURN_END, { background: count(p.background_tasks), crons: count(p.session_crons), claims: claimsPassing(p.last_assistant_message) || undefined })];
      case 'StopFailure':
        return [ev(EV.TURN_END, { reason: String(p.error || 'error') })];

      case 'SubagentStart': {
        // Teammates fire SubagentStart for every message they handle: that's a handoff, not a new villager.
        if (this.teammates.has(agentId)) return [ev(EV.TEAM, { action: 'assign', parentId: p.session_id })];
        const list = this.pendingSpawns.get(p.session_id) || [];
        const i = list.findIndex((x) => x.agentType === p.agent_type);
        const spawn = i >= 0 ? list.splice(i, 1)[0] : null;
        const parentId = spawn?.parent && spawn.parent !== agentId ? spawn.parent : p.session_id;
        this.parents.set(agentId, parentId);
        if (this.parents.size > 5000) this.parents.delete(this.parents.keys().next().value);
        // Workflow agents are not spawned through the Agent tool; they belong to the run in flight.
        const wf = !spawn && (p.agent_type === 'workflow-subagent' || this.workflows.has(p.session_id)) ? this.workflows.get(p.session_id) : null;
        const extra = wf ? { workflow: wf.name || wf.runId || 'workflow' } : (p.agent_type === 'workflow-subagent' ? { workflow: 'workflow' } : {});
        return [ev(EV.SUBAGENT_START, { parentId, detail: spawn?.detail || '', ...extra })];
      }
      case 'SubagentStop': {
        const m = String(p.agent_transcript_path || '').match(/subagents[\\/]workflows[\\/](wf_[^\\/]+)/);
        if (m) this.runOf.set(agentId, m[1]);
        const claims = claimsPassing(p.last_assistant_message) || undefined;
        if (this.teammates.has(agentId)) return [ev(EV.TEAM, { action: 'report', claims })];
        return [ev(EV.SUBAGENT_END, { background: count(p.background_tasks), claims })];
      }

      case 'TeammateIdle':
        return p.agent_id ? [] : [ev(EV.WAITING, { detail: 'teammate idle' })];
      case 'TaskCreated':
        return [ev(EV.TEAM, { action: 'task.created', subject: oneLine(p.task_subject || p.subject || p.task?.subject || '', 60), team: base.team })];
      case 'TaskCompleted':
        return [ev(EV.TEAM, { action: 'task.completed', subject: oneLine(p.task_subject || p.subject || p.task?.subject || '', 60), team: base.team })];

      case 'PreCompact':
        return [ev(EV.COMPACT, { reason: p.trigger || 'auto' })];
      case 'PostCompact':
        return [ev(EV.COMPACT_END, { reason: p.trigger || 'auto' })];

      case 'PostModelSwitch':
        return [ev(EV.MODEL_SWITCH, { from: p.from_model || '', to: p.to_model || '' })];

      // NOTE: we never register WorktreeCreate/WorktreeRemove — a WorktreeCreate hook REPLACES
      // Claude Code's own git-worktree creation. Worktrees are recognised from cwd paths instead.
      case 'CwdChanged':
        return [ev(EV.WORKTREE, { action: 'cwd', path: p.new_cwd || p.cwd || '' })];

      default:
        return [];
    }
  }
}

/** The hook events we register for. Each one spawns a tiny async process. */
export const CLAUDE_HOOK_EVENTS = [
  'SessionStart', 'SessionEnd', 'UserPromptSubmit',
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'PermissionRequest', 'PermissionDenied', 'Notification',
  'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop',
  'PreCompact', 'PostCompact', 'TeammateIdle', 'TaskCreated', 'TaskCompleted',
  'PostModelSwitch', 'CwdChanged', 'Elicitation', 'ElicitationResult',
];

/** Hook events we must NEVER register: they change Claude Code's behaviour when present. */
export const NEVER_REGISTER = ['WorktreeCreate', 'WorktreeRemove', 'PreModelSwitch'];
