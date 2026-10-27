// Claude Code hook payload  ->  normalized events.
// Reference: https://code.claude.com/docs/en/hooks
//
// Notes on the payloads we rely on:
//  - Every payload has session_id, transcript_path, cwd, hook_event_name.
//  - Inside a subagent, payloads also carry agent_id + agent_type, so tool calls
//    are attributed to the right character.
//  - Hook payloads carry no token usage; that comes from the transcript tailer.

import { EV } from '../../core/schema.js';
import { oneLine } from '../../core/util.js';
import { summarizeTool, responseFailed } from './summarize.js';

export class ClaudeHookAdapter {
  constructor({ capture = 'summary', provider = 'claude' } = {}) {
    this.capture = capture;
    this.provider = provider;
    this.pendingSpawns = new Map(); // sessionId -> [{agentType, detail, toolUseId, ts}]
  }

  agentIdFor(p) {
    return p.agent_id ? `${p.session_id}:${p.agent_id}` : p.session_id;
  }

  /** @returns {object[]} normalized events (possibly empty) */
  translate(p, ts = Date.now()) {
    if (!p || typeof p !== 'object' || !p.session_id || !p.hook_event_name) return [];
    const base = {
      v: 1, ts, provider: this.provider,
      sessionId: p.session_id,
      agentId: this.agentIdFor(p),
      cwd: p.cwd || '',
    };
    if (p.agent_id) {
      base.parentId = p.session_id;
      base.agentType = p.agent_type || 'subagent';
    }
    const ev = (kind, extra = {}) => ({ ...base, kind, ...extra });

    switch (p.hook_event_name) {
      case 'SessionStart':
        return [ev(EV.SESSION_START, { reason: p.source || '' })];
      case 'SessionEnd':
        return [ev(EV.SESSION_END, { reason: p.reason || '' })];
      case 'UserPromptSubmit':
        return [ev(EV.PROMPT)];

      case 'PreToolUse': {
        const s = summarizeTool(p.tool_name, p.tool_input, this.capture);
        if (s.agentType) {
          const list = this.pendingSpawns.get(p.session_id) || [];
          list.push({ agentType: s.agentType, detail: s.detail, toolUseId: p.tool_use_id, ts });
          this.pendingSpawns.set(p.session_id, list.slice(-20));
        }
        return [ev(EV.TOOL_START, {
          tool: p.tool_name, toolUseId: p.tool_use_id, category: s.category,
          detail: s.detail, file: s.file, command: s.command, inputHash: s.inputHash,
        })];
      }
      case 'PostToolUse': {
        const s = summarizeTool(p.tool_name, p.tool_input, this.capture);
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
        return [ev(EV.TOOL_END, { tool: p.tool_name, toolUseId: p.tool_use_id, ok: false, error: oneLine(`permission denied: ${p.reason || ''}`, 200) })];

      case 'Notification':
        if (p.notification_type === 'permission_prompt') return [ev(EV.PERMISSION, { detail: oneLine(p.message, 80) })];
        if (p.notification_type === 'idle_prompt' || p.notification_type === 'agent_needs_input'
            || p.notification_type === 'elicitation_dialog') return [ev(EV.WAITING)];
        return [];

      case 'Stop':
        return [ev(EV.TURN_END)];
      case 'StopFailure':
        return [ev(EV.TURN_END, { reason: p.error || 'error' })];

      case 'SubagentStart': {
        const list = this.pendingSpawns.get(p.session_id) || [];
        const i = list.findIndex((x) => x.agentType === p.agent_type);
        const spawn = i >= 0 ? list.splice(i, 1)[0] : null;
        return [ev(EV.SUBAGENT_START, { detail: spawn?.detail || '' })];
      }
      case 'SubagentStop':
        return [ev(EV.SUBAGENT_END)];

      case 'TeammateIdle':
        return [ev(EV.WAITING)];

      case 'PreCompact':
        return [ev(EV.COMPACT, { reason: p.trigger || 'auto' })];
      case 'PostCompact':
        return [ev(EV.COMPACT_END, { reason: p.trigger || 'auto' })];

      default:
        return [];
    }
  }
}

/** The hook events we register for. Kept small on purpose: each one spawns a tiny process. */
export const CLAUDE_HOOK_EVENTS = [
  'SessionStart', 'SessionEnd', 'UserPromptSubmit',
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'PermissionRequest', 'PermissionDenied', 'Notification',
  'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop',
  'PreCompact', 'PostCompact', 'TeammateIdle',
];
