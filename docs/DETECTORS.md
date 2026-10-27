# Issue detectors

All of these run locally in `core/detectors.js`, and every threshold can be changed in `~/.swarmstead/config.json`.

| Detector | Fires when (defaults) | Severity |
|---|---|---|
| `loop` | Same tool + same input ≥3× in the last 8 calls | warn (≥5 → crit) |
| `errorEcho` | Same normalised error message ≥3× in 10 min | warn |
| `stall` | ≥25 tool calls, ≥10 min, ≥$0.50 spent with no file edits (not for read-only roles) | warn |
| `context` | Context ≥65% full | warn (≥80% → crit) |
| `permission` | Main agent blocked on approval >20 s | warn |
| `permissionSub` | A **subagent** blocked on approval | crit |
| `waiting` | Main agent idle, waiting for you >3 min | info |
| `burn` | 5-min average ≥ $1/min | warn (3× → crit) |
| `budget` | Today's spend ≥ `dailyBudgetUsd` (off by default) | crit |
| `collision` | Two unrelated sessions edit the same file within 10 min | crit |
| `compactRisk` | Auto-compaction while subagents are running or just reported back | warn |
| `exhausted` | Turn stopped by `rate_limit`, `overloaded`, `billing_error` or `account_on_hold` | crit (warn for subagents) |
| `bypass` | Session running with `bypassPermissions` | warn |
| `straggler` | A run agent has been working >3× its stage's median and >2 min | warn |
| `sprawl` | A run reaches 50 agents, or spawns ≥20 per minute | info / warn |
| `runBudget` | A run's cost ≥ `runBudgetUsd` (off by default) | crit |
| `runForecast` / `runOverrun` | A run is projected over `runBudgetUsd`, or has cost 1.5× its usual | warn |
| `blockForecast` | At this pace you reach `limits.claudeBlockUsd` before the 5-hour block resets, or beat your heaviest block | warn / info |
| `limitForecast` | A provider limit (Codex) runs out before it resets | warn (<30 min → crit) |
| `unverified` | An agent claims tests pass without a passing test after its last edit | warn |
| `mergeRisk` | The same repo file edited in two worktrees within 24 h | warn |

**Swarm collapse:** when 3 or more subagents of one orchestrator trip the same rule, you get one alert ("7 subagents of payments are stuck on permission prompts") instead of seven.

Every alert comes with a one-line hint on what to do next.
