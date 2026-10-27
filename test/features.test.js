// The "come back every day" features: approvals, forecasts, unverified claims,
// merge-conflict forecast, cost per commit, replay and post-mortem.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-feat-'));
process.env.SWARMSTEAD_HOME = home;
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ claude: { transcripts: path.join(home, 'none') }, codex: { sessions: path.join(home, 'none') } }));

const { Village } = await import('../core/engine.js');
const { EV, claimsPassing, gitAction } = await import('../core/schema.js');
const { forecastRun, forecastBlock, forecastLimit } = await import('../core/forecast.js');
const { postmortem, postmortemMarkdown } = await import('../core/postmortem.js');
const { Replay, parseEvents } = await import('../web/replay.js');
const { startDaemon } = await import('../server/daemon.js');
const { installClaude, uninstallClaude, installGit, uninstallGit } = await import('../server/install.js');

const T = 1_800_000_000_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = (ts, kind, extra = {}) => ({ v: 1, ts, provider: 'claude', sessionId: 'S', agentId: 'S', cwd: '/w/app', kind, ...extra });
const fxOf = (v, list) => list.flatMap((e) => v.ingest(e));

// ------------------------------------------------------------------ 3. "tests pass" without running them

test('claimsPassing: claims, negations and plain prose', () => {
  assert.equal(claimsPassing('Done. All tests pass.'), true);
  assert.equal(claimsPassing('The build is green and lint is clean.'), true);
  assert.equal(claimsPassing('✅ tests'), true);
  assert.equal(claimsPassing('3 tests failed, see below.'), false);
  assert.equal(claimsPassing("I couldn't get the tests to pass."), false);
  assert.equal(claimsPassing('Refactored the cart hook.'), false);
  assert.equal(claimsPassing(''), false);
});

test('verify: a claim is unverified unless a test passed after the last edit', () => {
  const v = new Village({ now: T });
  // edits, never tests, then claims success
  let fx = fxOf(v, [
    ev(T, EV.PROMPT),
    ev(T + 100, EV.TOOL_START, { tool: 'Edit', toolUseId: 'e1', file: '/w/app/a.ts', category: 'write' }),
    ev(T + 200, EV.TOOL_END, { tool: 'Edit', toolUseId: 'e1', file: '/w/app/a.ts', category: 'write', ok: true }),
    ev(T + 300, EV.TURN_END, { claims: true }),
  ]);
  const u = fx.find((f) => f.fx === 'unverified');
  assert.ok(u, 'unverified fx');
  assert.equal(u.why, 'none');
  v.tick(T + 1000);
  assert.ok([...v.detectors.alerts.values()].some((a) => a.kind === 'unverified'));

  // edit -> passing test -> claim: fine
  const w = new Village({ now: T });
  fx = fxOf(w, [
    ev(T, EV.PROMPT),
    ev(T + 100, EV.TOOL_START, { tool: 'Edit', toolUseId: 'e1', file: '/w/app/a.ts', category: 'write' }),
    ev(T + 200, EV.TOOL_END, { tool: 'Edit', toolUseId: 'e1', file: '/w/app/a.ts', category: 'write', ok: true }),
    ev(T + 300, EV.TOOL_START, { tool: 'Bash', toolUseId: 'b1', command: 'npm test', category: 'run' }),
    ev(T + 900, EV.TOOL_END, { tool: 'Bash', toolUseId: 'b1', command: 'npm test', category: 'run', ok: true }),
    ev(T + 1000, EV.TURN_END, { claims: true }),
  ]);
  assert.ok(!fx.some((f) => f.fx === 'unverified'));

  // passing test, then another edit, then the claim: stale
  const x = new Village({ now: T });
  fx = fxOf(x, [
    ev(T, EV.PROMPT),
    ev(T + 300, EV.TOOL_START, { tool: 'Bash', toolUseId: 'b1', command: 'pytest', category: 'run' }),
    ev(T + 900, EV.TOOL_END, { tool: 'Bash', toolUseId: 'b1', command: 'pytest', category: 'run', ok: true }),
    ev(T + 1000, EV.TOOL_START, { tool: 'Edit', toolUseId: 'e2', file: '/w/app/b.py', category: 'write' }),
    ev(T + 1100, EV.TOOL_END, { tool: 'Edit', toolUseId: 'e2', file: '/w/app/b.py', category: 'write', ok: true }),
    ev(T + 1200, EV.TURN_END, { claims: true }),
  ]);
  assert.equal(fx.find((f) => f.fx === 'unverified')?.why, 'stale');
});

