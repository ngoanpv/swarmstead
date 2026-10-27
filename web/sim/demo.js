// Demo simulator: a scripted but varied day in the village, so anyone can see
// what Agent Village does without running an agent. It drives the real core
// engine with the same normalized events the daemon produces.

import { Village } from '../../core/engine.js';
import { EV, categorize } from '../../core/schema.js';
import { hash32, rng } from '../../core/util.js';
import { levelFromXp, xpForLevel } from '../../core/evolution.js';

const PROJECTS = {
  shop: '/home/dev/work/shop-api',
  web: '/home/dev/work/web-app',
  docs: '/home/dev/work/docs-site',
};

export class DemoSim {
  constructor({ onFx, onSnapshot, onRoster, speed = 1 }) {
    this.village = new Village({ xpMultiplier: 2, thresholds: { burnUsdPerMin: 1.6, permissionMs: 15_000, waitingMs: 60_000 } });
    this.onFx = onFx; this.onSnapshot = onSnapshot; this.onRoster = onRoster;
    this.speed = speed;
    this.r = rng(42);
    this.ctx = new Map();
    this.running = true;
    seedRoster(this.village.evolution);
  }

  start() {
    this.tick = setInterval(() => this.flush(this.village.tick(Date.now())), 1000);
    this.snap = setInterval(() => this.onSnapshot(this.village.snapshot(Date.now())), 250);
    this.onRoster(this.village.roster());
    this.rosterTimer = setInterval(() => this.onRoster(this.village.roster()), 2000);
    this.loop(() => this.lead(), 400);
    this.loop(() => this.webApp(), 2600);
    this.loop(() => this.docs(), 6000);
    this.loop(() => this.twin(), 26000);
  }

  setSpeed(s) { this.speed = s; }

  flush(fx) { if (fx.length) this.onFx(fx); }

  emit(ev) {
    const fx = this.village.ingest({ v: 1, ts: Date.now(), ...ev });
    this.flush(fx);
  }

  sleep(ms) { return new Promise((r) => setTimeout(r, ms / this.speed)); }
  jitter(ms) { return ms * (0.7 + this.r() * 0.6); }

  async loop(fn, delay) {
    await this.sleep(delay);
    while (this.running) {
      try { await fn(); } catch (e) { console.error(e); }
    }
  }

  // ------------------------------------------------------------- building blocks

  agent(sessionId, cwd, provider, model, agentType = null, parentId = null) {
    const id = parentId ? `${sessionId}:${agentType}-${Math.floor(this.r() * 1e6).toString(36)}` : sessionId;
    return { sessionId, agentId: id, cwd, provider, model, agentType, parentId };
  }

  base(a) {
    const b = { provider: a.provider, sessionId: a.sessionId, agentId: a.agentId, cwd: a.cwd };
    if (a.parentId) { b.parentId = a.parentId; b.agentType = a.agentType; }
    return b;
  }

  async usage(a, out = 600) {
    let ctx = this.ctx.get(a.agentId) || 18_000;
    const add = 1500 + Math.floor(this.r() * 5000);
    ctx += add;
    this.ctx.set(a.agentId, ctx);
    this.emit({
      ...this.base(a), kind: EV.USAGE,
      usage: { model: a.model, input: 400 + Math.floor(this.r() * 2000), output: Math.floor(out * (0.6 + this.r() * 0.8)), cacheRead: ctx - add, cacheWrite: add },
    });
  }

  async tool(a, tool, { detail = '', file = '', command = '', ok = true, error = '', ms = 900, think = 700, hash } = {}) {
    await this.usage(a, 300);
    await this.sleep(this.jitter(think));
    const id = 't' + Math.floor(this.r() * 1e9).toString(36);
    const inputHash = hash ?? hash32(`${tool}${detail}${file}${command}${this.r()}`);
    this.emit({ ...this.base(a), kind: EV.TOOL_START, tool, toolUseId: id, category: categorize(tool), detail: detail || shortName(file) || command.slice(0, 50), file, command, inputHash });
    await this.sleep(this.jitter(ms));
    this.emit({ ...this.base(a), kind: EV.TOOL_END, tool, toolUseId: id, category: categorize(tool), file, command, ok, error: ok ? undefined : error });
  }

