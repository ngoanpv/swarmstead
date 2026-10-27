// Remote approvals: answer Claude Code permission prompts from the village or
// your phone.
//
// The opt-in gate hook (plugin/hooks/swarmstead-gate.mjs) is a *synchronous*
// PermissionRequest hook. It asks the daemon, which parks the request here
// until someone decides or the wait runs out. No decision means "do nothing":
// Claude Code then shows its normal prompt (or, for a background subagent that
// cannot prompt, applies its usual rule).

import crypto from 'node:crypto';
import { summarizeTool } from './adapters/summarize.js';

export class Approvals {
  constructor({ onChange = () => {} } = {}) {
    this.pending = new Map(); // id -> { view, resolve, timer }
    this.recent = [];         // last decisions, for the UI
    this.onChange = onChange;
  }

  /**
   * Park a permission request. Resolves to a Claude Code `decision` object, or
   * null when nobody answered in time.
   */
  request(payload, { waitMs, agentId, label = '' }) {
    const id = crypto.randomBytes(6).toString('hex');
    const s = summarizeTool(payload.tool_name, payload.tool_input, 'summary');
    const view = {
      id, sessionId: payload.session_id, agentId, label, sub: !!payload.agent_id,
      tool: payload.tool_name || 'tool', detail: s.detail || s.command || '', cwd: payload.cwd || '',
      created: Date.now(), expires: Date.now() + waitMs,
      canRemember: Array.isArray(payload.permission_suggestions) && payload.permission_suggestions.length > 0,
    };
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.finish(id, null, 'timeout'), waitMs);
      this.pending.set(id, { view, resolve, timer, suggestions: payload.permission_suggestions || [] });
      this.onChange(this.list(), view);
    });
  }

  /** decision: 'allow' | 'allow-session' | 'deny' */
  decide(id, decision, by = 'village') {
    const p = this.pending.get(id);
    if (!p) return false;
    let out = null;
    if (decision === 'allow') out = { behavior: 'allow' };
    if (decision === 'allow-session') {
      out = { behavior: 'allow' };
      // Echo Claude Code's own suggestion ("don't ask again for …"), but only for this session.
      const updates = p.suggestions.map((u) => ({ ...u, destination: 'session' }));
      if (updates.length) out.updatedPermissions = updates;
    }
    if (decision === 'deny') out = { behavior: 'deny', message: `Denied by the user from Swarmstead (${by}).` };
    if (!out) return false;
    this.finish(id, out, `${decision} via ${by}`);
    return true;
  }

  finish(id, decision, how) {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id);
    this.recent.push({ ...p.view, decided: Date.now(), how, decision: decision?.behavior || 'none' });
    if (this.recent.length > 20) this.recent.shift();
    p.resolve(decision);
    this.onChange(this.list(), null);
  }

  list() {
    return { pending: [...this.pending.values()].map((p) => p.view), recent: this.recent.slice(-8) };
  }

  cancelAll() {
    for (const id of [...this.pending.keys()]) this.finish(id, null, 'shutdown');
  }
}
