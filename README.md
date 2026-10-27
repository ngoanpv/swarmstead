<p align="center">
  <img src="docs/brand/social-preview.png" alt="Swarmstead: your Claude Code and Codex agents as a living pixel village" width="100%">
</p>

<p align="center">
  <a href="https://github.com/ngoanpv/swarmstead/actions/workflows/ci.yml"><img src="https://github.com/ngoanpv/swarmstead/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/swarmstead"><img src="https://img.shields.io/npm/v/swarmstead?color=7fb3ff" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-b18cff" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A5%2018.17-5fd3c8" alt="Node 18.17 or newer">
  <img src="https://img.shields.io/badge/runtime%20deps-0-ffd34d" alt="Zero runtime dependencies">
  <a href="https://ngoanpv.github.io/swarmstead/"><img src="https://img.shields.io/badge/demo-play%20in%20browser-f08a3e" alt="Play the demo"></a>
</p>

**Watch your coding agents work as a living pixel village.** Every Claude Code session moves into the workshop as a little character. Subagents step out of a portal, carry scrolls back to their lead, and fight bug monsters when tests fail. Coins fly into a treasure chest as tokens are spent. When something goes wrong (a loop, a stuck permission prompt, context about to overflow, two agents editing the same file), you see it before it costs you.

And the villagers **evolve**, but only through good habits: finished work, few loops, and spending less than their own average.

> Claude Code first. Codex CLI support is in **beta**. Local-only, zero runtime dependencies, MIT licensed. · [Tiếng Việt](docs/README.vi.md)

## Install

Requires **Node 18+** and Claude Code.

**1. Install the plugin** (in a terminal, or with `/plugin marketplace add …` and `/plugin install …` inside Claude Code):

```bash
claude plugin marketplace add ngoanpv/swarmstead
claude plugin install swarmstead@swarmstead
```

**2. Start a new Claude Code session.** The plugin starts the village in the background (the first time takes a few seconds while npm fetches it). Later sessions reuse it.

**3. Open http://127.0.0.1:4317/web/.** Your session walks in through the door as a villager.

Nothing there? Run `npx swarmstead doctor` to check the setup, or `npx swarmstead ping` to send a fake session through.

