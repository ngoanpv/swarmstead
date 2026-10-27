# Architecture

```
agent-village/
├─ bin/agent-village.js        CLI: start, install/uninstall, doctor, ping
├─ core/                       isomorphic ES modules (daemon + browser)
│  ├─ schema.js                normalized event kinds, tool categories
│  ├─ state.js                 World: reducer over events → agents, totals, handoffs, effects
│  ├─ detectors.js             issue rules → alerts (with i18n params)
│  ├─ evolution.js             familiars, XP, stats, stages
│  ├─ engine.js                Village = World + Detectors + Evolution
│  ├─ pricing.js               per-model price table (overridable)
│  ├─ i18n.js                  en + vi strings, alert texts and hints
│  └─ util.js
├─ server/
│  ├─ daemon.js                HTTP + SSE, reorder buffer, persistence
│  ├─ install.js               safe settings.json / hooks.json editing
│  ├─ config.js
│  └─ adapters/
│     ├─ claude-hooks.js       hook payload → events (also used for Codex)
│     ├─ transcripts.js        Claude transcript + Codex rollout tailers
│     └─ summarize.js          privacy-safe tool summaries
├─ plugin/                     Claude Code plugin (hooks/hooks.json + forwarder)
├─ .claude-plugin/marketplace.json
├─ web/                        the pixel village (no build step)
│  ├─ index.html, main.js, sound.js
│  ├─ render/ sprites.js, scene.js, world.js, pixelfont.js
│  └─ sim/demo.js              scripted demo using the real engine
└─ test/                       node:test suites (core, adapters, end-to-end daemon)
```

## Data flow

1. **Hooks**: Claude Code runs `plugin/hooks/agent-village-hook.mjs` for each lifecycle event (`async: true`). The script stamps the time and POSTs the raw payload to `/api/hook/claude`, with an 800 ms timeout. It never prints and always exits 0.
2. **Adapter**: `ClaudeHookAdapter.translate()` turns the payload into normalized events (see `docs/EVENTS.md`). Inside a subagent, Claude Code adds `agent_id`/`agent_type`, so the event is attributed to `"<session>:<agent_id>"`.
3. **Transcript tailer**: on the first hook from a session, the daemon starts tailing its `transcript_path` and the `<session>/subagents/agent-*.jsonl` files beside it. Assistant lines with `message.usage` become `usage` events, deduplicated by `message.id + requestId`. Lines written before tailing started are flagged `backfill`, so they only count toward today's totals.
4. **Reorder buffer**: async hooks can arrive slightly out of order, so events wait 300 ms and are applied sorted by timestamp.
5. **Engine**: `World.apply` mutates state and returns *effects*. Detectors turn state and effects into alerts. Finished turns go to Evolution. A 1 s tick re-evaluates time-based rules (permission waits, stalls, burn rate).
6. **Broadcast**: effects are sent immediately over SSE. Snapshots are throttled to 2.5/s, and the roster is sent and saved every 2 s when it changes.
7. **Browser**: `WorldView` maps each agent's status to a place in the room. A new activity must persist 550 ms before the villager walks there, so a burst of tool calls doesn't make it jitter. Effects become animations.

## Status → place

| Status | Main agent | Subagent |
|---|---|---|
| reading | bookshelf | bookshelf |
| planning | whiteboard | whiteboard |
| web | globe | globe |
| running | server rack | server rack |
| writing, thinking, tool, delegating, permission | own desk | next to the parent's desk |
| waiting (>45 s) | coffee machine | — |
| done / ended | walks out through the door | delivers its scroll, then leaves through the portal |

## Why these choices

- **Zero runtime dependencies.** `npx`/`git clone` and go. The daemon uses only `node:http`, `node:fs` and `node:child_process`.
- **Polling, not fs.watch**, for transcripts. It's portable, survives file rotation, and costs almost nothing for a few dozen files.
- **Procedural sprites.** No asset licences to worry about, every familiar is unique, and evolution is easy to express in code.
- **Same engine in browser and daemon.** The demo exercises the real logic, and contributors can work on visuals without running an agent.
