#!/usr/bin/env node
// Swarmstead gate — OPT-IN synchronous hook (install with `swarmstead install claude --gate`).
//
//   PermissionRequest: asks the daemon whether you approved / denied the prompt
//                      from the village or your phone. No answer -> prints nothing,
//                      and Claude Code continues exactly as it would without us.
//   PreToolUse (Agent|Task|Workflow): the budget brake. If you set a daily or
//                      per-run budget and enabled "brakes", new subagents are
//                      refused with a reason Claude can read.
//
// Fails open: daemon not running, timeout, bad response -> no output, exit 0.

import http from 'node:http';

const base = process.env.SWARMSTEAD_URL || 'http://127.0.0.1:4317';
const MAX = 2 * 1024 * 1024;
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { if (raw.length < MAX) raw += c; });
process.stdin.on('error', () => process.exit(0));
process.stdin.on('end', () => {
  let payload;
  try { payload = JSON.parse(raw); } catch { return process.exit(0); }
  const event = payload.hook_event_name;
  const route = event === 'PermissionRequest' ? 'permission' : event === 'PreToolUse' ? 'pretool' : null;
  if (!route) return process.exit(0);
  const body = JSON.stringify(payload);
  let url;
  try { url = new URL(`/api/gate/${route}`, base); } catch { return process.exit(0); }
  // the daemon tells us how long it may hold the request; cap it hard anyway
  const req = http.request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    timeout: route === 'permission' ? 15 * 60_000 : 3000,
  }, (res) => {
    let out = '';
    res.setEncoding('utf8');
    res.on('data', (c) => { out += c; });
    res.on('end', () => {
      try {
        const r = JSON.parse(out);
        if (route === 'permission' && r.decision) {
          process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: r.decision } }));
        }
        if (route === 'pretool' && r.deny) {
          process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: r.deny } }));
        }
      } catch { /* fail open */ }
      process.exit(0);
    });
  });
  req.on('timeout', () => { req.destroy(); process.exit(0); });
  req.on('error', () => process.exit(0));
  req.end(body);
});