// ------------------------------------------------------------------ 4. merge-conflict forecast across worktrees

test('mergeRisk: same file edited in a worktree and the main checkout', () => {
  const v = new Village({ now: T });
  const edit = (ts, sid, cwd, file) => [
    { ...ev(ts, EV.TOOL_START, { tool: 'Edit', toolUseId: `${sid}${ts}`, file, category: 'write' }), sessionId: sid, agentId: sid, cwd },
    { ...ev(ts + 50, EV.TOOL_END, { tool: 'Edit', toolUseId: `${sid}${ts}`, file, category: 'write', ok: true }), sessionId: sid, agentId: sid, cwd },
  ];
  let fx = fxOf(v, edit(T, 'A', '/w/app', '/w/app/src/App.tsx'));
  assert.ok(!fx.some((f) => f.fx === 'mergeRisk'));
  // a different file in the worktree: no risk
  fx = fxOf(v, edit(T + 1000, 'B', '/w/app/.claude/worktrees/fix', '/w/app/.claude/worktrees/fix/src/other.ts'));
  assert.ok(!fx.some((f) => f.fx === 'mergeRisk'));
  // the same relative path in the worktree: risk, and it is not a live-edit collision
  fx = fxOf(v, edit(T + 2000, 'B', '/w/app/.claude/worktrees/fix', '/w/app/.claude/worktrees/fix/src/App.tsx'));
  const m = fx.find((f) => f.fx === 'mergeRisk');
  assert.ok(m, 'merge risk');
  assert.equal(m.file, 'src/App.tsx');
  assert.equal(m.project, 'app');
  assert.deepEqual(m.trees.sort(), ['fix', 'main']);
  assert.ok(!fx.some((f) => f.fx === 'collision'));
  v.tick(T + 3000);
  assert.ok([...v.detectors.alerts.values()].some((a) => a.kind === 'mergeRisk'));
});

// ------------------------------------------------------------------ 5. cost per commit / PR

test('gitAction recognises shipping commands', () => {
  assert.equal(gitAction('git commit -am "x"'), 'commit');
  assert.equal(gitAction('git -C repo commit -m x'), 'commit');
  assert.equal(gitAction('git commit --dry-run'), null);
  assert.equal(gitAction('gh pr create --fill'), 'pr.open');
  assert.equal(gitAction('gh pr merge 12 --squash'), 'pr.merge');
  assert.equal(gitAction('git push origin main'), 'push');
  assert.equal(gitAction('git status'), null);
});

