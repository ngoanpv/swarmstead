// Turn a raw tool call into a short, privacy-safe summary.
// We never keep file contents, diffs, prompts or tool output in state —
// only what a status line would show.

import { categorize, CATEGORY } from '../../core/schema.js';
import { hash32, oneLine, shortPath } from '../../core/util.js';

/**
 * @param {string} tool
 * @param {object} input tool_input
 * @param {'summary'|'minimal'} capture
 */
export function summarizeTool(tool, input = {}, capture = 'summary') {
  input = input && typeof input === 'object' ? input : {};
  const category = categorize(tool);
  const out = { category, detail: '', file: '', command: '' };
  const file = input.file_path || input.notebook_path || input.path || '';
  if (file && (category === CATEGORY.READ || category === CATEGORY.WRITE)) {
    out.file = String(file);
    out.detail = shortPath(file, 2);
  }
  switch (tool) {
    case 'Bash': case 'PowerShell': case 'shell': case 'local_shell': case 'exec_command': case 'unified_exec': {
      const cmd = Array.isArray(input.command) ? input.command.join(' ') : String(input.command || input.cmd || '');
      out.command = oneLine(cmd, 240);
      out.detail = capture === 'minimal' ? firstWord(cmd) : oneLine(cmd, 60);
      break;
    }
    case 'apply_patch': {
      const patch = String(input.command || input.input || input.patch || '');
      const m = patch.match(/\*\*\* (?:Update|Add|Delete) File: (.+)/);
      if (m) { out.file = m[1].trim(); out.detail = shortPath(out.file, 2); }
      break;
    }
    case 'Grep': out.detail = capture === 'minimal' ? 'grep' : oneLine(input.pattern, 40); break;
    case 'Glob': out.detail = oneLine(input.pattern, 40); break;
    case 'WebSearch': out.detail = capture === 'minimal' ? 'search' : oneLine(input.query, 50); break;
    case 'WebFetch': out.detail = host(input.url); break;
    case 'Task': case 'Agent':
      out.detail = oneLine([input.subagent_type, input.description].filter(Boolean).join(': '), 60);
      out.agentType = input.subagent_type || input.agent_type || 'general-purpose';
      break;
    default:
      if (!out.detail && tool && tool.startsWith('mcp__')) out.detail = tool.split('__').slice(1).join('/');
  }
  out.inputHash = hash32(safeStringify(input));
  return out;
}

function firstWord(cmd) {
  return String(cmd).trim().split(/\s+/)[0] || '';
}

function host(url) {
  try { return new URL(url).host; } catch { return oneLine(url, 40); }
}

function safeStringify(v) {
  try {
    const s = JSON.stringify(v);
    return s.length > 20000 ? s.slice(0, 20000) : s;
  } catch { return ''; }
}

/** Best-effort failure detection in a tool_response (Bash exit codes, is_error flags). */
export function responseFailed(resp) {
  if (!resp || typeof resp !== 'object') return null;
  if (resp.is_error === true || resp.isError === true) return oneLine(resp.error || resp.content || 'error', 200);
  const code = resp.exit_code ?? resp.exitCode ?? resp.returnCode ?? resp.code;
  if (Number.isInteger(code) && code !== 0) {
    const tail = String(resp.stderr || resp.output || resp.stdout || '').trim().split('\n').slice(-3).join(' ');
    return oneLine(`exit ${code}: ${tail}`, 200);
  }
  return null;
}
