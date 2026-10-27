---
name: village
description: Open the Swarmstead village (the live pixel view of your agents) in the browser, starting it if it isn't running.
disable-model-invocation: true
allowed-tools: Bash(node *)
---

!`node "${CLAUDE_PLUGIN_ROOT}/hooks/swarmstead-open.mjs"`

Reply with the line above, word for word, and nothing else.
