// Swarmstead — browser entry point.
// Live mode: subscribe to the local daemon (SSE). Demo mode: run the simulator in-page.

import { WorldView, OUTCOME_COLOR, shortModel } from './render/world.js';
import { getPortrait, getSprite } from './render/sprites.js';
import { Sound } from './sound.js';
import { getDict, alertText, alertHint } from '../core/i18n.js';
import { fmtUsd, fmtTokens, fmtDuration } from '../core/util.js';
import { STAGES, SPECIES, TRAITS } from '../core/evolution.js';
import { postmortem, postmortemMarkdown } from '../core/postmortem.js';
import { Replay, parseEvents } from './replay.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const params = new URLSearchParams(location.search);
let lang = 'en';
try { lang = localStorage.getItem('swarmstead.lang') || (navigator.language || 'en').slice(0, 2); } catch {}
let T = getDict(lang);

const sound = new Sound();
const state = {
  snap: null, roster: [], selected: null, mode: 'demo', log: [], seenAlerts: new Set(), tab: 'alerts', sim: null, speed: Number(params.get('speed')) || 1, expanded: new Set(),
  token: params.get('t') || '', approvals: { pending: [], recent: [] }, replay: null, replaying: false, replayEvents: null, replayLabel: '',
};

const world = new WorldView($('world'), {
  sound,
  onSelect: (id) => { state.selected = id; renderSide(); },
  onViewChange: (v, auto) => { renderViews(); renderLegend(); if (auto && v === 'arena') toast({ severity: 'info', kind: 'arena', custom: T.ui.arenaAuto }); },
});
world.onEvolve = (a, f) => showBanner(a, f);
if (params.has('hour')) world.forceHour = Number(params.get('hour')); // preview day/night: ?demo&hour=22
if (params.has('lang')) lang = params.get('lang');
if (params.has('view')) world.setViewMode(params.get('view'));

// ---------------------------------------------------------------- data sources

async function boot() {
  const wantDemo = params.has('demo') || location.protocol === 'file:' || globalThis.__SWARMSTEAD_DEMO__;
  if (!wantDemo && await daemonReachable()) startLive();
  else startDemo();
}

async function daemonReachable() {
  try { const r = await fetch('/api/health', { cache: 'no-store' }); return r.ok; } catch { return false; }
}

