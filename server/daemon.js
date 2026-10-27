// The Agent Village daemon: a zero-dependency local server.
//
//   hooks ──POST /api/hook/:provider──┐
//   transcripts (polled) ─────────────┼─► reorder buffer ─► Village engine ─► SSE /api/stream ─► browser
//   custom tools ──POST /api/events───┘                          │
//                                                                └─► roster.json, events/*.jsonl
//
// Binds to 127.0.0.1 only. Rejects cross-origin POSTs and foreign Host headers
// (DNS rebinding), so a web page you visit cannot feed it fake events.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

import { Village } from '../core/engine.js';
import { setPricingOverrides } from '../core/pricing.js';
import { isValidEvent } from '../core/schema.js';
import { getDict, alertText } from '../core/i18n.js';
import { ClaudeHookAdapter } from './adapters/claude-hooks.js';
import { ClaudeTranscripts, CodexRollouts } from './adapters/transcripts.js';
import { HOME, loadConfig, ensureHome, readJson, writeJsonAtomic } from './config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.wav': 'audio/wav',
};
const REORDER_MS = 300;

export function startDaemon(overrides = {}) {
  const cfg = loadConfig(overrides);
  ensureHome();
  setPricingOverrides(cfg.pricing);

  const rosterFile = path.join(HOME, 'roster.json');
  const village = new Village({
    roster: readJson(rosterFile),
    thresholds: cfg.thresholds,
    xpMultiplier: cfg.xpMultiplier,
  });

  const clients = new Set();
  const pending = [];
  let seq = 0;
  let snapshotDirty = true;

  const enqueue = (events) => {
    for (const e of events) if (isValidEvent(e)) pending.push({ e, seq: seq++ });
  };

  const claudeHooks = new ClaudeHookAdapter({ capture: cfg.capture, provider: 'claude' });
  const codexHooks = new ClaudeHookAdapter({ capture: cfg.capture, provider: 'codex' });
  const claudeTx = cfg.claude.enabled ? new ClaudeTranscripts(enqueue, { root: cfg.claude.transcripts }) : null;
  const codexTx = cfg.codex.enabled ? new CodexRollouts(enqueue, { root: cfg.codex.sessions }) : null;

  // ---- event log
  let logStream = null, logDay = '';
  const logEvent = (e) => {
    if (!cfg.logEvents || e.backfill) return;
    const day = new Date(e.ts).toISOString().slice(0, 10);
    if (day !== logDay) {
      logStream?.end();
      logDay = day;
      logStream = fs.createWriteStream(path.join(HOME, 'events', `${day}.jsonl`), { flags: 'a' });
    }
    logStream.write(JSON.stringify(e) + '\n');
  };

  // ---- broadcasting
  const send = (msg) => {
    const data = `data: ${JSON.stringify(msg)}\n\n`;
    for (const res of clients) res.write(data);
  };
  const dict = getDict(cfg.lang || 'en');
  const onFx = (fx) => {
    if (!fx.length) return;
    snapshotDirty = true;
    send({ type: 'fx', fx });
    if (cfg.desktopNotify) for (const f of fx) if (f.fx === 'alert' && f.alert.severity === 'crit') notify(alertText(dict, f.alert));
  };

  const flush = () => {
    if (!pending.length) return;
    const cutoff = Date.now() - REORDER_MS;
    pending.sort((a, b) => (a.e.ts - b.e.ts) || (a.seq - b.seq));
    const ready = [];
    while (pending.length && (pending[0].e.ts <= cutoff || pending[0].e.backfill)) ready.push(pending.shift().e);
    const fx = [];
    for (const e of ready) {
      logEvent(e);
      fx.push(...village.ingest(e));
    }
    onFx(fx);
  };

  const timers = [
    setInterval(flush, 100),
    setInterval(() => onFx(village.tick(Date.now())), 1000),
    setInterval(() => { claudeTx?.pollAll(); codexTx?.pollAll(); }, 1000),
    setInterval(() => {
      if (snapshotDirty && clients.size) { snapshotDirty = false; send({ type: 'snapshot', state: village.snapshot(Date.now()) }); }
    }, 400),
    setInterval(() => {
      if (!village.rosterDirty) return;
      village.rosterDirty = false;
      try { writeJsonAtomic(rosterFile, village.evolution.toJSON()); } catch (err) { console.error('roster save failed:', err.message); }
      send({ type: 'roster', roster: village.roster() });
    }, 2000),
  ];

  const booted = { claude: claudeTx?.bootstrap() || 0, codex: codexTx?.bootstrap() || 0 };

  // ---- http
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      if (!hostAllowed(req.headers.host, cfg.port)) return reply(res, 403, { error: 'bad host' });

      if (req.method === 'POST') {
        if (!originAllowed(req.headers.origin, cfg.port)) return reply(res, 403, { error: 'cross-origin' });
        const body = await readBody(req);
        if (url.pathname.startsWith('/api/hook/')) {
          const provider = url.pathname.split('/')[3];
          const adapter = provider === 'codex' ? codexHooks : provider === 'claude' ? claudeHooks : null;
          if (!adapter) return reply(res, 404, { error: 'unknown provider' });
          const ts = Number.isFinite(body._av_ts) ? body._av_ts : Date.now();
          enqueue(adapter.translate(body, ts));
          const tx = provider === 'codex' ? codexTx : claudeTx;
          if (body.transcript_path) tx?.noteSession(body.session_id, body.transcript_path, body.cwd);
          return reply(res, 202, { ok: true });
        }
        if (url.pathname === '/api/events') {
          const list = Array.isArray(body) ? body : [body];
          const now = Date.now();
          enqueue(list.map((e) => ({ v: 1, provider: 'custom', ts: now, ...e, sessionId: e.sessionId || e.agentId })));
          return reply(res, 202, { ok: true, accepted: list.length });
        }
        return reply(res, 404, { error: 'not found' });
      }

      if (url.pathname === '/api/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(`data: ${JSON.stringify({ type: 'hello', version: 1, mode: 'live' })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'snapshot', state: village.snapshot(Date.now()) })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'roster', roster: village.roster() })}\n\n`);
        clients.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
        req.on('close', () => { clearInterval(ping); clients.delete(res); });
        return;
      }
      if (url.pathname === '/api/state') return reply(res, 200, village.snapshot(Date.now()));
      if (url.pathname === '/api/roster') return reply(res, 200, village.roster());
      if (url.pathname === '/api/health') return reply(res, 200, { ok: true, clients: clients.size, booted, home: HOME });
      return serveStatic(url.pathname, res);
    } catch (err) {
      reply(res, err.statusCode || 500, { error: err.message });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port, cfg.host, () => {
      const close = () => {
        timers.forEach(clearInterval);
        try { writeJsonAtomic(rosterFile, village.evolution.toJSON()); } catch {}
        logStream?.end();
        for (const c of clients) c.end();
        return new Promise((r) => server.close(() => r()));
      };
      resolve({ server, village, cfg, close, url: `http://${cfg.host === '0.0.0.0' ? '127.0.0.1' : cfg.host}:${cfg.port}`, booted });
    });
  });
}

