import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ClaudeHookAdapter } from '../server/adapters/claude-hooks.js';
import { ClaudeTranscripts, CodexRollouts } from '../server/adapters/transcripts.js';
import { summarizeTool, responseFailed } from '../server/adapters/summarize.js';

const base = { session_id: 'S1', cwd: '/w/proj', transcript_path: '/tmp/x.jsonl' };

test('claude hooks: tool lifecycle maps to normalized events', () => {
  const ad = new ClaudeHookAdapter();
  const [start] = ad.translate({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_use_id: 'u1', tool_input: { file_path: '/w/proj/src/a.ts', old_string: 'x', new_string: 'y' } }, 1);
  assert.equal(start.kind, 'tool.start');
  assert.equal(start.category, 'write');
  assert.equal(start.file, '/w/proj/src/a.ts');
  assert.equal(start.detail, 'src/a.ts');
  assert.equal(typeof start.inputHash, 'number');
  const [fail] = ad.translate({ ...base, hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_use_id: 'u2', tool_input: { command: 'npm test' }, error: 'exit 1' }, 2);
  assert.equal(fail.ok, false);
  assert.equal(fail.command, 'npm test');
  const [intr] = ad.translate({ ...base, hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_use_id: 'u3', tool_input: {}, is_interrupt: true }, 3);
  assert.equal(intr.ok, true, 'a user interrupt is not an error');
});

test('claude hooks: subagent events carry agent ids and spawn detail', () => {
  const ad = new ClaudeHookAdapter();
  ad.translate({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Task', tool_use_id: 't1', tool_input: { subagent_type: 'code-reviewer', description: 'review auth' } });
  const [st] = ad.translate({ ...base, hook_event_name: 'SubagentStart', agent_id: 'ag9', agent_type: 'code-reviewer' });
  assert.equal(st.kind, 'subagent.start');
  assert.equal(st.agentId, 'S1:ag9');
  assert.equal(st.parentId, 'S1');
  assert.match(st.detail, /review auth/);
  const [tool] = ad.translate({ ...base, hook_event_name: 'PreToolUse', agent_id: 'ag9', agent_type: 'code-reviewer', tool_name: 'Grep', tool_use_id: 'g', tool_input: { pattern: 'TODO' } });
  assert.equal(tool.agentId, 'S1:ag9');
  const [perm] = ad.translate({ ...base, hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission' });
  assert.equal(perm.kind, 'permission.request');
  const [idle] = ad.translate({ ...base, hook_event_name: 'Notification', notification_type: 'idle_prompt' });
  assert.equal(idle.kind, 'waiting.input');
  assert.deepEqual(ad.translate({ ...base, hook_event_name: 'SomethingNew' }), []);
  assert.deepEqual(ad.translate({ hook_event_name: 'Stop' }), [], 'no session id -> ignored');
});

test('summarize: privacy-safe details and failure detection', () => {
  assert.equal(summarizeTool('Bash', { command: 'API_KEY=secret npm test' }, 'minimal').detail, 'API_KEY=secret');
  assert.equal(summarizeTool('WebFetch', { url: 'https://example.com/a?token=1' }).detail, 'example.com');
  assert.equal(summarizeTool('apply_patch', { command: '*** Begin Patch\n*** Update File: src/x.rs\n' }).detail, 'src/x.rs');
  assert.match(responseFailed({ exit_code: 2, stderr: 'boom' }), /exit 2/);
  assert.equal(responseFailed({ stdout: 'ok', exit_code: 0 }), null);
});

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'av-test-')); }

test('claude transcripts: dedupe by message id, subagents, backfill flag', () => {
  const root = tmpdir();
  const proj = path.join(root, '-w-proj');
  fs.mkdirSync(path.join(proj, 'S1', 'subagents'), { recursive: true });
  const file = path.join(proj, 'S1.jsonl');
  const now = new Date().toISOString();
  const old = new Date(Date.now() - 3600_000).toISOString();
  const line = (id, ts, extra = {}) => JSON.stringify({ type: 'assistant', sessionId: 'S1', requestId: 'r' + id, timestamp: ts, message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50, cache_creation: { ephemeral_1h_input_tokens: 50 } } }, ...extra });
  fs.writeFileSync(file, [line('m0', old), line('m1', now), line('m1', now), JSON.stringify({ type: 'user' }), 'not json'].join('\n') + '\n');
  fs.writeFileSync(path.join(proj, 'S1', 'subagents', 'agent-abc.jsonl'), line('m2', now, { isSidechain: true, agentId: 'abc' }) + '\n');
  const got = [];
  const tx = new ClaudeTranscripts((evs) => got.push(...evs), { root });
  tx.noteSession('S1', file, '/w/proj');
  assert.equal(got.length, 3, 'old line + one deduped line + subagent line');
  const [backfilled, live, sub] = got;
  assert.equal(backfilled.backfill, true);
  assert.equal(live.backfill, undefined);
  assert.equal(live.usage.cacheWrite1h, 50);
  assert.equal(sub.agentId, 'S1:abc');
  // appending new lines is picked up by poll
  fs.appendFileSync(file, line('m3', new Date().toISOString()) + '\n');
  tx.pollAll();
  assert.equal(got.length, 4);
});

