// Push notifications, all opt-in (~/.swarmstead/config.json → "notify"):
//
//   "notify": {
//     "desktop": true,                                  // macOS / Linux notification
//     "ntfy": "https://ntfy.sh/<a-long-secret-topic>",  // phone push via the ntfy app
//     "webhook": "https://hooks.slack.com/services/…",  // Slack / Discord / anything that takes JSON
//     "publicUrl": "http://192.168.1.20:4317"           // where your phone can reach the daemon (--lan)
//   }
//
// With ntfy + publicUrl (+ --lan), approval pushes carry Approve / Deny
// buttons that work from the lock screen.

import { execFile } from 'node:child_process';

export class Notifier {
  constructor(cfg = {}, { token = '' } = {}) {
    this.cfg = cfg || {};
    this.token = token;
    this.last = new Map();
  }

  get enabled() { return !!(this.cfg.ntfy || this.cfg.webhook || this.cfg.desktop); }

  link(hash = '') {
    if (!this.cfg.publicUrl) return null;
    return `${this.cfg.publicUrl.replace(/\/$/, '')}/web/?t=${encodeURIComponent(this.token)}${hash}`;
  }

  /** kind: 'approval' | 'alert'. Rate-limited per key so nothing spams you. */
  async send(kind, { key, title, text, approvalId = null, priority = 'default' }) {
    const now = Date.now();
    if (kind !== 'approval' && now - (this.last.get(key) || 0) < 60_000) return;
    this.last.set(key, now);
    const jobs = [];
    if (this.cfg.desktop) jobs.push(this.desktop(title, text));
    if (this.cfg.ntfy) jobs.push(this.ntfy(title, text, approvalId, priority));
    if (this.cfg.webhook) jobs.push(this.webhook(title, text));
    await Promise.allSettled(jobs);
  }

  desktop(title, text) {
    return new Promise((resolve) => {
      if (process.platform === 'darwin') execFile('osascript', ['-e', `display notification ${JSON.stringify(text)} with title ${JSON.stringify(title)}`], () => resolve());
      else if (process.platform === 'linux') execFile('notify-send', [title, text], () => resolve());
      else resolve();
    });
  }

  async ntfy(title, text, approvalId, priority) {
    const headers = { Title: ascii(title), Priority: priority, Tags: approvalId ? 'raising_hand' : 'warning' };
    const click = this.link(approvalId ? '#approvals' : '');
    if (click) headers.Click = click;
    if (approvalId && this.cfg.publicUrl) {
      const base = `${this.cfg.publicUrl.replace(/\/$/, '')}/api/approvals/${approvalId}?t=${encodeURIComponent(this.token)}`;
      headers.Actions = `http, Approve, ${base}&d=allow, method=POST, clear=true; http, Deny, ${base}&d=deny, method=POST, clear=true`;
    }
    await fetch(this.cfg.ntfy, { method: 'POST', headers, body: text, signal: AbortSignal.timeout(5000) });
  }

  async webhook(title, text) {
    const body = JSON.stringify({ text: `*${title}*\n${text}`, content: `**${title}**\n${text}` });
    await fetch(this.cfg.webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(5000) });
  }
}

/** HTTP headers must be latin-1; strip what can't travel. */
function ascii(s) { return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7e]/g, ''); }