test('ledger: spend since the last commit is booked against the next one', () => {
  const v = new Village({ now: T });
  const usage = (ts, out) => ev(ts, EV.USAGE, { costUsd: out });
  const bash = (ts, command) => [
    ev(ts, EV.TOOL_START, { tool: 'Bash', toolUseId: `b${ts}`, command, category: 'run' }),
    ev(ts + 10, EV.TOOL_END, { tool: 'Bash', toolUseId: `b${ts}`, command, category: 'run', ok: true }),
  ];
  let fx = fxOf(v, [ev(T, EV.PROMPT), usage(T + 1, 0.4), usage(T + 2, 0.6), ...bash(T + 10, 'git commit -m "a"')]);
  const ship = fx.find((f) => f.fx === 'ship');
  assert.equal(ship.action, 'commit');
  assert.ok(Math.abs(ship.cost - 1.0) < 1e-9);
  fxOf(v, [usage(T + 100, 0.5), ...bash(T + 110, 'gh pr create --fill')]);
  // a human commit through the git hook (no agent) books what was spent since
  fxOf(v, [usage(T + 200, 0.25), { v: 1, ts: T + 60_000, provider: 'git', kind: EV.GIT, agentId: 'git', sessionId: 'git', action: 'commit', sha: 'abcdef1234', cwd: '/w/app' }]);
  const L = v.snapshot(T + 60_100).ledger.find((p) => p.project === 'app');
  assert.equal(L.commits, 2);
  assert.equal(L.prsOpened, 1);
  assert.ok(Math.abs(L.costPerCommit - (1.0 + 0.75) / 2) < 1e-9);
  assert.ok(Math.abs(L.costPerPr - 1.5) < 1e-9);
  assert.equal(L.recent[1].sha, 'abcdef1');
  assert.equal(L.recent[1].human, true);
  // the post-commit hook firing right after the agent's own `git commit` is the same commit
  fxOf(v, [...bash(T + 120_000, 'git commit -m b'), { v: 1, ts: T + 120_100, provider: 'git', kind: EV.GIT, agentId: 'git', sessionId: 'git', action: 'commit', sha: '99999999', cwd: '/w/app' }]);
  assert.equal(v.snapshot(T + 121_000).ledger.find((p) => p.project === 'app').commits, 3);
});

// ------------------------------------------------------------------ 2. forecasts

test('forecastRun: from history, else from the agents already finished', () => {
  const run = { workflow: 'audit', project: 'p', total: 20, done: 5, failed: 0, running: 10, cost: 1, finishedCost: 0.5, startedAt: T };
  const hist = [1, 2, 3].map((c) => ({ workflow: 'audit', project: 'p', total: 20, cost: c * 2, durationMs: 60_000 }));
  const h = forecastRun(run, hist, T + 1000);
  assert.equal(h.basis, 'history');
  assert.equal(h.samples, 3);
  assert.equal(h.expectedCost, 4);
  assert.equal(h.projectedCost, 4);
  const f = forecastRun({ ...run, workflow: 'other' }, hist, T + 1000);
  assert.equal(f.basis, 'in-flight');
  assert.ok(Math.abs(f.projectedCost - (1 + 10 * 0.1 * 0.5)) < 1e-9);
  assert.equal(forecastRun({ ...run, workflow: 'x', done: 0 }, [], T).basis, 'none');
});

test('forecastBlock and forecastLimit: will you hit the wall before the reset?', () => {
  const block = { start: T, end: T + 5 * 3600_000, cost: 30 };
  const b = forecastBlock(block, T + 3600_000, { ceiling: 100, pastBlocks: [40, 50, 60] });
  assert.ok(Math.abs(b.projectedEnd - 150) < 1e-6);
  assert.equal(b.hitsBeforeReset, true);
  assert.equal(b.aboveUsual, true);
  assert.ok(Math.abs(b.eta - (T + 3600_000 + (70 / 30) * 3600_000)) < 1);
  assert.equal(forecastBlock(block, T + 3600_000, { ceiling: 1000 }).hitsBeforeReset, false);

  const lim = { primary: { usedPercent: 60, resetsAt: T + 3 * 3600_000 }, history: [[T, 40], [T + 20 * 60_000, 60]] };
  const l = forecastLimit(lim, T + 20 * 60_000);
  assert.ok(Math.abs(l.eta - (T + 60 * 60_000)) < 1);
  assert.equal(l.hitsBeforeReset, true);
  assert.equal(forecastLimit({ primary: { usedPercent: 10 } }, T).eta, null);
});

