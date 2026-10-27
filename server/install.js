// Install / uninstall the forwarding hooks.
// We only ever touch hook entries whose command contains HOOK_MARKER, and we
// back up the settings file before writing.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { CLAUDE_HOOK_EVENTS } from './adapters/claude-hooks.js';
import { HOME } from './config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const HOOK_SCRIPT = path.join(ROOT, 'plugin', 'hooks', 'swarmstead-hook.mjs');
export const GATE_SCRIPT = path.join(ROOT, 'plugin', 'hooks', 'swarmstead-gate.mjs');
export const GIT_SCRIPT = path.join(ROOT, 'plugin', 'hooks', 'swarmstead-git.mjs');
export const HOOK_MARKER = 'swarmstead-hook.mjs';
export const GATE_MARKER = 'swarmstead-gate.mjs';
const MARKERS = [HOOK_MARKER, GATE_MARKER];

// `npx swarmstead` runs from a cache npm may clear, so hooks installed from
// there point at a copy in ~/.swarmstead/hooks (the scripts only need node:*).
const FROM_NPX = /[\\/]_npx[\\/]/.test(ROOT);
function stable(script) {
  if (!FROM_NPX) return script;
  const copy = path.join(HOME, 'hooks', path.basename(script));
  fs.mkdirSync(path.dirname(copy), { recursive: true });
  fs.copyFileSync(script, copy);
  return copy;
}

const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied']);
export const CODEX_HOOK_EVENTS = [
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse',
  'PreCompact', 'PostCompact', 'SubagentStart', 'SubagentStop', 'Stop',
];

function hookCommand(provider) {
  return `"${process.execPath}" "${stable(HOOK_SCRIPT)}" ${provider}`;
}

function gateCommand() {
  return `"${process.execPath}" "${stable(GATE_SCRIPT)}"`;
}

function readJsonFile(file) {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, 'utf8').trim();
  if (!text) return {};
  try { return JSON.parse(text); } catch (e) {
    throw new Error(`${file} is not valid JSON (${e.message}). Fix it first; nothing was changed.`);
  }
}

function backupAndWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.swarmstead.bak`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

function stripOurs(hooks) {
  const out = {};
  for (const [event, groups] of Object.entries(hooks || {})) {
    if (!Array.isArray(groups)) { out[event] = groups; continue; }
    const kept = groups
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !MARKERS.some((m) => String(h.command || '').includes(m))) }))
      .filter((g) => g.hooks.length > 0);
    if (kept.length) out[event] = kept;
  }
  return out;
}

function addOurs(hooks, events, provider, { async = true } = {}) {
  const out = stripOurs(hooks);
  const command = hookCommand(provider);
  for (const event of events) {
    const entry = { type: 'command', command, timeout: 5 };
    if (async) entry.async = true;
    const group = TOOL_EVENTS.has(event) ? { matcher: '*', hooks: [entry] } : { hooks: [entry] };
    out[event] = [...(out[event] || []), group];
  }
  return out;
}

export function claudeSettingsPath(scope = 'user', cwd = process.cwd()) {
  return scope === 'project'
    ? path.join(cwd, '.claude', 'settings.local.json')
    : path.join(os.homedir(), '.claude', 'settings.json');
}

/**
 * gate: also add the OPT-IN synchronous hooks — remote approvals (PermissionRequest)
 * and the budget brake (PreToolUse on Agent/Task/Workflow). They fail open.
 */
export function installClaude({ scope = 'user', cwd, gate = false, waitSec = 120 } = {}) {
  const file = claudeSettingsPath(scope, cwd);
  const settings = readJsonFile(file);
  settings.hooks = addOurs(settings.hooks, CLAUDE_HOOK_EVENTS, 'claude');
  if (gate) {
    const h = settings.hooks;
    const command = gateCommand();
    h.PermissionRequest = [...(h.PermissionRequest || []), { matcher: '*', hooks: [{ type: 'command', command, timeout: Math.max(30, waitSec + 15) }] }];
    h.PreToolUse = [...(h.PreToolUse || []), { matcher: 'Agent|Task|Workflow', hooks: [{ type: 'command', command, timeout: 5 }] }];
  }
  backupAndWrite(file, settings);
  return { file, events: CLAUDE_HOOK_EVENTS.length, gate };
}

/** Add a post-commit hook to the git repo at cwd (keeps any existing hook). */
export function installGit({ cwd = process.cwd() } = {}) {
  let hooksDir, roots;
  try {
    [hooksDir, ...roots] = execFileSync('git', ['rev-parse', '--git-path', 'hooks', '--git-common-dir', '--show-toplevel'], { cwd, encoding: 'utf8' })
      .trim().split('\n').map((p) => path.resolve(cwd, p));
  } catch { throw new Error('Not inside a git repository.'); }
  fs.mkdirSync(hooksDir, { recursive: true });
  const file = path.join(hooksDir, 'post-commit');
  const line = `"${process.execPath}" "${stable(GIT_SCRIPT)}" commit >/dev/null 2>&1 || true # swarmstead`;
  let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '#!/bin/sh\n';
  if (!text.includes('# swarmstead')) text = text.replace(/\s*$/, '\n') + line + '\n';
  fs.writeFileSync(file, text, { mode: 0o755 });
  // core.hooksPath can point at a folder other repos use too (e.g. a global one)
  const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
  const inside = (dir, root) => { const rel = path.relative(real(root), real(dir)); return !rel.startsWith('..') && !path.isAbsolute(rel); };
  return { file, shared: !roots.some((root) => inside(hooksDir, root)) };
}

