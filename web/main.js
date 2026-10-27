// Agent Village — browser entry point.
// Live mode: subscribe to the local daemon (SSE). Demo mode: run the simulator in-page.

import { WorldView } from './render/world.js';
import { getPortrait, getSprite } from './render/sprites.js';
import { Sound } from './sound.js';
import { getDict, alertText, alertHint } from '../core/i18n.js';
import { fmtUsd, fmtTokens, fmtDuration } from '../core/util.js';
import { STAGES, SPECIES, TRAITS } from '../core/evolution.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const params = new URLSearchParams(location.search);
let lang = 'en';
try { lang = localStorage.getItem('av.lang') || (navigator.language || 'en').slice(0, 2); } catch {}
let T = getDict(lang);

const sound = new Sound();
const state = { snap: null, roster: [], selected: null, mode: 'demo', log: [], seenAlerts: new Set(), tab: 'alerts', sim: null, speed: 1 };

const world = new WorldView($('world'), { sound, onSelect: (id) => { state.selected = id; renderSide(); } });
world.onEvolve = (a, f) => showBanner(a, f);
if (params.has('hour')) world.forceHour = Number(params.get('hour')); // preview day/night: ?demo&hour=22
if (params.has('lang')) lang = params.get('lang');

// ---------------------------------------------------------------- data sources

async function boot() {
  const wantDemo = params.has('demo') || location.protocol === 'file:' || globalThis.__AV_DEMO__;
  if (!wantDemo && await daemonReachable()) startLive();
  else startDemo();
}

async function daemonReachable() {
  try { const r = await fetch('/api/health', { cache: 'no-store' }); return r.ok; } catch { return false; }
}

function startLive() {
  state.mode = 'live';
  setMode('live');
  const es = new EventSource('/api/stream');
  es.onmessage = (m) => {
    let msg; try { msg = JSON.parse(m.data); } catch { return; }
    if (msg.type === 'snapshot') onSnapshot(msg.state);
    else if (msg.type === 'fx') onFx(msg.fx);
    else if (msg.type === 'roster') onRoster(msg.roster);
    else if (msg.type === 'hello') setMode('live');
  };
  es.onerror = () => setMode('offline');
}

async function startDemo() {
  state.mode = 'demo';
  setMode('demo');
  const { DemoSim } = await import('./sim/demo.js');
  state.sim = new DemoSim({ onFx, onSnapshot, onRoster, speed: state.speed });
  state.sim.start();
}

