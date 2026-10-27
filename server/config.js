import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const HOME = process.env.SWARMSTEAD_HOME || path.join(os.homedir(), '.swarmstead');

export const DEFAULT_CONFIG = {
  port: 4317,
  host: '127.0.0.1',
  capture: 'summary',      // 'summary' | 'minimal' — how much of a tool call is kept
  logEvents: true,         // append normalized events to ~/.swarmstead/events/*.jsonl
  desktopNotify: false,    // OS notification for critical alerts
  claude: { enabled: true, transcripts: path.join(os.homedir(), '.claude', 'projects') },
  codex: { enabled: true, sessions: path.join(os.homedir(), '.codex', 'sessions') },
  thresholds: {},          // see core/detectors.js DEFAULT_THRESHOLDS
  pricing: {},             // see core/pricing.js
  xpMultiplier: 1,
  lan: false,              // listen on your network so your phone can approve (token required)
  autostart: true,         // plugin and `install codex`: start the daemon when a session starts (plugin/hooks/swarmstead-up.mjs)
  reminder: true,          // plugin: one line with the village address when a Claude Code session starts or resumes
  gate: {                  // only used if you installed the gate hook: `swarmstead install claude --gate`
    approvals: true,       // answer permission prompts from the village / phone
    waitSubSec: 120,       // subagent prompts: hold this long for your answer (else Claude Code's default)
    waitMainSec: 0,        // main-session prompts: 0 = never delay the terminal prompt
    brakes: false,         // refuse new subagents once dailyBudgetUsd / runBudgetUsd is reached
  },
  notify: {},              // { desktop, ntfy, webhook, publicUrl } — see server/notify.js
  limits: { claudeBlockUsd: 0 }, // your plan's comfortable $ per 5-hour block, for block forecasts
};

export function loadConfig(overrides = {}) {
  let user = {};
  const file = path.join(HOME, 'config.json');
  try { user = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* none yet */ }
  const cfg = {
    ...DEFAULT_CONFIG, ...user, ...overrides,
    claude: { ...DEFAULT_CONFIG.claude, ...(user.claude || {}), ...(overrides.claude || {}) },
    codex: { ...DEFAULT_CONFIG.codex, ...(user.codex || {}), ...(overrides.codex || {}) },
    thresholds: { ...(user.thresholds || {}), ...(overrides.thresholds || {}) },
    pricing: { ...(user.pricing || {}), ...(overrides.pricing || {}) },
    gate: { ...DEFAULT_CONFIG.gate, ...(user.gate || {}), ...(overrides.gate || {}) },
    notify: { ...(user.notify || {}), ...(overrides.notify || {}) },
    limits: { ...DEFAULT_CONFIG.limits, ...(user.limits || {}), ...(overrides.limits || {}) },
  };
  if (cfg.desktopNotify) cfg.notify.desktop = true; // older option name
  if (cfg.lan) cfg.host = '0.0.0.0';
  if (process.env.SWARMSTEAD_PORT) cfg.port = Number(process.env.SWARMSTEAD_PORT);
  return cfg;
}

export function ensureHome() {
  fs.mkdirSync(path.join(HOME, 'events'), { recursive: true });
}

export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

/** Atomic write: temp file + rename, so a crash never leaves half a roster. */
export function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

/** A random token that guards approvals and LAN access. Created once, kept 0600. */
export function loadToken() {
  const file = path.join(HOME, 'token');
  try { const t = fs.readFileSync(file, 'utf8').trim(); if (t.length >= 20) return t; } catch {}
  const t = crypto.randomBytes(18).toString('base64url');
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(file, t, { mode: 0o600 });
  return t;
}

export function readJsonl(file, max = 500) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-max);
    return lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