const tq = () => (state.token ? `?t=${encodeURIComponent(state.token)}` : '');
async function api(path, opts = {}) {
  const r = await fetch(path + (path.includes('?') ? (state.token ? `&t=${encodeURIComponent(state.token)}` : '') : tq()), {
    ...opts, headers: { 'content-type': 'application/json', ...(state.token ? { 'x-swarmstead-token': state.token } : {}), ...(opts.headers || {}) },
  });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

async function startLive() {
  state.mode = 'live';
  setMode('live');
  try { const sess = await api('/api/session'); if (sess.token) state.token = sess.token; } catch { /* remote without token: the stream will say so */ }
  const es = new EventSource(`/api/stream${tq()}`);
  es.onmessage = (m) => {
    let msg; try { msg = JSON.parse(m.data); } catch { return; }
    if (msg.type === 'snapshot') { if (!state.replaying) onSnapshot(msg.state); else state.liveSnap = msg.state; }
    else if (msg.type === 'fx') { if (!state.replaying) onFx(msg.fx); }
    else if (msg.type === 'roster') { if (!state.replaying) onRoster(msg.roster); }
    else if (msg.type === 'approvals') onApprovals(msg.approvals);
    else if (msg.type === 'hello') setMode('live');
  };
  es.onerror = () => setMode('offline');
}

async function startDemo() {
  state.mode = 'demo';
  setMode('demo');
  const { DemoSim } = await import('./sim/demo.js');
  state.sim = new DemoSim({
    onFx: (fx) => { if (!state.replaying) onFx(fx); },
    onSnapshot: (s) => { if (!state.replaying) onSnapshot(s); },
    onRoster: (r) => { if (!state.replaying) onRoster(r); },
    onApprovals,
    speed: state.speed,
  });
  state.sim.start();
}

function setMode(m) {
  const b = $('mode');
  b.className = `badge ${m}`;
  b.textContent = m === 'live' ? T.ui.live : m === 'demo' ? T.ui.demo : T.ui.offline;
  $('b-speed').hidden = state.mode !== 'demo';
  $('b-speed').textContent = `${state.speed}×`;
  $('b-demo').textContent = state.mode === 'demo' ? 'LIVE' : 'DEMO';
  $('b-demo').hidden = !!globalThis.__SWARMSTEAD_DEMO__;
}

// ---------------------------------------------------------------- handlers

let lastSide = 0, lastBottom = 0;
function onSnapshot(snap) {
  state.snap = snap;
  world.setSnapshot(snap);
  renderHeader();
  const now = performance.now();
  if (now - lastSide > 300) { lastSide = now; renderSide(); }
  if (now - lastBottom > 700) { lastBottom = now; renderBottom(); }
  const alive = snap.agents.filter((a) => a.alive).length;
  const empty = $('empty');
  empty.hidden = alive > 0;
  if (!alive) empty.innerHTML = `${esc(T.ui.empty)}${state.mode === 'live' ? ` <button class="btn" id="try-demo">DEMO</button>` : ''}`;
  $('try-demo')?.addEventListener('click', () => { location.search = '?demo'; });
}

function onFx(fx) {
  world.applyFx(fx);
  const now = Date.now();
  for (const f of fx) {
    const ag = f.agentId && state.snap?.agents.find((a) => a.id === f.agentId);
    const fam = ag && state.snap?.familiars?.[ag.familiar];
    const who = fam ? nameOf(ag, fam) : ag?.project || '';
    if (f.fx === 'evolve' || f.fx === 'hatch') addLog(now, `★ ${who} ${f.fx === 'hatch' ? T.ui.hatched : T.ui.evolved} ${f.to}`, 'epic');
    else if (f.fx === 'levelup') addLog(now, `▲ ${who} → ${T.ui.level} ${f.level}`, 'xp');
    else if (f.fx === 'shiny') addLog(now, `✦ ${who} ${T.ui.shiny}`, 'epic');
    else if (f.fx === 'forecast') addLog(now, `≈ ${who}: ${f.workflow || ''} ${T.ui.usually} ${fmtUsd(f.expectedCost)} (${f.samples}×)`, 'xp');
    else if (f.fx === 'alert' && !state.seenAlerts.has(f.alert.id + f.alert.severity)) {
      state.seenAlerts.add(f.alert.id + f.alert.severity);
      addLog(now, `⚠ ${alertText(T, f.alert)}`, 'warn');
      if (f.alert.severity === 'crit') toast(f.alert); // warnings wait on the Monster board, toasts are for what can't
    } else if (f.fx === 'alert.resolve') state.seenAlerts.delete(f.alert.id + f.alert.severity);
  }
}

function onRoster(roster) {
  state.roster = roster;
  if (state.tab === 'roster') renderRoster();
}

function addLog(ts, text, level = 'info') {
  state.log.push({ ts, text, level, client: true });
  if (state.log.length > 120) state.log.shift();
}

// ---------------------------------------------------------------- header

function renderHeader() {
  const s = state.snap; if (!s) return;
  const t = s.totals;
  $('s-cost').textContent = fmtUsd(t.cost);
  $('s-burn').innerHTML = `${fmtUsd(s.burnRate)}<small>${esc(T.ui.perMin)}</small>`;
  $('s-burn-box').classList.toggle('hot', (s.alerts || []).some((a) => a.kind === 'burn'));
  const total = t.input + t.output + t.cacheRead + t.cacheWrite;
  $('s-tok').textContent = fmtTokens(total);
  $('s-tok2').textContent = `in ${fmtTokens(t.input + t.cacheWrite)} · out ${fmtTokens(t.output)}`;
  const ctx = t.input + t.cacheRead + t.cacheWrite;
  const hit = ctx ? Math.round((t.cacheRead / ctx) * 100) : 0;
  $('s-cache').textContent = `${hit}%`;
  $('s-cache-bar').style.width = `${hit}%`;
  const lim = s.limits?.codex?.primary;
  if (lim && lim.usedPercent != null) {
    $('s-block-k').textContent = 'Codex 5h';
    $('s-block').textContent = `${Math.round(lim.usedPercent)}%`;
    $('s-block-bar').style.width = `${Math.min(100, lim.usedPercent)}%`;
  } else if (s.block) {
    const left = s.block.end - s.now;
    $('s-block-k').textContent = T.ui.block;
    $('s-block').innerHTML = `${fmtDuration(Math.max(0, left))}<small> ${esc(T.ui.left)}</small>`;
    $('s-block-bar').style.width = `${Math.min(100, ((s.now - s.block.start) / (s.block.end - s.block.start)) * 100)}%`;
  }
  // forecasts: provider limit ETA, else the 5-hour block pace
  const bf = s.block?.forecast, lf = s.limitForecasts?.codex;
  const fEl = $('s-block-f');
  let warn = false;
  if (lf && lf.eta && lf.hitsBeforeReset) { fEl.textContent = `${T.ui.limitIn} ${fmtDuration(lf.eta - s.now)}`; warn = true; }
  else if (bf) { fEl.textContent = `${T.ui.blockPace} ~${fmtUsd(bf.projectedEnd)}${bf.ceiling ? ` / ${fmtUsd(bf.ceiling)}` : ''}`; warn = bf.hitsBeforeReset || bf.aboveUsual; }
  else fEl.textContent = '';
  fEl.style.color = warn ? 'var(--gold)' : '';
  $('s-block-box').classList.toggle('hot', !!(lf?.hitsBeforeReset && lf.eta - s.now < 30 * 60_000));
  // shipping: cost per commit across projects today
  const L = s.ledger || [];
  const commits = L.reduce((n, p) => n + p.commits, 0);
  const shippedN = L.reduce((n, p) => n + (p.shipped || 0), 0);
  $('s-commit').textContent = shippedN ? fmtUsd(L.reduce((n, p) => n + (p.shippedCost || 0), 0) / shippedN) : '—';
  const unshipped = L.reduce((n, p) => n + p.unshipped, 0);
  $('s-commit2').textContent = `${commits} ${T.ui.commits.toLowerCase()} · +${fmtUsd(unshipped)}`;
  $('s-commit2').title = `${fmtUsd(unshipped)} ${T.ui.unshipped.toLowerCase()}`;
  drawSpark(s.burn);
  $('clock').textContent = new Date(s.now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function drawSpark(burn) {
  const cv = $('spark'), x = cv.getContext('2d');
  x.clearRect(0, 0, cv.width, cv.height);
  const max = Math.max(0.05, ...burn);
  for (let i = 0; i < burn.length; i++) {
    const h = Math.round((burn[i] / max) * (cv.height - 1));
    x.fillStyle = i >= burn.length - 6 ? '#ffd34d' : '#7c5cff';
    if (h) x.fillRect(i, cv.height - h, 1, h);
  }
  x.fillStyle = '#3d3058'; x.fillRect(0, cv.height - 1, cv.width, 1);
}

// ---------------------------------------------------------------- side panel

const STATUS_COLOR = {
  writing: '#5cff8a', reading: '#7cf0ff', running: '#ffb35c', web: '#4d9dff', delegating: '#b69cff', planning: '#ffd34d',
  thinking: '#ffffff', tool: '#9aa3b5', permission: '#ff4d6d', waiting: '#4d9dff', compacting: '#c58bff', exhausted: '#ff9a3c', idle: '#6f6390', done: '#6f6390',
};

function famOf(ag) {
  return state.snap?.familiars?.[ag.familiar] || { key: ag.familiar, name: '?', form: 'Egg', stage: 0, species: 'egg', level: 1, xp: 0, into: 0, need: 40, genome: { hue: 30, accentHue: 200 } };
}

// Agents of the same project and type share a familiar; their number tells them apart.
function nameOf(ag, fam = famOf(ag)) {
  return `${fam.name}${ag.twin ? ` ${ag.twin}` : ''}`;
}

// What a subagent was asked to do, without the "<type>: " its card already shows.
function taskOf(ag) {
  const t = ag.task || '';
  return t.startsWith(`${ag.type}: `) ? t.slice(ag.type.length + 2) : t;
}

function renderSide() {
  const s = state.snap; if (!s) return;
  // finished agents linger briefly (so you see "done"), then drop off the list
  const agents = s.agents.filter((a) => a.alive || s.now - a.endedAt < 15_000 || a.id === state.selected);
  const alertBy = new Map();
  for (const al of s.alerts || []) if (al.agentId && (!alertBy.has(al.agentId) || al.severity === 'crit')) alertBy.set(al.agentId, al);
  const mains = agents.filter((a) => !a.parentId);
  const html = [];
  const chips = (ag) => {
    const out = [];
    if (ag.mode && ag.mode !== 'default') out.push(`<span class="chip ${ag.mode === 'bypassPermissions' ? 'danger' : ''}">${esc(T.ui.mode[ag.mode] || ag.mode)}</span>`);
    if (ag.effort) out.push(`<span class="chip">${esc(T.ui.effort)} ${esc(ag.effort)}</span>`);
    if (ag.worktree) out.push(`<span class="chip tree">⎇ ${esc(ag.worktree)}</span>`);
    if (ag.team) out.push(`<span class="chip">${esc(T.ui.team)} ${esc(ag.team)}</span>`);
    if (ag.background) out.push(`<span class="chip">${ag.background} ${esc(T.ui.background)}</span>`);
    if (ag.parallel >= 2) out.push(`<span class="chip">×${ag.parallel} ${esc(T.ui.parallel)}</span>`);
    if (!ag.alive && ag.outcome) out.push(`<span class="chip" style="color:${OUTCOME_COLOR[ag.outcome]}">${esc(T.ui.outcome[ag.outcome] || ag.outcome)}</span>`);
    return out.length ? `<div class="chips">${out.join('')}</div>` : '';
  };
  const card = (ag, sub) => {
    const fam = famOf(ag);
    const pct = ag.context?.window ? ag.context.used / ag.context.window : 0;
    const cls = pct > 0.75 ? 'hi' : pct > 0.5 ? 'mid' : 'ok';
    const al = alertBy.get(ag.id);
    return `<div class="card ${sub ? 'sub' : ''} ${state.selected === ag.id ? 'sel' : ''} ${ag.alive ? '' : 'gone'}" data-id="${esc(ag.id)}">
      <img class="portrait" src="${getPortrait(fam)}" alt="">
      <div style="min-width:0">
        <div class="name"><b>${esc(nameOf(ag, fam))}</b><span class="form">${esc(fam.form)}</span><span class="lv">${T.ui.level}${fam.level}</span></div>
        <div class="meta"><span>${esc(sub ? ag.type : ag.project)}</span>${ag.provider !== 'claude' ? `<span>· ${esc(ag.provider)}</span>` : ''}<span>· ${fmtUsd(ag.cost)}</span>${ag.model ? `<span>· ${esc(shortModel(ag.model))}</span>` : ''}</div>
        <div class="status"><i class="dot" style="background:${STATUS_COLOR[ag.status] || '#999'}"></i><span class="what">${esc(T.status[ag.status] || ag.status)}</span><span class="det">${esc(ag.detail || '')}</span></div>
        ${sub && ag.task ? `<div class="task" title="${esc(taskOf(ag))}">↳ ${esc(taskOf(ag))}</div>` : ''}
        ${chips(ag)}
        <div class="mini"><span>${T.ui.xp}</span><div class="bar xpbar"><i style="width:${Math.round((fam.into / Math.max(1, fam.need)) * 100)}%"></i></div><span>${fam.into}/${fam.need}</span></div>
        <div class="mini"><span>CTX</span><div class="bar ctxbar ${cls}"><i style="width:${Math.round(pct * 100)}%"></i></div><span>${Math.round(pct * 100)}%</span></div>
      </div>
      ${al ? `<i class="alertdot" style="background:${al.severity === 'crit' ? 'var(--red)' : al.severity === 'warn' ? 'var(--gold)' : '#4d9dff'}"></i>` : ''}
    </div>`;
  };
  // Big fan-outs: one summary row per stage instead of dozens of cards.
  // Agents with alerts are always listed individually.
  const stageRows = (m, kids) => {
    const run = (s.runs || []).find((r) => r.id === m.runId);
    const groups = new Map();
    for (const c of kids) { const g = c.stage || c.type; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(c); }
    const rows = [];
    const stages = run ? run.stages : [...groups.keys()].map((name) => ({ name, total: groups.get(name).length, running: groups.get(name).filter((c) => c.alive).length, done: 0, failed: 0 }));
    for (const st of stages) {
      const live = (groups.get(st.name) || []);
      const fam = state.snap.familiars?.[st.familiar] || (live[0] && famOf(live[0]));
      const key = `${m.id}|${st.name}`;
      const open = state.expanded.has(key);
      const pct = st.total ? Math.round(((st.done + st.failed) / st.total) * 100) : 0;
      rows.push(`<div class="card sub stagerow" data-stage="${esc(key)}">
        ${fam ? `<img class="portrait" src="${getPortrait(fam)}" alt="">` : '<i></i>'}
        <div style="min-width:0"><div class="name"><b>${esc(st.name)}</b><span class="form">${esc(fam?.form || '')}</span><span class="lv">${open ? '▾' : '▸'} ×${st.total}</span></div>
        <div class="meta"><span style="color:var(--cyan)">${st.running} ${esc(T.ui.running)}</span><span>· ${st.done} ${esc(T.ui.doneN)}</span>${st.failed ? `<span style="color:var(--red)">· ${st.failed} ${esc(T.ui.failedN)}</span>` : ''}${st.cost ? `<span>· ${fmtUsd(st.cost)}</span>` : ''}</div>
        <div class="mini"><span>${pct}%</span><div class="bar"><i style="width:${pct}%;background:${st.failed ? 'var(--gold)' : 'var(--green)'}"></i></div><span>${st.done + st.failed}/${st.total}</span></div></div></div>`);
      for (const c of live) if (open || alertBy.has(c.id)) rows.push(card(c, true));
    }
    return rows;
  };
  for (const m of mains) {
    html.push(card(m, false));
    const kids = m.children.map((id) => agents.find((x) => x.id === id)).filter(Boolean);
    const run = (s.runs || []).find((r) => r.id === m.runId);
    if (kids.length > 6 || (run && run.total > 8)) html.push(...stageRows(m, kids));
    else for (const c of kids) html.push(card(c, true));
  }
  for (const orphan of agents.filter((a) => a.parentId && !agents.some((m) => m.id === a.parentId))) html.push(card(orphan, true));
  $('party').innerHTML = html.join('') || `<div class="allclear" style="color:var(--muted)">${esc(T.ui.empty)}</div>`;
  $('party-n').textContent = agents.filter((a) => a.alive).length;
  for (const el of document.querySelectorAll('.card[data-id]')) el.onclick = () => world.select(el.dataset.id === state.selected ? null : el.dataset.id);
  for (const el of document.querySelectorAll('.stagerow')) el.onclick = () => { const k = el.dataset.stage; state.expanded.has(k) ? state.expanded.delete(k) : state.expanded.add(k); renderSide(); };
  renderDetail();
}

function renderDetail() {
  const el = $('detail');
  const ag = state.selected && state.snap?.agents.find((a) => a.id === state.selected);
  if (!ag) { el.innerHTML = ''; return; }
  const fam = famOf(ag);
  const stats = fam.stats || {};
  const bar = (k, v) => `<span>${esc(T.ui.stats[k])}</span><div class="bar"><i style="width:${Math.round(v)}%;background:${statColor(k)}"></i></div><span>${Math.round(v)}</span>`;
  const g = fam.nextGate;
  const pct = ag.context?.window ? Math.round((ag.context.used / ag.context.window) * 100) : 0;
  el.innerHTML = `<div class="detail">
    <div class="top"><img src="${getPortrait(fam)}" alt="">
      <div><div style="display:flex;justify-content:space-between"><h3>${esc(nameOf(ag, fam))}</h3><button class="x" id="close-detail">✕</button></div>
      <div class="sub">${esc(fam.form)} · ${esc(T.ui.traits[fam.trait] || fam.trait)} · ${esc(STAGES[fam.stage])}</div>
      <div class="mini" style="margin-top:6px"><span>${T.ui.level}${fam.level}</span><div class="bar xpbar"><i style="width:${Math.round((fam.into / Math.max(1, fam.need)) * 100)}%"></i></div><span>${fam.xp} XP</span></div>
      <div class="tags" style="display:flex;gap:4px;margin-top:6px;flex-wrap:wrap">${fam.shiny ? '<span class="tag shiny">SHINY</span>' : ''}${fam.corruption >= 0.5 ? '<span class="tag glitch">GLITCH</span>' : ''}${fam.branch === 'zen' ? '<span class="tag zen">ZEN</span>' : ''}${fam.branch === 'alchemist' ? '<span class="tag alch">ALCHEMIST</span>' : ''}${fam.accessory ? `<span class="tag">${esc(fam.accessory)}</span>` : ''}</div></div>
    </div>
    <div class="statgrid">${['focus', 'thrift', 'craft', 'cache', 'grit'].map((k) => bar(k, stats[k] || 0)).join('')}</div>
    ${g ? `<div class="gate ${g.ready ? 'ready' : ''}">${esc(T.ui.next)}: ${T.ui.level}${g.level} + ${esc(g.need)} ${g.ready ? '✓' : ''}</div>` : ''}
    <dl class="kv">
      ${ag.task ? `<dt>${esc(T.ui.party === 'Party' ? 'Task' : 'Nhiệm vụ')}</dt><dd title="${esc(taskOf(ag))}">${esc(taskOf(ag))}</dd>` : ''}
      <dt>${esc(T.ui.party === 'Party' ? 'Doing' : 'Đang làm')}</dt><dd>${esc(T.status[ag.status] || ag.status)} ${esc(ag.detail || '')}</dd>
      <dt>${esc(T.ui.model)}</dt><dd>${esc(ag.model || '—')}${ag.effort ? ` · ${esc(ag.effort)}` : ''}</dd>
      ${ag.mode ? `<dt>Mode</dt><dd>${esc(T.ui.mode[ag.mode] || ag.mode)}</dd>` : ''}
      ${ag.worktree ? `<dt>${esc(T.ui.worktree)}</dt><dd>${esc(ag.worktree)}</dd>` : ''}
      ${ag.stage && ag.parentId ? `<dt>${esc(T.ui.stage)}</dt><dd>${esc(ag.stage)}</dd>` : ''}
      ${ag.thinking ? `<dt>${esc(T.ui.thinking)}</dt><dd>${fmtTokens(ag.thinking)}</dd>` : ''}
      <dt>${esc(T.ui.cost)}</dt><dd>${fmtUsd(ag.cost)} · ${fmtTokens(ag.input + ag.output + ag.cacheRead + ag.cacheWrite)} tok</dd>
      <dt>${esc(T.ui.context)}</dt><dd>${fmtTokens(ag.context.used)} / ${fmtTokens(ag.context.window)} (${pct}%)</dd>
      <dt>${esc(T.ui.streak)}</dt><dd>${fam.streak || 0} (best ${fam.bestStreak || 0})</dd>
      <dt>${esc(T.ui.bugs)}</dt><dd>${fam.bugsSlain || 0} · ${esc(T.ui.turns)} ${fam.turns || 0}</dd>
    </dl>
  </div>`;
  $('close-detail').onclick = () => world.select(null);
}

function statColor(k) { return { focus: '#7cf0ff', thrift: '#ffd34d', craft: '#5cff8a', cache: '#b69cff', grit: '#ffb35c' }[k]; }

// ---------------------------------------------------------------- bottom tabs

for (const t of document.querySelectorAll('.tab')) {
  t.onclick = () => {
    state.tab = t.dataset.tab;
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x === t));
    document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('on', p.id === `pane-${state.tab}`));
    renderBottom();
  };
}

