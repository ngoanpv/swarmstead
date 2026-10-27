#!/usr/bin/env node
// swarmstead CLI
//
//   swarmstead [start] [--port 4317] [--open]   run the daemon + pixel UI
//   swarmstead install claude [--project]       add forwarding hooks to Claude Code
//   swarmstead uninstall claude [--project]
//   swarmstead install codex                    (beta) add hooks to ~/.codex/hooks.json
//   swarmstead uninstall codex
//   swarmstead doctor                           check that everything is wired up
//   swarmstead ping                             send a fake mini-session to a running daemon

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1] === '--port'));
const [cmd = 'start', target] = positional;

const c = { dim: (s) => `\x1b[2m${s}\x1b[0m`, green: (s) => `\x1b[32m${s}\x1b[0m`, yellow: (s) => `\x1b[33m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m`, red: (s) => `\x1b[31m${s}\x1b[0m` };

async function main() {
  switch (cmd) {
    case 'start': case 'serve': return start();
    case 'install': return install(target);
    case 'uninstall': return uninstall(target);
    case 'doctor': return doctor();
    case 'ping': return ping();
    case 'help': case '--help': case '-h': return help();
    default:
      console.error(c.red(`Unknown command: ${cmd}`));
      help();
      process.exitCode = 1;
  }
}

function help() {
  console.log(`
${c.bold('swarmstead')} — your coding agents, as a living pixel village

  swarmstead [start] [--port 4317] [--open]   run the daemon and open the village
  swarmstead install claude [--project] [--gate]  forward Claude Code hook events
                                                  (--gate: approve prompts from the village/phone + budget brake)
  swarmstead install git                          book commits in this repo (cost per commit)
  swarmstead uninstall claude [--project]
  swarmstead install codex                    (beta) forward Codex CLI hook events
  swarmstead uninstall codex
  swarmstead doctor                           check the setup
  swarmstead ping                             send a fake mini-session to the daemon

  Demo without any agent: start, then open  http://127.0.0.1:4317/web/?demo
`);
}

