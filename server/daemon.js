// The Swarmstead daemon: a zero-dependency local server.
//
//   hooks ──POST /api/hook/:provider──┐
//   transcripts (polled) ─────────────┼─► reorder buffer ─► Village engine ─► SSE /api/stream ─► browser
//   git hook ──POST /api/git──────────┤                          │
//   custom tools ──POST /api/events───┘                          ├─► roster.json, runs.jsonl, events/*.jsonl
//                                                                └─► push (ntfy / webhook / desktop)
//   gate hook ──POST /api/gate/permission──► approvals ◄── village UI / phone (POST /api/approvals/:id)
//   gate hook ──POST /api/gate/pretool─────► budget brake
//
// Security
//  - Binds to 127.0.0.1 unless you opt into LAN mode (--lan).
//  - Cross-origin POSTs and foreign Host headers (DNS rebinding) are refused.
//  - Deciding approvals, and every request from another machine, needs the
//    token in ~/.swarmstead/token (the local UI fetches it same-origin).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Village } from '../core/engine.js';
import { setPricingOverrides } from '../core/pricing.js';
import { isValidEvent, EV } from '../core/schema.js';
import { getDict, alertText } from '../core/i18n.js';
import { fmtUsd } from '../core/util.js';
import { ClaudeHookAdapter } from './adapters/claude-hooks.js';
import { ClaudeTranscripts, CodexRollouts } from './adapters/transcripts.js';
import { Approvals } from './approvals.js';
import { Notifier } from './notify.js';
import { HOME, loadConfig, ensureHome, readJson, readJsonl, writeJsonAtomic, loadToken } from './config.js';

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
  const token = loadToken();

  const rosterFile = path.join(HOME, 'roster.json');
  const runsFile = path.join(HOME, 'runs.jsonl');
  const blocksFile = path.join(HOME, 'blocks.json');
  const village = new Village({
    roster: readJson(rosterFile),
    thresholds: cfg.thresholds,
    xpMultiplier: cfg.xpMultiplier,
    history: readJsonl(runsFile, 500),
    pastBlocks: readJson(blocksFile, { past: [] }).past || [],
    blockCeilingUsd: cfg.limits.claudeBlockUsd || 0,
    onRunEnd: (rec) => { try { fs.appendFileSync(runsFile, JSON.stringify(rec) + '\n'); } catch {} },
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

  // ---- event log (also the source for replays)
  let logStream = null, logDay = '';
  const logEvent = (e) => {
    if (!cfg.logEvents || e.backfill) return;
    const day = localDay(e.ts);
    if (day !== logDay) {
      logStream?.end();
      logDay = day;
      logStream = fs.createWriteStream(path.join(HOME, 'events', `${day}.jsonl`), { flags: 'a' });
    }
    logStream.write(JSON.stringify(e) + '\n');
  };

  // ---- broadcasting + push
  const send = (msg) => {
    const data = `data: ${JSON.stringify(msg)}\n\n`;
    for (const res of clients) res.write(data);
  };
  const dict = getDict(cfg.lang || 'en');
  const notifier = new Notifier(cfg.notify, { token });
  const onFx = (fx) => {
    if (!fx.length) return;
    snapshotDirty = true;
    send({ type: 'fx', fx });
    for (const f of fx) {
      if (f.fx === 'alert' && f.alert.severity === 'crit' && notifier.enabled) {
        notifier.send('alert', { key: f.alert.id, title: 'Swarmstead', text: alertText(dict, f.alert), priority: 'high' }).catch(() => {});
      }
    }
  };

  const approvals = new Approvals({
    onChange: (list, added) => {
      send({ type: 'approvals', approvals: list });
      if (added && notifier.enabled) {
        const who = added.label || 'An agent';
        notifier.send('approval', {
          key: added.id, approvalId: added.id, priority: 'high',
          title: `${who} needs approval`, text: `${added.tool}${added.detail ? `: ${added.detail}` : ''}`,
        }).catch(() => {});
      }
    },
  });

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
    setInterval(() => { try { writeJsonAtomic(blocksFile, { past: village.world.pastBlocks }); } catch {} }, 60_000),
  ];

  const booted = { claude: claudeTx?.bootstrap() || 0, codex: codexTx?.bootstrap() || 0 };

  // Agent teams: ~/.claude/teams/<team>/config.json tells us who is a teammate (and whose).
  const teamsDir = cfg.claude.teams || path.join(path.dirname(cfg.claude.transcripts), 'teams');
  const scanTeams = () => {
    let names = [];
    try { names = fs.readdirSync(teamsDir); } catch { return; }
    for (const t of names) {
      const conf = readJson(path.join(teamsDir, t, 'config.json'));
      if (conf) claudeHooks.registerTeam(conf, t);
    }
  };
  scanTeams();
  timers.push(setInterval(scanTeams, 5000));

  // ---- gate: remote approvals + budget brake
  const gatePermission = async (body) => {
    const g = cfg.gate;
    if (!g.approvals) return { decision: null };
    const sub = !!body.agent_id;
    const waitMs = Math.max(0, (sub ? g.waitSubSec : g.waitMainSec) || 0) * 1000;
    // Only hold the prompt if someone can actually answer it.
    if (!waitMs || (!clients.size && !notifier.enabled)) return { decision: null };
    const agentId = body.agent_id ? `${body.session_id}:${body.agent_id}` : body.session_id;
    const snap = village.world.agents.get(agentId);
    const fam = snap && village.evolution.familiars.get(snap.familiar);
    const label = fam ? `${fam.name} (${snap.type === 'main' ? snap.project : snap.type})` : (body.agent_type || 'agent');
    const decision = await approvals.request(body, { waitMs, agentId, label });
    if (decision) enqueue([{ v: 1, ts: Date.now(), provider: 'claude', kind: EV.NOTICE, sessionId: body.session_id, agentId, text: `${body.tool_name || 'tool'} ${decision.behavior === 'allow' ? 'approved' : 'denied'} from Swarmstead`, level: decision.behavior === 'allow' ? 'good' : 'warn' }]);
    return { decision };
  };

  const gatePretool = (body) => {
    if (!cfg.gate.brakes) return {};
    const t = village.detectors.t;
    const w = village.world;
    if (t.dailyBudgetUsd > 0 && w.totals.cost >= t.dailyBudgetUsd) {
      return { deny: `Swarmstead budget brake: today's spend is ${fmtUsd(w.totals.cost)}, at or above the daily budget of ${fmtUsd(t.dailyBudgetUsd)}. Don't start new subagents; finish with what you have, or ask the user to raise dailyBudgetUsd in ~/.swarmstead/config.json.` };
    }
    const lead = w.agents.get(body.agent_id ? `${body.session_id}:${body.agent_id}` : body.session_id);
    const run = lead?.runId && w.runs.get(lead.runId);
    if (run && !run.endedAt && t.runBudgetUsd > 0 && run.cost >= t.runBudgetUsd) {
      return { deny: `Swarmstead budget brake: this run has cost ${fmtUsd(run.cost)}, at or above runBudgetUsd ${fmtUsd(t.runBudgetUsd)}. Stop delegating and summarise the results so far.` };
    }
    return {};
  };

  // ---- http
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const local = isLoopback(req.socket.remoteAddress);
      const hasToken = (url.searchParams.get('t') || req.headers['x-swarmstead-token']) === token;
      if (local && !hostAllowed(req.headers.host)) return reply(res, 403, { error: 'bad host' });
      // From another machine (LAN mode): the API needs the token; static files don't.
      if (!local && url.pathname.startsWith('/api/') && !hasToken) return reply(res, 401, { error: 'token required' });

      if (req.method === 'POST') {
        if (!originAllowed(req.headers.origin, cfg.port, req.headers.host)) return reply(res, 403, { error: 'cross-origin' });
        if (url.pathname.startsWith('/api/approvals/')) {
          if (!hasToken) return reply(res, 401, { error: 'token required' });
          const id = url.pathname.split('/')[3];
          const body = await readBody(req).catch(() => ({}));
          const d = url.searchParams.get('d') || body.decision;
          return reply(res, approvals.decide(id, d, local ? 'village' : 'phone') ? 200 : 404, { ok: true });
        }
        const body = await readBody(req);
        if (url.pathname.startsWith('/api/hook/')) {
          const provider = url.pathname.split('/')[3];
          const adapter = provider === 'codex' ? codexHooks : provider === 'claude' ? claudeHooks : null;
          if (!adapter) return reply(res, 404, { error: 'unknown provider' });
          const ts = Number.isFinite(body._ss_ts) ? body._ss_ts : Date.now();
          enqueue(adapter.translate(body, ts));
          const tx = provider === 'codex' ? codexTx : claudeTx;
          if (body.transcript_path) tx?.noteSession(body.session_id, body.transcript_path, body.cwd);
          return reply(res, 202, { ok: true });
        }
        if (url.pathname === '/api/gate/permission') return reply(res, 200, await gatePermission(body));
        if (url.pathname === '/api/gate/pretool') return reply(res, 200, gatePretool(body));
        if (url.pathname === '/api/git') {
          enqueue([{ v: 1, ts: Date.now(), provider: 'git', kind: EV.GIT, agentId: 'git', sessionId: 'git', action: String(body.action || 'commit'), cwd: String(body.cwd || ''), sha: String(body.sha || '').slice(0, 40) }]);
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

      if (url.pathname === '/api/session') {
        // Same-origin only in practice: browsers won't let other sites read this response.
        return reply(res, 200, { token, lan: !!cfg.lan, gate: cfg.gate, notify: { ntfy: !!cfg.notify.ntfy, webhook: !!cfg.notify.webhook, desktop: !!cfg.notify.desktop, publicUrl: cfg.notify.publicUrl || null } });
      }
      if (url.pathname === '/api/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(`data: ${JSON.stringify({ type: 'hello', version: 2, mode: 'live' })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'snapshot', state: village.snapshot(Date.now()) })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'roster', roster: village.roster() })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'approvals', approvals: approvals.list() })}\n\n`);
        clients.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
        ping.unref?.();
        req.on('close', () => { clearInterval(ping); clients.delete(res); });
        return;
      }
      if (url.pathname === '/api/state') return reply(res, 200, village.snapshot(Date.now()));
      if (url.pathname === '/api/roster') return reply(res, 200, village.roster());
      if (url.pathname === '/api/approvals') return reply(res, 200, approvals.list());
      if (url.pathname === '/api/history') return reply(res, 200, village.history.slice(-100));
      if (url.pathname === '/api/replay/days') return reply(res, 200, replayDays());
      if (url.pathname.startsWith('/api/replay/')) {
        const day = url.pathname.split('/')[3];
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return reply(res, 400, { error: 'bad day' });
        return reply(res, 200, readJsonl(path.join(HOME, 'events', `${day}.jsonl`), 300_000));
      }
      if (url.pathname === '/api/health') return reply(res, 200, { ok: true, clients: clients.size, booted, home: HOME, gate: cfg.gate.approvals || cfg.gate.brakes });
      return serveStatic(url.pathname, res, url.search);
    } catch (err) {
      reply(res, err.statusCode || 500, { error: err.message });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', (err) => {
      // e.g. EADDRINUSE / EACCES: stop everything we started so the process can exit
      timers.forEach(clearInterval);
      logStream?.end();
      reject(err);
    });
    server.listen(cfg.port, cfg.host, () => {
      cfg.port = server.address().port; // port 0 = any free port (tests)
      const close = () => {
        timers.forEach(clearInterval);
        approvals.cancelAll();
        try { writeJsonAtomic(rosterFile, village.evolution.toJSON()); } catch {}
        try { writeJsonAtomic(blocksFile, { past: village.world.pastBlocks }); } catch {}
        logStream?.end();
        for (const c of clients) c.end();
        clients.clear();
        const done = new Promise((r) => server.close(() => r()));
        server.closeAllConnections?.(); // Node 18.2+: don't wait for keep-alive sockets
        return done;
      };
      resolve({ server, village, approvals, cfg, close, token, url: `http://127.0.0.1:${cfg.port}`, booted });
    });
  });
}

// ---------------------------------------------------------------- helpers

function replayDays() {
  let names = [];
  try { names = fs.readdirSync(path.join(HOME, 'events')); } catch { return []; }
  return names.filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort().reverse().slice(0, 60).map((n) => {
    let bytes = 0;
    try { bytes = fs.statSync(path.join(HOME, 'events', n)).size; } catch {}
    return { day: n.slice(0, 10), bytes };
  });
}

function localDay(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

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

function isLoopback(addr) {
  return !addr || addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function hostAllowed(host) {
  if (!host) return true;
  const h = host.replace(/:\d+$/, '');
  return h === '127.0.0.1' || h === 'localhost' || h === '[::1]';
}

function originAllowed(origin, port, host) {
  if (!origin) return true; // hooks, curl, ntfy actions
  try {
    const u = new URL(origin);
    if (host && u.host === host) return true; // same origin (also covers LAN mode)
    return ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) && Number(u.port || 80) === Number(port);
  } catch { return false; }
}

function serveStatic(pathname, res, search = '') {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return reply(res, 400, { error: 'bad path' }); }
  if (rel === '/' || rel === '' || rel === '/web') { res.writeHead(302, { location: '/web/' + (search || '') }); return res.end(); }
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
