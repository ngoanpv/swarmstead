import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const HOME = process.env.AGENT_VILLAGE_HOME || path.join(os.homedir(), '.agent-village');

export const DEFAULT_CONFIG = {
  port: 4317,
  host: '127.0.0.1',
  capture: 'summary',      // 'summary' | 'minimal' — how much of a tool call is kept
  logEvents: true,         // append normalized events to ~/.agent-village/events/*.jsonl
  desktopNotify: false,    // OS notification for critical alerts
  claude: { enabled: true, transcripts: path.join(os.homedir(), '.claude', 'projects') },
  codex: { enabled: true, sessions: path.join(os.homedir(), '.codex', 'sessions') },
  thresholds: {},          // see core/detectors.js DEFAULT_THRESHOLDS
  pricing: {},             // see core/pricing.js
  xpMultiplier: 1,
};

export function loadConfig(overrides = {}) {
  let user = {};
  const file = path.join(HOME, 'config.json');
  try { user = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* none yet */ }
  const cfg = {
    ...DEFAULT_CONFIG, ...user, ...overrides,
    claude: { ...DEFAULT_CONFIG.claude, ...(user.claude || {}) },
    codex: { ...DEFAULT_CONFIG.codex, ...(user.codex || {}) },
    thresholds: { ...(user.thresholds || {}) },
    pricing: { ...(user.pricing || {}) },
  };
  if (process.env.AGENT_VILLAGE_PORT) cfg.port = Number(process.env.AGENT_VILLAGE_PORT);
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