function renderBottom() {
  const s = state.snap; if (!s) return;
  const n = (s.alerts || []).filter((a) => a.severity !== 'info').length;
  const badge = $('alert-n');
  badge.textContent = (s.alerts || []).length;
  badge.classList.toggle('zero', n === 0);
  if (state.tab === 'alerts') renderAlerts();
  if (state.tab === 'log') renderLog();
  if (state.tab === 'roster') renderRoster();
  if (state.tab === 'timeline') renderTimeline();
  if (state.tab === 'ledger') renderLedger();
}

// ---------------------------------------------------------------- ledger: cost per commit / PR

function renderLedger() {
  const L = state.snap.ledger || [];
  if (!L.length) { $('pane-ledger').innerHTML = `<div class="allclear" style="color:var(--muted)">${esc(T.ui.noLedger)}</div>`; return; }
  const rows = L.map((p) => `<tr>
    <td><b class="px">${esc(p.project)}</b></td>
    <td class="num">${fmtUsd(p.cost)}</td>
    <td class="num">${p.commits}</td>
    <td class="num big">${p.costPerCommit != null ? fmtUsd(p.costPerCommit) : '—'}</td>
    <td class="num">${p.prsOpened} ${esc(T.ui.opened)} · ${p.prsMerged} ${esc(T.ui.merged)}</td>
    <td class="num">${p.costPerPr != null ? fmtUsd(p.costPerPr) : '—'}</td>
    <td class="num" style="color:${p.unshipped > 1 ? 'var(--gold)' : 'var(--muted)'}">${fmtUsd(p.unshipped)}</td>
    <td><div class="commits">${p.recent.slice().reverse().map((c) => `<span title="${new Date(c.ts).toLocaleTimeString()}">${esc(c.sha ? c.sha.slice(0, 7) : (c.human ? 'you' : 'agent'))} <b>${fmtUsd(c.cost)}</b></span>`).join('')}</div></td>
  </tr>`).join('');
  $('pane-ledger').innerHTML = `<div style="overflow-x:auto"><table class="ledger-table"><thead><tr>
    <th>${esc(T.ui.project)}</th><th>${esc(T.ui.costToday)}</th><th>${esc(T.ui.commits)}</th><th>${esc(T.ui.perCommit)}</th><th>${esc(T.ui.prs)}</th><th>$/PR</th><th>${esc(T.ui.unshipped)}</th><th>${esc(T.ui.recentCommits)}</th>
  </tr></thead><tbody>${rows}</tbody></table></div>`;
}