test('village: a workflow with history gets a forecast and an overrun alert', () => {
  const history = [0.5, 0.6, 0.55].map((cost, i) => ({ id: `h${i}`, workflow: 'audit', project: 'app', total: 2, cost, durationMs: 60_000 }));
  const v = new Village({ now: T, history });
  const sub = (i, ts, kind, extra = {}) => ({ ...ev(ts, kind, extra), agentId: `S:w${i}`, parentId: 'S', agentType: 'worker', workflow: 'audit' });
  const fx = fxOf(v, [ev(T, EV.PROMPT), sub(1, T + 10, EV.SUBAGENT_START), sub(2, T + 20, EV.SUBAGENT_START)]);
  const fc = fx.find((f) => f.fx === 'forecast');
  assert.ok(fc, 'forecast fx on run start');
  assert.equal(fc.samples, 3);
  fxOf(v, [sub(1, T + 1000, EV.USAGE, { costUsd: 1.2 })]);
  v.tick(T + 2000);
  assert.ok([...v.detectors.alerts.values()].some((a) => a.kind === 'runOverrun'));
});

// ------------------------------------------------------------------ 6. post-mortem + replay

function sampleDay() {
  const out = [ev(T, EV.SESSION_START), ev(T + 10, EV.PROMPT)];
  // a loop: the same Grep five times while spending
  for (let i = 0; i < 5; i++) {
    out.push(ev(T + 100 + i * 100, EV.TOOL_START, { tool: 'Grep', toolUseId: `g${i}`, category: 'read', inputHash: 7 }));
    out.push(ev(T + 150 + i * 100, EV.TOOL_END, { tool: 'Grep', toolUseId: `g${i}`, category: 'read', ok: true }));
    out.push(ev(T + 160 + i * 100, EV.USAGE, { costUsd: 0.5, usage: { model: 'claude-opus-5-5', input: 100, output: 100, cacheRead: 1000, cacheWrite: 0 } }));
  }
  out.push(ev(T + 900, EV.TOOL_START, { tool: 'Bash', toolUseId: 'c1', command: 'git commit -m x', category: 'run' }));
  out.push(ev(T + 950, EV.TOOL_END, { tool: 'Bash', toolUseId: 'c1', command: 'git commit -m x', category: 'run', ok: true }));
  out.push(ev(T + 1000, EV.TURN_END));
  return out;
}

test('postmortem: where the money went, waste, incidents, shareable markdown', () => {
  const pm = postmortem(sampleDay());
  assert.ok(Math.abs(pm.cost - 2.5) < 1e-9);
  assert.ok(pm.waste > 0 && pm.waste < pm.cost, 'spend while looping counts as waste');
  assert.ok(pm.incidents.some((i) => i.kind === 'loop'));
  assert.equal(pm.commits, 1);
  assert.ok(Math.abs(pm.costPerCommit - 2.5) < 1e-9);
  assert.equal(pm.turnCount, 1);
  assert.ok(pm.byModel['claude-opus-5-5'] > 0);
  const md = postmortemMarkdown(pm);
  assert.match(md, /^# Swarmstead post-mortem/);
  assert.match(md, /\*\*Waste:\*\*/);
  assert.match(md, /Incidents/);
});

test('replay: seek rebuilds state; parseEvents reads arrays and JSON Lines', () => {
  const events = sampleDay();
  let snap = null;
  const r = new Replay(events, { onSnapshot: (s) => { snap = s; } });
  assert.equal(r.t0, T);
  assert.equal(r.t1, T + 1000);
  r.seek(T + 400);
  assert.ok(snap.totals.cost > 0 && snap.totals.cost < 2.5);
  r.seek(r.t1);
  assert.ok(Math.abs(snap.totals.cost - 2.5) < 1e-9);
  r.destroy();
  assert.equal(parseEvents(JSON.stringify(events)).length, events.length);
  assert.equal(parseEvents(events.map((e) => JSON.stringify(e)).join('\n')).length, events.length);
  assert.equal(parseEvents(JSON.stringify({ events })).length, events.length);
  assert.deepEqual(parseEvents(''), []);
});

// ------------------------------------------------------------------ 1. approvals + budget brake (real daemon, real gate script)

function gate(port, payload) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'plugin/hooks/swarmstead-gate.mjs')], { env: { ...process.env, SWARMSTEAD_URL: `http://127.0.0.1:${port}` } });
    let out = '';
    const kill = setTimeout(() => p.kill(), 20_000); // never hang the suite
    p.stdout.on('data', (c) => { out += c; });
    p.on('close', (code) => { clearTimeout(kill); resolve({ code, out }); });
    p.stdin.end(JSON.stringify(payload));
  });
}

