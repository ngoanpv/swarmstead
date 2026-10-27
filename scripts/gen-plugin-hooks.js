// Regenerate plugin/hooks/hooks.json from the single source of truth in the adapter.
//   node scripts/gen-plugin-hooks.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLAUDE_HOOK_EVENTS, NEVER_REGISTER } from '../server/adapters/claude-hooks.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied']);
const bad = CLAUDE_HOOK_EVENTS.filter((e) => NEVER_REGISTER.includes(e));
if (bad.length) throw new Error(`refusing to register ${bad.join(', ')}`);
const hooks = {};
for (const e of CLAUDE_HOOK_EVENTS) {
  const h = { type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/swarmstead-hook.mjs" claude', timeout: 5, async: true };
  hooks[e] = [TOOL_EVENTS.has(e) ? { matcher: '*', hooks: [h] } : { hooks: [h] }];
}
// plugin only: start the daemon if it isn't running ("autostart": false turns it off) and show the
// village's address. Synchronous on purpose: Claude Code only shows a sync hook's systemMessage.
// It takes a few milliseconds; the daemon itself starts in the background.
hooks.SessionStart[0].hooks.push({ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/swarmstead-up.mjs" --say', timeout: 10 });
const out = { description: 'Forward Claude Code lifecycle events to the local Swarmstead daemon (http://127.0.0.1:4317). The forwarders are async and never print. On SessionStart one quick synchronous hook starts the daemon if needed and shows the village address.', hooks };
fs.writeFileSync(path.join(ROOT, 'plugin/hooks/hooks.json'), JSON.stringify(out, null, 2) + '\n');
console.log(`wrote plugin/hooks/hooks.json with ${CLAUDE_HOOK_EVENTS.length} events`);