  async read(a, files) { for (const f of files) await this.tool(a, 'Read', { file: `${a.cwd}/${f}`, ms: 500 }); }
  async edit(a, f, ms = 1600) { await this.tool(a, 'Edit', { file: `${a.cwd}/${f}`, ms, think: 1400 }); }

  async delegate(parent, agentType, detail, work) {
    const id = 'task' + Math.floor(this.r() * 1e9).toString(36);
    this.emit({ ...this.base(parent), kind: EV.TOOL_START, tool: 'Task', toolUseId: id, category: 'delegate', detail: `${agentType}: ${detail}` });
    const sub = this.agent(parent.sessionId, parent.cwd, parent.provider, agentType === 'test-runner' ? 'claude-haiku-5-5' : 'claude-sonnet-5-5', agentType, parent.agentId);
    await this.sleep(300);
    this.emit({ ...this.base(sub), kind: EV.SUBAGENT_START, detail });
    return (async () => {
      await work(sub);
      this.emit({ ...this.base(sub), kind: EV.SUBAGENT_END });
      await this.usage(parent, 200);
      this.emit({ ...this.base(parent), kind: EV.TOOL_END, tool: 'Task', toolUseId: id, category: 'delegate', ok: true });
      this.ctx.set(parent.agentId, (this.ctx.get(parent.agentId) || 0) + 9000);
    })();
  }

  // ------------------------------------------------------------- scenarios

  async lead() {
    const lead = this.agent('lead-7f3a', PROJECTS.shop, 'claude', 'claude-opus-5-5');
    if (!this.leadStarted) { this.emit({ ...this.base(lead), kind: EV.SESSION_START }); this.leadStarted = true; this.leadRuns = 0; }
    this.leadRuns++;
    this.emit({ ...this.base(lead), kind: EV.PROMPT });
    await this.tool(lead, 'TodoWrite', { detail: 'plan: checkout refactor', ms: 600 });
    await this.read(lead, ['src/checkout/cart.ts', 'src/checkout/pricing.ts', 'src/routes.ts']);
    const reviewer = this.delegate(lead, 'code-reviewer', 'review pricing rules', async (sub) => {
      for (const p of ['discount', 'TODO', 'roundCents', 'currency']) await this.tool(sub, 'Grep', { detail: p, ms: 500, think: 900 });
      await this.read(sub, ['src/checkout/pricing.ts', 'test/pricing.test.ts']);
      await this.usage(sub, 1400);
      await this.sleep(1200);
    });
    await this.sleep(900);
    const tester = this.delegate(lead, 'test-runner', 'fix failing checkout tests', async (sub) => {
      await this.tool(sub, 'Bash', { command: 'npm test -- checkout', ms: 2600, ok: false, error: 'FAIL test/cart.test.ts › applies coupon: expected 90 received 100' });
      await this.read(sub, ['test/cart.test.ts']);
      await this.edit(sub, 'src/checkout/cart.ts');
      await this.tool(sub, 'Bash', { command: 'npm test -- checkout', ms: 2400 });
      await this.sleep(800);
    });
    if (this.leadRuns > 1 && this.leadRuns % 3 === 0) this.ctx.set(lead.agentId, 150_000);
    await this.tool(lead, 'WebSearch', { detail: 'stripe idempotency keys', ms: 1500 });
    await Promise.all([reviewer, tester]);
    if ((this.ctx.get(lead.agentId) || 0) > 160_000) {
      this.emit({ ...this.base(lead), kind: EV.COMPACT, reason: 'auto' });
      await this.sleep(3500);
      this.ctx.set(lead.agentId, 30_000);
      this.emit({ ...this.base(lead), kind: EV.COMPACT_END, reason: 'auto' });
    }
    await this.edit(lead, 'src/checkout/pricing.ts');
    await this.edit(lead, 'src/routes.ts');
    await this.tool(lead, 'Bash', { command: 'npm test', ms: 3000 });
    await this.usage(lead, 900);
    this.emit({ ...this.base(lead), kind: EV.TURN_END });
    this.emit({ ...this.base(lead), kind: EV.WAITING });
    await this.sleep(this.jitter(9000));
  }

