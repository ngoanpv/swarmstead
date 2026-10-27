# Evolution: design and tuning

The goal is a pet that **reflects how well an agent works**, not how much it works. If the game rewarded token burn, it would push people toward exactly the behaviour that costs money. So we reward three things: finished work, clean work, and efficient work.

All of the code is in `core/evolution.js` and is pure and deterministic. The same turn summaries always produce the same roster, so the roster can be rebuilt from the event log and is easy to test (`test/core.test.js`).

## Identity

A familiar is keyed by `provider:project:agentType`:

- `claude:shop-api:main` is the main agent you run in `shop-api`.
- `claude:shop-api:code-reviewer` is the `code-reviewer` subagent in that project.

Every live agent you see is that familiar at work. Two parallel sessions on the same project share a familiar, and look like twins.

## The turn summary

When a turn ends (`Stop` for a main agent, `SubagentStop` for a subagent), the world closes the turn and produces a summary. It holds cost, tokens, tool counts by category, edits, runs, failed runs, test failures and fixes, loops, repeated errors, handoffs returned, permission prompts and compactions.

## XP

```
work     = clamp(1 + 0.5·edits + 0.25·runs + 1·returns + 0.15·tools, 1, 8)   (edits, runs ≤ 8; tools ≤ 30)
quality  = clamp(1 − 0.35·loops − 0.2·errorEchoes − 0.1·autoCompactions, 0.1, 1)
thrift   = clamp(baselineCostPerWork / thisCostPerWork, 0.5, 1.75)            (1 on the first turn)
cache    = 1 + 0.25 · cacheRead / (input + cacheRead + cacheWrite)
xp       = 10·work·quality·thrift·cache + 15·bugsSlain + (clean ? 5 : 0)
```

- **Caps** on `work` stop agents from farming XP with busywork.
- **thrift** compares the turn against the familiar's *own* moving baseline (EMA, α=0.1). An agent that is expensive but improving still gets rewarded, and spending more than usual reduces XP.
- A **bug slain** means a test or build command failed (a monster spawned) and a later run of the same kind of command passed.

## Swarms and fan-in

A Claude Code workflow can run hundreds of subagents. If each earned full XP, launching more agents would be the fastest way to level up, which is exactly the habit we don't want to reward.

- **Subagent turns** in a run of more than 4 agents are multiplied by `√(4 / swarm)`. At 16 agents that's 0.5×, and at 100 agents 0.2×.
- **The orchestrator** gets one fan-in bonus when every agent of the run has reported back: `20 × min(10, √total) × success`. Here `success = (clean + ½·rough + ¼·lost) / total`.
- A report that comes back **failed** is worth 0.6×, unless the failure was a rate limit, overload, billing or quota stop (not the agent's fault).

## Levels

`xpForLevel(n) = round(40 · n^1.5)` is the XP needed to go from level *n* to *n*+1. With typical turns worth 40–80 XP:

| Level | Roughly |
|---|---|
| 2 (hatch) | 1 turn |
| 6 (Adept) | ~20 turns |
| 14 (Master) | ~160 turns |
| 28 (Legend) | ~900 turns |

A familiar for a project you work on daily reaches Master in a couple of weeks and Legend over a few months.

## Stats (0–100, moving averages)

| Stat | From |
|---|---|
| Focus | turn quality |
| Thrift | 50 = your own average; above 50 means cheaper per unit of work than usual |
| Craft | edits that end without failed runs, plus bugs slain |
| Cache | prompt-cache hit ratio |
| Grit | log of turns + bugs slain |

## Stages and gates

| Stage | Gate |
|---|---|
| Egg → Hatchling | level 2. The species is fixed now, from the dominant work style. |
| Hatchling → Adept | level 6 **and** (≥1 bug slain **or** ≥10 turns) |
| Adept → Master | level 14 **and** Focus ≥ 55. The branch is chosen now: **Zen** if Focus ≥ Thrift, else **Alchemist**. |
| Master → Legend | level 28 **and** best clean streak ≥ 10 **and** (Thrift ≥ 55 **or** Focus ≥ 80) |

## Species = work style

Work style is a moving average (α=0.15) of each turn's tool mix:

| Trait | Weighting | Species |
|---|---|---|
| scholar | read + ½·plan | Owl |
| smith | 1.2·write | Fox |
| engineer | run | Bot |
| ranger | 1.5·web + ½·other tools | Bunny |
| commander | 3·delegate | Cat |

From Adept on, a **secondary** trait above 18% adds an accessory: glasses, hammer, antenna, scarf or cape.

## Marks of habit

- **Glitch (corruption).** Each loop or repeated error adds 0.25. A clean turn removes 0.15 and any other turn removes 0.05. At 0.5 or more the sprite turns purple and flickers. Nothing is ever lost; it heals.
- **Shiny.** Earned the first time a familiar strings together 10 clean turns. There is also a 1-in-128 chance at birth.

## Tuning ideas

- Change the gates in `GATES` or the curve in `xpForLevel`. Keep it deterministic.
- Add a trait by extending `TRAITS`, `traitMix`, `SPECIES` and a sprite in `web/render/sprites.js`.
- Contributions that make the incentives *more* honest are especially welcome, for example rewarding merged PRs via git hooks.
