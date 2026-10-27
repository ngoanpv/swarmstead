# Normalized events

Adapters translate provider payloads into these events, and everything downstream only sees this shape. You can also send them yourself with `POST http://127.0.0.1:4317/api/events`, which accepts a single object or an array. That way any agent framework can live in the village.

```jsonc
{
  "v": 1,
  "ts": 1767000000000,            // epoch ms (defaults to now)
  "provider": "claude",           // claude | codex | custom | …
  "kind": "tool.start",
  "sessionId": "abc",             // top-level session
  "agentId": "abc",               // == sessionId for the main agent; "abc:sub1" for a subagent
  "parentId": "abc",              // subagents only
  "agentType": "code-reviewer",   // subagents only
  "cwd": "/home/me/project",
  "tool": "Edit", "toolUseId": "t1", "category": "write",
  "detail": "src/app.ts",         // short summary shown in the UI
  "file": "/home/me/project/src/app.ts",
  "command": "npm test",          // for run tools (used to detect test runs)
  "inputHash": 12345,             // same tool + same hash repeated = loop
  "ok": true, "error": "…",       // on tool.end
  "usage": { "model": "claude-opus-5-5", "input": 1200, "output": 300, "cacheRead": 40000, "cacheWrite": 2000 },
  "costUsd": 0.05,                // optional; otherwise priced from usage
  "context": { "used": 42000, "window": 200000 }
}
```

| kind | Meaning |
|---|---|
| `session.start` / `session.end` | A villager arrives / leaves |
| `prompt` | The human sent a prompt; a new turn starts |
| `tool.start` / `tool.end` | Tool call lifecycle. `category`: read, write, run, web, delegate, plan, tool |
| `permission.request` | Blocked on an approval |
| `waiting.input` | Idle, waiting for the human |
| `turn.end` | Turn finished. XP is awarded. |
| `subagent.start` / `subagent.end` | Handoff out / report back |
| `compact.start` / `compact.end` | Context compaction |
| `usage` | Tokens for one model response |
| `limits` | Provider quota snapshot: `{ primary: { usedPercent, windowMinutes, resetsAt } }` |
| `model.switch` | `{ from, to }` |
| `team` | `{ action: assign / report / task.created / task.completed, team, teammate, subject }` |
| `agent.meta` | Late facts about an agent: `{ stage, workflow, title, parentId }` |
| `notice` | Informational log line: `{ text, level }` |

Any event may also carry `mode` (permission mode), `effort`, `stage`, `workflow`, `background` and `crons`. These are copied onto the agent. On `subagent.end`, `outcome` overrides the computed one (`clean`, `rough`, `failed`, `lost`).

## Example: a custom agent in five lines

```bash
curl -s localhost:4317/api/events -H 'content-type: application/json' -d '[
 {"agentId":"bot1","kind":"session.start","cwd":"/work/etl"},
 {"agentId":"bot1","kind":"prompt"},
 {"agentId":"bot1","kind":"tool.start","tool":"run_sql","category":"run","detail":"SELECT …"},
 {"agentId":"bot1","kind":"usage","usage":{"model":"claude-sonnet-5-5","input":800,"output":200,"cacheRead":9000}},
 {"agentId":"bot1","kind":"turn.end"}
]'
```

## Claude Code hook mapping

| Hook | Event |
|---|---|
| SessionStart / SessionEnd | session.start / session.end |
| UserPromptSubmit | prompt |
| PreToolUse | tool.start (Task/Agent also queues the spawn detail) |
| PostToolUse / PostToolUseFailure / PermissionDenied | tool.end (failure detection, interrupts are not errors) |
| PermissionRequest, Notification `permission_prompt` | permission.request |
| Notification `idle_prompt` / `agent_needs_input`, TeammateIdle | waiting.input |
| Stop / StopFailure | turn.end (with `background`/`crons` counts, or the error as `reason`) |
| PostModelSwitch | model.switch |
| TaskCreated / TaskCompleted, SubagentStart/Stop of a known teammate | team |
| CwdChanged | worktree (cwd) |
| SubagentStart / SubagentStop | subagent.start / subagent.end |
| PreCompact / PostCompact | compact.start / compact.end |

Tokens and model come from the transcript, because hook payloads don't carry usage.