  async webApp() {
    const a = this.agent('web-19c2', PROJECTS.web, 'claude', 'claude-sonnet-5-5');
    if (!this.webStarted) { this.emit({ ...this.base(a), kind: EV.SESSION_START }); this.webStarted = true; this.webRuns = 0; }
    this.webRuns++;
    this.emit({ ...this.base(a), kind: EV.PROMPT });
    await this.tool(a, 'WebSearch', { detail: 'react 20 transitions api', ms: 1800 });
    await this.tool(a, 'WebFetch', { detail: 'react.dev', ms: 1400 });
    await this.read(a, ['src/App.tsx', 'src/components/Cart.tsx']);
    if (this.webRuns % 2 === 1) {
      // The classic: grepping for the same thing again and again.
      for (let i = 0; i < 5; i++) await this.tool(a, 'Grep', { detail: 'useCartStore', hash: 77777, ms: 500, think: 600 });
    }
    await this.edit(a, 'src/App.tsx', 2200);
    await this.edit(a, 'src/components/Cart.tsx', 1800);
    if (this.webRuns % 2 === 0) {
      await this.usage(a, 200);
      this.emit({ ...this.base(a), kind: EV.PERMISSION, tool: 'Bash', detail: 'npm install framer-motion' });
      await this.sleep(22_000);
      await this.tool(a, 'Bash', { command: 'npm install framer-motion', ms: 2500, think: 100 });
    }
    await this.tool(a, 'Bash', { command: 'npm run build', ms: 3200 });
    await this.usage(a, 700);
    this.emit({ ...this.base(a), kind: EV.TURN_END });
    this.emit({ ...this.base(a), kind: EV.WAITING });
    await this.sleep(this.jitter(this.webRuns % 3 === 0 ? 65_000 : 12_000));
  }

  async docs() {
    const a = this.agent('docs-0b77', PROJECTS.docs, 'codex', 'gpt-6.1-sol');
    if (!this.docsStarted) { this.emit({ ...this.base(a), kind: EV.SESSION_START }); this.docsStarted = true; }
    this.emit({ ...this.base(a), kind: EV.PROMPT });
    this.emit({ ...this.base(a), kind: EV.LIMITS, limits: { primary: { usedPercent: 18 + Math.floor(this.r() * 30), windowMinutes: 300, resetsAt: Date.now() + 2.4 * 3600_000 }, secondary: { usedPercent: 41, windowMinutes: 10080 } } });
    await this.tool(a, 'shell', { command: 'rg -n "deprecated" docs/', ms: 900 });
    await this.tool(a, 'read_file', { file: `${a.cwd}/docs/getting-started.md`, ms: 600 });
    await this.tool(a, 'apply_patch', { file: `${a.cwd}/docs/getting-started.md`, ms: 1400, think: 1500 });
    await this.tool(a, 'shell', { command: 'npm run build', ms: 2600 });
    await this.usage(a, 500);
    this.emit({ ...this.base(a), kind: EV.TURN_END });
    await this.sleep(this.jitter(15_000));
  }

