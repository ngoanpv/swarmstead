// The normalized event schema every adapter emits.
// Adapters (Claude Code hooks, transcripts, Codex) translate provider-specific
// payloads into these events; everything downstream (state, detectors,
// evolution, UI) only ever sees this shape.
//
// {
//   v: 1,
//   ts: number,                // epoch ms
//   provider: 'claude' | 'codex' | 'demo',
//   kind: EventKind,
//   sessionId: string,         // top-level session
//   agentId: string,           // who did it (== sessionId for the main agent)
//   parentId?: string,         // set on subagent.start
//   agentType?: string,        // subagent type, e.g. "code-reviewer"
//   cwd?: string,
//   tool?: string, toolUseId?: string, category?: ToolCategory,
//   detail?: string,           // short, privacy-safe summary ("src/a.ts", "npm test")
//   file?: string,             // absolute path for file-touching tools
//   inputHash?: number,        // hash of the tool input, for loop detection
//   ok?: boolean, error?: string,
//   usage?: { model, input, output, cacheRead, cacheWrite },
//   costUsd?: number,
//   context?: { used, window },
//   reason?: string,
// }

export const EV = Object.freeze({
  SESSION_START: 'session.start',
  SESSION_END: 'session.end',
  PROMPT: 'prompt',                 // user submitted a prompt -> agent starts thinking
  TOOL_START: 'tool.start',
  TOOL_END: 'tool.end',
  PERMISSION: 'permission.request', // agent is blocked on an approval
  WAITING: 'waiting.input',         // agent idle, waiting for the human
  TURN_END: 'turn.end',             // agent finished its turn (Stop)
  SUBAGENT_START: 'subagent.start',
  SUBAGENT_END: 'subagent.end',
  COMPACT: 'compact.start',
  COMPACT_END: 'compact.end',
  USAGE: 'usage',                   // tokens/cost for one model response
  LIMITS: 'limits',                 // provider rate-limit / quota snapshot
  MODEL_SWITCH: 'model.switch',     // { from, to }
  WORKTREE: 'worktree',             // { action: 'create'|'remove'|'cwd', path, name }
  TEAM: 'team',                     // { action: 'task.created'|'task.completed'|'join', team, teammate, subject }
  NOTICE: 'notice',                 // { text, level } — informational, e.g. quota auto-resume
  AGENT_META: 'agent.meta',         // late facts about an agent: { stage, workflow, title, parentId }
});

/** StopFailure error values that mean "the agent can't continue right now". */
export const EXHAUSTION = new Set(['rate_limit', 'rate_limited', 'overloaded', 'billing_error', 'account_on_hold', 'quota_exceeded', 'usage_limit']);

/** Optional fields any event may carry; the world copies them onto the agent. */
export const AGENT_FIELDS = ['mode', 'effort', 'model', 'background', 'crons', 'team', 'teammate', 'stage', 'workflow'];

export const CATEGORY = Object.freeze({
  READ: 'read',
  WRITE: 'write',
  RUN: 'run',
  WEB: 'web',
  DELEGATE: 'delegate',
  PLAN: 'plan',
  TOOL: 'tool',
});

const TOOL_CATEGORY = {
  // Claude Code
  Read: CATEGORY.READ, Grep: CATEGORY.READ, Glob: CATEGORY.READ, LS: CATEGORY.READ,
  NotebookRead: CATEGORY.READ,
  Edit: CATEGORY.WRITE, MultiEdit: CATEGORY.WRITE, Write: CATEGORY.WRITE, NotebookEdit: CATEGORY.WRITE,
  Bash: CATEGORY.RUN, BashOutput: CATEGORY.RUN, KillShell: CATEGORY.RUN, PowerShell: CATEGORY.RUN,
  WebSearch: CATEGORY.WEB, WebFetch: CATEGORY.WEB,
  Task: CATEGORY.DELEGATE, Agent: CATEGORY.DELEGATE, Workflow: CATEGORY.DELEGATE, SendMessage: CATEGORY.DELEGATE,
  TodoWrite: CATEGORY.PLAN, TaskCreate: CATEGORY.PLAN, TaskUpdate: CATEGORY.PLAN, ExitPlanMode: CATEGORY.PLAN,
  // Codex
  shell: CATEGORY.RUN, local_shell: CATEGORY.RUN, exec_command: CATEGORY.RUN, unified_exec: CATEGORY.RUN,
  apply_patch: CATEGORY.WRITE, read_file: CATEGORY.READ, list_dir: CATEGORY.READ, grep_files: CATEGORY.READ,
  web_search: CATEGORY.WEB, update_plan: CATEGORY.PLAN,
};

export function categorize(tool) {
  if (!tool) return CATEGORY.TOOL;
  if (TOOL_CATEGORY[tool]) return TOOL_CATEGORY[tool];
  const t = tool.toLowerCase();
  if (t.startsWith('mcp__')) {
    if (/search|fetch|browse|web/.test(t)) return CATEGORY.WEB;
    if (/read|get|list|query|find/.test(t)) return CATEGORY.READ;
    if (/write|create|update|edit|delete/.test(t)) return CATEGORY.WRITE;
    return CATEGORY.TOOL;
  }
  if (/read|grep|glob|search_files|list/.test(t)) return CATEGORY.READ;
  if (/write|edit|patch/.test(t)) return CATEGORY.WRITE;
  if (/bash|shell|exec|command|run/.test(t)) return CATEGORY.RUN;
  if (/web|fetch|http/.test(t)) return CATEGORY.WEB;
  if (/task|agent|delegate|spawn/.test(t)) return CATEGORY.DELEGATE;
  return CATEGORY.TOOL;
}

/** Commands that look like a test/build/lint run. Their outcome spawns/defeats monsters. */
export const TEST_COMMAND = /\b(test|tests|pytest|jest|vitest|mocha|go test|cargo (test|build|check)|npm (run )?(test|build|lint)|pnpm (test|build|lint)|yarn (test|build|lint)|bun test|tsc|eslint|ruff|mypy|make( test)?|gradle|mvn|dotnet (test|build)|rspec|phpunit)\b/i;

export function isTestCommand(cmd) {
  return !!cmd && TEST_COMMAND.test(cmd);
}

/** Valid kinds, for input validation on the daemon side. */
export const KINDS = new Set(Object.values(EV));

export function isValidEvent(e) {
  return !!e && typeof e === 'object' && KINDS.has(e.kind) && typeof e.agentId === 'string' && e.agentId.length > 0;
}
