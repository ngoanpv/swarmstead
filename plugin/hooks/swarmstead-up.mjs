#!/usr/bin/env node
// Swarmstead autostart, run on SessionStart by the plugin and by `swarmstead install codex`.
//
// If no daemon answers, start one in the background and exit. Same contract as
// swarmstead-hook.mjs: always exit 0, never wait for the daemon, and print nothing,
// except that with --say (the plugin) it prints one JSON systemMessage: a line for the
// user with the village's address. Claude Code shows that line and doesn't add it to
// Claude's context; it only does so for a synchronous hook, so the plugin runs this one
// synchronously. "reminder": false turns the line off.
//   - plugin loaded from a source checkout (bin/ next to plugin/): run that copy
//   - plugin installed from a marketplace: run the npm package of the same version
//   - copied to ~/.swarmstead/hooks by an npx install: run the package named in argv
// Turn it off with "autostart": false in ~/.swarmstead/config.json.
//
// Usage: node swarmstead-up.mjs [swarmstead@<version>] [--say]
// Env:   SWARMSTEAD_URL (default http://127.0.0.1:4317), SWARMSTEAD_HOME

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
const SPEC = process.argv.slice(2).find((a) => /^swarmstead@[\w.+-]+$/.test(a)) || null;
const SAY = process.argv.includes('--say');

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
  const args = ['-y', SPEC || (version ? `swarmstead@${version}` : 'swarmstead')];
  if (process.platform === 'win32') return { cmd: 'npx', args, shell: true };
  const npx = path.join(path.dirname(process.execPath), 'npx');
  return { cmd: fs.existsSync(npx) ? npx : 'npx', args };
}

function stdin() {
  if (process.stdin.isTTY) return Promise.resolve('');
  return new Promise((resolve) => {
    let d = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { d += c; }).on('end', () => resolve(d)).on('error', () => resolve(d));
    setTimeout(() => resolve(d), 1000);
  });
}

/** @returns {Promise<'running'|'starting'|'off'|'remote'>} */
async function start(cfg) {
  if (!LOCAL.has(base.hostname)) return 'remote'; // a daemon on another machine isn't ours to start
  if (await healthy()) return 'running';
  if (cfg.autostart === false) return 'off';
  fs.mkdirSync(HOME, { recursive: true });
  const lock = path.join(HOME, 'autostart.lock');
  try { if (Date.now() - fs.statSync(lock).mtimeMs < 30_000) return 'starting'; } catch {} // another session is starting it
  const { cmd, args, shell } = launcher();
  const log = fs.openSync(path.join(HOME, 'daemon.log'), 'a');
  // Run from our own folder: inside a project named "swarmstead" (this repo), npx
  // mistakes the project for the package and fails with "swarmstead: command not found".
  const child = spawn(cmd, [...args, 'start', '--port', base.port || '80'], { cwd: HOME, detached: true, stdio: ['ignore', log, log], shell, windowsHide: true });
  child.on('error', () => {});
  fs.writeFileSync(lock, String(child.pid || ''));
  child.unref();
  return 'starting';
}

async function main() {
  const cfg = readJson(path.join(HOME, 'config.json'));
  const state = await start(cfg);
  if (!SAY || cfg.reminder === false) return;
  let source;
  try { ({ source } = JSON.parse(await stdin())); } catch {}
  if (source === 'clear' || source === 'compact') return; // only when a session starts or resumes
  const village = new URL('/web/', base).href;
  const systemMessage = state === 'off'
    ? '🏘 Swarmstead isn\'t running ("autostart" is off). Start it with: npx swarmstead start --open'
    : `🏘 Swarmstead village: ${village} · /village opens it`;
  await new Promise((resolve) => process.stdout.write(JSON.stringify({ systemMessage }) + '\n', resolve));
}

main().catch(() => {}).finally(() => process.exit(0));