// ---------------------------------------------------------------- approvals (answer permission prompts here / on the phone)

function onApprovals(list) {
  state.approvals = list || { pending: [], recent: [] };
  renderApprovals();
}

function renderApprovals() {
  const pend = state.approvals.pending || [];
  $('approvals').hidden = pend.length === 0;
  $('approvals-n').textContent = pend.length;
  const now = Date.now();
  $('approvals-list').innerHTML = pend.map((a) => `<div class="ap">
    <div class="who"><span>${esc(a.label || a.agentId)}${a.sub ? ' <small>subagent</small>' : ''}</span><small>${esc(T.ui.expiresIn)} ${fmtDuration(Math.max(0, a.expires - now))}</small></div>
    <code>${esc(a.tool)}${a.detail ? ': ' + esc(a.detail) : ''}</code>
    <div class="acts">
      <button class="btn sm ok" data-ap="${esc(a.id)}" data-d="allow">${esc(T.ui.approve)}</button>
      ${a.canRemember ? `<button class="btn sm" data-ap="${esc(a.id)}" data-d="allow-session">${esc(T.ui.allowSession)}</button>` : ''}
      <button class="btn sm no" data-ap="${esc(a.id)}" data-d="deny">${esc(T.ui.deny)}</button>
    </div></div>`).join('');
  for (const b of document.querySelectorAll('[data-ap]')) b.onclick = () => decide(b.dataset.ap, b.dataset.d);
}

