import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Village } from '../core/engine.js';
import { EV } from '../core/schema.js';
import { priceUsage } from '../core/pricing.js';
import { scoreTurn, Evolution, levelFromXp, xpForLevel, traitMix } from '../core/evolution.js';

const S = 'sess-1';
const cwd = '/home/me/shop-api';
let t0 = Date.parse('2026-10-27T03:00:00Z');
const ev = (kind, extra = {}) => ({ v: 1, ts: (t0 += 500), provider: 'claude', sessionId: S, agentId: S, cwd, kind, ...extra });

test('pricing: per-model, cache tiers and multipliers', () => {
  const u = { model: 'claude-opus-5-5', input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 };
  assert.equal(priceUsage(u), 4);
  assert.ok(Math.abs(priceUsage({ ...u, input: 0, cacheRead: 1e6 }) - 0.2) < 1e-9);
  assert.equal(priceUsage({ ...u, input: 0, cacheWrite: 1e6, cacheWrite1h: 1e6 }), 8);
  assert.equal(priceUsage({ ...u, multiplier: 2 }), 8);
  assert.equal(priceUsage({ model: 'claude-sonnet-4-5', input: 1e6 }), 3);
  assert.equal(priceUsage({ model: 'gpt-6.1-sol', output: 1e6 }), 10);
  assert.equal(priceUsage({ model: 'totally-unknown', input: 1e6 }), 0);
});

test('levels: xp curve is monotonic and levelFromXp inverts it', () => {
  let acc = 0;
  for (let l = 1; l < 30; l++) {
    assert.ok(xpForLevel(l + 1) > xpForLevel(l));
    assert.equal(levelFromXp(acc).level, l);
    acc += xpForLevel(l);
  }
});

test('scoreTurn rewards quality and thrift, never raw spend', () => {
  const base = { tools: 12, edits: 3, runs: 2, returns: 0, cost: 0.5, input: 1000, cacheRead: 20000, cacheWrite: 1000, output: 800 };
  const clean = scoreTurn(base, { baselineCpw: null });
  const loopy = scoreTurn({ ...base, loops: 2, errorEchoes: 1 }, { baselineCpw: null });
  assert.ok(clean.xp > loopy.xp, 'loops must cost XP');
  const pricey = scoreTurn({ ...base, cost: 5 }, { baselineCpw: clean.cpw });
  const cheap = scoreTurn({ ...base, cost: 0.1 }, { baselineCpw: clean.cpw });
  assert.ok(cheap.xp > pricey.xp, 'beating your own cost baseline earns more');
  const bug = scoreTurn({ ...base, testFixes: 1 }, { baselineCpw: null });
  assert.equal(bug.xp - clean.xp, 15);
  // spending 10x more with the same work must not earn more XP
  assert.ok(scoreTurn({ ...base, cost: 5 }, { baselineCpw: clean.cpw }).xp <= clean.xp);
});

test('traitMix decides species from work style', () => {
  assert.equal(Object.entries(traitMix({ read: 10, write: 1 })).sort((a, b) => b[1] - a[1])[0][0], 'scholar');
  assert.equal(Object.entries(traitMix({ write: 5, read: 3 })).sort((a, b) => b[1] - a[1])[0][0], 'smith');
  assert.equal(Object.entries(traitMix({ delegate: 2, read: 4 })).sort((a, b) => b[1] - a[1])[0][0], 'commander');
});

test('evolution: hatch, gates, corruption, shiny streak, persistence', () => {
  const evo = new Evolution();
  const key = 'claude:demo:main';
  const turn = (over = {}) => evo.onTurn({ familiar: key, agentId: 'a', provider: 'claude', project: 'demo', type: 'main', tools: 10, edits: 4, runs: 2, cost: 0.3, input: 1000, cacheRead: 30000, cacheWrite: 1000, output: 500, cat: { write: 6, read: 3, run: 2 }, ...over });
  const fx1 = turn();
  const f = evo.familiars.get(key);
  assert.equal(f.stage, 1, 'first turn hatches the egg');
  assert.equal(f.trait, 'smith');
  assert.ok(fx1.some((x) => x.fx === 'hatch'));
  for (let i = 0; i < 3; i++) turn({ loops: 2 });
  assert.ok(f.corruption >= 0.5, 'loops leave a glitch');
  assert.equal(f.perfectStreak, 0);
  for (let i = 0; i < 10; i++) turn();
  assert.ok(f.corruption < 0.5, 'clean turns heal the glitch');
  assert.ok(f.shiny, '10 clean turns in a row -> shiny');
  // stage 2 needs level 6 AND (a bug slain OR 10 turns)
  while (f.level < 6) turn();
  assert.equal(f.stage, 2);
  assert.equal(f.nextGate, undefined);
  // Master is gated on Focus, not just XP: a sloppy familiar stays Adept
  const sloppy = new Evolution();
  const k2 = 'claude:sloppy:main';
  for (let i = 0; i < 3000; i++) sloppy.onTurn({ familiar: k2, agentId: 'b', tools: 10, edits: 4, runs: 2, cost: 0.3, loops: 2, errorEchoes: 1, cat: { write: 6 } });
  const g = sloppy.familiars.get(k2);
  assert.ok(g.level >= 14, `level ${g.level}`);
  assert.equal(g.stage, 2, 'focus gate blocks Master');
  const restored = new Evolution(JSON.parse(JSON.stringify(evo.toJSON())));
  assert.deepEqual(restored.familiars.get(key), f);
});

