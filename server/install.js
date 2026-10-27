// Install / uninstall the forwarding hooks.
// We only ever touch hook entries whose command contains HOOK_MARKER, and we
// back up the settings file before writing.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { CLAUDE_HOOK_EVENTS } from './adapters/claude-hooks.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const HOOK_SCRIPT = path.join(ROOT, 'plugin', 'hooks', 'swarmstead-hook.mjs');
export const HOOK_MARKER = 'swarmstead-hook.mjs';

const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied']);
export const CODEX_HOOK_EVENTS = [
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse',
  'PreCompact', 'PostCompact', 'SubagentStart', 'SubagentStop', 'Stop',
];

function hookCommand(provider) {
  return `"${process.execPath}" "${HOOK_SCRIPT}" ${provider}`;
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
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !String(h.command || '').includes(HOOK_MARKER)) }))
      .filter((g) => g.hooks.length > 0);
    if (kept.length) out[event] = kept;
  }
  return out;
}

function addOurs(hooks, events, provider, { async = true } = {}) {
  const out = stripOurs(hooks);
  for (const event of events) {
    const entry = { type: 'command', command: hookCommand(provider), timeout: 5 };
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

export function installClaude({ scope = 'user', cwd } = {}) {
  const file = claudeSettingsPath(scope, cwd);
  const settings = readJsonFile(file);
  settings.hooks = addOurs(settings.hooks, CLAUDE_HOOK_EVENTS, 'claude');
  backupAndWrite(file, settings);
  return { file, events: CLAUDE_HOOK_EVENTS.length };
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