test('codex rollouts: a session started after the daemon is found without hooks', () => {
  const root = tmpdir();
  const d = new Date();
  const dir = path.join(root, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  const got = [];
  const tx = new CodexRollouts((evs) => got.push(...evs), { root });
  assert.equal(tx.bootstrap(), 0, 'no folder for today yet');
  fs.mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString();
  fs.writeFileSync(path.join(dir, 'rollout-late.jsonl'), [
    JSON.stringify({ timestamp: ts, type: 'session_meta', payload: { id: 'T2', cwd: '/w/late' } }),
    JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 50 }, last_token_usage: { input_tokens: 40, output_tokens: 10 } } } }),
  ].join('\n') + '\n');
  tx.pollAll();
  tx.pollAll();
  const usage = got.filter((e) => e.kind === 'usage');
  assert.equal(usage.length, 1, 'tracked once across polls');
  assert.equal(usage[0].sessionId, 'T2');
  assert.equal(usage[0].cwd, '/w/late');
  assert.equal(usage[0].backfill, undefined, 'live, so the agent appears');
});

test('codex rollouts: token_count deltas, cached input split, rate limits', () => {
  const root = tmpdir();
  const file = path.join(root, 'rollout-test.jsonl');
  const ts = new Date().toISOString();
  const tc = (total, last) => JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: total }, last_token_usage: last, model_context_window: 272000 }, rate_limits: { primary: { used_percent: 12.5, window_minutes: 300, resets_at: 1800000000 } } } });
  fs.writeFileSync(file, [
    JSON.stringify({ timestamp: ts, type: 'session_meta', payload: { id: 'T1', cwd: '/w/docs' } }),
    JSON.stringify({ timestamp: ts, type: 'turn_context', payload: { model: 'gpt-6.1-sol' } }),
    tc(1500, { input_tokens: 1200, cached_input_tokens: 1000, output_tokens: 300 }),
    tc(1500, { input_tokens: 1200, cached_input_tokens: 1000, output_tokens: 300 }),
  ].join('\n') + '\n');
  const got = [];
  const tx = new CodexRollouts((evs) => got.push(...evs), { root });
  tx.track(file);
  const usage = got.filter((e) => e.kind === 'usage');
  const limits = got.filter((e) => e.kind === 'limits');
  assert.equal(usage.length, 1, 'repeated totals are deduped');
  assert.equal(usage[0].usage.input, 200);
  assert.equal(usage[0].usage.cacheRead, 1000);
  assert.equal(usage[0].usage.model, 'gpt-6.1-sol');
  assert.equal(usage[0].usage.contextWindow, 272000);
  assert.equal(limits[0].limits.primary.usedPercent, 12.5);
});
