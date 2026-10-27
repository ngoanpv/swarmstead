// End-to-end: real daemon, real hook script (stdin -> HTTP), real transcript file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'av-home-'));
process.env.SWARMSTEAD_HOME = home;
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ claude: { transcripts: path.join(home, 'none') }, codex: { sessions: path.join(home, 'none') } }));

const { startDaemon } = await import('../server/daemon.js');
const { installClaude, uninstallClaude } = await import('../server/install.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('hook script -> daemon -> state, plus transcript usage', async () => {
  const d = await startDaemon({ port: 0 });
  const port = d.cfg.port;
  try {
    const transcript = path.join(home, 'S9.jsonl');
    fs.writeFileSync(transcript, '');
    const hook = (payload) => spawnSync(process.execPath, [path.join(ROOT, 'plugin/hooks/swarmstead-hook.mjs'), 'claude'], {
      input: JSON.stringify({ session_id: 'S9', cwd: '/w/e2e', transcript_path: transcript, ...payload }),
      env: { ...process.env, SWARMSTEAD_URL: `http://127.0.0.1:${port}` },
    });
    let r = hook({ hook_event_name: 'SessionStart', source: 'startup' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.length, 0, 'hook must never print');
    hook({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' });
    hook({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_use_id: 'w1', tool_input: { file_path: '/w/e2e/a.txt', content: 'secret content' } });
    fs.appendFileSync(transcript, JSON.stringify({ type: 'assistant', sessionId: 'S9', requestId: 'q', timestamp: new Date().toISOString(), message: { id: 'm', model: 'claude-sonnet-5-5', usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0 } } }) + '\n');
    await sleep(1600);
    const state = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
    const a = state.agents.find((x) => x.id === 'S9');
    assert.ok(a, 'agent exists');
    assert.equal(a.status, 'writing');
    assert.equal(a.project, 'e2e');
    assert.ok(state.totals.cost > 0, 'transcript usage was priced');
    assert.ok(!JSON.stringify(state).includes('secret content'), 'file contents never reach state');

    // hook exits cleanly even when the daemon is gone
    const dead = spawnSync(process.execPath, [path.join(ROOT, 'plugin/hooks/swarmstead-hook.mjs'), 'claude'], {
      input: '{"session_id":"x","hook_event_name":"Stop"}', env: { ...process.env, SWARMSTEAD_URL: 'http://127.0.0.1:1' }, timeout: 3000,
    });
    assert.equal(dead.status, 0);

    // cross-origin POSTs are refused
    const res = await fetch(`http://127.0.0.1:${port}/api/events`, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 403);
    // static files cannot escape the repo
    const trav = await fetch(`http://127.0.0.1:${port}/web/..%2f..%2fpackage.json`);
    assert.notEqual(trav.status, 200);
  } finally {
    await d.close();
  }
});

test('installer adds and removes only its own hooks', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'av-cc-'));
  const cwd = fakeHome;
  const file = path.join(cwd, '.claude', 'settings.local.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const mine = { type: 'command', command: 'echo mine' };
  fs.writeFileSync(file, JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [mine] }] } }));
  installClaude({ scope: 'project', cwd });
  installClaude({ scope: 'project', cwd }); // idempotent
  let s = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(s.model, 'opus');
  assert.equal(s.hooks.Stop.length, 2);
  assert.equal(s.hooks.PreToolUse.length, 1);
  assert.equal(s.hooks.PreToolUse[0].matcher, '*');
  assert.equal(s.hooks.PreToolUse[0].hooks[0].async, true);
  uninstallClaude({ scope: 'project', cwd });
  s = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(s.hooks, { Stop: [{ hooks: [mine] }] });
  assert.ok(fs.existsSync(file + '.swarmstead.bak'));
});
