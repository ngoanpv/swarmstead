import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Village } from '../core/engine.js';
import { EV } from '../core/schema.js';
import { scoreTurn } from '../core/evolution.js';
import { ClaudeHookAdapter, CLAUDE_HOOK_EVENTS, NEVER_REGISTER } from '../server/adapters/claude-hooks.js';
import { ClaudeTranscripts } from '../server/adapters/transcripts.js';

let T = Date.parse('2026-10-27T03:00:00Z');
const S = 'lead';
const base = { session_id: S, cwd: '/w/payments', transcript_path: '/tmp/none.jsonl' };

function feed(v, ad, payloads) {
  const fx = [];
  for (const p of payloads) for (const e of ad.translate({ ...base, ...p }, (T += 400))) fx.push(...v.ingest(e));
  return fx;
}

test('never registers hooks that change Claude Code behaviour', () => {
  for (const e of NEVER_REGISTER) assert.ok(!CLAUDE_HOOK_EVENTS.includes(e), e);
  const plugin = JSON.parse(fs.readFileSync(new URL('../plugin/hooks/hooks.json', import.meta.url)));
  assert.deepEqual(Object.keys(plugin.hooks).sort(), [...CLAUDE_HOOK_EVENTS].sort(), 'plugin hooks.json is in sync (npm run gen:hooks)');
  for (const groups of Object.values(plugin.hooks)) for (const g of groups) for (const h of g.hooks) assert.equal(h.async, true);
  assert.ok(plugin.hooks.SessionStart[0].hooks.some((h) => h.command.includes('swarmstead-up.mjs')), 'autostart on SessionStart');
});

test('the plugin and the npm package share one version (autostart runs swarmstead@<plugin version>)', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url)));
  const plugin = JSON.parse(fs.readFileSync(new URL('../plugin/.claude-plugin/plugin.json', import.meta.url)));
  assert.equal(plugin.version, pkg.version);
});

test('workflow agents join one run, by stage, with the workflow name', () => {
  const v = new Village({ now: T });
  const ad = new ClaudeHookAdapter();
  feed(v, ad, [
    { hook_event_name: 'SessionStart', source: 'startup', permission_mode: 'auto', effort: { level: 'high' } },
    { hook_event_name: 'PreToolUse', tool_name: 'Workflow', tool_use_id: 'w', tool_input: {} },
    { hook_event_name: 'PostToolUse', tool_name: 'Workflow', tool_use_id: 'w', tool_input: {}, tool_response: { runId: 'wf_1a2b3c4d-5e6', workflowName: 'audit-payments' } },
  ]);
  const ids = [];
  for (let i = 0; i < 14; i++) {
    feed(v, ad, [{ hook_event_name: 'SubagentStart', agent_id: `a${i}`, agent_type: 'workflow-subagent' }]);
    ids.push(`a${i}`);
  }
  // the journal tells us which phase each agent belongs to (arrives later)
  for (let i = 0; i < 14; i++) v.ingest({ v: 1, ts: (T += 10), provider: 'claude', kind: EV.AGENT_META, sessionId: S, agentId: `${S}:a${i}`, parentId: S, stage: i < 6 ? 'Scan' : 'Classify', title: `item ${i}` });
  let snap = v.snapshot(T);
  const run = snap.runs[0];
  assert.equal(run.workflow, 'audit-payments');
  assert.equal(run.total, 14);
  assert.deepEqual(run.stages.map((s) => [s.name, s.total, s.running]), [['Scan', 6, 6], ['Classify', 8, 8]]);
  const lead = snap.agents.find((a) => a.id === S);
  assert.equal(lead.mode, 'auto');
  assert.equal(lead.effort, 'high');
  // three of them stuck on permission prompts -> ONE swarm alert on the lead
  for (const i of [7, 8, 9]) feed(v, ad, [{ hook_event_name: 'PermissionRequest', agent_id: `a${i}`, agent_type: 'workflow-subagent', tool_name: 'Bash', tool_input: { command: 'psql' } }]);
  v.tick(T + 30_000);
  snap = v.snapshot(T + 30_000);
  const perm = snap.alerts.filter((a) => a.kind === 'permissionSub');
  assert.equal(perm.length, 1);
  assert.equal(perm[0].params.count, 3);
  assert.equal(perm[0].agentId, S);
  // everyone reports back -> fan-in, and the lead gets a run bonus
  let fx = [];
  for (const id of ids) fx.push(...feed(v, ad, [{ hook_event_name: 'SubagentStop', agent_id: id, agent_type: 'workflow-subagent', agent_transcript_path: `/x/subagents/workflows/wf_1a2b3c4d-5e6/agent-${id}.jsonl` }]));
  assert.ok(!fx.some((f) => f.fx === 'fanin'), 'fan-in waits for a quiet moment (pipelines pause between stages)');
  fx.push(...v.tick(T + 3000));
  const fanin = fx.find((f) => f.fx === 'fanin');
  assert.ok(fanin && fanin.total === 14);
  assert.ok(fx.some((f) => f.fx === 'stage.done' && f.stage === 'Scan'));
  assert.ok(fx.some((f) => f.fx === 'xp' && f.agentId === S && f.score?.fanin));
  const returns = fx.filter((f) => f.fx === 'handoff' && f.kind === 'return');
  assert.equal(returns.length, 14);
  assert.ok(returns.every((r) => ['clean', 'rough', 'failed', 'lost'].includes(r.outcome)));
});