async function start() {
  const { startDaemon } = await import('../server/daemon.js');
  const port = Number(opt('port', process.env.SWARMSTEAD_PORT || 4317));
  let d;
  try {
    d = await startDaemon({ port, ...(flag('lan') ? { lan: true } : {}) });
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      console.error(c.yellow(`Port ${port} is busy — is Swarmstead already running? Try --port 4318`));
      process.exitCode = 1; return;
    }
    throw err;
  }
  const { installClaudeHint } = await hints();
  console.log(`
  ${c.bold('🏘  Swarmstead')} is running at ${c.green(d.url + '/web/')}
  ${c.dim(`demo mode: ${d.url}/web/?demo`)}${d.cfg.lan ? `\n  ${c.yellow('LAN mode')}: on your phone open ${c.bold(`http://<this-computer-ip>:${d.cfg.port}/web/?t=${d.token}`)}` : ''}
  ${c.dim(`picked up ${d.booted.claude} Claude transcript(s), ${d.booted.codex} Codex rollout(s) from today`)}
${installClaudeHint}`);
  if (flag('open')) openBrowser(`${d.url}/web/`);
  const stop = async () => { await d.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

async function hints() {
  const { claudeInstalled } = await import('../server/install.js');
  const pluginDir = path.join(os.homedir(), '.claude', 'plugins');
  const viaPlugin = fs.existsSync(pluginDir) && JSON.stringify(safeList(pluginDir)).includes('swarmstead');
  const ok = claudeInstalled('user') || viaPlugin;
  return {
    installClaudeHint: ok ? '' : `\n  ${c.yellow('Claude Code hooks are not installed yet.')} Run: ${c.bold('npx swarmstead install claude')}\n`,
  };
}

function safeList(dir) { try { return fs.readdirSync(dir); } catch { return []; } }

async function install(what) {
  const m = await import('../server/install.js');
  if (what === 'claude') {
    const { loadConfig } = await import('../server/config.js');
    const g = loadConfig().gate;
    const r = m.installClaude({ scope: flag('project') ? 'project' : 'user', gate: flag('gate'), waitSec: Math.max(g.waitSubSec, g.waitMainSec) });
    console.log(`${c.green('✓')} Added ${r.events} async hooks to ${r.file}`);
    if (r.gate) {
      console.log(`${c.green('✓')} Added the gate (remote approvals + budget brake). It fails open: if Swarmstead isn't running, nothing changes.`);
      console.log(c.dim(`  Subagent prompts wait up to ${g.waitSubSec}s for your answer; main-session prompts wait ${g.waitMainSec}s (change "gate" in ~/.swarmstead/config.json).`));
    }
    console.log(c.dim('  A backup was saved next to it (*.swarmstead.bak). New Claude Code sessions will show up in the village.'));
  } else if (what === 'git') {
    const r = m.installGit({ cwd: process.cwd() });
    console.log(`${c.green('✓')} Added a post-commit hook: ${r.file}`);
    if (r.shared) {
      console.log(c.yellow(`  git's core.hooksPath puts this folder outside the repo: every repo that uses ${path.dirname(r.file)} now books its commits.`));
      console.log(c.yellow('  To undo: swarmstead uninstall git'));
    } else console.log(c.dim('  Each commit in this repo now books the agent cost spent since the previous one.'));
  } else if (what === 'codex') {
    const r = m.installCodex();
    console.log(`${c.green('✓')} Added ${r.events} hooks to ${r.file}  ${c.yellow('(beta)')}`);
    console.log(c.yellow('  Codex only runs hooks you have trusted: open Codex, run /hooks and trust the swarmstead entries.'));
  } else {
    console.error('Usage: swarmstead install <claude|codex> [--project]');
    process.exitCode = 1;
  }
}

async function uninstall(what) {
  const m = await import('../server/install.js');
  if (what === 'git') {
    const r = m.uninstallGit({ cwd: process.cwd() });
    console.log(r.removed ? `${c.green('✓')} Removed the Swarmstead line from ${r.file}` : 'Nothing to remove.');
    return;
  }
  if (what === 'claude') {
    const r = m.uninstallClaude({ scope: flag('project') ? 'project' : 'user' });
    console.log(r.removed ? `${c.green('✓')} Removed Swarmstead hooks from ${r.file}` : `Nothing to remove in ${r.file}`);
  } else if (what === 'codex') {
    const r = m.uninstallCodex();
    console.log(r.removed ? `${c.green('✓')} Removed Swarmstead hooks from ${r.file}` : `Nothing to remove in ${r.file}`);
  } else {
    console.error('Usage: swarmstead uninstall <claude|codex>');
    process.exitCode = 1;
  }
}

async function doctor() {
  const m = await import('../server/install.js');
  const port = Number(opt('port', process.env.SWARMSTEAD_PORT || 4317));
  const line = (ok, text) => console.log(`${ok ? c.green('✓') : c.yellow('•')} ${text}`);
  const [major] = process.versions.node.split('.').map(Number);
  line(major >= 18, `Node ${process.versions.node} ${major >= 18 ? '' : '(need 18+)'}`);
  line(fs.existsSync(m.HOOK_SCRIPT), `hook script at ${m.HOOK_SCRIPT}`);
  line(m.claudeInstalled('user') || m.claudeInstalled('project'), 'Claude Code hooks installed (or use the plugin)');
  line(fs.existsSync(path.join(os.homedir(), '.claude', 'projects')), 'Claude Code transcripts folder exists');
  line(fs.existsSync(m.codexHooksPath()), `Codex hooks file (${m.codexHooksPath()}) — optional`);
  const health = await get(`http://127.0.0.1:${port}/api/health`).catch(() => null);
  line(!!health, health ? `daemon running on :${port} (${health.clients} viewer(s))` : `daemon not running on :${port} — run: swarmstead start`);
}

async function ping() {
  const port = Number(opt('port', process.env.SWARMSTEAD_PORT || 4317));
  const sid = 'ping-' + Date.now().toString(36);
  const cwd = path.join(os.tmpdir(), 'village-ping');
  const steps = [
    { hook_event_name: 'SessionStart', source: 'startup' },
    { hook_event_name: 'UserPromptSubmit', prompt: '(ping)' },
    { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 't1', tool_input: { file_path: cwd + '/README.md' } },
    { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: 't1', tool_input: { file_path: cwd + '/README.md' }, tool_response: {} },
    { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_use_id: 't2', tool_input: { file_path: cwd + '/hello.js' } },
    { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_use_id: 't2', tool_input: { file_path: cwd + '/hello.js' }, tool_response: {} },
    { hook_event_name: 'Stop' },
  ];
  for (const s of steps) {
    await post(`http://127.0.0.1:${port}/api/hook/claude`, { session_id: sid, cwd, transcript_path: '', ...s, _ss_ts: Date.now() });
    await new Promise((r) => setTimeout(r, 700));
  }
  console.log(`${c.green('✓')} Sent a fake session "${sid}" — look for a new villager in the "village-ping" project.`);
}

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, { timeout: 1000 }, (res) => {
      let d = ''; res.on('data', (x) => (d += x)); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout')); });
  });
}

function post(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => { res.resume(); res.on('end', resolve); });
    req.on('error', reject);
    req.end(data);
  });
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const a = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  execFile(cmd, a, () => {});
}

main().catch((err) => { console.error(c.red(err.stack || err.message)); process.exitCode = 1; });