async function decide(id, d) {
  state.approvals.pending = state.approvals.pending.filter((a) => a.id !== id);
  renderApprovals();
  if (state.mode === 'demo') return state.sim?.decide(id, d);
  try { await api(`/api/approvals/${encodeURIComponent(id)}`, { method: 'POST', body: JSON.stringify({ decision: d }) }); }
  catch (e) { toast({ severity: 'warn', custom: `Approval failed (${e.message}).` }); }
}
setInterval(() => { if ((state.approvals.pending || []).length) renderApprovals(); }, 1000);

// ---------------------------------------------------------------- replay + post-mortem

async function openReplay() {
  $('replay').hidden = false;
  const sel = $('rp-src');
  const opts = [];
  if (state.mode === 'demo') opts.push(['demo', T.ui.thisDemo]);
  else {
    try { for (const d of await api('/api/replay/days')) opts.push([`day:${d.day}`, `${d.day} (${Math.max(1, Math.round(d.bytes / 1024))} KB)`]); } catch {}
  }
  opts.push(['file', T.ui.loadFile]);
  sel.innerHTML = opts.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('');
  $('rp-export').hidden = state.mode === 'demo' || !!globalThis.__SWARMSTEAD_DEMO__;
  await loadSource(sel.value);
}

async function loadSource(v) {
  if (v === 'file') { $('rp-file').click(); return; }
  let events = [];
  if (v === 'demo') events = state.sim?.getEvents() || [];
  else if (v.startsWith('day:')) { try { events = await api(`/api/replay/${v.slice(4)}`); } catch { events = []; } }
  startReplay(events, v === 'demo' ? T.ui.thisDemo : v.slice(4));
}

function startReplay(events, label = '') {
  state.replay?.destroy();
  if (!events.length) { toast({ severity: 'warn', custom: T.ui.replayEmpty }); return; }
  state.replaying = true;
  state.replayEvents = events;
  state.replayLabel = label;
  world.reset();
  state.seenAlerts.clear();
  state.replay = new Replay(events, { onFx, onSnapshot, onRoster, onTime: updateScrubber });
  state.replay.setSpeed(Number($('rp-speed').value));
  state.replay.play();
  $('mode').className = 'badge demo';
  $('mode').textContent = `${T.ui.replay.toUpperCase()}`;
}

function updateScrubber(clock, r) {
  if (!r) return;
  const span = Math.max(1, r.t1 - r.t0);
  if (!state.dragging) $('rp-pos').value = Math.round(((clock - r.t0) / span) * 1000);
  $('rp-time').textContent = new Date(clock).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  $('rp-play').textContent = r.playing ? '❚❚' : '▶';
}

function exitReplay() {
  state.replay?.destroy();
  state.replay = null;
  state.replaying = false;
  $('replay').hidden = true;
  world.reset();
  state.seenAlerts.clear();
  setMode(state.mode);
  if (state.liveSnap) onSnapshot(state.liveSnap);
}