test('nested subagents link to the agent that spawned them', () => {
  const v = new Village({ now: T });
  const ad = new ClaudeHookAdapter();
  feed(v, ad, [
    { hook_event_name: 'SessionStart' },
    { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 't1', tool_input: { subagent_type: 'planner' } },
    { hook_event_name: 'SubagentStart', agent_id: 'p', agent_type: 'planner' },
    { hook_event_name: 'PreToolUse', agent_id: 'p', agent_type: 'planner', tool_name: 'Agent', tool_use_id: 't2', tool_input: { subagent_type: 'researcher' } },
    { hook_event_name: 'SubagentStart', agent_id: 'r', agent_type: 'researcher' },
  ]);
  const snap = v.snapshot(T);
  assert.equal(snap.agents.find((a) => a.id === `${S}:r`).parentId, `${S}:p`);
});

test('teammates hand messages back and forth without leaving', () => {
  const v = new Village({ now: T });
  const ad = new ClaudeHookAdapter();
  ad.registerTeam({ leadSessionId: S, members: [{ name: 'team-lead', agentId: 'lead', agentType: 'team-lead' }, { name: 'tester', agentId: 'm1', agentType: 'qa' }] }, 'session-lead');
  feed(v, ad, [{ hook_event_name: 'SessionStart' }]);
  let fx = feed(v, ad, [{ hook_event_name: 'SubagentStart', agent_id: 'm1', agent_type: 'qa' }]);
  assert.ok(fx.some((f) => f.fx === 'handoff' && f.kind === 'delegate'));
  fx = feed(v, ad, [{ hook_event_name: 'SubagentStop', agent_id: 'm1', agent_type: 'qa' }]);
  assert.ok(fx.some((f) => f.fx === 'handoff' && f.kind === 'return' && f.stay));
  const mate = v.snapshot(T).agents.find((a) => a.id === `${S}:m1`);
  assert.equal(mate.alive, true);
  assert.equal(mate.teammate, 'tester');
  assert.equal(v.snapshot(T).teams[0].lead, S);
});

test('rate limits exhaust an agent; other failures do not', () => {
  const v = new Village({ now: T });
  const ad = new ClaudeHookAdapter();
  feed(v, ad, [{ hook_event_name: 'SessionStart' }, { hook_event_name: 'UserPromptSubmit' }, { hook_event_name: 'StopFailure', error: 'rate_limit' }]);
  let snap = v.snapshot(T);
  assert.equal(snap.agents[0].status, 'exhausted');
  v.tick(T + 1000);
  assert.ok(v.snapshot(T + 1000).alerts.some((a) => a.kind === 'exhausted'));
  feed(v, ad, [{ hook_event_name: 'UserPromptSubmit' }, { hook_event_name: 'StopFailure', error: 'max_output_tokens' }]);
  snap = v.snapshot(T);
  assert.equal(snap.agents[0].status, 'waiting');
});

