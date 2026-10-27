# Contributing

Thanks for wanting to make the village better! 🏘

## Setup

```bash
git clone https://github.com/ngoanpv/swarmstead && cd swarmstead
npm test                                   # node:test, no dependencies
node bin/swarmstead.js start --open     # live village
open http://127.0.0.1:4317/web/?demo       # demo; add &hour=22 for night, &lang=vi
```

There's no build step: edit files in `web/` or `core/` and reload. Use `npm run dev` instead of `start` while you work on `server/` or `core/`: the daemon restarts on every save.

## Good first contributions

- **Detectors** (`core/detectors.js`): add a rule, i18n strings in `core/i18n.js` (`alert` + `hint`), and a test.
- **Adapters** (`server/adapters/`): Gemini CLI, OpenCode, Aider… Translate to the events in `docs/EVENTS.md`.
- **Sprites** (`web/render/sprites.js`): new species, accessories or poses. Use the `scripts/spritesheet.html` page to preview.
- **Translations**: copy `en` in `core/i18n.js`.
- **Scenery** (`web/render/scene.js`): new stations, seasonal decorations.

## Hooks

The list of hook events lives in `server/adapters/claude-hooks.js` (`CLAUDE_HOOK_EVENTS`). After changing it, run `npm run gen:hooks` to regenerate `plugin/hooks/hooks.json`; a test keeps them in sync. Never add an event listed in `NEVER_REGISTER`: those hooks change Claude Code's behaviour just by being present.

## Releasing

The npm package and the plugin ship together: the plugin's autostart runs `npx swarmstead@<plugin version>`.

1. Set the same `version` in `package.json` and `plugin/.claude-plugin/plugin.json` (a test checks they match). Plugin users only get an update when this string changes.
2. Check the plugin: `claude plugin validate --strict ./plugin` and `claude plugin validate .`
3. Commit, then `git tag v0.3.0 && git push origin main --tags`. `.github/workflows/release.yml` tests, packs, smoke-tests the tarball through `npx` and publishes. A version with a `-` (like `0.3.0-beta.1`) goes to the `next` tag, so testers run `npx swarmstead@next`.

The very first publish is manual (`npm login && npm publish --access public`). After that, set up trusted publishing on npmjs.com (package > Settings > Trusted publishing > GitHub Actions: `ngoanpv/swarmstead`, workflow `release.yml`) so no npm token lives in the repo.

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

## Re-recording the README GIFs

The GIFs in `docs/images/*.gif` and `docs/media/swarmstead-tour.mp4` come from the demo, recorded with Playwright:

```bash
node bin/swarmstead.js start &
pip install playwright && playwright install chromium   # once
python3 scripts/tour/record.py && scripts/tour/cut.sh
cp .tour/gifs/*.gif docs/images/ && cp .tour/gifs/swarmstead-tour.mp4 docs/media/
```