function showPostmortem() {
  const events = state.replayEvents || state.sim?.getEvents() || [];
  if (!events.length) { toast({ severity: 'warn', custom: T.ui.replayEmpty }); return; }
  const pm = postmortem(events, { lang });
  const md = postmortemMarkdown(pm, { title: `Swarmstead post-mortem${state.replayLabel ? ' · ' + state.replayLabel : ''}` });
  $('pm-md').value = md;
  const bars = (map, nameOf = (k) => k) => {
    const rows = Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, 6);
    const max = Math.max(0.0001, ...rows.map((r) => r[1]));
    return rows.map(([k, v]) => `<div class="pm-row"><span>${esc(nameOf(k))}</span><span>${fmtUsd(v)}</span><span><div class="bar"><i style="width:${Math.round((v / max) * 100)}%;background:var(--violet)"></i></div></span></div>`).join('') || `<div class="pm-row"><span style="color:var(--muted)">—</span></div>`;
  };
  const wastePct = pm.cost ? Math.round((pm.waste / pm.cost) * 100) : 0;
  $('pm-body').innerHTML = `
    <div class="pm-kpis">
      <div><small>${esc(T.ui.spent)}</small><b>${fmtUsd(pm.cost)}</b></div>
      <div class="${wastePct >= 10 ? 'bad' : ''}"><small>${esc(T.ui.waste)}</small><b>${fmtUsd(pm.waste)} · ${wastePct}%</b></div>
      <div><small>${esc(T.ui.cache)}</small><b>${Math.round(pm.cacheHit * 100)}%</b></div>
      <div><small>${esc(T.ui.perCommit)}</small><b>${pm.costPerCommit != null ? fmtUsd(pm.costPerCommit) : '—'}</b></div>
      <div><small>${esc(T.ui.turns)}</small><b>${pm.turnCount}</b></div>
      <div><small>${esc(T.ui.incidents)}</small><b>${pm.incidents.length}</b></div>
    </div>
    <div class="pm-grid">
      <div class="pm-sec"><h3>${esc(T.ui.byActivity)}</h3>${bars(pm.byActivity, (k) => T.status[k] || k)}</div>
      <div class="pm-sec"><h3>${esc(T.ui.byProject)}</h3>${bars(pm.byProject)}</div>
      <div class="pm-sec"><h3>${esc(T.ui.byType)}</h3>${bars(pm.byType)}</div>
      <div class="pm-sec"><h3>${esc(T.ui.byModel)}</h3>${bars(pm.byModel, shortModel)}</div>
    </div>
    <div class="pm-sec"><h3>${esc(T.ui.topTurns)}</h3><div style="overflow-x:auto"><table class="ledger-table"><thead><tr><th>Agent</th><th>${esc(T.ui.project)}</th><th>$</th><th>Tools</th><th>Edits</th><th>Loops</th><th>Time</th></tr></thead><tbody>
      ${pm.topTurns.map((t) => `<tr><td>${esc(t.type)}</td><td>${esc(t.project)}</td><td class="num big">${fmtUsd(t.cost)}</td><td class="num">${t.tools}</td><td class="num">${t.edits}</td><td class="num" style="color:${t.loops ? 'var(--red)' : ''}">${t.loops}</td><td class="num">${fmtDuration(t.durationMs)}</td></tr>`).join('')}
    </tbody></table></div></div>
    <div class="pm-sec"><h3>${esc(T.ui.incidents)}</h3><ul class="pm-list">${pm.incidents.slice(0, 15).map((i) => `<li><span class="sev ${i.severity}" style="display:inline-block;padding:2px 4px;margin-right:6px">${i.severity.toUpperCase()}</span>${new Date(i.ts).toLocaleTimeString()} · ${esc(alertText(T, i))}</li>`).join('') || '<li>—</li>'}</ul></div>`;
  $('pm').hidden = false;
}

$('b-replay').onclick = () => { if ($('replay').hidden) openReplay(); else exitReplay(); };
$('rp-src').onchange = (e) => loadSource(e.target.value);
$('rp-file').onchange = async (e) => { const f = e.target.files?.[0]; if (f) startReplay(parseEvents(await f.text()), f.name); };
$('rp-play').onclick = () => { const r = state.replay; if (!r) return; r.playing ? r.pause() : r.play(); updateScrubber(r.clock, r); };
$('rp-speed').onchange = (e) => state.replay?.setSpeed(Number(e.target.value));
$('rp-pos').oninput = () => { state.dragging = true; };
$('rp-pos').onchange = (e) => {
  state.dragging = false;
  const r = state.replay; if (!r) return;
  const wasPlaying = r.playing;
  world.reset();
  r.seek(r.t0 + (Number(e.target.value) / 1000) * (r.t1 - r.t0));
  if (wasPlaying) r.play();
};
$('rp-pm').onclick = showPostmortem;
$('rp-exit').onclick = exitReplay;
$('rp-export').onclick = () => {
  const blob = new Blob([JSON.stringify(state.replayEvents || [])], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `swarmstead-${state.replayLabel || 'events'}.json` });
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
};
$('pm-close').onclick = () => { $('pm').hidden = true; };
$('pm').onclick = (e) => { if (e.target === $('pm')) $('pm').hidden = true; };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('pm').hidden = true; });
$('pm-copy').onclick = async () => {
  const md = $('pm-md').value;
  try { await navigator.clipboard.writeText(md); $('pm-copy').textContent = T.ui.copied; setTimeout(() => { $('pm-copy').textContent = T.ui.copyMd; }, 1500); }
  catch { const ta = $('pm-md'); ta.hidden = false; ta.style.cssText = 'margin:0 14px 14px;height:160px;background:#120e1b;color:var(--text);border:1px solid var(--line)'; ta.select(); }
};
// drag & drop an exported file anywhere to replay it
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types?.includes('Files')) { dragDepth++; $('dropzone').hidden = false; } });
window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('dropzone').hidden = true; });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault(); dragDepth = 0; $('dropzone').hidden = true;
  const f = e.dataTransfer?.files?.[0];
  if (!f) return;
  try { $('replay').hidden = false; startReplay(parseEvents(await f.text()), f.name); } catch { toast({ severity: 'warn', custom: T.ui.replayEmpty }); }
});

function renderAlerts() {
  const s = state.snap;
  const now = s.now;
  const row = (al, resolved) => `<div class="alert ${resolved ? 'resolved' : ''}">
    <span class="sev ${al.severity}">${al.severity.toUpperCase()}</span>
    <div><div class="msg">${esc(alertText(T, al))}</div><div class="hint">${esc(alertHint(T, al))}</div></div>
    <span class="age">${fmtDuration(now - al.since)}</span></div>`;
  const active = (s.alerts || []).map((a) => row(a, false)).join('');
  const past = (s.alertHistory || []).slice(-6).reverse().map((a) => row(a, true)).join('');
  $('pane-alerts').innerHTML = (active || `<div class="allclear">✓ ${esc(T.ui.noAlerts)}</div>`) + past;
}

function renderLog() {
  const s = state.snap;
  const names = new Map(s.agents.map((a) => [a.id, famOf(a).name]));
  const lines = [
    ...(s.feed || []).map((f) => ({ ts: f.ts, text: `${names.get(f.agentId) ? names.get(f.agentId) + ' · ' : ''}${f.text}`, level: f.level })),
    ...state.log,
  ].sort((a, b) => b.ts - a.ts).slice(0, 120);
  $('pane-log').innerHTML = lines.map((l) => `<div><time>${new Date(l.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time><span class="${esc(l.level)}">${esc(l.text)}</span></div>`).join('');
}