function setMode(m) {
  const b = $('mode');
  b.className = `badge ${m}`;
  b.textContent = m === 'live' ? T.ui.live : m === 'demo' ? T.ui.demo : T.ui.offline;
  $('b-speed').hidden = state.mode !== 'demo';
  $('b-demo').textContent = state.mode === 'demo' ? 'LIVE' : 'DEMO';
  $('b-demo').hidden = !!globalThis.__AV_DEMO__;
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
    const who = fam?.name || ag?.project || '';
    if (f.fx === 'evolve' || f.fx === 'hatch') addLog(now, `★ ${who} ${f.fx === 'hatch' ? T.ui.hatched : T.ui.evolved} ${f.to}`, 'epic');
    else if (f.fx === 'levelup') addLog(now, `▲ ${who} → ${T.ui.level} ${f.level}`, 'xp');
    else if (f.fx === 'shiny') addLog(now, `✦ ${who} ${T.ui.shiny}`, 'epic');
    else if (f.fx === 'alert' && !state.seenAlerts.has(f.alert.id + f.alert.severity)) {
      state.seenAlerts.add(f.alert.id + f.alert.severity);
      addLog(now, `⚠ ${alertText(T, f.alert)}`, 'warn');
      if (f.alert.severity !== 'info') toast(f.alert);
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
  thinking: '#ffffff', tool: '#9aa3b5', permission: '#ff4d6d', waiting: '#4d9dff', compacting: '#c58bff', idle: '#6f6390', done: '#6f6390',
};

function famOf(ag) {
  return state.snap?.familiars?.[ag.familiar] || { key: ag.familiar, name: '?', form: 'Egg', stage: 0, species: 'egg', level: 1, xp: 0, into: 0, need: 40, genome: { hue: 30, accentHue: 200 } };
}

function renderSide() {
  const s = state.snap; if (!s) return;
  // finished agents linger briefly (so you see "done"), then drop off the list
  const agents = s.agents.filter((a) => a.alive || s.now - a.endedAt < 15_000 || a.id === state.selected);
  const alertBy = new Map();
  for (const al of s.alerts || []) if (al.agentId && (!alertBy.has(al.agentId) || al.severity === 'crit')) alertBy.set(al.agentId, al);
  const mains = agents.filter((a) => !a.parentId);
  const html = [];
  const card = (ag, sub) => {
    const fam = famOf(ag);
    const pct = ag.context?.window ? ag.context.used / ag.context.window : 0;
    const cls = pct > 0.75 ? 'hi' : pct > 0.5 ? 'mid' : 'ok';
    const al = alertBy.get(ag.id);
    return `<div class="card ${sub ? 'sub' : ''} ${state.selected === ag.id ? 'sel' : ''} ${ag.alive ? '' : 'gone'}" data-id="${esc(ag.id)}">
      <img class="portrait" src="${getPortrait(fam)}" alt="">
      <div style="min-width:0">
        <div class="name"><b>${esc(fam.name)}</b><span class="form">${esc(fam.form)}</span><span class="lv">${T.ui.level}${fam.level}</span></div>
        <div class="meta"><span>${esc(sub ? ag.type : ag.project)}</span>${ag.provider !== 'claude' ? `<span>· ${esc(ag.provider)}</span>` : ''}<span>· ${fmtUsd(ag.cost)}</span>${ag.model ? `<span>· ${esc(shortModel(ag.model))}</span>` : ''}</div>
        <div class="status"><i class="dot" style="background:${STATUS_COLOR[ag.status] || '#999'}"></i><span class="what">${esc(T.status[ag.status] || ag.status)}</span><span class="det">${esc(ag.detail || '')}</span></div>
        <div class="mini"><span>${T.ui.xp}</span><div class="bar xpbar"><i style="width:${Math.round((fam.into / Math.max(1, fam.need)) * 100)}%"></i></div><span>${fam.into}/${fam.need}</span></div>
        <div class="mini"><span>CTX</span><div class="bar ctxbar ${cls}"><i style="width:${Math.round(pct * 100)}%"></i></div><span>${Math.round(pct * 100)}%</span></div>
      </div>
      ${al ? `<i class="alertdot" style="background:${al.severity === 'crit' ? 'var(--red)' : al.severity === 'warn' ? 'var(--gold)' : '#4d9dff'}"></i>` : ''}
    </div>`;
  };
  for (const m of mains) {
    html.push(card(m, false));
    for (const id of m.children) { const c = agents.find((x) => x.id === id); if (c) html.push(card(c, true)); }
  }
  for (const orphan of agents.filter((a) => a.parentId && !agents.some((m) => m.id === a.parentId))) html.push(card(orphan, true));
  $('party').innerHTML = html.join('') || `<div class="allclear" style="color:var(--muted)">${esc(T.ui.empty)}</div>`;
  $('party-n').textContent = agents.filter((a) => a.alive).length;
  for (const el of document.querySelectorAll('.card')) el.onclick = () => world.select(el.dataset.id === state.selected ? null : el.dataset.id);
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
      <div><div style="display:flex;justify-content:space-between"><h3>${esc(fam.name)}</h3><button class="x" id="close-detail">✕</button></div>
      <div class="sub">${esc(fam.form)} · ${esc(T.ui.traits[fam.trait] || fam.trait)} · ${esc(STAGES[fam.stage])}</div>
      <div class="mini" style="margin-top:6px"><span>${T.ui.level}${fam.level}</span><div class="bar xpbar"><i style="width:${Math.round((fam.into / Math.max(1, fam.need)) * 100)}%"></i></div><span>${fam.xp} XP</span></div>
      <div class="tags" style="display:flex;gap:4px;margin-top:6px;flex-wrap:wrap">${fam.shiny ? '<span class="tag shiny">SHINY</span>' : ''}${fam.corruption >= 0.5 ? '<span class="tag glitch">GLITCH</span>' : ''}${fam.branch === 'zen' ? '<span class="tag zen">ZEN</span>' : ''}${fam.branch === 'alchemist' ? '<span class="tag alch">ALCHEMIST</span>' : ''}${fam.accessory ? `<span class="tag">${esc(fam.accessory)}</span>` : ''}</div></div>
    </div>
    <div class="statgrid">${['focus', 'thrift', 'craft', 'cache', 'grit'].map((k) => bar(k, stats[k] || 0)).join('')}</div>
    ${g ? `<div class="gate ${g.ready ? 'ready' : ''}">${esc(T.ui.next)}: ${T.ui.level}${g.level} + ${esc(g.need)} ${g.ready ? '✓' : ''}</div>` : ''}
    <dl class="kv">
      <dt>${esc(T.ui.party === 'Party' ? 'Doing' : 'Đang làm')}</dt><dd>${esc(T.status[ag.status] || ag.status)} ${esc(ag.detail || '')}</dd>
      <dt>${esc(T.ui.model)}</dt><dd>${esc(ag.model || '—')}</dd>
      <dt>${esc(T.ui.cost)}</dt><dd>${fmtUsd(ag.cost)} · ${fmtTokens(ag.input + ag.output + ag.cacheRead + ag.cacheWrite)} tok</dd>
      <dt>${esc(T.ui.context)}</dt><dd>${fmtTokens(ag.context.used)} / ${fmtTokens(ag.context.window)} (${pct}%)</dd>
      <dt>${esc(T.ui.streak)}</dt><dd>${fam.streak || 0} (best ${fam.bestStreak || 0})</dd>
      <dt>${esc(T.ui.bugs)}</dt><dd>${fam.bugsSlain || 0} · ${esc(T.ui.turns)} ${fam.turns || 0}</dd>
    </dl>
  </div>`;
  $('close-detail').onclick = () => world.select(null);
}

function statColor(k) { return { focus: '#7cf0ff', thrift: '#ffd34d', craft: '#5cff8a', cache: '#b69cff', grit: '#ffb35c' }[k]; }
function shortModel(m) { return String(m).replace(/^claude-/, '').replace(/-\d{8}$/, ''); }

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
}

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
  const fam = state.snap?.familiars?.[a.agent.familiar];
  const el = $('banner');
  el.innerHTML = `<div class="t1">${f.fx === 'hatch' ? 'HATCHED!' : 'EVOLUTION!'}</div>
    ${fam ? `<img src="${getPortrait(fam)}" alt="">` : ''}
    <div class="t2">${esc(fam?.name || '')} ${esc(f.fx === 'hatch' ? T.ui.hatched : T.ui.evolved)} ${esc(f.to)}</div>
    <div class="t3">${esc(f.from)} → ${esc(f.to)} · ${esc(STAGES[f.stage] || '')}</div>`;
  clearTimeout(bannerTimer);
  setTimeout(() => el.classList.add('show'), 2200);
  bannerTimer = setTimeout(() => el.classList.remove('show'), 6200);
}

function toast(al) {
  const el = document.createElement('div');
  el.className = `toast ${al.severity === 'crit' ? '' : 'warn'}`;
  el.innerHTML = `<b style="color:${al.severity === 'crit' ? 'var(--red)' : 'var(--gold)'}">${al.severity === 'crit' ? '⚠ CRITICAL' : '⚠ WARNING'}</b>${esc(alertText(T, al))}`;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 6500);
  while ($('toasts').children.length > 3) $('toasts').firstChild.remove();
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
  setMode(state.mode === 'live' ? 'live' : 'demo');
  renderLegend();
  renderSide(); renderBottom();
}

function renderLegend() {
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

$('b-lang').onclick = () => { lang = lang === 'vi' ? 'en' : 'vi'; try { localStorage.setItem('av.lang', lang); } catch {} applyLang(); };
$('b-sound').onclick = () => { const on = sound.toggle(); $('b-sound').textContent = on ? '♪ ON' : '♪ OFF'; $('b-sound').classList.toggle('on', on); };
$('b-sound').textContent = sound.enabled ? '♪ ON' : '♪ OFF';
$('b-sound').classList.toggle('on', sound.enabled);
$('b-speed').onclick = () => { state.speed = state.speed >= 4 ? 1 : state.speed * 2; state.sim?.setSpeed(state.speed); $('b-speed').textContent = `${state.speed}×`; };
$('b-demo').onclick = () => { location.search = state.mode === 'demo' ? '' : '?demo'; };

// animated logo villager
(function logo() {
  const cv = $('logo'), x = cv.getContext('2d');
  const fam = { key: 'logo', species: 'fox', stage: 3, branch: 'zen', accessory: null, genome: { hue: 10, accentHue: 280, pattern: 'plain', eyes: 'big' } };
  let f = 0;
  setInterval(() => { x.clearRect(0, 0, 20, 22); x.drawImage(getSprite(fam, 'idle', f++ % 2, f % 9 === 0 ? 'blink' : ''), 0, 0); }, 450);
})();

applyLang();
boot();