test('village: delegation, monsters, xp, alerts end-to-end', () => {
  const v = new Village({ now: t0 });
  v.ingest(ev(EV.SESSION_START));
  v.ingest(ev(EV.PROMPT));
  v.ingest(ev(EV.TOOL_START, { tool: 'Task', toolUseId: 'k1', detail: 'reviewer' }));
  const sub = `${S}:a1`;
  let fx = v.ingest(ev(EV.SUBAGENT_START, { agentId: sub, parentId: S, agentType: 'code-reviewer' }));
  assert.ok(fx.some((f) => f.fx === 'handoff' && f.kind === 'delegate'));
  // same Grep 4 times -> loop alert on the subagent
  for (let i = 0; i < 4; i++) {
    v.ingest(ev(EV.TOOL_START, { agentId: sub, parentId: S, agentType: 'code-reviewer', tool: 'Grep', toolUseId: 'g' + i, inputHash: 42 }));
    v.ingest(ev(EV.TOOL_END, { agentId: sub, parentId: S, agentType: 'code-reviewer', tool: 'Grep', toolUseId: 'g' + i, ok: true }));
  }
  assert.ok(v.snapshot(t0).alerts.some((a) => a.kind === 'loop' && a.agentId === sub));
  fx = v.ingest(ev(EV.SUBAGENT_END, { agentId: sub, parentId: S, agentType: 'code-reviewer' }));
  assert.ok(fx.some((f) => f.fx === 'handoff' && f.kind === 'return'));
  assert.ok(fx.some((f) => f.fx === 'xp'));
  // failing test spawns a monster, passing test defeats it
  v.ingest(ev(EV.TOOL_START, { tool: 'Bash', toolUseId: 'b1', command: 'npm test' }));
  fx = v.ingest(ev(EV.TOOL_END, { tool: 'Bash', toolUseId: 'b1', command: 'npm test', ok: false, error: 'FAIL' }));
  assert.ok(fx.some((f) => f.fx === 'monster' && f.action === 'spawn'));
  v.ingest(ev(EV.TOOL_START, { tool: 'Bash', toolUseId: 'b2', command: 'npm test' }));
  fx = v.ingest(ev(EV.TOOL_END, { tool: 'Bash', toolUseId: 'b2', command: 'npm test', ok: true }));
  assert.ok(fx.some((f) => f.fx === 'monster' && f.action === 'defeat'));
  // usage feeds cost + context
  v.ingest(ev(EV.USAGE, { usage: { model: 'claude-opus-5-5', input: 1000, output: 1000, cacheRead: 150000, cacheWrite: 2000 } }));
  const snap = v.snapshot(t0);
  const lead = snap.agents.find((a) => a.id === S);
  assert.ok(snap.totals.cost > 0.05);
  assert.equal(lead.context.used, 153000);
  assert.ok(snap.alerts.some((a) => a.kind === 'context'));
  fx = v.ingest(ev(EV.TURN_END));
  assert.ok(fx.some((f) => f.fx === 'hatch'), 'the lead hatches after its first turn');
});

test('village: permission prompt on a background subagent becomes critical', () => {
  const v = new Village({ now: t0 });
  v.ingest(ev(EV.SESSION_START));
  const sub = `${S}:bg`;
  v.ingest(ev(EV.SUBAGENT_START, { agentId: sub, parentId: S, agentType: 'worker' }));
  v.ingest(ev(EV.PERMISSION, { agentId: sub, parentId: S, agentType: 'worker', tool: 'Bash' }));
  const fx = v.tick(t0 + 30_000);
  const al = fx.find((f) => f.fx === 'alert')?.alert;
  assert.equal(al.kind, 'permissionSub');
  assert.equal(al.severity, 'crit');
});

test('village: two unrelated sessions editing one file -> collision', () => {
  const v = new Village({ now: t0 });
  const file = `${cwd}/src/app.ts`;
  for (const sid of ['s-a', 's-b']) {
    v.ingest({ ...ev(EV.SESSION_START), sessionId: sid, agentId: sid });
    v.ingest({ ...ev(EV.TOOL_START, { tool: 'Edit', toolUseId: sid + 'e', file }), sessionId: sid, agentId: sid });
    v.ingest({ ...ev(EV.TOOL_END, { tool: 'Edit', toolUseId: sid + 'e', file, ok: true }), sessionId: sid, agentId: sid });
  }
  const al = v.snapshot(t0).alerts.find((a) => a.kind === 'collision');
  assert.ok(al, 'collision alert raised');
  assert.match(al.params.a + al.params.b, /#/, 'labels carry session ids');
});

test('village: backfilled usage counts toward today but spawns nobody', () => {
  const v = new Village({ now: t0 });
  const fx = v.ingest({ ...ev(EV.USAGE, { usage: { model: 'claude-sonnet-5-5', input: 1e6 } }), backfill: true });
  assert.equal(fx.length, 0);
  const snap = v.snapshot(t0);
  assert.equal(snap.agents.length, 0);
  assert.equal(snap.totals.cost, 2);
});