function renderRoster() {
  const list = state.roster || [];
  const cards = list.map((f) => {
    const line = SPECIES[f.trait]?.names || [];
    return `<div class="beast"><img src="${getPortrait(f)}" alt="">
      <div style="min-width:0"><div class="name"><b>${esc(f.name)}</b><span class="lv">${T.ui.level}${f.level}</span></div>
      <div class="form px" style="color:var(--violet)">${esc(f.form)} · ${esc(f.project)}${f.type !== 'main' ? ' / ' + esc(f.type) : ''}</div>
      <div class="stages">${[0, 1, 2, 3, 4].map((i) => `<i class="${i <= f.stage ? 'on' : ''}" title="${esc(i ? (Array.isArray(line[i - 1]) ? line[i - 1].join(' / ') : line[i - 1]) : 'Egg')}"></i>`).join('')}</div>
      <div class="meta"><span>${esc(T.ui.traits[f.trait] || f.trait)}</span><span>· F${f.stats.focus} T${f.stats.thrift}</span><span>· 🐞${f.bugsSlain}</span></div>
      <div class="tags">${f.shiny ? '<span class="tag shiny">SHINY</span>' : ''}${f.corruption >= 0.5 ? '<span class="tag glitch">GLITCH</span>' : ''}${f.branch === 'zen' ? '<span class="tag zen">ZEN</span>' : ''}${f.branch === 'alchemist' ? '<span class="tag alch">ALCHEMIST</span>' : ''}${f.nextGate ? `<span class="tag">${esc(T.ui.next)}: ${T.ui.level}${f.nextGate.level}</span>` : ''}</div>
      </div></div>`;
  }).join('');
  $('pane-roster').innerHTML = `<div class="bestiary">${cards}</div>${howTo()}`;
}

function howTo() {
  return lang === 'vi'
    ? `<div class="howto"><b>Tiến hoá thế nào?</b> Mỗi agent (theo dự án + loại) có một linh thú sống qua nhiều phiên. XP chỉ đến từ <b>lượt làm việc đã xong</b>: <code>10 × khối lượng × chất lượng × tiết kiệm × cache</code> + thưởng diệt bug. Lặp vòng và lỗi lặp lại làm giảm XP và gây <b>glitch</b>. Loài do <b>thói quen làm việc</b> quyết định (đọc → Cú, viết → Cáo, chạy lệnh → Robot, lướt web → Thỏ, giao việc → Mèo). Mỗi lần tiến hoá cần cả cấp độ lẫn một điều kiện chất lượng. 10 lượt sạch liên tiếp → <b>SHINY</b>.</div>`
    : `<div class="howto"><b>How evolution works.</b> Each agent identity (project + agent type) owns a familiar that lives across sessions. XP comes only from <b>finished turns</b>: <code>10 × work × quality × thrift × cache</code> + a bonus per bug slain. Loops and repeated errors cut XP and cause <b>glitch</b>. Species follows <b>work style</b> (reading → Owl, writing → Fox, running → Bot, web → Bunny, delegating → Cat). Every evolution needs a level <i>and</i> a quality gate. A 10-turn clean streak makes it <b>SHINY</b>.</div>`;
}

// ---------------------------------------------------------------- banner + toasts

let bannerTimer = 0;
function showBanner(a, f) {
  if (f.fx === 'hatch') return; // every new familiar hatches after its first turn: the quest log has it
  const fam = state.snap?.familiars?.[a.agent.familiar];
  const el = $('banner');
  el.innerHTML = `<div class="t1">EVOLUTION!</div>
    ${fam ? `<img src="${getPortrait(fam)}" alt="">` : ''}
    <div class="t2">${esc(fam?.name || '')} ${esc(f.fx === 'hatch' ? T.ui.hatched : T.ui.evolved)} ${esc(f.to)}</div>
    <div class="t3">${esc(f.from)} → ${esc(f.to)} · ${esc(STAGES[f.stage] || '')}</div>`;
  clearTimeout(bannerTimer);
  setTimeout(() => el.classList.add('show'), 2200);
  bannerTimer = setTimeout(() => el.classList.remove('show'), 6200);
}

function toast(al) {
  const el = document.createElement('div');
  el.className = `toast ${al.severity === 'crit' ? '' : al.severity === 'info' ? 'info' : 'warn'}`;
  const head = al.severity === 'crit' ? '⚠ CRITICAL' : al.severity === 'info' ? '★ ARENA' : al.custom ? '•' : '⚠ WARNING';
  el.innerHTML = `<b style="color:${al.severity === 'crit' ? 'var(--red)' : al.severity === 'info' ? 'var(--violet)' : 'var(--gold)'}">${head}</b>${esc(al.custom || alertText(T, al))}`;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 5000);
  while ($('toasts').children.length > 2) $('toasts').firstChild.remove();
}

// ---------------------------------------------------------------- controls & i18n

function applyLang() {
  T = getDict(lang);
  document.documentElement.lang = lang;
  for (const el of document.querySelectorAll('[data-i18n]')) {
    const v = el.dataset.i18n.split('.').reduce((o, k) => o?.[k], T);
    if (typeof v === 'string') el.textContent = v;
  }
  $('b-lang').textContent = lang.toUpperCase();
  world.allInText = T.ui.allIn;
  renderViews();
  setMode(state.mode === 'live' ? 'live' : 'demo');
  renderLegend();
  renderSide(); renderBottom(); renderApprovals();
}

function renderLegend() {
  if (world.view === 'arena') {
    const vi = lang === 'vi';
    const items = [
      ['#7dff9a', vi ? 'Cuộn xanh = báo cáo sạch' : 'Green scroll = clean report'],
      ['#ffd34d', vi ? 'Vàng = có trục trặc' : 'Yellow = rough'],
      ['#ff5c7a', vi ? 'Đỏ = thất bại' : 'Red = failed'],
      ['#c58bff', vi ? 'Tím = có thể mất khi nén' : 'Purple = maybe lost to compaction'],
      ['#b69cff', vi ? 'Bệ = giai đoạn, ×N = đội' : 'Pad = stage, ×N = squad'],
    ];
    $('legend').innerHTML = items.map(([c, t]) => `<span><i style="background:${c}"></i>${esc(t)}</span>`).join('');
    return;
  }
  const items = [
    ['#7cf0ff', lang === 'vi' ? 'Kệ sách = đọc' : 'Bookshelf = reading'],
    ['#ffd34d', lang === 'vi' ? 'Bảng = kế hoạch' : 'Whiteboard = planning'],
    ['#4d9dff', lang === 'vi' ? 'Quả cầu = web' : 'Globe = web'],
    ['#ffb35c', lang === 'vi' ? 'Tủ server = chạy lệnh' : 'Server rack = commands'],
    ['#b69cff', lang === 'vi' ? 'Cổng = subagent' : 'Portal = subagents'],
    ['#ff4d6d', lang === 'vi' ? 'Quái đỏ = test fail' : 'Red slime = failing test'],
  ];
  $('legend').innerHTML = items.map(([c, t]) => `<span><i style="background:${c}"></i>${esc(t)}</span>`).join('');
}

