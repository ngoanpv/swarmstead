#!/usr/bin/env node
// Open the village in the browser, starting the daemon first if it isn't running.
// Used by the plugin's /village command. Unlike the hooks, this one talks: its output
// is what the user sees.
//
// Usage: node swarmstead-open.mjs [swarmstead@<version>]
// Env:   SWARMSTEAD_URL (default http://127.0.0.1:4317), SWARMSTEAD_HOME

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const base = new URL(process.env.SWARMSTEAD_URL || 'http://127.0.0.1:4317');
const village = new URL('/web/', base).href;
const HOME = process.env.SWARMSTEAD_HOME || path.join(os.homedir(), '.swarmstead');
const log = path.join(HOME, 'daemon.log');
const autostart = (() => { try { return JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8')).autostart !== false; } catch { return true; } })();

function healthy() {
  return new Promise((resolve) => {
    http.get(new URL('/api/health', base), { timeout: 800 }, (res) => { res.resume(); resolve(res.statusCode === 200); })
      .on('error', () => resolve(false))
      .on('timeout', function () { this.destroy(); });
  });
}

function openBrowser(url) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : ['xdg-open', [url]];
  execFile(cmd, args, () => {});
}

if (!(await healthy())) {
  if (!autostart) {
    console.log(`The village isn't running, and "autostart" is off in ${path.join(HOME, 'config.json')}. Start it with: npx swarmstead start --open`);
    process.exit(0);
  }
  // swarmstead-up.mjs knows how to start the daemon (source checkout, plugin or npx copy)
  spawn(process.execPath, [path.join(HERE, 'swarmstead-up.mjs'), ...process.argv.slice(2)], { stdio: 'ignore' }).on('error', () => {});
  let up = false;
  for (let i = 0; i < 40 && !up; i++) { await new Promise((r) => setTimeout(r, 500)); up = await healthy(); }
  if (!up) {
    console.log(`The village is still starting. Open ${village} in a few seconds (log: ${log}).`);
    process.exit(0);
  }
}
openBrowser(village);
console.log(`🏘 Opened the village: ${village}`);