export function uninstallGit({ cwd = process.cwd() } = {}) {
  let hooksDir;
  try { hooksDir = path.resolve(cwd, execFileSync('git', ['rev-parse', '--git-path', 'hooks'], { cwd, encoding: 'utf8' }).trim()); } catch { return { removed: false }; }
  const file = path.join(hooksDir, 'post-commit');
  if (!fs.existsSync(file)) return { file, removed: false };
  const text = fs.readFileSync(file, 'utf8').split('\n').filter((l) => !l.includes('# swarmstead')).join('\n');
  fs.writeFileSync(file, text);
  return { file, removed: true };
}

export function uninstallClaude({ scope = 'user', cwd } = {}) {
  const file = claudeSettingsPath(scope, cwd);
  if (!fs.existsSync(file)) return { file, removed: false };
  const settings = readJsonFile(file);
  settings.hooks = stripOurs(settings.hooks);
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  backupAndWrite(file, settings);
  return { file, removed: true };
}

export function codexHooksPath() {
  return path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'hooks.json');
}

export function installCodex() {
  const file = codexHooksPath();
  const data = readJsonFile(file);
  data.hooks = addOurs(data.hooks, CODEX_HOOK_EVENTS, 'codex');
  backupAndWrite(file, data);
  return { file, events: CODEX_HOOK_EVENTS.length };
}

export function uninstallCodex() {
  const file = codexHooksPath();
  if (!fs.existsSync(file)) return { file, removed: false };
  const data = readJsonFile(file);
  data.hooks = stripOurs(data.hooks);
  backupAndWrite(file, data);
  return { file, removed: true };
}

export function claudeInstalled(scope = 'user') {
  try {
    const s = readJsonFile(claudeSettingsPath(scope));
    return JSON.stringify(s.hooks || {}).includes(HOOK_MARKER);
  } catch { return false; }
}

/** Installed as a Claude Code plugin (from any marketplace)? */
export function claudePluginInstalled() {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  try {
    return Object.keys(readJsonFile(path.join(dir, 'plugins', 'installed_plugins.json')).plugins || {}).some((id) => id.startsWith('swarmstead@'));
  } catch { return false; }
}

export function gateInstalled(scope = 'user') {
  try {
    return JSON.stringify(readJsonFile(claudeSettingsPath(scope)).hooks || {}).includes(GATE_MARKER);
  } catch { return false; }
}