**Just want to look?** Play the [live demo](https://ngoanpv.github.io/swarmstead/) in your browser (also [hosted on Claude](https://claude.ai/artifact/8HT8mz3i3xZLV7m8iDTe7J)), watch the [1-minute feature tour (MP4)](docs/media/swarmstead-tour.mp4), or run `npx swarmstead start --open` and add `?demo` to the address (`&hour=22` for night mode, `&lang=vi` for Vietnamese).

![Swarmstead: the village, then a 35-agent workflow in the Arena](docs/images/tour-hero.gif)

## What it does for you every day

| | Feature | |
|---|---|---|
| 1 | **Answer permission prompts from the village or your phone**, so a background subagent never hangs on a prompt nobody sees | [→](docs/FEATURES.md#1-approve-from-the-village-or-your-phone) |
| 2 | **Forecasts**: what this workflow will cost (from your past runs), and whether you hit your 5-hour block or Codex limit before it resets, plus an optional budget brake | [→](docs/FEATURES.md#2-forecasts-and-the-budget-brake) |
| 3 | **"All tests pass", checked**: flags an agent that claims success without a passing test after its last edit | [→](docs/FEATURES.md#3-and-4-claims-that-were-never-tested-and-merge-conflicts-before-they-happen) |
| 4 | **Merge-conflict forecast** across git worktrees: the same file changed in two trees | [→](docs/FEATURES.md#3-and-4-claims-that-were-never-tested-and-merge-conflicts-before-they-happen) |
| 5 | **Cost per commit and per PR**, per project | [→](docs/FEATURES.md#5-cost-per-commit-and-per-pr) |
| 6 | **Replay any day** and get a **post-mortem**: where the money went, what was wasted, shareable as Markdown | [→](docs/FEATURES.md#6-replay-and-post-mortem) |

There is more in the village itself: what every villager, scroll and monster means, the Arena for workflows with dozens of agents, the issue detectors, and familiars that evolve. See [Features](docs/FEATURES.md), [Issue detectors](docs/DETECTORS.md) and [Evolution](docs/EVOLUTION.md).

## Everyday use

| To | Do |
|---|---|
| Open the village | http://127.0.0.1:4317/web/ |
| Check the setup | `npx swarmstead doctor` |
| Update | `claude plugin update swarmstead@swarmstead`. Third-party plugins don't update on their own; you can turn on auto-update in `/plugin` > Marketplaces. |
| Find out why the village didn't start | Read `~/.swarmstead/daemon.log` |
| Run the daemon yourself | Set `"autostart": false` in `~/.swarmstead/config.json`, then `npx swarmstead start` |
| Uninstall | `claude plugin uninstall swarmstead@swarmstead`. Your config and event log stay in `~/.swarmstead/`; delete it if you want them gone. |

## Other ways to install

### Without the plugin

Plain hooks in `~/.claude/settings.json` work too, and the approval gate below needs them:

```bash
npx swarmstead install claude      # --project: only this repo's .claude/settings.local.json
npx swarmstead start --open        # keep it running while you work
```

Use the plugin **or** these hooks, not both: with both, every event is counted twice. Update with `npx swarmstead@latest install claude` (plain `npx swarmstead` can reuse an older cached copy). Remove with `npx swarmstead uninstall claude`.

### Optional extras

```bash
npx swarmstead install claude --gate   # hooks only: approve prompts from the village/phone + budget brake
npx swarmstead install git             # inside a repo: book your own commits too (cost per commit)
npx swarmstead start --lan             # reach the village (and approve) from your phone
```

With the plugin, set `"lan": true` in `~/.swarmstead/config.json` instead of `--lan`. It applies the next time the daemon starts.

### Codex CLI (beta)

```bash
npx swarmstead install codex     # writes ~/.codex/hooks.json
```

Codex only runs hooks you have trusted. Open Codex, run `/hooks`, and trust the swarmstead entries. Token usage and rate limits come from `~/.codex/sessions/**/rollout-*.jsonl`.

### From source

`git clone https://github.com/ngoanpv/swarmstead && cd swarmstead && npm run dev` runs the daemon and restarts it on every save. Connect Claude Code with `node bin/swarmstead.js install claude`, or load the plugin for one session with `claude --plugin-dir ./plugin`. Build the single-file demo with `npm i --no-save esbuild && npm run build:demo` (writes `dist/swarmstead-demo.html`). See [CONTRIBUTING.md](CONTRIBUTING.md).

## Privacy & security

- Everything stays on your machine. The daemon binds to `127.0.0.1`, rejects cross-origin POSTs and foreign `Host` headers (DNS rebinding), and serves only `web/` and `core/`.
- The state holds **summaries only**: file paths, the first 60 characters of a command, a search query. File contents, diffs, prompts and tool output are never stored. Use `"capture": "minimal"` to keep even less.
- **What can leave your machine**, only if you set it up: push notifications to your ntfy topic (`notify.ntfy`) and messages to a Slack or Discord webhook (`notify.webhook`). Each carries an alert's title and one line of text: the agent, the tool and a short detail. Nothing is ever sent to the Swarmstead author.
- An event log is written to `~/.swarmstead/events/` so you can replay sessions. It stays on your machine until you delete it. Turn it off with `"logEvents": false`.
- The plugin's autostart runs `npx -y swarmstead@<version>` with exactly the version of the plugin you installed. Turn it off with `"autostart": false` and run the daemon yourself.
- Deciding an approval always needs the token in `~/.swarmstead/token` (created with mode 0600). With `--lan`, every API call from another device needs it too. Use a long, secret ntfy topic: anyone who knows the topic can read the pushes.

## Documentation

- [Features](docs/FEATURES.md): why it exists, what you see in the village, big runs and the six daily tools
- [Issue detectors](docs/DETECTORS.md): every alert, its default threshold and severity
- [Evolution](docs/EVOLUTION.md): XP, species, stages, and how to tune them
- [Configuration](docs/CONFIGURATION.md): `~/.swarmstead/config.json`
- [Architecture](docs/ARCHITECTURE.md): how it works, Claude Code coverage, data flow
- [Events](docs/EVENTS.md): the event schema, and how to feed events from your own tools
- [Tiếng Việt](docs/README.vi.md)

## Roadmap

- [x] Replay mode and post-mortem
- [x] Cost per commit / PR, using agent git commands and a git hook
- [x] Approvals from the village and the phone, budget brake
- [ ] Live workflow progress from the SDK's `task_progress` stream (queued agents, retries)
- [ ] Split-pane agent-team teammates (separate sessions) linked to their lead
- [ ] Cost per *merged* PR via the GitHub API
- [ ] VS Code panel and menubar mini-village
- [ ] Gemini CLI / OpenCode adapters
- [ ] Community sprite packs, as long as they are under a free licence

## Contributing

PRs are welcome, especially new detectors, adapters, sprites and translations. See [CONTRIBUTING.md](CONTRIBUTING.md). Run `npm test` before you open a PR.

## Logo

<p>
  <img src="docs/brand/icon-256.png" width="128" height="128" alt="Swarmstead icon, 256 px">
  <img src="docs/brand/icon-64.png" width="64" height="64" alt="Swarmstead icon, 64 px">
  <img src="docs/brand/icon-32.png" width="32" height="32" alt="Swarmstead icon, 32 px">
</p>

A fox-eared cottage (the *stead*) with glowing window eyes, and a few sparks around it (the *swarm*). It is pixel art on a 32×32 grid, so scale it by whole numbers with nearest-neighbour filtering (`image-rendering: pixelated`).

| File | Use |
|---|---|
| [`docs/brand/icon.svg`](docs/brand/icon.svg) | Vector, any size |
| [`docs/brand/icon-512.png`](docs/brand/icon-512.png) · [`256`](docs/brand/icon-256.png) · [`64`](docs/brand/icon-64.png) · [`32`](docs/brand/icon-32.png) | App icons, avatars, favicons |
| [`docs/brand/social-preview.png`](docs/brand/social-preview.png) | 1280×640 banner: README header and GitHub social preview |

Regenerate them with `python3 scripts/brand/make-icon.py` (needs Pillow). The logo is under the same MIT licence as the code.

## Credits & license

MIT © [ngoanpv](https://github.com/ngoanpv) and Swarmstead contributors. Fonts: [Pixelify Sans](https://github.com/eifetx/Pixelify-Sans) and [Silkscreen](https://kottke.org/plus/type/silkscreen/), both under the SIL Open Font License (see `web/fonts/`). Inspired by the community's pixel-office and observability experiments around Claude Code.