$('b-lang').onclick = () => { lang = lang === 'vi' ? 'en' : 'vi'; try { localStorage.setItem('swarmstead.lang', lang); } catch {} applyLang(); };
$('b-sound').onclick = () => { const on = sound.toggle(); $('b-sound').textContent = on ? '♪ ON' : '♪ OFF'; $('b-sound').classList.toggle('on', on); };
$('b-sound').textContent = sound.enabled ? '♪ ON' : '♪ OFF';
$('b-sound').classList.toggle('on', sound.enabled);
$('b-speed').onclick = () => { state.speed = state.speed >= 4 ? 1 : state.speed * 2; state.sim?.setSpeed(state.speed); $('b-speed').textContent = `${state.speed}×`; };
$('b-demo').onclick = () => { location.search = state.mode === 'demo' ? '' : '?demo'; };
for (const b of document.querySelectorAll('#views [data-view]')) b.onclick = () => { world.setViewMode(b.dataset.view); renderViews(); renderLegend(); };

function renderViews() {
  for (const b of document.querySelectorAll('#views [data-view]')) {
    b.classList.toggle('on', b.dataset.view === world.viewMode);
    if (b.dataset.view !== 'auto') b.textContent = b.dataset.view === 'room' ? T.ui.room : T.ui.arena;
  }
  $('view-now').textContent = world.viewMode === 'auto' ? `→ ${world.view === 'arena' ? T.ui.arena : T.ui.room}` : '';
}

// ---------------------------------------------------------------- timeline (swimlanes of the focus run)

function renderTimeline() {
  const pane = $('pane-timeline');
  const run = world.focusRun;
  if (!run) { pane.innerHTML = `<div class="allclear" style="color:var(--muted)">${esc(T.ui.noRun)}</div>`; return; }
  if (!$('tl')) pane.innerHTML = '<div class="tl-head" id="tl-head"></div><div class="tl-wrap"><canvas id="tl"></canvas></div>';
  const now = state.snap.now;
  $('tl-head').innerHTML = `<b>${esc(run.workflow || run.project)}</b> · ${run.done + run.failed}/${run.total} ${esc(T.ui.doneN)} · ${run.running} ${esc(T.ui.running)}${run.failed ? ` · <span style="color:var(--red)">${run.failed} ${esc(T.ui.failedN)}</span>` : ''} · ${fmtUsd(run.cost)}${run.forecast?.projectedCost != null && !run.endedAt ? ` <span style="color:${run.forecast.projectedCost > (run.forecast.expectedCost || Infinity) * 1.5 ? 'var(--gold)' : 'var(--muted)'}">(~${fmtUsd(run.forecast.projectedCost)} ${esc(T.ui.projected)}${run.forecast.samples ? `, ${esc(T.ui.usually)} ${fmtUsd(run.forecast.expectedCost)}` : ''})</span>` : ''} · ${fmtDuration((run.endedAt || now) - run.startedAt)}`;
  const cv = $('tl');
  const W = Math.max(320, cv.parentElement.clientWidth - 2);
  const rows = run.timeline.length;
  const labelW = 110;
  const rowH = rows > 120 ? 2 : rows > 60 ? 3 : rows > 30 ? 5 : 8;
  const gap = rowH >= 5 ? 1 : 0;
  const stageGap = 6;
  const H = Math.max(80, rows * (rowH + gap) + run.stages.length * stageGap + 26);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + 'px'; cv.style.height = H + 'px';
  const x = cv.getContext('2d');
  x.scale(dpr, dpr);
  x.clearRect(0, 0, W, H);
  const t0 = run.startedAt, t1 = Math.max(run.endedAt || now, t0 + 60_000);
  const sx = (ts) => labelW + ((ts - t0) / (t1 - t0)) * (W - labelW - 8);
  // grid: one line per minute (or 5 min)
  const span = (t1 - t0) / 60_000;
  const step = span > 60 ? 10 : span > 20 ? 5 : 1;
  x.font = '10px ui-monospace, Menlo, monospace';
  for (let m = 0; m <= span; m += step) {
    const gx = Math.round(sx(t0 + m * 60_000)) + 0.5;
    x.fillStyle = '#2f2645'; x.fillRect(gx, 14, 1, H - 14);
    x.fillStyle = '#6f6390'; x.fillText(`${m}m`, gx + 2, 10);
  }
  let y = 18;
  const medians = new Map(run.stages.map((st, i) => [i, st.median]));
  run.stages.forEach((st, si) => {
    const items = run.timeline.filter((r) => r[1] === si).sort((a, b) => a[2] - b[2]);
    x.fillStyle = '#a497c4';
    x.fillText(`${st.name.slice(0, 14)} ${st.done + st.failed}/${st.total}`, 4, y + Math.max(8, rowH));
    for (const [, , start, end, outcome] of items) {
      const e = end || now;
      const bx = sx(start), bw = Math.max(2, sx(e) - bx);
      const running = !end;
      x.fillStyle = running ? (Math.floor(Date.now() / 400) % 2 ? '#7cf0ff' : '#5ad6e8') : (OUTCOME_COLOR[outcome] || '#7dff9a');
      x.fillRect(bx, y, bw, rowH);
      const med = medians.get(si);
      if (running && med && e - start > 3 * med && e - start > 120_000) { x.strokeStyle = '#ff4d6d'; x.lineWidth = 1; x.strokeRect(bx - 0.5, y - 0.5, bw + 1, rowH + 1); }
      y += rowH + gap;
    }
    y += stageGap;
  });
  const nx = Math.round(sx(now)) + 0.5;
  if (!run.endedAt) { x.fillStyle = '#ffd34d'; x.fillRect(nx, 14, 1, H - 14); }
}

// animated logo villager
(function logo() {
  const cv = $('logo'), x = cv.getContext('2d');
  const fam = { key: 'logo', species: 'fox', stage: 3, branch: 'zen', accessory: null, genome: { hue: 10, accentHue: 280, pattern: 'plain', eyes: 'big' } };
  let f = 0;
  setInterval(() => { x.clearRect(0, 0, 20, 22); x.drawImage(getSprite(fam, 'idle', f++ % 2, f % 9 === 0 ? 'blink' : ''), 0, 0); }, 450);
})();

applyLang();
boot();
