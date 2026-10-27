#!/usr/bin/env node
// agent-village CLI
//
//   agent-village [start] [--port 4317] [--open]   run the daemon + pixel UI
//   agent-village install claude [--project]       add forwarding hooks to Claude Code
//   agent-village uninstall claude [--project]
//   agent-village install codex                    (beta) add hooks to ~/.codex/hooks.json
//   agent-village uninstall codex
//   agent-village doctor                           check that everything is wired up
//   agent-village ping                             send a fake mini-session to a running daemon

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
${c.bold('agent-village')} — your coding agents, as a living pixel village

  agent-village [start] [--port 4317] [--open]   run the daemon and open the village
  agent-village install claude [--project]       forward Claude Code hook events
  agent-village uninstall claude [--project]
  agent-village install codex                    (beta) forward Codex CLI hook events
  agent-village uninstall codex
  agent-village doctor                           check the setup
  agent-village ping                             send a fake mini-session to the daemon

  Demo without any agent: start, then open  http://127.0.0.1:4317/web/?demo
`);
}

async function start() {
  const { startDaemon } = await import('../server/daemon.js');
  const port = Number(opt('port', process.env.AGENT_VILLAGE_PORT || 4317));
  let d;
  try {
    d = await startDaemon({ port });
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      console.error(c.yellow(`Port ${port} is busy — is Agent Village already running? Try --port 4318`));
      process.exitCode = 1; return;
    }
    throw err;
  }
  const { installClaudeHint } = await hints();
  console.log(`
  ${c.bold('🏘  Agent Village')} is running at ${c.green(d.url + '/web/')}
  ${c.dim(`demo mode: ${d.url}/web/?demo`)}
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
  const viaPlugin = fs.existsSync(pluginDir) && JSON.stringify(safeList(pluginDir)).includes('agent-village');
  const ok = claudeInstalled('user') || viaPlugin;
  return {
    installClaudeHint: ok ? '' : `\n  ${c.yellow('Claude Code hooks are not installed yet.')} Run: ${c.bold('npx agent-village install claude')}\n`,
  };
}

function safeList(dir) { try { return fs.readdirSync(dir); } catch { return []; } }

async function install(what) {
  const m = await import('../server/install.js');
  if (what === 'claude') {
    const r = m.installClaude({ scope: flag('project') ? 'project' : 'user' });
    console.log(`${c.green('✓')} Added ${r.events} async hooks to ${r.file}`);
    console.log(c.dim('  A backup was saved next to it (*.agent-village.bak). New Claude Code sessions will show up in the village.'));
  } else if (what === 'codex') {
    const r = m.installCodex();
    console.log(`${c.green('✓')} Added ${r.events} hooks to ${r.file}  ${c.yellow('(beta)')}`);
    console.log(c.yellow('  Codex only runs hooks you have trusted: open Codex, run /hooks and trust the agent-village entries.'));
  } else {
    console.error('Usage: agent-village install <claude|codex> [--project]');
    process.exitCode = 1;
  }
}

async function uninstall(what) {
  const m = await import('../server/install.js');
  if (what === 'claude') {
    const r = m.uninstallClaude({ scope: flag('project') ? 'project' : 'user' });
    console.log(r.removed ? `${c.green('✓')} Removed Agent Village hooks from ${r.file}` : `Nothing to remove in ${r.file}`);
  } else if (what === 'codex') {
    const r = m.uninstallCodex();
    console.log(r.removed ? `${c.green('✓')} Removed Agent Village hooks from ${r.file}` : `Nothing to remove in ${r.file}`);
  } else {
    console.error('Usage: agent-village uninstall <claude|codex>');
    process.exitCode = 1;
  }
}

async function doctor() {
  const m = await import('../server/install.js');
  const port = Number(opt('port', process.env.AGENT_VILLAGE_PORT || 4317));
  const line = (ok, text) => console.log(`${ok ? c.green('✓') : c.yellow('•')} ${text}`);
  const [major] = process.versions.node.split('.').map(Number);
  line(major >= 18, `Node ${process.versions.node} ${major >= 18 ? '' : '(need 18+)'}`);
  line(fs.existsSync(m.HOOK_SCRIPT), `hook script at ${m.HOOK_SCRIPT}`);
  line(m.claudeInstalled('user') || m.claudeInstalled('project'), 'Claude Code hooks installed (or use the plugin)');
  line(fs.existsSync(path.join(os.homedir(), '.claude', 'projects')), 'Claude Code transcripts folder exists');
  line(fs.existsSync(m.codexHooksPath()), `Codex hooks file (${m.codexHooksPath()}) — optional`);
  const health = await get(`http://127.0.0.1:${port}/api/health`).catch(() => null);
  line(!!health, health ? `daemon running on :${port} (${health.clients} viewer(s))` : `daemon not running on :${port} — run: agent-village start`);
}

async function ping() {
  const port = Number(opt('port', process.env.AGENT_VILLAGE_PORT || 4317));
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
    await post(`http://127.0.0.1:${port}/api/hook/claude`, { session_id: sid, cwd, transcript_path: '', ...s, _av_ts: Date.now() });
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
