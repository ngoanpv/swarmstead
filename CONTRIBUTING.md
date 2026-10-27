# Contributing

Thanks for wanting to make the village better! 🏘

## Setup

```bash
git clone https://github.com/your-org/swarmstead && cd swarmstead
npm test                                   # node:test, no dependencies
node bin/swarmstead.js start --open     # live village
open http://127.0.0.1:4317/web/?demo       # demo; add &hour=22 for night, &lang=vi
```

There's no build step: edit files in `web/` or `core/` and reload.

## Good first contributions

- **Detectors** (`core/detectors.js`): add a rule, i18n strings in `core/i18n.js` (`alert` + `hint`), and a test.
- **Adapters** (`server/adapters/`): Gemini CLI, OpenCode, Aider… Translate to the events in `docs/EVENTS.md`.
- **Sprites** (`web/render/sprites.js`): new species, accessories or poses. Use the `scripts/spritesheet.html` page to preview.
- **Translations**: copy `en` in `core/i18n.js`.
- **Scenery** (`web/render/scene.js`): new stations, seasonal decorations.

## Hooks

The list of hook events lives in `server/adapters/claude-hooks.js` (`CLAUDE_HOOK_EVENTS`). After changing it, run `npm run gen:hooks` to regenerate `plugin/hooks/hooks.json`; a test keeps them in sync. Never add an event listed in `NEVER_REGISTER`: those hooks change Claude Code's behaviour just by being present.

## Rules of the road

1. **Never get in the agent's way.** Hooks must stay async, silent, and always exit 0.
2. **Privacy first.** Never put file contents, diffs, prompts or tool output in state, logs or the UI.
3. **Honest incentives.** Evolution must never reward spending more tokens. If you change the XP formula, explain the incentive in your PR.
4. **Zero runtime dependencies** for the daemon and the web UI. Dev tooling is fine.
5. **Free assets only.** Any art or font must have an OSI/OFL-compatible licence, credited in the README.

## Pull requests

- Keep PRs focused, add or adjust tests, and run `npm test`.
- For visual changes, include a screenshot or GIF (the demo mode makes this easy).
- Be kind. We follow the [Contributor Covenant](https://www.contributor-covenant.org/version/2/1/code_of_conduct/).