  async twin() {
    // A second Claude session opened on the same repo, editing the same file → collision.
    const a = this.agent('web-twin-55e', PROJECTS.web, 'claude', 'claude-sonnet-5-5');
    this.emit({ ...this.base(a), kind: EV.SESSION_START });
    this.emit({ ...this.base(a), kind: EV.PROMPT });
    await this.read(a, ['src/App.tsx']);
    await this.edit(a, 'src/App.tsx', 2000);
    await this.edit(a, 'src/App.tsx', 2000);
    await this.tool(a, 'Bash', { command: 'npm run lint', ms: 1800 });
    await this.usage(a, 400);
    this.emit({ ...this.base(a), kind: EV.TURN_END });
    await this.sleep(6000);
    this.emit({ ...this.base(a), kind: EV.SESSION_END });
    await this.sleep(this.jitter(70_000));
  }
}

function shortName(f) { return f ? f.split('/').slice(-2).join('/') : ''; }

// ---------------------------------------------------------------- pre-trained familiars

function train(evo, key, meta, { level, mix, edits = 2, runs = 1, returns = 0, loops = 0, after = {} }) {
  const f = evo.ensure(key, { ...meta, now: Date.now() - 86400_000 * 5 });
  const cat = { read: 0, write: 0, run: 0, web: 0, delegate: 0, plan: 0, tool: 0, ...mix };
  let guard = 0;
  while (f.level < level && guard++ < 400) {
    evo.onTurn({
      agentId: key, familiar: key, ...meta, cost: 0.4, input: 3000, output: 2000, cacheRead: 60000, cacheWrite: 4000,
      tools: Object.values(cat).reduce((s, v) => s + v, 0), edits, runs, failedRuns: 0, testFails: 0,
      testFixes: guard % 9 === 0 ? 1 : 0, loops: guard % 13 === 0 ? loops : 0, errorEchoes: 0, returns, permissions: 0, compactions: 0, cat,
    }, Date.now() - 86400_000);
  }
  Object.assign(f, after);
  // park the familiar just below its next level so the demo shows progress quickly
  if (after.xpToNext != null) {
    let acc = 0;
    for (let l = 1; l < level; l++) acc += xpForLevel(l);
    f.xp = acc + xpForLevel(level) - after.xpToNext;
    f.level = levelFromXp(f.xp).level;
    delete f.xpToNext;
  }
  if (after.stage != null) f.stage = after.stage;
  f.history = f.history.slice(-6);
  return f;
}

function seedRoster(evo) {
  const xpMult = evo.xpMultiplier; evo.xpMultiplier = 1;
  train(evo, 'claude:shop-api:main', { provider: 'claude', project: 'shop-api', type: 'main' },
    { level: 13, mix: { read: 3, write: 3, delegate: 2, run: 1, plan: 1 }, edits: 3, returns: 2, after: { xpToNext: 160 } });
  train(evo, 'claude:shop-api:code-reviewer', { provider: 'claude', project: 'shop-api', type: 'code-reviewer' },
    { level: 16, mix: { read: 8, plan: 1, web: 1 }, edits: 1, runs: 0, after: { xpToNext: 60, perfectStreak: 8, bestStreak: 8, stage: 3, branch: 'zen', stats: { focus: 88, thrift: 61, craft: 55, cache: 80, grit: 70 } } });
  const rev = evo.familiars.get('claude:shop-api:code-reviewer');
  let acc = 0; for (let l = 1; l < 27; l++) acc += xpForLevel(l);
  rev.xp = acc + xpForLevel(27) - 50; rev.level = 27;
  train(evo, 'claude:shop-api:test-runner', { provider: 'claude', project: 'shop-api', type: 'test-runner' },
    { level: 5, mix: { run: 4, read: 1, write: 1 }, edits: 1, runs: 3, after: { xpToNext: 40, bugsSlain: 0, turns: 6 } });
  train(evo, 'claude:web-app:main', { provider: 'claude', project: 'web-app', type: 'main' },
    { level: 9, mix: { write: 4, read: 2, web: 2, run: 1 }, edits: 3, loops: 2, after: { corruption: 0.6 } });
  evo.xpMultiplier = xpMult;
}
