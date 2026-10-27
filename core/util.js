// Small isomorphic helpers shared by the daemon and the browser.

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const lerp = (a, b, t) => a + (b - a) * t;

/** FNV-1a 32-bit string hash. Stable across runs and platforms. */
export function hash32(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic PRNG (mulberry32). Same seed -> same sequence. */
export function rng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const pick = (r, arr) => arr[Math.floor(r() * arr.length) % arr.length];

/** Exponential moving average; returns `sample` when there is no previous value. */
export const ema = (prev, sample, alpha = 0.2) =>
  prev == null || !Number.isFinite(prev) ? sample : prev + alpha * (sample - prev);

export function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Last path segment(s), for display. Works with / and \ separators. */
export function shortPath(p, segments = 2) {
  if (!p) return '';
  const parts = String(p).split(/[\\/]+/).filter(Boolean);
  return parts.slice(-segments).join('/');
}

// Worktrees should count as the same project, labelled with the worktree name:
//   /repo/.claude/worktrees/fix-auth  -> project "repo", worktree "fix-auth"
//   /work/repo-worktrees/feature-x    -> project "repo", worktree "feature-x"
const WORKTREE_PATTERNS = [
  /^(.*?)[\\/]\.claude[\\/]worktrees[\\/]([^\\/]+)/,
  /^(.*?)[\\/]\.worktrees[\\/]([^\\/]+)/,
  /^(.*?)-worktrees[\\/]([^\\/]+)/,
];

export function worktreeOf(cwd) {
  if (!cwd) return null;
  for (const re of WORKTREE_PATTERNS) {
    const m = String(cwd).match(re);
    if (m) return { root: m[1], name: m[2] };
  }
  return null;
}

export function projectName(cwd) {
  const wt = worktreeOf(cwd);
  if (wt) return shortPath(wt.root, 1) || 'unknown';
  return shortPath(cwd, 1) || 'unknown';
}

/** Truncate and collapse whitespace so nothing large ever lands in state. */
export function oneLine(s, max = 80) {
  if (s == null) return '';
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/** Normalise an error message so "same error, different line number" still matches. */
export function errorSignature(msg) {
  return oneLine(msg, 400)
    .toLowerCase()
    .replace(/0x[0-9a-f]+/g, '#')
    .replace(/\d+/g, '#')
    .replace(/(['"`]).*?\1/g, '"…"')
    .slice(0, 160);
}

export function fmtUsd(v) {
  if (!Number.isFinite(v)) return '$0.00';
  if (v >= 100) return '$' + v.toFixed(0);
  if (v >= 1) return '$' + v.toFixed(2);
  return '$' + v.toFixed(3);
}

export function fmtTokens(n) {
  if (!Number.isFinite(n)) return '0';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(Math.round(n));
}

export function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm' + String(s % 60).padStart(2, '0');
  const h = Math.floor(m / 60);
  return h + 'h' + String(m % 60).padStart(2, '0');
}

let _id = 0;
export const uid = (prefix = 'id') => `${prefix}_${Date.now().toString(36)}_${(_id++).toString(36)}`;
