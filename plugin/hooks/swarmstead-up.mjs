#!/usr/bin/env node
// Swarmstead autostart, run by the plugin on SessionStart.
//
// If no daemon answers, start one in the background and exit. Same contract as
// swarmstead-hook.mjs: always exit 0, never print, never wait for the daemon.
//   - plugin loaded from a source checkout (bin/ next to plugin/): run that copy
//   - plugin installed from a marketplace: run the npm package of the same version
// Turn it off with "autostart": false in ~/.swarmstead/config.json.
//
// Env: SWARMSTEAD_URL (default http://127.0.0.1:4317), SWARMSTEAD_HOME

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = process.env.SWARMSTEAD_HOME || path.join(os.homedir(), '.swarmstead');
const base = new URL(process.env.SWARMSTEAD_URL || 'http://127.0.0.1:4317');
const LOCAL = new Set(['127.0.0.1', 'localhost', '[::1]']);

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };

function healthy() {
  return new Promise((resolve) => {
    http.get(new URL('/api/health', base), { timeout: 800 }, (res) => { res.resume(); resolve(res.statusCode === 200); })
      .on('error', () => resolve(false))
      .on('timeout', function () { this.destroy(); });
  });
}

function launcher() {
  const cli = path.join(PLUGIN, '..', 'bin', 'swarmstead.js');
  if (fs.existsSync(cli)) return { cmd: process.execPath, args: [cli] };
  const { version } = readJson(path.join(PLUGIN, '.claude-plugin', 'plugin.json'));
  const args = ['-y', version ? `swarmstead@${version}` : 'swarmstead'];
  if (process.platform === 'win32') return { cmd: 'npx', args, shell: true };
  const npx = path.join(path.dirname(process.execPath), 'npx');
  return { cmd: fs.existsSync(npx) ? npx : 'npx', args };
}

async function main() {
  if (readJson(path.join(HOME, 'config.json')).autostart === false) return;
  if (!LOCAL.has(base.hostname)) return; // a daemon on another machine isn't ours to start
  if (await healthy()) return;
  fs.mkdirSync(HOME, { recursive: true });
  const lock = path.join(HOME, 'autostart.lock');
  try { if (Date.now() - fs.statSync(lock).mtimeMs < 30_000) return; } catch {} // another session is starting it
  const { cmd, args, shell } = launcher();
  const log = fs.openSync(path.join(HOME, 'daemon.log'), 'a');
  const child = spawn(cmd, [...args, 'start', '--port', base.port || '80'], { detached: true, stdio: ['ignore', log, log], shell, windowsHide: true });
  child.on('error', () => {});
  fs.writeFileSync(lock, String(child.pid || ''));
  child.unref();
}

main().catch(() => {}).finally(() => process.exit(0));