// ---------------------------------------------------------------- helpers

function reply(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { const e = new Error('payload too large'); e.statusCode = 413; reject(e); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { const e = new Error('invalid json'); e.statusCode = 400; reject(e); }
    });
    req.on('error', reject);
  });
}

function hostAllowed(host, port) {
  if (!host) return true;
  const h = host.replace(/:\d+$/, '');
  return h === '127.0.0.1' || h === 'localhost' || h === '[::1]';
}

function originAllowed(origin, port) {
  if (!origin) return true; // hooks, curl
  try {
    const u = new URL(origin);
    return ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) && Number(u.port || 80) === Number(port);
  } catch { return false; }
}

function serveStatic(pathname, res) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '' || rel === '/web') { res.writeHead(302, { location: '/web/' }); return res.end(); }
  if (rel === '/web/') rel = '/web/index.html';
  if (!rel.startsWith('/web/') && !rel.startsWith('/core/')) return reply(res, 404, { error: 'not found' });
  const file = path.resolve(ROOT, '.' + rel);
  if (!file.startsWith(ROOT + path.sep)) return reply(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return reply(res, 404, { error: 'not found' });
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  });
}

let lastNotify = 0;
function notify(text) {
  const now = Date.now();
  if (now - lastNotify < 15_000) return; // never spam
  lastNotify = now;
  const title = 'Agent Village';
  if (process.platform === 'darwin') {
    execFile('osascript', ['-e', `display notification ${JSON.stringify(text)} with title ${JSON.stringify(title)}`], () => {});
  } else if (process.platform === 'linux') {
    execFile('notify-send', [title, text], () => {});
  }
}