async function sse(port, onMsg) {
  const ctrl = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}/api/stream`, { signal: ctrl.signal });
  (async () => {
    const dec = new TextDecoder();
    let buf = '';
    try {
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 2);
          if (line.startsWith('data: ')) onMsg(JSON.parse(line.slice(6)));
        }
      }
    } catch { /* aborted */ }
  })();
  return () => ctrl.abort();
}

test('gate: approve from the village, deny, time out, and the budget brake', async () => {
  const port = 48000 + Math.floor(Math.random() * 1000);
  const d = await startDaemon({ port, gate: { approvals: true, waitSubSec: 3, waitMainSec: 3, brakes: true }, thresholds: { dailyBudgetUsd: 0.5 } });
  let stop = () => {};
  try {
    const base = `http://127.0.0.1:${port}`;
    const { token } = await (await fetch(`${base}/api/session`)).json();
    assert.ok(token && token.length >= 16);

    // nobody watching -> answer immediately with no decision (Claude Code shows its own prompt)
    let r = await gate(port, { hook_event_name: 'PermissionRequest', session_id: 'G', tool_name: 'Bash', tool_input: { command: 'rm -rf build' } });
    assert.equal(r.code, 0);
    assert.equal(r.out, '');

    // with the village open, the prompt waits for an answer
    let lists = [];
    stop = await sse(port, (m) => { if (m.type === 'approvals') lists.push(m.approvals); });
    await sleep(150);
    const pending = gate(port, { hook_event_name: 'PermissionRequest', session_id: 'G', agent_id: 'sub1', tool_name: 'Bash', tool_input: { command: 'npm install left-pad' }, permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'localSettings' }] });
    let item;
    for (let i = 0; i < 40 && !item; i++) { await sleep(50); item = lists.at(-1)?.pending?.[0]; }
    assert.ok(item, 'approval shown in the village');
    assert.equal(item.tool, 'Bash');
    assert.equal(item.canRemember, true);
    // deciding needs the token
    let res = await fetch(`${base}/api/approvals/${item.id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'allow' }) });
    assert.equal(res.status, 401);
    res = await fetch(`${base}/api/approvals/${item.id}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-swarmstead-token': token }, body: JSON.stringify({ decision: 'allow-session' }) });
    assert.equal(res.status, 200);
    r = await pending;
    const out = JSON.parse(r.out);
    assert.equal(out.hookSpecificOutput.hookEventName, 'PermissionRequest');
    assert.equal(out.hookSpecificOutput.decision.behavior, 'allow');
    assert.equal(out.hookSpecificOutput.decision.updatedPermissions[0].destination, 'session');

    // deny (phone-style link with ?t=&d=)
    lists = [];
    const p2 = gate(port, { hook_event_name: 'PermissionRequest', session_id: 'G', tool_name: 'Write', tool_input: { file_path: '/etc/hosts' } });
    item = null;
    for (let i = 0; i < 40 && !item; i++) { await sleep(50); item = lists.at(-1)?.pending?.[0]; }
    res = await fetch(`${base}/api/approvals/${item.id}?t=${token}&d=deny`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse((await p2).out).hookSpecificOutput.decision.behavior, 'deny');

    // nobody answers -> times out with no output
    const t0 = Date.now();
    r = await gate(port, { hook_event_name: 'PermissionRequest', session_id: 'G', tool_name: 'Bash', tool_input: { command: 'ls' } });
    assert.equal(r.out, '');
    assert.ok(Date.now() - t0 >= 2500);

    // budget brake: below budget -> nothing; above -> deny new subagents with a reason
    r = await gate(port, { hook_event_name: 'PreToolUse', session_id: 'G', tool_name: 'Agent', tool_input: {} });
    assert.equal(r.out, '');
    await fetch(`${base}/api/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'usage', agentId: 'G', cwd: '/w/x', costUsd: 0.75 }) });
    await sleep(700);
    r = await gate(port, { hook_event_name: 'PreToolUse', session_id: 'G', tool_name: 'Agent', tool_input: {} });
    const brake = JSON.parse(r.out).hookSpecificOutput;
    assert.equal(brake.permissionDecision, 'deny');
    assert.match(brake.permissionDecisionReason, /budget brake/);

    // gate script fails open when the daemon is gone
    const dead = spawnSync(process.execPath, [path.join(ROOT, 'plugin/hooks/swarmstead-gate.mjs')], { input: '{"hook_event_name":"PermissionRequest"}', env: { ...process.env, SWARMSTEAD_URL: 'http://127.0.0.1:1' }, timeout: 4000 });
    assert.equal(dead.status, 0);
    assert.equal(String(dead.stdout), '');
  } finally {
    stop();
    await d.close();
  }
});

test('git endpoint books commits; replay endpoints serve the day log', async () => {
  const port = 49000 + Math.floor(Math.random() * 900);
  const d = await startDaemon({ port });
  try {
    const base = `http://127.0.0.1:${port}`;
    await fetch(`${base}/api/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'usage', agentId: 'H', cwd: '/w/shop', costUsd: 0.3 }) });
    await fetch(`${base}/api/git`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'commit', sha: '0123456789abcdef', cwd: '/w/shop' }) });
    await sleep(700);
    const st = await (await fetch(`${base}/api/state`)).json();
    const L = st.ledger.find((p) => p.project === 'shop');
    assert.equal(L.commits, 1);
    assert.ok(Math.abs(L.costPerCommit - 0.3) < 1e-9);
    const days = await (await fetch(`${base}/api/replay/days`)).json();
    assert.ok(days.length >= 1);
    const evs = await (await fetch(`${base}/api/replay/${days[0].day}`)).json();
    assert.ok(evs.some((e) => e.kind === 'git'));
    assert.equal((await fetch(`${base}/api/replay/..%2f..%2fetc`)).status >= 400, true);
  } finally {
    await d.close();
  }
});

// ------------------------------------------------------------------ installers

test('installer: gate hooks are opt-in and removed cleanly; git hook keeps yours', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-gate-'));
  const file = path.join(cwd, '.claude', 'settings.local.json');
  installClaude({ scope: 'project', cwd });
  let s = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(s.hooks.PermissionRequest.length, 1, 'only the async observer without --gate');
  assert.equal(s.hooks.PermissionRequest[0].hooks[0].async, true);
  uninstallClaude({ scope: 'project', cwd });
  installClaude({ scope: 'project', cwd, gate: true, waitSec: 60 });
  s = JSON.parse(fs.readFileSync(file, 'utf8'));
  const sync = s.hooks.PermissionRequest.find((g) => !g.hooks[0].async);
  assert.ok(sync, 'sync gate hook');
  assert.match(sync.hooks[0].command, /swarmstead-gate\.mjs/);
  assert.equal(sync.hooks[0].timeout, 75);
  assert.ok(s.hooks.PreToolUse.some((g) => g.matcher === 'Agent|Task|Workflow'));
  assert.ok(!s.hooks.WorktreeCreate && !s.hooks.WorktreeRemove);
  uninstallClaude({ scope: 'project', cwd });
  s = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(s.hooks || {}, {});

  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-git-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const hook = path.join(repo, '.git', 'hooks', 'post-commit');
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  fs.writeFileSync(hook, '#!/bin/sh\necho mine\n', { mode: 0o755 });
  installGit({ cwd: repo });
  installGit({ cwd: repo });
  let text = fs.readFileSync(hook, 'utf8');
  assert.equal(text.split('# swarmstead').length - 1, 1, 'idempotent');
  assert.match(text, /echo mine/);
  uninstallGit({ cwd: repo });
  text = fs.readFileSync(hook, 'utf8');
  assert.ok(!text.includes('swarmstead'));
  assert.match(text, /echo mine/);
});