test('model switches, parallel tools, denied tools and background tasks are tracked', () => {
  const v = new Village({ now: T });
  const ad = new ClaudeHookAdapter();
  const fx = feed(v, ad, [
    { hook_event_name: 'SessionStart', model: 'claude-opus-5-5' },
    { hook_event_name: 'PostModelSwitch', from_model: 'claude-opus-5-5', to_model: 'claude-sonnet-5-5' },
    { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'a', tool_input: { file_path: '/w/1' } },
    { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'b', tool_input: { file_path: '/w/2' } },
    { hook_event_name: 'PermissionDenied', tool_name: 'Bash', tool_use_id: 'c', reason: 'auto mode classifier' },
    { hook_event_name: 'Stop', background_tasks: [{ id: 1, type: 'shell' }, { id: 2, type: 'workflow' }] },
  ]);
  const a = v.snapshot(T).agents[0];
  assert.equal(a.model, 'claude-sonnet-5-5');
  assert.equal(a.background, 2);
  assert.ok(fx.some((f) => f.fx === 'parallel' && f.count === 2));
  assert.ok(fx.some((f) => f.fx === 'bubble' && f.icon === 'deny'));
});

test('worktrees count as the same project, so a worktree is not a collision', () => {
  const v = new Village({ now: T });
  const ad = new ClaudeHookAdapter();
  const edit = (sid, cwd, file) => [
    { session_id: sid, cwd, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_use_id: sid, tool_input: { file_path: file } },
  ];
  feed(v, ad, edit('s1', '/w/app', '/w/app/src/a.ts'));
  feed(v, ad, edit('s2', '/w/app/.claude/worktrees/fix', '/w/app/.claude/worktrees/fix/src/a.ts'));
  const snap = v.snapshot(T);
  assert.deepEqual(snap.agents.map((a) => [a.project, a.worktree]), [['app', ''], ['app', 'fix']]);
  assert.ok(!snap.alerts.some((a) => a.kind === 'collision'));
});

test('swarm XP shrinks with swarm size; never rewards running more agents', () => {
  const s = { tools: 8, edits: 2, runs: 1, cost: 0.2, cat: { read: 4 } };
  const solo = scoreTurn({ ...s, swarm: 1 }, {}).xp;
  const big = scoreTurn({ ...s, swarm: 100 }, {}).xp;
  assert.ok(big < solo / 4);
});

test('workflow journal lines become agent metadata, with the run name from the script file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'av-wf-'));
  const proj = path.join(root, '-w-payments');
  const sess = path.join(proj, 'S1');
  fs.mkdirSync(path.join(sess, 'workflows', 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(sess, 'subagents', 'workflows', 'wf_abc123'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'S1.jsonl'), '');
  fs.writeFileSync(path.join(sess, 'workflows', 'scripts', 'audit-payments-wf_abc123.js'), '');
  const got = [];
  const tx = new ClaudeTranscripts((evs) => got.push(...evs), { root });
  tx.noteSession('S1', path.join(proj, 'S1.jsonl'), '/w/payments');
  fs.appendFileSync(path.join(sess, 'subagents', 'workflows', 'wf_abc123', 'journal.jsonl'),
    JSON.stringify({ type: 'started', key: 'k1', agentId: 'ag1', label: 'scan ledger', phase: 'Scan', timestamp: new Date().toISOString() }) + '\n' +
    JSON.stringify({ type: 'result', key: 'k1', agentId: 'ag1' }) + '\n');
  tx.pollAll();
  const meta = got.filter((e) => e.kind === 'agent.meta');
  assert.equal(meta.length, 1);
  assert.equal(meta[0].agentId, 'S1:ag1');
  assert.equal(meta[0].stage, 'Scan');
  assert.equal(meta[0].workflow, 'audit-payments');
});
