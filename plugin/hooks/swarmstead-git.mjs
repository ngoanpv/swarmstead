#!/usr/bin/env node
// Swarmstead git hook (install with `swarmstead install git` inside a repo).
// Tells the daemon "a commit happened in this repo", so the cost spent since
// the previous commit is booked against it — whoever made the commit.
// Sends only the repo path and the commit hash. Never blocks, never prints.

import http from 'node:http';
import { execFileSync } from 'node:child_process';

const action = process.argv[2] || 'commit';
const base = process.env.SWARMSTEAD_URL || 'http://127.0.0.1:4317';
let sha = '', cwd = process.cwd();
try {
  sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 2000 }).trim();
  cwd = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 2000 }).trim() || cwd;
} catch { /* not fatal */ }
const body = JSON.stringify({ action, sha, cwd });
try {
  const req = http.request(new URL('/api/git', base), {
    method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }, timeout: 800,
  }, (res) => { res.resume(); res.on('end', () => process.exit(0)); });
  req.on('timeout', () => { req.destroy(); process.exit(0); });
  req.on('error', () => process.exit(0));
  req.end(body);
} catch { process.exit(0); }
setTimeout(() => process.exit(0), 1500).unref?.();
