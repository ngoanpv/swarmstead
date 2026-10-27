#!/usr/bin/env node
// Swarmstead hook forwarder.
//
// Claude Code / Codex run this for each hook event with the event JSON on
// stdin. We stamp the time, POST it to the local Swarmstead daemon and exit.
//
// Contract with the coding agent — this script must NEVER get in the way:
//   - always exit 0
//   - never print to stdout/stderr (stdout can be interpreted as a hook decision)
//   - give up quickly if the daemon is not running
//
// Usage: node swarmstead-hook.mjs <claude|codex>
// Env:   SWARMSTEAD_URL (default http://127.0.0.1:4317)

import http from 'node:http';

const provider = (process.argv[2] || 'claude').replace(/[^a-z]/g, '') || 'claude';
const base = process.env.SWARMSTEAD_URL || 'http://127.0.0.1:4317';
const stampedAt = Date.now();
const MAX = 2 * 1024 * 1024;

function done() { process.exit(0); }
setTimeout(done, 1500).unref?.(); // hard ceiling, whatever happens

let raw = '';
let size = 0;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { size += c.length; if (size <= MAX) raw += c; });
process.stdin.on('error', done);
process.stdin.on('end', () => {
  if (!raw.trim() || size > MAX) return done();
  let body;
  try {
    const payload = JSON.parse(raw);
    payload._ss_ts = stampedAt;
    body = JSON.stringify(payload);
  } catch { return done(); }
  let url;
  try { url = new URL(`/api/hook/${provider}`, base); } catch { return done(); }
  const req = http.request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    timeout: 800,
  }, (res) => { res.resume(); res.on('end', done); });
  req.on('timeout', () => { req.destroy(); done(); });
  req.on('error', done);
  req.end(body);
});
